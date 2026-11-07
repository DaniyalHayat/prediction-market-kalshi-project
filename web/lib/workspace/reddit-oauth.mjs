import {createHash} from 'node:crypto';
import {readJSON} from '../transport.mjs';

const sessions=new WeakMap();
const tokenURL='https://www.reddit.com/api/v1/access_token';
const configured=value=>typeof value==='string'&&value.trim().length>0;

export function redditAuthConfigured(env=process.env){
  return env.REDDIT_DATA_API_APPROVED==='true'&&configured(env.REDDIT_USER_AGENT)&&
    (configured(env.REDDIT_ACCESS_TOKEN)||(configured(env.REDDIT_CLIENT_ID)&&configured(env.REDDIT_CLIENT_SECRET)));
}

function oauthFailure(status,retryAfter,now){
  const seconds=retryAfter===null?NaN:Number(retryAfter);
  const retryAt=Number.isFinite(seconds)?now+seconds*1000:Date.parse(retryAfter||'');
  return Object.assign(new Error('Reddit OAuth token exchange failed'),{status,
    ...(Number.isFinite(retryAt)&&retryAt>now&&retryAt<now+86400000?{retry_at:new Date(retryAt).toISOString()}:{})});
}

export async function redditAccessToken(env,{fetcher=fetch,now=Date.now}={}){
  if(!redditAuthConfigured(env))throw oauthFailure(401,null,now());
  const clientId=env.REDDIT_CLIENT_ID,clientSecret=env.REDDIT_CLIENT_SECRET,refresh=env.REDDIT_REFRESH_TOKEN;
  if(!configured(clientId)||!configured(clientSecret))return env.REDDIT_ACCESS_TOKEN.trim();
  const fingerprint=createHash('sha256').update(JSON.stringify([clientId,clientSecret,refresh])).digest('hex');
  let state=sessions.get(env);
  if(state?.fingerprint!==fingerprint){
    state={fingerprint};
    sessions.set(env,state);
  }
  if(state.token&&state.expiresAt>now()+30000)return state.token;
  if(state.inflight)return state.inflight;
  const body=configured(refresh)?new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh.trim()}):
    new URLSearchParams({grant_type:'client_credentials'});
  const task=(async()=>{
    const response=await fetcher(tokenURL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),body,
      headers:{Accept:'application/json',Authorization:'Basic '+Buffer.from(clientId+':'+clientSecret).toString('base64'),
        'Content-Type':'application/x-www-form-urlencoded','User-Agent':env.REDDIT_USER_AGENT}});
    if(!response.ok){
      await response.body?.cancel();
      throw oauthFailure(response.status,response.headers.get('retry-after'),now());
    }
    let data;
    try{({data}=await readJSON(response,{source:'Reddit OAuth',maximumBytes:12000}));}
    catch{throw oauthFailure(502,null,now());}
    const expires=Number(data.expires_in),scope=String(data.scope||'').split(/\s+/);
    if(data.error)throw oauthFailure(data.error==='invalid_scope'?403:401,null,now());
    if(!scope.includes('*')&&!scope.includes('read'))throw oauthFailure(403,null,now());
    if(typeof data.access_token!=='string'||!data.access_token.trim()||/\s/.test(data.access_token)||
      String(data.token_type).toLowerCase()!=='bearer'||!Number.isFinite(expires)||expires<=0)throw oauthFailure(502,null,now());
    state.token=data.access_token;
    state.expiresAt=now()+Math.min(expires,3600)*1000;
    return state.token;
  })();
  state.inflight=task;
  try{return await task;}finally{state.inflight=null;}
}
