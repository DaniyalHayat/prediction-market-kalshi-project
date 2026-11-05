import {createHash} from 'node:crypto';
import {readJSON} from '../transport.mjs';
import {cloudEnabled,store} from '../cloud/store.mjs';
import {observeProviderAttempt} from '../runtime/telemetry.mjs';

const cache=new Map(),inflight=new Map(),status=new Map(),cooldowns=new Map(),failureStreak=new Map();
const hosts=new Set(['site.api.espn.com','rss.marketingtools.apple.com','api.x.com','api.spotify.com','accounts.spotify.com','oauth.reddit.com','www.reddit.com','kworb.net']);
const providerUsage=new Map();
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
  if((cooldowns.get(parsed.hostname)||0)>Date.now())throw Object.assign(new Error(id+' is cooling down after an upstream error'),{status:503,retry_at:new Date(cooldowns.get(parsed.hostname)).toISOString()});
  if(inflight.has(key))return inflight.get(key);
  const produce=async()=>{
    const day=new Date().toISOString().slice(0,10),usage=providerUsage.get(id),count=usage?.day===day?usage.requests:0;
    const configured=Number(process.env.PROVIDER_DAILY_REQUEST_LIMIT||1000),limit=Number.isInteger(configured)&&configured>=1?Math.min(12000,configured):1000;
    if(count>=limit)throw Object.assign(new Error('Provider daily allowance reached'),{status:429});
    providerUsage.set(id,{day,requests:count+1,limit});
    const provider=parsed.hostname.includes('espn.com')?'espn':parsed.hostname.includes('apple.com')?'apple_music':parsed.hostname==='api.x.com'?'x':parsed.hostname.includes('spotify.com')?'spotify':parsed.hostname.includes('reddit.com')?'reddit':'kworb';
    const response=await observeProviderAttempt(provider,()=>fetcher(url,{headers:{Accept:'application/json','User-Agent':'KalshiMarketLab/4.0 public-research',...headers},redirect:'error',signal:AbortSignal.timeout(16000)}));
    if(response.status===429||response.status===402||response.status>=500){
      cooldowns.set(parsed.hostname,Date.now()+retryDelay(response.headers,response.status));
    }
    else if(response.status===401||response.status===403)cooldowns.set(parsed.hostname,Date.now()+300000);
    else if(response.headers.get('x-rate-limit-remaining')==='0')cooldowns.set(parsed.hostname,Date.now()+retryDelay(response.headers,429));
    let data,raw;
    if(format==='json')({data,raw}=await readJSON(response,{source:id,maximumBytes}));
    else{
      if(!response.ok)throw Object.assign(new Error('Public source unavailable'),{status:response.status});
      if(Number(response.headers.get('content-length'))>maximumBytes)throw new Error('Public source exceeds size limit');
      const reader=response.body?.getReader(),chunks=[];let length=0;
      if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maximumBytes){await reader.cancel();throw new Error('Public source exceeds size limit');}chunks.push(value);}}finally{reader.releaseLock();}
      raw=Buffer.concat(chunks).toString('utf8');data={text:raw};
    }
    return {data,source_url:url,as_of:new Date().toISOString(),sha256:createHash('sha256').update(raw).digest('hex')};
  };
  const task=(async()=>{
    try {
      const value=cloudEnabled()&&fetcher===fetch?await store().cached('provider#'+key,ttl,produce):await produce();
      failureStreak.delete(parsed.hostname);
      if(cache.size>200)cache.delete(cache.keys().next().value);
      cache.set(key,{until:Date.now()+ttl*1000,value});
      status.set(id,{id,name:id,status:'available',as_of:value.as_of,url:value.source_url,detail:'Retrieval time; the observation date is shown in each dataset.'});
      return value;
    }catch(error){const code=Number(error.status),upstreamStatus=Number.isInteger(code)&&code>=400&&code<=599?code:null;
      if(!upstreamStatus||upstreamStatus>=500){const failures=Math.min(5,(failureStreak.get(parsed.hostname)||0)+1);failureStreak.set(parsed.hostname,failures);cooldowns.set(parsed.hostname,Math.max(cooldowns.get(parsed.hostname)||0,Date.now()+Math.min(300000,15000*2**(failures-1))));}
      const retryAt=(cooldowns.get(parsed.hostname)||0)>Date.now()?new Date(cooldowns.get(parsed.hostname)).toISOString():null;
      const detail=upstreamStatus?id+' could not be retrieved (HTTP '+upstreamStatus+').':id+' could not be retrieved. Its source or shared cache is temporarily unavailable.';
      status.set(id,{id,name:id,status:'unavailable',detail,retry_at:retryAt});throw Object.assign(new Error(detail,{cause:error}),{status:upstreamStatus||503,retry_at:retryAt});}
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
