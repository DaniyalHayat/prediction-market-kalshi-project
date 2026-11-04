import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GET,POST} from '../app/api/[...path]/route.js';
import {sizePaperPosition} from '../lib/paper/risk.ts';
import {marketFeed} from '../lib/cloud/feed.mjs';
import {cloudEnabled,store} from '../lib/cloud/store.mjs';
import {freezeForecast,listForecasts,ownerKey} from '../lib/cloud/journal.mjs';
import {resolveContracts,marketFees} from '../lib/cloud/resolve.mjs';

const limits=new Map(),publicRoot=resolve(process.env.MARKET_PUBLIC_DIR || fileURLToPath(new URL('../public',import.meta.url)));
let connections=0,disabled=false,previousCpu=process.cpuUsage();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
function headers(res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security','max-age=31536000');
  res.setHeader('Content-Security-Policy',"default-src 'self' https: data: blob:; script-src 'self' 'unsafe-inline' https: blob:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' https: wss:; frame-ancestors 'self' https://*.figma.com https://*.figma.site https://daniyalhayat.github.io");
}
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function allowed(req) {
  const now=Date.now(),ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',').at(-1).trim();
  let counter=limits.get(ip);if(!counter||now-counter.at>=60000){counter={at:now,used:0};limits.set(ip,counter);}
  if(limits.size>1000)for(const [key,value] of limits)if(now-value.at>=60000)limits.delete(key);
  return ++counter.used<=60;
}
async function body(req) {
  let bytes=0;const chunks=[];
  for await(const chunk of req){bytes+=chunk.length;if(bytes>16000){const e=new RangeError('Request exceeds 16 KB');e.status=413;throw e;}chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
async function quota(weight=1) {
  if(disabled)throw Object.assign(new Error('Usage allowance reached; retry later'),{status:429});
  if(cloudEnabled() && !await store().consume('work#'+new Date().toISOString().slice(0,10),6000,weight))throw Object.assign(new Error('Daily work allowance reached'),{status:429});
}
async function sse(req,res,ticker) {
  if(connections>=8)throw Object.assign(new Error('Streaming capacity is currently full'),{status:429});
  await quota(3);
  if(cloudEnabled()&&!await store().consume('stream-minutes#'+new Date().toISOString().slice(0,7),1200,1,45*86400))throw Object.assign(new Error('Monthly streaming allowance reached'),{status:429});
  connections++;
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
  const send=message=>{if(!res.destroyed)res.write('data: '+JSON.stringify(message)+'\n\n');};
  let remove,latest,ticks=0,closed=false;
  const cleanup=()=>{if(closed)return;closed=true;clearInterval(timer);clearTimeout(timeout);remove?.();connections--;};
  const timer=setInterval(async()=>{
    if(latest){send(latest);latest=null;}
    ticks++;
    if(ticks%40===0)send({kind:'heartbeat',status:marketFeed.status,server_time:new Date().toISOString(),transport:'exchange-websocket'});
    if(ticks%240===0&&cloudEnabled()){
      try{if(!await store().consume('stream-minutes#'+new Date().toISOString().slice(0,7),1200,1,45*86400))res.end();}
      catch{res.end();}
    }
    if(disabled)res.end();
  },250);
  const timeout=setTimeout(()=>res.end(),840000);
  res.on('close',cleanup);
  try {remove=await marketFeed.add(ticker,message=>{if(message.kind==='quote')latest=message;else send(message);});
    if(closed)remove();}
  catch(error){send({kind:'connection',status:'unavailable',reason:error.message});res.end();}
}
async function serveStatic(req,res,path) {
  if(req.method!=='GET'&&req.method!=='HEAD')return json(res,{error:'Method not allowed'},405);
  if(path==='/'){res.writeHead(302,{Location:'/dashboard/index.html','Cache-Control':'no-store'});return res.end();}
  const candidate=path==='/'?'/lab.html':path;
  const file=resolve(publicRoot,'.'+candidate);
  if(!file.startsWith(publicRoot+'/')&&!file.startsWith(publicRoot+'\\'))return json(res,{error:'Unknown file'},404);
  try {
    const info=await stat(file);if(!info.isFile()||info.size>5e6)return json(res,{error:'Unknown file'},404);
    res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':candidate.endsWith('.html')?'no-cache':'public, max-age=3600'});
    if(req.method==='HEAD')return res.end();createReadStream(file).pipe(res);
  } catch(error){if(error.code==='ENOENT')return json(res,{error:'Unknown file'},404);throw error;}
}
export const server=createServer(async(req,res)=>{
  headers(res);
  try {
    const url=new URL(req.url,'http://localhost');
    if(req.url.length>2000)return json(res,{error:'URL too long'},414);
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    if(!url.pathname.startsWith('/api/'))return await serveStatic(req,res,decodeURIComponent(url.pathname));
    if(!allowed(req)){res.setHeader('Retry-After','60');return json(res,{error:'Rate limit reached. Retry in one minute.'},429);}
    if(url.pathname==='/api/health')return json(res,{status:disabled?'limited':'ok',runtime:'AWS Lambda Web Functions',
      market_data_only:true,stream:marketFeed.status,cloud_storage:cloudEnabled(),max_live_contracts_per_environment:12,
      monthly_stream_minutes:1200,observed_at:new Date().toISOString()});
    if(url.pathname==='/api/stream')return await sse(req,res,url.searchParams.get('ticker'));
    if(url.pathname==='/api/resolve'){await quota(2);return json(res,await resolveContracts(url.searchParams.get('q')));}
    if(url.pathname==='/api/fees'){await quota(2);return json(res,await marketFees(url.searchParams.get('ticker')));}
    const raw=['POST','PUT'].includes(req.method)?await body(req):'';
    if(url.pathname==='/api/journal') {
      if(!cloudEnabled())return json(res,{error:'The durable journal requires the documented AWS deployment'},503);
      const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      if(!token)return json(res,{error:'A private journal token is required'},401);ownerKey(token);
      await quota(req.method==='POST'?15:1);
      if(req.method==='POST')return json(res,await freezeForecast(JSON.parse(raw),token),201);
      if(req.method==='GET')return json(res,await listForecasts(token));
      return json(res,{error:'Method not allowed'},405);
    }
    if(url.pathname==='/api/paper/size') {
      if(req.method!=='POST')return json(res,{error:'Method not allowed'},405);
      await quota();return json(res,sizePaperPosition(JSON.parse(raw)));
    }
    await quota(url.pathname.includes('forward/start')?30:url.pathname.includes('intelligence')?5:1);
    const request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,...(raw?{body:raw}:{})});
    const context={params:Promise.resolve({path:url.pathname.slice(5).split('/')})};
    const output=req.method==='GET'?await GET(request,context):req.method==='POST'?await POST(request,context):null;
    if(!output)return json(res,{error:'Method not allowed'},405);
    res.writeHead(output.status,Object.fromEntries(output.headers));
    const buffer=Buffer.from(await output.arrayBuffer());res.end(buffer);
  } catch(error) {
    if(res.headersSent)return res.end();
    const status=error.name==='ConditionalCheckFailedException'?409:error.status||(error instanceof SyntaxError||error instanceof RangeError?400:503);
    const message=error.name==='ConditionalCheckFailedException'?'A forecast for this contract is already registered in this journal':
      error.$metadata?'Cloud storage is temporarily unavailable':error.message;
    json(res,{error:message},status);
  }
});
if(process.env.AWS_LAMBDA_HTTP_ENDPOINT || process.env.MARKET_LOCAL_SERVER==='1') {
  const [host,port]=(process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:8780').split(':');
  server.listen(Number(port),host,()=>console.log(JSON.stringify({service:'market-lab',listening:true})));
  const monitor=setInterval(async()=>{
    const current=process.cpuUsage(),used=Math.ceil((current.user-previousCpu.user+current.system-previousCpu.system)/1000);previousCpu=current;
    if(!cloudEnabled())return;
    try {
      const stop=await store().get('config#cost');
      disabled=Boolean(stop?.disabled) || used>0&&!await store().consume('cpu-ms#'+new Date().toISOString().slice(0,10),1800000,Math.min(used,1800000));
    }catch{disabled=true;}
  },30000);monitor.unref();
}
