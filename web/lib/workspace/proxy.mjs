import {isCountryAllowed} from './geo.mjs';
import {traceContext,structuredLog} from '../runtime-observability.mjs';
const known=/^\/(?:session|account\/(?:login|logout|profile|portfolio)|health|book|market|markets|trades|history|brief|fees|resolve|stream|portfolio\/stream|journal|paper\/size|export\.xlsx|workspace\/(?:catalog|markets|portfolio-books|context|history|research|execution-research|position-review|opinions|recommendations|search|sources|attribution|evidence(?:\/search)?)|intelligence(?:\/(?:catalog|series|candles|execution|forward(?:\/(?:start|checkpoint))?))?)$/;
export const STREAM_CONNECT_TIMEOUT_MS=5000,STREAM_LIFETIME_MS=750000;
export function applicationOriginMatches(origin,url,{development=process.env.NODE_ENV==='development'}={}){
  try{const supplied=new URL(origin),own=new URL(url);
    if(supplied.username||supplied.password)return false;
    if(supplied.origin===own.origin)return true;
    const loopback=host=>['localhost','127.0.0.1','[::1]'].includes(host);
    return development&&loopback(supplied.hostname)&&loopback(own.hostname)&&supplied.protocol===own.protocol&&supplied.port===own.port;
  }catch{return false;}
}
export async function readProxyBody(request,maximum=20000){
  if(Number(request.headers.get('content-length')||0)>maximum)throw Object.assign(new RangeError('Request too large'),{status:413});
  const reader=request.body?.getReader(),chunks=[];let size=0;
  if(reader){try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw Object.assign(new RangeError('Request too large'),{status:413});}chunks.push(value);}}finally{reader.releaseLock();}}
  return Buffer.concat(chunks).toString('utf8');
}
function relayEventStream(body,{requestSignal,abortUpstream,lifetimeMs,onUnexpectedError}){
  const reader=body?.getReader();let controller,closed=false,timer,cleanup;
  const finish=(closeOutput=true)=>{
    if(closed)return cleanup;closed=true;clearTimeout(timer);requestSignal.removeEventListener('abort',aborted);
    if(closeOutput)controller.close();
    abortUpstream();cleanup=Promise.resolve(reader?.cancel()).catch(()=>{}).finally(()=>reader?.releaseLock());return cleanup;
  };
  const aborted=()=>{void finish();};
  return new ReadableStream({
    start(value){controller=value;timer=setTimeout(()=>{void finish();},lifetimeMs);requestSignal.addEventListener('abort',aborted,{once:true});if(requestSignal.aborted||!reader)void finish();},
    async pull(){
      if(closed)return;
      try{const next=await reader.read();if(closed)return;if(next.done)await finish();else controller.enqueue(next.value);}
      catch{if(!closed){try{onUnexpectedError();}catch{}await finish();}}
    },
    cancel(){return finish(false);}
  },{highWaterMark:1});
}
export async function proxyBackend(request,path,{fetcher=fetch,streamConnectTimeoutMs=STREAM_CONNECT_TIMEOUT_MS,streamLifetimeMs=STREAM_LIFETIME_MS,
  onStreamError=values=>structuredLog('proxy.stream_error',values)}={}){
  if(!process.env.MARKET_BACKEND_URL)return null;
  if(!Array.isArray(path)||path.length>5||path.some(part=>typeof part!=='string'))return Response.json({error:'Unknown API route'},{status:404});
  const route='/'+path.join('/');
  const positionReview=route==='/workspace/position-review';
  const privateRoute=route==='/session'||route.startsWith('/account/');
  if(!known.test(route)||!['GET','POST','OPTIONS',...(route==='/account/portfolio'?['PUT']:[])].includes(request.method))return Response.json({error:'Unknown API route'},{status:404});
  if(privateRoute&&request.headers.get('sec-fetch-site')==='cross-site')return Response.json({error:'Open this action from the application.'},{status:403});
  const origin=request.headers.get('origin'),own=new URL(request.url).origin;
  if(origin&&!applicationOriginMatches(origin,own))return Response.json({error:'Use the application origin'},{status:403});
  if(positionReview&&(request.headers.get('sec-fetch-site')==='cross-site'||!origin&&request.headers.get('sec-fetch-site')!=='same-origin'))
    return Response.json({error:'Open this review from the application.'},{status:403});
  if(privateRoute&&['POST','PUT'].includes(request.method)&&!origin)return Response.json({error:'Use the application origin'},{status:403});
  const country=request.headers.get('x-vercel-ip-country');
  if(process.env.VERCEL==='1'&&!isCountryAllowed(country))return Response.json({error:'This service is unavailable in your region'},{status:403});
  let url;try{
    const address=new URL(process.env.MARKET_BACKEND_URL);
    if(address.username||address.password||address.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(address.hostname))throw new Error('Invalid backend address');
    url=new URL('/api'+route+new URL(request.url).search,address);
  }catch{return Response.json({error:'Backend configuration unavailable'},{status:503});}
  const streaming=route==='/stream'||route==='/portfolio/stream',trace=traceContext(request.headers);
  const headers={'x-market-edge-secret':process.env.MARKET_EDGE_SECRET||'','x-market-country':country||'US',
    'x-market-client-ip':request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()||'local',Accept:streaming?'text/event-stream':'application/json',
    traceparent:trace.traceparent,tracestate:trace.tracestate};
  if(route==='/journal'&&request.headers.get('authorization'))headers.Authorization=request.headers.get('authorization');
  if(privateRoute&&request.headers.get('cookie'))headers.Cookie=request.headers.get('cookie');
  if(privateRoute&&origin)headers.Origin=origin;
  if(privateRoute&&request.headers.get('sec-fetch-site'))headers['Sec-Fetch-Site']=request.headers.get('sec-fetch-site');
  let upstream,connectTimer;
  try{
    let body;if(['POST','PUT'].includes(request.method)){body=await readProxyBody(request,route==='/account/portfolio'?1500000:positionReview?4000:20000);headers['Content-Type']='application/json';}
    if(streaming){
      if(!Number.isInteger(streamConnectTimeoutMs)||streamConnectTimeoutMs<1||streamConnectTimeoutMs>STREAM_CONNECT_TIMEOUT_MS||!Number.isInteger(streamLifetimeMs)||streamLifetimeMs<1||streamLifetimeMs>STREAM_LIFETIME_MS)throw new RangeError('Invalid stream deadline');
      upstream=new AbortController();connectTimer=setTimeout(()=>upstream.abort(),streamConnectTimeoutMs);
    }
    const result=await fetcher(url,{method:request.method,headers,body,redirect:'error',cache:'no-store',signal:AbortSignal.any([request.signal,streaming?upstream.signal:AbortSignal.timeout(positionReview?7600:50000)])});
    clearTimeout(connectTimer);
    const type=result.headers.get('content-type')||'';
    if(/text\/html/i.test(type)){upstream?.abort();return Response.json({error:'The data service returned a web page instead of data. Try again shortly.'},{status:502});}
    const outputHeaders={'Cache-Control':'no-store','Content-Type':result.headers.get('content-type')||'application/json','X-Content-Type-Options':'nosniff',traceparent:trace.traceparent};
    if(result.headers.has('retry-after'))outputHeaders['Retry-After']=result.headers.get('retry-after');
    if(positionReview&&result.headers.has('server-timing'))outputHeaders['Server-Timing']=result.headers.get('server-timing');
    if(streaming)outputHeaders['X-Accel-Buffering']='no';
    let outputBody=result.body;
    if(streaming){
      if(/text\/event-stream/i.test(type))outputBody=relayEventStream(result.body,{requestSignal:request.signal,abortUpstream:()=>upstream.abort(),lifetimeMs:streamLifetimeMs,
        onUnexpectedError:()=>onStreamError({route,error_code:'UPSTREAM_STREAM_INTERRUPTED',trace_id:trace.traceId})});
      else{connectTimer=setTimeout(()=>upstream.abort(),streamLifetimeMs);outputBody=result.body===null?null:await result.arrayBuffer();upstream.abort();}
    }
    const output=new Response(outputBody,{status:result.status,headers:outputHeaders});
    if(privateRoute){output.headers.set('Vary','Cookie');for(const cookie of result.headers.getSetCookie())output.headers.append('Set-Cookie',cookie);}
    return output;
  }catch(error){upstream?.abort();return Response.json({error:error.status===413?'Request too large':'The data service is temporarily unavailable. Try again shortly.'},{status:error.status===413?413:503});}
  finally{clearTimeout(connectTimer);}
}
