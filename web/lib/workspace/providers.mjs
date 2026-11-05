import {createHash} from 'node:crypto';
import {readJSON} from '../transport.mjs';
import {cloudEnabled,store} from '../cloud/store.mjs';
import {observeProviderAttempt} from '../runtime/telemetry.mjs';

const cache=new Map(),inflight=new Map(),status=new Map(),cooldowns=new Map(),failureStreak=new Map();
const hosts=new Set(['site.api.espn.com','rss.marketingtools.apple.com','api.x.com','api.spotify.com','accounts.spotify.com','oauth.reddit.com','www.reddit.com','kworb.net']);
const providerUsage=new Map();
const causeCodes=new Set(['UPSTREAM_TIMEOUT','UPSTREAM_BODY_TIMEOUT','UPSTREAM_NETWORK_ERROR','UPSTREAM_BODY_ERROR','UPSTREAM_INVALID_JSON','UPSTREAM_HTML_RESPONSE','UPSTREAM_SCHEMA_ERROR','UPSTREAM_RESPONSE_TOO_LARGE','PROVIDER_COOLDOWN','PROVIDER_BUDGET_REACHED','SHARED_CACHE_UNAVAILABLE','CACHE_LEASE_BUSY','CACHE_LEASE_LOST']);
export function sourceFailureDetails(error){
  const raw=typeof error?.code==='string'?error.code:'',code=causeCodes.has(raw)||/^UPSTREAM_HTTP_[45]\d{2}$/.test(raw)?raw:'SOURCE_UNAVAILABLE';
  const upstream=Number(error?.upstream_status);
  return {error_code:code,...(Number.isInteger(upstream)&&upstream>=100&&upstream<=599?{upstream_status:upstream}:{})};
}
function upstreamFailure(error,phase,response){
  if(error?.code==='CACHE_LEASE_BUSY'||error?.code==='CACHE_LEASE_LOST')return error;
  const timeout=error?.name==='TimeoutError'||error?.name==='AbortError',http=response?.status;
  const mapped={INVALID_JSON:'UPSTREAM_INVALID_JSON',HTML_INSTEAD_OF_JSON:'UPSTREAM_HTML_RESPONSE',INVALID_SCHEMA:'UPSTREAM_SCHEMA_ERROR',RESPONSE_TOO_LARGE:'UPSTREAM_RESPONSE_TOO_LARGE'};
  const code=timeout?(phase==='body'?'UPSTREAM_BODY_TIMEOUT':'UPSTREAM_TIMEOUT'):response&&!response.ok?'UPSTREAM_HTTP_'+http:mapped[error?.code]||
    (error?.code==='UPSTREAM_RESPONSE_TOO_LARGE'?error.code:phase==='body'?'UPSTREAM_BODY_ERROR':'UPSTREAM_NETWORK_ERROR');
  return Object.assign(new Error('Public source retrieval failed'),{status:response&&!response.ok?http:timeout?503:Number(error?.status)>=400&&Number(error.status)<=599?Number(error.status):503,
    code,...(Number.isInteger(http)?{upstream_status:http}:{})});
}
export function retryDelay(headers,status,now=Date.now()){
  const raw=headers.get('retry-after'),numeric=raw===null?NaN:Number(raw),date=Date.parse(raw||''),reset=Number(headers.get('x-rate-limit-reset'))*1000;
  const candidates=[Number.isFinite(numeric)?numeric*1000:0,Number.isFinite(date)?date-now:0,reset>now?reset-now:0];
  return Math.max(status===429?60000:status===402?3600000:15000,...candidates);
}
export function recordProviderStatus(id,value){status.set(id,{id,name:id,...value});}
export function providerStatus(){
  const defaults=[{id:'Kalshi public exchange',detail:'Public rules, catalog, observed prices and order books.'},
    {id:'ESPN NBA',detail:'Completed regular-season schedules, matched fixtures and reported availability.'},
    {id:'ESPN Premier League',detail:'Premier League results and exact-date fixtures; no cup or extra-time model.'},
    {id:'Apple Music US chart',detail:'US song-rank snapshots; not artist stream totals or Spotify charts.'},
    {id:'Spotify catalog references',detail:'Display-only artist references; excluded from AI and forecasting.',configured:Boolean(process.env.SPOTIFY_CLIENT_ID&&process.env.SPOTIFY_CLIENT_SECRET)},
    {id:'X public chart news',detail:'Allowlisted public posts, shared cache and conservative paid-read allowance.',configured:Boolean(process.env.X_BEARER_TOKEN)},
    {id:'Reddit selected-trade context',detail:'Explicit selected-trade opt-in. Bounded public pages respect robots and access limits; approved external OAuth is optional.'}];
  const rows=new Map(defaults.map(row=>[row.id,{...row,name:row.id,status:row.configured===false?'not_configured':'not_queried'}]));
  for(const [key,value] of status)rows.set(key,value);
  return [...rows.values()].map(row=>({...row,usage:providerUsage.get(row.id)||null}));
}
export async function sourceJSON(id,url,{ttl=900,headers={},maximumBytes=8_000_000,fetcher=fetch,format='json'}={}) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||!hosts.has(parsed.hostname)||parsed.username||parsed.password)throw new RangeError('Source address is not permitted');
  if(!['json','text'].includes(format))throw new RangeError('Unsupported source format');
  const key=id+'#'+format+'#'+url,hit=cache.get(key);
  if(hit&&hit.until>Date.now())return hit.value;
  if((cooldowns.get(parsed.hostname)||0)>Date.now())throw Object.assign(new Error(id+' is cooling down after an upstream error'),{status:503,code:'PROVIDER_COOLDOWN',retry_at:new Date(cooldowns.get(parsed.hostname)).toISOString()});
  if(inflight.has(key))return inflight.get(key);
  const produce=async()=>{
    const day=new Date().toISOString().slice(0,10),usage=providerUsage.get(id),count=usage?.day===day?usage.requests:0;
    const configured=Number(process.env.PROVIDER_DAILY_REQUEST_LIMIT||1000),limit=Number.isInteger(configured)&&configured>=1?Math.min(12000,configured):1000;
    if(count>=limit)throw Object.assign(new Error('Provider daily allowance reached'),{status:429,code:'PROVIDER_BUDGET_REACHED'});
    providerUsage.set(id,{day,requests:count+1,limit});
    const provider=parsed.hostname.includes('espn.com')?'espn':parsed.hostname.includes('apple.com')?'apple_music':parsed.hostname==='api.x.com'?'x':parsed.hostname.includes('spotify.com')?'spotify':parsed.hostname.includes('reddit.com')?'reddit':'kworb';
    return observeProviderAttempt(provider,async()=>{
    let response;
    try{response=await fetcher(url,{headers:{Accept:'application/json','User-Agent':'KalshiMarketLab/4.0 public-research',...headers},redirect:'error',signal:AbortSignal.timeout(16000)});}
    catch(error){throw upstreamFailure(error,'request');}
    if(response.status===429||response.status===402||response.status>=500){
      cooldowns.set(parsed.hostname,Date.now()+retryDelay(response.headers,response.status));
    }
    else if(response.status===401||response.status===403)cooldowns.set(parsed.hostname,Date.now()+300000);
    else if(response.headers.get('x-rate-limit-remaining')==='0')cooldowns.set(parsed.hostname,Date.now()+retryDelay(response.headers,429));
    let data,raw;
    try{
    if(format==='json')({data,raw}=await readJSON(response,{source:id,maximumBytes}));
    else{
      if(!response.ok)throw Object.assign(new Error('Public source unavailable'),{status:response.status});
      if(Number(response.headers.get('content-length'))>maximumBytes)throw Object.assign(new Error('Public source exceeds size limit'),{code:'UPSTREAM_RESPONSE_TOO_LARGE'});
      const reader=response.body?.getReader(),chunks=[];let length=0;
      if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maximumBytes){await reader.cancel();throw Object.assign(new Error('Public source exceeds size limit'),{code:'UPSTREAM_RESPONSE_TOO_LARGE'});}chunks.push(value);}}finally{reader.releaseLock();}
      raw=Buffer.concat(chunks).toString('utf8');data={text:raw};
    }
    }catch(error){throw upstreamFailure(error,'body',response);}
    return {data,source_url:url,as_of:new Date().toISOString(),sha256:createHash('sha256').update(raw).digest('hex')};
    });
  };
  const task=(async()=>{
    try {
      const value=cloudEnabled()&&fetcher===fetch?await store().cached('provider#'+key,ttl,produce):await produce();
      failureStreak.delete(parsed.hostname);
      if(cache.size>200)cache.delete(cache.keys().next().value);
      cache.set(key,{until:Date.now()+ttl*1000,value});
      status.set(id,{id,name:id,status:'available',as_of:value.as_of,url:value.source_url,detail:'Retrieval time; the observation date is shown in each dataset.'});
      return value;
    }catch(error){
      if(error.code==='CACHE_LEASE_LOST'||error.code==='CACHE_LEASE_BUSY'){const detail='The shared source refresh is busy or lost its lease; retry shortly.';status.set(id,{id,name:id,status:'refreshing',detail});throw Object.assign(new Error(detail),{status:429,code:error.code});}
      const numeric=Number(error.status),httpStatus=Number.isInteger(numeric)&&numeric>=400&&numeric<=599?numeric:503,diagnostic=sourceFailureDetails(error),upstreamStatus=diagnostic.upstream_status;
      if(httpStatus>=500){const failures=Math.min(5,(failureStreak.get(parsed.hostname)||0)+1);failureStreak.set(parsed.hostname,failures);cooldowns.set(parsed.hostname,Math.max(cooldowns.get(parsed.hostname)||0,Date.now()+Math.min(300000,15000*2**(failures-1))));}
      const retryAt=(cooldowns.get(parsed.hostname)||0)>Date.now()?new Date(cooldowns.get(parsed.hostname)).toISOString():null;
      const detail=upstreamStatus>=400?id+' could not be retrieved (HTTP '+upstreamStatus+').':id+' could not be retrieved. Its source or shared cache is temporarily unavailable.';
      status.set(id,{id,name:id,status:'unavailable',detail,...diagnostic,retry_at:retryAt});throw Object.assign(new Error(detail),{status:httpStatus,code:diagnostic.error_code,...(upstreamStatus?{upstream_status:upstreamStatus}:{}),retry_at:retryAt});}
  })();
  inflight.set(key,task);try{return await task;}finally{inflight.delete(key);}
}
export const sourceText=(id,url,options={})=>sourceJSON(id,url,{...options,format:'text'});
export async function boundedMap(values,maximum,fn) {
  if(!Array.isArray(values)||!Number.isInteger(maximum)||maximum<1||maximum>32)throw new RangeError('A bounded concurrency from 1 through 32 is required');
  const result=new Array(values.length);let next=0;
  await Promise.all(Array.from({length:Math.min(maximum,values.length)},async()=>{while(next<values.length){const i=next++;result[i]=await fn(values[i],i);}}));
  return result;
}
