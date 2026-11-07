import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

export const SHARE_COOKIE='__Host-predictir-share';
export const SHARE_COOKIE_SECONDS=86400;
export const PRIVATE_HEADERS=Object.freeze({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow, noarchive, nosnippet, noimageindex','X-Content-Type-Options':'nosniff'});
const limits=globalThis[Symbol.for('predictir.share.limits.v1')] ||= new Map();
export const shareAccessEnabled=(env=process.env)=>env.PREDICTIR_SHARE_ACCESS==='1';
function settings(env){
  const hash=env.PREDICTIR_SHARE_TOKEN_HASH,key=env.MARKET_EDGE_SECRET;
  return typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)&&typeof key==='string'&&key.length>=32?{hash,key}:null;
}
function sameBytes(left,right){return left.length===right.length&&timingSafeEqual(left,right);}
function signature(value,key){return createHmac('sha256',key).update('predictir.share.cookie.v1\0'+value).digest('base64url');}
export function shareCookieValue(header){
  if(typeof header!=='string'||header.length>16000)return null;
  const values=header.split(';').map(part=>part.trim()).filter(part=>part.startsWith(SHARE_COOKIE+'='));
  return values.length===1?values[0].slice(SHARE_COOKIE.length+1):null;
}
export function shareCookieAuthorized(header,env=process.env,now=Date.now()){
  if(!shareAccessEnabled(env))return true;
  const config=settings(env),value=shareCookieValue(header);
  if(!config||!value||value.length>400||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))return false;
  const [encoded,mac]=value.split('.');
  if(!sameBytes(Buffer.from(mac),Buffer.from(signature(encoded,config.key))))return false;
  try{
    const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    return Object.keys(payload).length===3&&payload.v===1&&typeof payload.h==='string'&&
      sameBytes(Buffer.from(payload.h),Buffer.from(config.hash))&&Number.isSafeInteger(payload.exp)&&payload.exp>Math.floor(now/1000)&&payload.exp<=Math.floor(now/1000)+SHARE_COOKIE_SECONDS;
  }catch{return false;}
}
export function shareCookieForward(header){
  const value=shareCookieValue(header);return value?SHARE_COOKIE+'='+value:null;
}
export function privateAccessResponse(request,env=process.env,now=Date.now()){
  if(shareCookieAuthorized(request.headers.get('cookie'),env,now))return null;
  return Response.json({error:'A private Predictir link is required.'},{status:401,headers:PRIVATE_HEADERS});
}
export function publicAccessPath(pathname){
  return ['/access','/api/access/redeem','/api/access/logout','/healthz','/favicon.ico','/favicon.svg','/robots.txt','/hibp-verification.txt','/google7653305cfae6f81b.html'].includes(pathname)||pathname.startsWith('/_next/static/');
}
function originAllowed(request,env){
  const origin=request.headers.get('origin');if(!origin)return false;
  try{
    const parsed=new URL(origin),own=new URL(request.url);
    if(parsed.origin!==origin||!['https:','http:'].includes(parsed.protocol))return false;
    return origin===(env.APP_ORIGIN||own.origin);
  }catch{return false;}
}
function allowance(request,env,now){
  const slot=Math.floor(now/60000),ip=request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
  const fingerprint=createHmac('sha256',settings(env)?.key||'unconfigured').update('share-limit\0'+ip).digest('hex');
  for(const [key,value]of limits)if(value.slot!==slot)limits.delete(key);
  if(limits.size>4096&&!limits.has(fingerprint))return false;
  for(const [key,maximum]of [['global',300],[fingerprint,10]]){
    const value=limits.get(key)||{slot,used:0};value.used++;limits.set(key,value);
    if(value.used>maximum)return false;
  }
  return true;
}
async function accessBody(request){
  if(!String(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))throw Object.assign(new Error(),{status:415});
  if(Number(request.headers.get('content-length')||0)>256)throw Object.assign(new Error(),{status:413});
  const reader=request.body?.getReader(),parts=[];let size=0;
  if(reader)try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>256){await reader.cancel();throw Object.assign(new Error(),{status:413});}parts.push(value);}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function redeemShareAccess(request,{env=process.env,now=Date.now()}={}){
  if(request.method!=='POST')return Response.json({error:'Use POST.'},{status:405,headers:PRIVATE_HEADERS});
  if(!shareAccessEnabled(env)||!settings(env))return Response.json({error:'Private access is not configured.'},{status:503,headers:PRIVATE_HEADERS});
  if(!originAllowed(request,env)||new URL(request.url).search)return Response.json({error:'Open the private link directly.'},{status:403,headers:PRIVATE_HEADERS});
  if(!allowance(request,env,now))return Response.json({error:'Too many attempts. Try again in one minute.'},{status:429,headers:{...PRIVATE_HEADERS,'Retry-After':'60'}});
  try{
    const value=await accessBody(request);
    if(!value||Object.keys(value).length!==1||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(value.token))return Response.json({error:'This private link is invalid or expired.'},{status:401,headers:PRIVATE_HEADERS});
    const config=settings(env),hash=createHash('sha256').update(value.token).digest('hex');
    if(!sameBytes(Buffer.from(hash),Buffer.from(config.hash)))return Response.json({error:'This private link is invalid or expired.'},{status:401,headers:PRIVATE_HEADERS});
    const encoded=Buffer.from(JSON.stringify({v:1,h:config.hash,exp:Math.floor(now/1000)+SHARE_COOKIE_SECONDS})).toString('base64url');
    const cookie=SHARE_COOKIE+'='+encoded+'.'+signature(encoded,config.key)+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='+SHARE_COOKIE_SECONDS;
    return new Response(null,{status:204,headers:{...PRIVATE_HEADERS,'Set-Cookie':cookie}});
  }catch(error){return Response.json({error:'The private link could not be opened.'},{status:[413,415].includes(error.status)?error.status:400,headers:PRIVATE_HEADERS});}
}
export async function logoutShareAccess(request,{env=process.env}={}){
  if(request.method!=='POST')return Response.json({error:'Use POST.'},{status:405,headers:PRIVATE_HEADERS});
  if(!originAllowed(request,env))return Response.json({error:'Open this action from Predictir.'},{status:403,headers:PRIVATE_HEADERS});
  return new Response(null,{status:204,headers:{...PRIVATE_HEADERS,'Set-Cookie':SHARE_COOKIE+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'}});
}
