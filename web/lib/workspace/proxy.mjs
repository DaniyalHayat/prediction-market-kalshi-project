import {isCountryAllowed} from './geo.mjs';
import {traceContext} from '../runtime-observability.mjs';
const known=/^\/(?:health|book|market|markets|trades|history|brief|fees|resolve|stream|portfolio\/stream|journal|paper\/size|export\.xlsx|workspace\/(?:catalog|markets|context|history|research|opinions|recommendations|search|sources|attribution)|intelligence(?:\/(?:catalog|series|candles|execution|forward(?:\/(?:start|checkpoint))?))?)$/;
export async function readProxyBody(request,maximum=20000){
  if(Number(request.headers.get('content-length')||0)>maximum)throw Object.assign(new RangeError('Request too large'),{status:413});
  const reader=request.body?.getReader(),chunks=[];let size=0;
  if(reader){try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw Object.assign(new RangeError('Request too large'),{status:413});}chunks.push(value);}}finally{reader.releaseLock();}}
  return Buffer.concat(chunks).toString('utf8');
}
export async function proxyBackend(request,path,{fetcher=fetch}={}){
  if(!process.env.MARKET_BACKEND_URL)return null;
  if(!Array.isArray(path)||path.length>5||path.some(part=>typeof part!=='string'))return Response.json({error:'Unknown API route'},{status:404});
  const route='/'+path.join('/');
  if(!known.test(route)||!['GET','POST','OPTIONS'].includes(request.method))return Response.json({error:'Unknown API route'},{status:404});
  const origin=request.headers.get('origin'),own=new URL(request.url).origin;
  if(origin&&origin!==own)return Response.json({error:'Use the application origin'},{status:403});
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
  try{
    let body;if(request.method==='POST'){body=await readProxyBody(request);headers['Content-Type']='application/json';}
    const result=await fetcher(url,{method:request.method,headers,body,redirect:'error',cache:'no-store',signal:AbortSignal.any([request.signal,AbortSignal.timeout(streaming?55000:50000)])});
    const type=result.headers.get('content-type')||'';
    if(/text\/html/i.test(type))return Response.json({error:'The data service returned a web page instead of data. Try again shortly.'},{status:502});
    const outputHeaders={'Cache-Control':'no-store','Content-Type':result.headers.get('content-type')||'application/json','X-Content-Type-Options':'nosniff',traceparent:trace.traceparent};
    if(result.headers.has('retry-after'))outputHeaders['Retry-After']=result.headers.get('retry-after');
    if(streaming)outputHeaders['X-Accel-Buffering']='no';
    return new Response(result.body,{status:result.status,headers:outputHeaders});
  }catch(error){return Response.json({error:error.status===413?'Request too large':'The data service is temporarily unavailable. Try again shortly.'},{status:error.status===413?413:503});}
}
