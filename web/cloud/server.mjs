import {createServer} from 'node:http';
import {stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {GET,POST} from '../app/api/[...path]/route.js';
import {sizePaperPosition} from '../lib/paper/risk.ts';
import {marketFeed} from '../lib/cloud/feed.mjs';
import {cloudEnabled,store} from '../lib/cloud/store.mjs';
import {freezeForecast,listForecasts,ownerKey} from '../lib/cloud/journal.mjs';
import {resolveContracts,marketFees} from '../lib/cloud/resolve.mjs';
import {validateTicker} from '../lib/live.mjs';
import {handleMCP} from '../lib/workspace/mcp.mjs';
import {serviceAuthorized,reserveAssistant} from '../lib/workspace/assistant.mjs';
import {isCountryAllowed} from '../lib/workspace/geo.mjs';
import {traceContext} from '../lib/runtime-observability.mjs';
import {runtimeTelemetry,observeProviderAttempt} from '../lib/runtime/telemetry.mjs';
import {createLogPipeline,sanitizeOperationalRecord} from '../lib/runtime/log-pipeline.mjs';
import {makeAccountHandler} from '../lib/workspace/account.mjs';

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
const productionDefault=process.env.NODE_ENV==='production'||Boolean(process.env.RAILWAY_ENVIRONMENT_ID);
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
export function requestIdentity(req,edgeVerified=false){
  const claimed=String(req.headers['x-market-client-ip']||'').trim();
  const raw=edgeVerified&&isIP(claimed)?claimed:String(req.socket.remoteAddress||'unknown');
  return raw.replace(/^::ffff:/,'');
}
export async function readBody(req,maximum=16000){
  if(Number(req.headers['content-length']||0)>maximum)throw Object.assign(new RangeError('Request exceeds the size limit'),{status:413});
  let bytes=0;const chunks=[];
  for await(const chunk of req){bytes+=chunk.length;if(bytes>maximum)throw Object.assign(new RangeError('Request exceeds the size limit'),{status:413});chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
export function createMarketServer({feed=marketFeed,storageEnabled=cloudEnabled,storage=store,now=Date.now,
  production=productionDefault,edgeSecret=process.env.MARKET_EDGE_SECRET,serviceSecret=process.env.ASSISTANT_SERVICE_SECRET,
  getRoute=GET,postRoute=POST,mcp=handleMCP,publicRoot=resolve(process.env.MARKET_PUBLIC_DIR||fileURLToPath(new URL('../public',import.meta.url))),
  streamMonthlyMinutes=Number(process.env.MARKET_STREAM_MINUTES||18000),streamMonthlyBytes=Number(process.env.MARKET_STREAM_BYTE_LIMIT||60000000000),
  monthlyAssistantDollars=Number(process.env.ASSISTANT_MONTHLY_BUDGET_USD||3),logger,telemetry=runtimeTelemetry,accountOptions={}}={}){
  const limits=new Map(),streamByIP=new Map();let connections=0,disabled=false,previousCpu=process.cpuUsage();
  const recentLogs=[],logPipeline=createLogPipeline({write:line=>{const record=JSON.parse(line);recentLogs.push(record);if(recentLogs.length>200)recentLogs.shift();if(production&&!logger)process.stdout.write(line+'\n');}});
  function recordLog(event,values){
    const level=values.status>=500?'error':values.status>=400?'warn':'info',safe=sanitizeOperationalRecord(event,values,level);
    logger?.(event,safe);logPipeline.log(event,safe,level);
  }
  const eventLoop=monitorEventLoopDelay({resolution:20});
  const allowedOrigins=new Set(['https://predictir.dev','https://www.predictir.dev']);
  function validOrigin(origin){
    if(!origin)return true;if(allowedOrigins.has(origin))return true;
    if(!production){try{const u=new URL(origin);return u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname);}catch{}}
    return false;
  }
  function headers(req,res){
    const origin=req.headers.origin;
    if(origin&&validOrigin(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  }
  function allowed(identity){
    const current=now(),slot=Math.floor(current/60000);
    if(limits.size>2048)for(const [key,value] of limits)if(value.slot<slot)limits.delete(key);
    const update=(key,maximum)=>{
      let item=limits.get(key);if(!item||item.slot!==slot){if(limits.size>4096)return false;item={slot,used:0};limits.set(key,item);}
      return ++item.used<=maximum;
    };
    return update('global',1200)&&update(identity,120);
  }
  async function quota(weight=1){
    if(disabled)throw Object.assign(new Error('Usage allowance reached; retry later'),{status:429});
    if(storageEnabled()&&!await storage().consume('work#'+new Date(now()).toISOString().slice(0,10),6000,weight))throw Object.assign(new Error('Daily work allowance reached'),{status:429});
  }
  async function sse(req,res,tickers,identity,multiplex=false){
    tickers=[...new Set(tickers.map(validateTicker))];
    if(!tickers.length||tickers.length>(multiplex?12:1))throw new RangeError('Choose one to twelve unique portfolio tickers');
    if(connections>=16||(streamByIP.get(identity)||0)>=3)throw Object.assign(new Error('Streaming capacity is currently full'),{status:429});
    if(!Number.isSafeInteger(streamMonthlyMinutes)||streamMonthlyMinutes<1||streamMonthlyMinutes>60000)throw new RangeError('Invalid streaming allowance');
    if(!Number.isSafeInteger(streamMonthlyBytes)||streamMonthlyBytes<65536||streamMonthlyBytes>100000000000)throw new RangeError('Invalid streaming byte allowance');
    connections++;streamByIP.set(identity,(streamByIP.get(identity)||0)+1);let countReleased=false;
    const releaseCount=()=>{if(countReleased)return;countReleased=true;connections--;
      const count=(streamByIP.get(identity)||1)-1;if(count)streamByIP.set(identity,count);else streamByIP.delete(identity);};
    const consumeMinute=()=>storageEnabled()?storage().consume('stream-minutes#'+new Date(now()).toISOString().slice(0,7),streamMonthlyMinutes,1,45*86400):Promise.resolve(true);
    const consumeBytes=()=>storageEnabled()?storage().consume('stream-egress-bytes#'+new Date(now()).toISOString().slice(0,7),streamMonthlyBytes,65536,45*86400):Promise.resolve(true);
    try{await quota(3);if(!await consumeMinute()||!await consumeBytes())throw Object.assign(new Error('Monthly streaming allowance reached'),{status:429});}
    catch(error){releaseCount();throw error;}
    req.setTimeout(0);res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const removers=[],latest=new Map();let ticks=0,closed=false,blockedSince=0,checking=false,refilling=false,bytesRemaining=65536;
    const refill=async()=>{if(refilling||closed)return;refilling=true;try{if(await consumeBytes())bytesRemaining+=65536;else res.end();}catch{res.end();}finally{refilling=false;}};
    const send=(message,event)=>{
      if(closed||res.destroyed||blockedSince)return false;
      const value=(event?'event: '+event+'\n':'')+'data: '+JSON.stringify(message)+'\n\n',bytes=Buffer.byteLength(value);
      if(bytes>65536){res.end();return false;}
      if(bytes>bytesRemaining){refill();return false;}bytesRemaining-=bytes;if(bytesRemaining<32768)refill();
      if(!res.write(value))blockedSince=now();return true;
    };
    res.on('drain',()=>{blockedSince=0;});
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);clearTimeout(timeout);for(const remove of removers)remove();latest.clear();releaseCount();};
    const timer=setInterval(async()=>{
      if(blockedSince&&now()-blockedSince>20000){res.destroy();return;}
      if(!blockedSince)for(const [ticker,value] of latest)if(send(value,multiplex?'book':null))latest.delete(ticker);else break;
      ticks++;
      if(ticks%100===0)send({kind:'heartbeat',status:feed.status,server_time:new Date(now()).toISOString(),transport:'exchange-websocket'},multiplex?'heartbeat':null);
      if(ticks%600===0&&!checking){checking=true;try{if(!await consumeMinute())res.end();}catch{res.end();}finally{checking=false;}}
      if(disabled)res.end();
    },100);
    const timeout=setTimeout(()=>res.end(),840000);res.on('close',cleanup);
    try{
      for(const ticker of tickers){
        const remove=await feed.add(ticker,message=>{if(message.kind==='quote')latest.set(ticker,{...message,ticker});
          else send(multiplex?{ticker,status:message.status,reason:message.reason}:message,multiplex?'status':null);});
        if(closed)remove();else removers.push(remove);
      }
    }catch{for(const ticker of tickers)send({kind:'connection',ticker,status:'unavailable',reason:'The native stream is unavailable. REST snapshots remain available.'},multiplex?'status':null);res.end();}
  }
  async function serveStatic(req,res,path){
    if(req.method!=='GET'&&req.method!=='HEAD')return json(res,{error:'Method not allowed'},405);
    if(production||path==='/'){res.writeHead(302,{Location:'https://predictir.dev/','Cache-Control':'no-store'});return res.end();}
    const file=resolve(publicRoot,'.'+path);
    if(!file.startsWith(publicRoot+'/')&&!file.startsWith(publicRoot+'\\'))return json(res,{error:'Unknown file'},404);
    try{const info=await stat(file);if(!info.isFile()||info.size>5e6)return json(res,{error:'Unknown file'},404);
      res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':path.endsWith('.html')?'no-cache':'public, max-age=3600'});
      if(req.method==='HEAD')return res.end();const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch(error){if(error.code==='ENOENT')return json(res,{error:'Unknown file'},404);throw error;}
  }
  const server=createServer({maxHeaderSize:16384,headersTimeout:10000,requestTimeout:25000,keepAliveTimeout:5000},async(req,res)=>{
    headers(req,res);
    const started=performance.now();let trace,route='unknown',reported=false;
    const report=()=>{if(reported)return;reported=true;const durationMs=Math.round((performance.now()-started)*100)/100;telemetry.observeRequest({route,status:res.statusCode,durationMs});recordLog('request.finished',{method:req.method,route,status:res.statusCode,duration_ms:durationMs,
      trace_id:trace?.traceId,span_id:trace?.spanId,parent_id:trace?.parentId,baggage_dropped:trace?.baggageDropped,open_streams:connections});};
    res.once('finish',report);res.once('close',report);
    try{
      if(req.url.length>2000)return json(res,{error:'URL too long'},414);
      const url=new URL(req.url,'http://localhost'),edgeVerified=serviceAuthorized(req.headers['x-market-edge-secret'],edgeSecret);
      trace=traceContext(req.headers,{trusted:edgeVerified||serviceAuthorized(req.headers.authorization,serviceSecret)});
      res.setHeader('traceparent',trace.traceparent);res.setHeader('tracestate',trace.tracestate);
      route=/^\/(?:api\/[a-z/-]{1,60}|mcp|internal\/(?:diagnostics|assistant\/(?:reserve|settle)))$/.test(url.pathname)?url.pathname:'unknown';
      const identity=requestIdentity(req,edgeVerified);
      if(!allowed(identity)){res.setHeader('Retry-After','60');return json(res,{error:'Rate limit reached. Retry in one minute.'},429);}
      if(!validOrigin(req.headers.origin))return json(res,{error:'This origin is not allowed'},403);
      if(url.pathname==='/api/health')return json(res,{status:disabled?'limited':'ok',runtime:'Railway Node backend',market_data_only:true,
        streaming:{connections,...(feed.metrics?.()||{})},performance:{event_loop_p99_ms:Number.isFinite(eventLoop.percentile(99))?Math.round(eventLoop.percentile(99)/1e4)/100:0}});
      const internal=url.pathname==='/mcp'||url.pathname.startsWith('/internal/');
      if(internal){
        if(!serviceAuthorized(req.headers.authorization,serviceSecret))return json(res,{error:'Service authorization required'},401);
        if(req.method!=='POST')return json(res,{error:'Method not allowed'},405);
        if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return json(res,{error:'Use application/json'},415);
        const raw=await readBody(req,20000),input=JSON.parse(raw||'{}');
        if(url.pathname==='/internal/diagnostics'){
          if(input.operation==='runtime_snapshot')return json(res,{telemetry:telemetry.snapshot(),logs:recentLogs.slice(),log_filter:logPipeline.snapshot(),provider_duration_scope:'Public source retrieval includes body reads and decoding. Other HTTP adapter timings may stop at response headers. Supabase Auth measures SDK calls.'});
          if(input.operation==='runtime_metrics'){res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store'});return res.end(telemetry.prometheus());}
          if(!storageEnabled()||storage().kind!=='postgres')return json(res,{error:'The relational store is not configured'},503);
          if(input.operation==='usage_allowances'){
            const month=new Date(now()).toISOString().slice(0,7),day=new Date(now()).toISOString().slice(0,10);
            const resources=[['stream_minutes','stream-minutes#'+month,streamMonthlyMinutes],['stream_egress_bytes','stream-egress-bytes#'+month,streamMonthlyBytes],
              ['archive_bytes','archive-bytes#'+month,Number(process.env.ARCHIVE_MONTHLY_BYTE_LIMIT||1000000000)],
              ['assistant_milliusd','assistant-reserved-milliusd#'+month,Math.floor(monthlyAssistantDollars*1000)],['x_post_reads','x-posts#'+month,Number(process.env.X_MONTHLY_POST_READ_LIMIT||1000)],
              ['daily_work','work#'+day,6000],['daily_cpu_ms','cpu-ms#'+day,1800000]];
            const rows=(await storage().db.query('SELECT key,used::float8 FROM market_lab.quotas WHERE key=ANY($1::text[]) AND expires_at>now()',[resources.map(row=>row[1])])).rows;
            const used=new Map(rows.map(row=>[row.key,row.used]));
            return json(res,{as_of:new Date(now()).toISOString(),allowances:resources.map(([resource,key,limit])=>({resource,limit,used:used.get(key)||0,
              remaining:Math.max(0,limit-(used.get(key)||0)),warning:(used.get(key)||0)>=limit*.8})),scope:'Reserved application allowances; provider invoices and included plan usage are separate.'});
          }
          if(input.operation!=='database_latency'||!Number.isInteger(input.samples)||input.samples<1||input.samples>9)throw new RangeError('Choose usage_allowances or database_latency with one through nine samples');
          await quota(3);const milliseconds=[];
          for(let i=0;i<input.samples;i++){const start=performance.now();await observeProviderAttempt('postgres',()=>storage().db.query('SELECT 1'),telemetry);milliseconds.push(Math.round((performance.now()-start)*100)/100);}
          return json(res,{operation:'database_latency',samples_ms:milliseconds,mean_ms:milliseconds.reduce((a,b)=>a+b,0)/milliseconds.length,
            runtime_region:process.env.RAILWAY_REGION||'unknown',pool:{total:storage().db.totalCount,idle:storage().db.idleCount,waiting:storage().db.waitingCount}});
        }
        if(url.pathname==='/internal/assistant/reserve')return json(res,await reserveAssistant(input.fingerprint,{storage:storageEnabled()?storage():null,monthlyDollars:monthlyAssistantDollars,now:now()}));
        if(url.pathname==='/internal/assistant/settle'){
          if(!storageEnabled()||typeof storage().settleAssistantBudget!=='function')return json(res,{error:'Usage settlement is unavailable'},503);
          return json(res,await storage().settleAssistantBudget(input.reservation_id,input.billed_milliusd));
        }
        if(url.pathname==='/mcp'){
          const ticker=validateTicker(req.headers['x-market-ticker']),modelScope=req.headers['x-market-model']==='challenger'?'challenger':'baseline';
          const rawExecution=req.headers['x-market-execution'];
          if(rawExecution&&Buffer.byteLength(String(rawExecution))>2000)throw new RangeError('Execution controls exceed their limit');
          const executionScope=rawExecution?JSON.parse(rawExecution):undefined;
          await quota(2);return await mcp(req,res,input,{tickerScope:ticker,modelScope,executionScope});
        }
        return json(res,{error:'Unknown service path'},404);
      }
      if(!url.pathname.startsWith('/api/'))return await serveStatic(req,res,decodeURIComponent(url.pathname));
      if(production&&!edgeVerified)return json(res,{error:'Open the application at predictir.dev'},403);
      if(edgeVerified&&!isCountryAllowed(String(req.headers['x-market-country']||'')))return json(res,{error:'This service is unavailable in your region'},403);
      if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
      if(!['GET','POST','PUT'].includes(req.method))return json(res,{error:'Method not allowed'},405);
      if(url.pathname==='/api/session'||url.pathname.startsWith('/api/account/')){
        await quota(2);const body=['POST','PUT'].includes(req.method)?await readBody(req,url.pathname==='/api/account/portfolio'?1500000:20000):undefined;
        const handler=makeAccountHandler({storage:storageEnabled()?storage():null,secret:process.env.ACCOUNT_COOKIE_SECRET||serviceSecret,secure:production,...accountOptions});
        const output=await handler(new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...(body?{body}:{})}),url.pathname.slice(5));
        const outputHeaders=Object.fromEntries(output.headers),cookies=output.headers.getSetCookie();if(cookies.length)outputHeaders['set-cookie']=cookies;
        res.writeHead(output.status,outputHeaders);return res.end(Buffer.from(await output.arrayBuffer()));
      }
      if(req.method==='PUT')return json(res,{error:'Method not allowed'},405);
      if(url.pathname==='/api/stream'){if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);return await sse(req,res,[url.searchParams.get('ticker')],identity);}
      if(url.pathname==='/api/portfolio/stream'){if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);
        const raw=url.searchParams.get('tickers')||'';if(raw.length>1750)throw new RangeError('Portfolio watchlist is too long');return await sse(req,res,raw.split(','),identity,true);}
      if(url.pathname==='/api/resolve'){if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);await quota(2);return json(res,await resolveContracts(url.searchParams.get('q')));}
      if(url.pathname==='/api/fees'){if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);await quota(2);return json(res,await marketFees(url.searchParams.get('ticker')));}
      if(req.method==='POST'&&!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return json(res,{error:'Use application/json'},415);
      const raw=req.method==='POST'?await readBody(req):'';
      if(url.pathname==='/api/journal'){
        if(!storageEnabled())return json(res,{error:'The durable journal is not connected'},503);
        const token=String(req.headers.authorization||'').replace(/^Bearer /,'');if(!token)return json(res,{error:'A private journal token is required'},401);ownerKey(token);
        await quota(req.method==='POST'?15:1);
        return req.method==='POST'?json(res,await freezeForecast(JSON.parse(raw),token),201):json(res,await listForecasts(token));
      }
      if(url.pathname==='/api/paper/size'){
        if(req.method!=='POST')return json(res,{error:'Method not allowed'},405);
        await quota();return json(res,sizePaperPosition(JSON.parse(raw)));
      }
      await quota(url.pathname.includes('forward/start')?30:url.pathname.includes('/recommendations')?12:
        url.pathname.includes('intelligence')||url.pathname.includes('/research')||url.pathname.includes('/execution-research')||url.pathname.includes('/opinions')?5:url.pathname.includes('/search')?2:1);
      const request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...(raw?{body:raw}:{})});
      const context={params:Promise.resolve({path:url.pathname.slice(5).split('/')})},output=req.method==='GET'?await getRoute(request,context):await postRoute(request,context);
      const buffer=Buffer.from(await output.arrayBuffer());if(buffer.byteLength>8e6)throw new Error('The response exceeds its size allowance');
      res.writeHead(output.status,Object.fromEntries(output.headers));res.end(buffer);
    }catch(error){
      if(res.headersSent)return res.end();
      const status=error.name==='ConditionalCheckFailedException'?409:error.status||(error instanceof SyntaxError||error instanceof RangeError||error instanceof URIError?400:503);
      const message=error instanceof SyntaxError?'Request body must be valid JSON':error.name==='ConditionalCheckFailedException'?'A forecast for this contract is already registered in this journal':
        status<500?error.message:'The data service is temporarily unavailable. Try again shortly.';
      json(res,{error:message},status);
    }
  });
  const monitor=setInterval(async()=>{
    if(!server.listening)return;
    const current=process.cpuUsage(),used=Math.ceil((current.user-previousCpu.user+current.system-previousCpu.system)/1000);previousCpu=current;
      const memory=process.memoryUsage();let pool;try{pool=storageEnabled()?storage().db:null;}catch{}
      recordLog('runtime.health',{event_loop_p99_ms:Math.round(eventLoop.percentile(99)/1e4)/100,heap_mb:Math.round(memory.heapUsed/1048576),rss_mb:Math.round(memory.rss/1048576),open_streams:connections,pool_total:pool?.totalCount,pool_idle:pool?.idleCount,pool_waiting:pool?.waitingCount});eventLoop.reset();
      if(!storageEnabled())return;
    try{const stop=await storage().get('config#cost');disabled=Boolean(stop?.disabled)||used>0&&!await storage().consume('cpu-ms#'+new Date(now()).toISOString().slice(0,10),1800000,Math.min(used,1800000));}
    catch{disabled=true;}
  },30000);monitor.unref();server.on('listening',()=>eventLoop.enable());server.on('close',()=>{clearInterval(monitor);eventLoop.disable();});
  return server;
}
export const server=createMarketServer();
if(process.env.PORT||process.env.AWS_LAMBDA_HTTP_ENDPOINT||process.env.MARKET_LOCAL_SERVER==='1'){
  const [legacyHost,legacyPort]=(process.env.AWS_LAMBDA_HTTP_ENDPOINT||'127.0.0.1:8780').split(':');
  const port=Number(process.env.PORT||legacyPort),host=process.env.HOST||(process.env.PORT?'0.0.0.0':legacyHost);
  server.listen(port,host,()=>console.log(JSON.stringify({service:'market-lab',runtime:'node',listening:true,port})));
}
