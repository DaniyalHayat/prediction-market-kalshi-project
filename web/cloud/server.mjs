import {createServer} from 'node:http';
import {stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';
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
  streamMonthlyMinutes=Number(process.env.MARKET_STREAM_MINUTES||6000),monthlyAssistantDollars=Number(process.env.ASSISTANT_MONTHLY_BUDGET_USD||3)}={}){
  const limits=new Map(),streamByIP=new Map();let connections=0,disabled=false,previousCpu=process.cpuUsage();
  const allowedOrigins=new Set(['https://predictir.dev','https://www.predictir.dev']);
  function validOrigin(origin){
    if(!origin)return true;if(allowedOrigins.has(origin))return true;
    if(!production){try{const u=new URL(origin);return u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname);}catch{}}
    return false;
  }
  function headers(req,res){
    const origin=req.headers.origin;
    if(origin&&validOrigin(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
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
  async function sse(req,res,ticker,identity){
    validateTicker(ticker);
    if(connections>=16||(streamByIP.get(identity)||0)>=3)throw Object.assign(new Error('Streaming capacity is currently full'),{status:429});
    if(!Number.isSafeInteger(streamMonthlyMinutes)||streamMonthlyMinutes<1||streamMonthlyMinutes>12000)throw new RangeError('Invalid streaming allowance');
    connections++;streamByIP.set(identity,(streamByIP.get(identity)||0)+1);let countReleased=false;
    const releaseCount=()=>{if(countReleased)return;countReleased=true;connections--;
      const count=(streamByIP.get(identity)||1)-1;if(count)streamByIP.set(identity,count);else streamByIP.delete(identity);};
    const consumeMinute=()=>storageEnabled()?storage().consume('stream-minutes#'+new Date(now()).toISOString().slice(0,7),streamMonthlyMinutes,1,45*86400):Promise.resolve(true);
    try{await quota(3);if(!await consumeMinute())throw Object.assign(new Error('Monthly streaming allowance reached'),{status:429});}
    catch(error){releaseCount();throw error;}
    req.setTimeout(0);res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    let remove,latest,ticks=0,closed=false,blockedSince=0,checking=false;
    const send=message=>{
      if(closed||res.destroyed||blockedSince)return false;
      const value='data: '+JSON.stringify(message)+'\n\n';
      if(Buffer.byteLength(value)>500000){res.end();return false;}
      if(!res.write(value))blockedSince=now();return true;
    };
    res.on('drain',()=>{blockedSince=0;});
    const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);clearTimeout(timeout);remove?.();releaseCount();};
    const timer=setInterval(async()=>{
      if(blockedSince&&now()-blockedSince>20000){res.destroy();return;}
      if(latest&&!blockedSince){const value=latest;latest=null;send(value);}
      ticks++;
      if(ticks%40===0)send({kind:'heartbeat',status:feed.status,server_time:new Date(now()).toISOString(),transport:'exchange-websocket'});
      if(ticks%240===0&&!checking){checking=true;try{if(!await consumeMinute())res.end();}catch{res.end();}finally{checking=false;}}
      if(disabled)res.end();
    },250);
    const timeout=setTimeout(()=>res.end(),840000);res.on('close',cleanup);
    try{remove=await feed.add(ticker,message=>{if(message.kind==='quote')latest=message;else send(message);});if(closed)remove();}
    catch{send({kind:'connection',status:'unavailable',reason:'The native stream is unavailable. REST snapshots remain available.'});res.end();}
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
    try{
      if(req.url.length>2000)return json(res,{error:'URL too long'},414);
      const url=new URL(req.url,'http://localhost'),edgeVerified=serviceAuthorized(req.headers['x-market-edge-secret'],edgeSecret);
      const identity=requestIdentity(req,edgeVerified);
      if(!allowed(identity)){res.setHeader('Retry-After','60');return json(res,{error:'Rate limit reached. Retry in one minute.'},429);}
      if(!validOrigin(req.headers.origin))return json(res,{error:'This origin is not allowed'},403);
      if(url.pathname==='/api/health')return json(res,{status:disabled?'limited':'ok',runtime:'Railway Node backend',market_data_only:true});
      const internal=url.pathname==='/mcp'||url.pathname.startsWith('/internal/');
      if(internal){
        if(!serviceAuthorized(req.headers.authorization,serviceSecret))return json(res,{error:'Service authorization required'},401);
        if(req.method!=='POST')return json(res,{error:'Method not allowed'},405);
        if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))return json(res,{error:'Use application/json'},415);
        const raw=await readBody(req,20000),input=JSON.parse(raw||'{}');
        if(url.pathname==='/internal/assistant/reserve')return json(res,await reserveAssistant(input.fingerprint,{storage:storageEnabled()?storage():null,monthlyDollars:monthlyAssistantDollars,now:now()}));
        if(url.pathname==='/mcp'){
          const ticker=validateTicker(req.headers['x-market-ticker']);await quota(2);return await mcp(req,res,input,{tickerScope:ticker});
        }
        return json(res,{error:'Unknown service path'},404);
      }
      if(!url.pathname.startsWith('/api/'))return await serveStatic(req,res,decodeURIComponent(url.pathname));
      if(production&&!edgeVerified)return json(res,{error:'Open the application at predictir.dev'},403);
      if(edgeVerified&&!isCountryAllowed(String(req.headers['x-market-country']||'')))return json(res,{error:'This service is unavailable in your region'},403);
      if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
      if(!['GET','POST'].includes(req.method))return json(res,{error:'Method not allowed'},405);
      if(url.pathname==='/api/stream'){if(req.method!=='GET')return json(res,{error:'Method not allowed'},405);return await sse(req,res,url.searchParams.get('ticker'),identity);}
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
      await quota(url.pathname.includes('forward/start')?30:url.pathname.includes('intelligence')||url.pathname.includes('/research')||url.pathname.includes('/opinions')?5:1);
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
    if(!storageEnabled())return;
    try{const stop=await storage().get('config#cost');disabled=Boolean(stop?.disabled)||used>0&&!await storage().consume('cpu-ms#'+new Date(now()).toISOString().slice(0,10),1800000,Math.min(used,1800000));}
    catch{disabled=true;}
  },30000);monitor.unref();server.on('close',()=>clearInterval(monitor));
  return server;
}
export const server=createMarketServer();
if(process.env.PORT||process.env.AWS_LAMBDA_HTTP_ENDPOINT||process.env.MARKET_LOCAL_SERVER==='1'){
  const [legacyHost,legacyPort]=(process.env.AWS_LAMBDA_HTTP_ENDPOINT||'127.0.0.1:8780').split(':');
  const port=Number(process.env.PORT||legacyPort),host=process.env.HOST||(process.env.PORT?'0.0.0.0':legacyHost);
  server.listen(port,host,()=>console.log(JSON.stringify({service:'market-lab',runtime:'node',listening:true,port})));
}
