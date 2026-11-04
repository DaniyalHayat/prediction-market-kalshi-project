import {createHash} from 'node:crypto';
import {readJSON} from '../transport.mjs';
import {cloudEnabled,store} from '../cloud/store.mjs';

const cache=new Map(),inflight=new Map(),status=new Map(),cooldowns=new Map();
const hosts=new Set(['site.api.espn.com','rss.applemarketingtools.com','rss.marketingtools.apple.com','api.x.com','api.spotify.com','accounts.spotify.com']);
export function recordProviderStatus(id,value){status.set(id,{id,name:id,...value});}
export function providerStatus(){
  const defaults=[{id:'Kalshi public exchange',detail:'Public rules, catalog, observed prices and order books.'},
    {id:'ESPN NBA',detail:'Completed regular-season schedules, matched fixtures and reported availability.'},
    {id:'ESPN Premier League',detail:'Premier League results and exact-date fixtures; no cup or extra-time model.'},
    {id:'Apple Music US chart',detail:'US song-rank snapshots; not artist stream totals or Spotify charts.'},
    {id:'Spotify catalog references',detail:'Display-only artist references; excluded from AI and forecasting.',configured:Boolean(process.env.SPOTIFY_CLIENT_ID&&process.env.SPOTIFY_CLIENT_SECRET)},
    {id:'X public chart news',detail:'Allowlisted public posts, shared cache and conservative paid-read allowance.',configured:Boolean(process.env.X_BEARER_TOKEN)}];
  const rows=new Map(defaults.map(row=>[row.id,{...row,name:row.id,status:row.configured===false?'not_configured':'not_queried'}]));
  for(const [key,value] of status)rows.set(key,value);
  return [...rows.values()];
}
export async function sourceJSON(id,url,{ttl=900,headers={},maximumBytes=8_000_000,fetcher=fetch}={}) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||!hosts.has(parsed.hostname)||parsed.username||parsed.password)throw new RangeError('Source address is not permitted');
  const key=id+'#'+url,hit=cache.get(key);
  if(hit&&hit.until>Date.now())return hit.value;
  if((cooldowns.get(parsed.hostname)||0)>Date.now())throw Object.assign(new Error(id+' is cooling down after an upstream error'),{status:503});
  if(inflight.has(key))return inflight.get(key);
  const produce=async()=>{
    const response=await fetcher(url,{headers:{Accept:'application/json','User-Agent':'KalshiMarketLab/4.0 public-research',...headers},redirect:'error',signal:AbortSignal.timeout(16000)});
    if(response.status===429||response.status===402||response.status>=500){
      const retry=Number(response.headers.get('retry-after')),seconds=response.status===429?Math.max(60,Math.min(900,Number.isFinite(retry)?retry:300)):response.status===402?60:15;
      cooldowns.set(parsed.hostname,Date.now()+seconds*1000);
    }
    const {data,raw}=await readJSON(response,{source:id,maximumBytes});
    return {data,source_url:url,as_of:new Date().toISOString(),sha256:createHash('sha256').update(raw).digest('hex')};
  };
  const task=(async()=>{
    try {
      const value=cloudEnabled()&&fetcher===fetch?await store().cached('provider#'+key,ttl,produce):await produce();
      if(cache.size>200)cache.delete(cache.keys().next().value);
      cache.set(key,{until:Date.now()+ttl*1000,value});
      status.set(id,{id,name:id,status:'available',as_of:value.as_of,url:value.source_url,detail:'Retrieval time; the observation date is shown in each dataset.'});
      return value;
    }catch(error){status.set(id,{id,name:id,status:'unavailable',detail:String(error.message).slice(0,180)});throw error;}
  })();
  inflight.set(key,task);try{return await task;}finally{inflight.delete(key);}
}
export async function boundedMap(values,maximum,fn) {
  if(!Array.isArray(values)||!Number.isInteger(maximum)||maximum<1||maximum>32)throw new RangeError('A bounded concurrency from 1 through 32 is required');
  const result=new Array(values.length);let next=0;
  await Promise.all(Array.from({length:Math.min(maximum,values.length)},async()=>{while(next<values.length){const i=next++;result[i]=await fn(values[i],i);}}));
  return result;
}
