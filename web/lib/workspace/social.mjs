import {sourceJSON,recordProviderStatus} from './providers.mjs';
import {cloudEnabled,store} from '../cloud/store.mjs';
import {SOURCE_CATALOG,evidenceSearchTerms,evidenceTopic,safePublicURL} from './source-ranking.mjs';
import {createHash} from 'node:crypto';
const boundedInteger=(value,fallback,maximum)=>Number.isInteger(Number(value))&&Number(value)>=1?Math.min(maximum,Number(value)):fallback;
const empty=(status,reason)=>({status,posts:[],reason});
export function xSearchScope(topic,entities,maximumAccounts=2){
  if(!Array.isArray(entities))return null;
  const terms=[...new Set(entities.filter(value=>typeof value==='string').map(value=>value.normalize('NFKC').replace(/[^\p{L}\p{N}\s'-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,64)).filter(value=>value.length>=3))].sort().slice(0,8);
  const accounts=SOURCE_CATALOG.filter(row=>row.handle&&row.topics.includes(topic)).slice(0,boundedInteger(maximumAccounts,2,2));
  if(!terms.length||!accounts.length)return null;
  const query='('+accounts.map(row=>'from:'+row.handle).join(' OR ')+') ('+terms.map(term=>'"'+term+'"').join(' OR ')+') -is:retweet -is:reply';
  return {query,terms,accounts,key:createHash('sha256').update(query).digest('hex').slice(0,32)};
}
async function selectedXSearch(scope,{durable,get,env,now,reserve}){
  try{
    const failure=await durable.get('x-public-cooldown');
    if(failure?.until>now())return {...empty('cooldown','Shared X retrieval is paused after a provider error.'),retry_at:new Date(failure.until).toISOString()};
    const result=await durable.cached('x-selected-search#'+scope.key,1800,async(context={})=>{
      if(durable.kind==='postgres'&&typeof context.publishRecord!=='function')throw Object.assign(new Error('Durable cursor fencing is unavailable'),{status:503,code:'CACHE_FENCE_UNAVAILABLE'});
      if(!await reserve(50+10*scope.accounts.length,10))throw Object.assign(new Error('Shared X search allowance reached'),{status:429,code:'X_BUDGET_REACHED'});
      const previous=await durable.get('x-search-cursor#'+scope.key),params=new URLSearchParams({query:scope.query,max_results:'10','tweet.fields':'created_at,public_metrics,author_id',expansions:'author_id','user.fields':'username',sort_order:'recency'});
      if(/^\d{1,19}$/.test(previous?.newest_id||''))params.set('since_id',previous.newest_id);
      const response=await get('X selected-trade news','https://api.x.com/2/tweets/search/recent?'+params,{ttl:1,headers:{Authorization:'Bearer '+env.X_BEARER_TOKEN},maximumBytes:150000,timeoutMs:3500});
      if(response.data.errors?.length||!Array.isArray(response.data.data)&&response.data.meta?.result_count!==0)throw Object.assign(new Error('X search coverage was not established'),{status:502});
      const authors=new Map((response.data.includes?.users||[]).filter(row=>/^\d+$/.test(row.id)).map(row=>[row.id,scope.accounts.find(account=>account.handle.toLowerCase()===String(row.username).toLowerCase())]));
      const valid=(response.data.data||[]).filter(row=>/^\d{1,19}$/.test(row.id)&&typeof row.text==='string'&&Number.isFinite(Date.parse(row.created_at))&&Date.parse(row.created_at)<=now()+300000),rows=valid.flatMap(row=>{
        const account=authors.get(row.author_id);if(!account)return [];
        return [{id:row.id,author:account.handle,title:row.text.slice(0,220),excerpt:row.text.slice(0,900),created_at:row.created_at,as_of:row.created_at,platform:'x',publisher:account.name,metrics:row.public_metrics||{},url:`https://x.com/${account.handle}/status/${row.id}`}];
      });
      if(rows.length!==valid.length)throw Object.assign(new Error('X search author identity was not established'),{status:502});
      const merged=[...new Map([...(previous?.posts||[]),...rows].map(row=>[row.id,row])).values()].filter(row=>now()-Date.parse(row.created_at)<7*86400000).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,30);
      const newest=valid.reduce((id,row)=>!id||BigInt(row.id)>BigInt(id)?row.id:id,previous?.newest_id||null),cursor={pk:'x-search-cursor#'+scope.key,sk:'value',newest_id:newest,posts:merged,expires_epoch:Math.floor(now()/1000)+7*86400};
      if(typeof context.publishRecord==='function')await context.publishRecord(cursor);else await durable.save(cursor,true);
      return {status:'available',posts:merged,as_of:response.as_of,coverage:{returned:valid.length,verified_authors:rows.length,truncated:Boolean(response.data.meta?.next_token)}};
    });
    return {...result,query:scope.query,scope:'selected_entities',note:'One recent-search page for selected entities from at most two curated authors, excluding replies and reposts. Shared for 30 minutes. Ten post reads and possible author expansions are reserved before each paid request; pagination is not followed. Source identity and relevance do not establish predictive accuracy.'};
  }catch(error){
    if(error.code==='X_BUDGET_REACHED')return empty('budget_reached','Shared X lookup, post-read or monetary allowance reached.');
    if(error.code==='CACHE_LEASE_LOST'||error.code==='CACHE_LEASE_BUSY')return empty('refreshing','The shared search refresh is busy or lost its lease. Retry shortly; no stale cursor was published.');
    if(error.code==='CACHE_FENCE_UNAVAILABLE')return empty('unavailable','The shared search cache cannot safely publish this refresh.');
    const status=Number(error.status),seconds=status===402?86400:status===429?900:status===401||status===403?3600:60,reported=Date.parse(error.retry_at),until=Math.max(now()+seconds*1000,Number.isFinite(reported)?reported:0);
    await durable.save({pk:'x-public-cooldown',sk:'value',until,expires_epoch:Math.ceil(until/1000)},true).catch(()=>{});
    return empty('unavailable',Number.isInteger(status)?'Public X search returned HTTP '+status+'.':'Public X search or its quota store is unavailable.');
  }
}

export async function publicXFeed({topic='music',entities,maximumAccounts=2,enabled=false}={},dependencies={}){
  if(!enabled)return empty('not_queried','Public X reads require explicit evidence retrieval.');
  const env=dependencies.env||process.env,configured=Boolean(env.X_BEARER_TOKEN),durable=dependencies.store||(cloudEnabled()?store():null),get=dependencies.sourceJSON||sourceJSON;
  if(!configured)return empty('not_configured','A backend X Bearer Token is required.');
  if(!durable||['get','save','cached','consume'].some(k=>typeof durable[k]!=='function'))return empty('unavailable','A durable shared quota and cursor store is required before paid X reads.');
  const now=dependencies.now||Date.now,feeds=[],accounts=SOURCE_CATALOG.filter(s=>s.handle&&s.topics.includes(topic)).slice(0,Math.min(2,Math.max(1,maximumAccounts))),month=new Date(now()).toISOString().slice(0,7),day=new Date(now()).toISOString().slice(0,10);
  const postLimit=boundedInteger(env.X_MONTHLY_POST_READ_LIMIT,1000,10000),costLimit=boundedInteger(env.X_MONTHLY_COST_CENTS,650,2500)*10;
  const reserve=async(amount,posts=0)=>{
    if(!await durable.consume('x-requests#'+day,200,1,3*86400))return false;
    if(posts&&!await durable.consume('x-posts#'+month,postLimit,posts,45*86400))return false;
    return durable.consume('x-cost-milliusd#'+month,costLimit,amount,45*86400);
  };
  if(entities!==undefined){
    const scope=xSearchScope(topic,entities,maximumAccounts),result=scope?await selectedXSearch(scope,{durable,get,env,now,reserve}):empty('not_queried','No supported curated authors and selected entities were established.');
    recordProviderStatus('X selected-trade news',{status:result.status,detail:result.note||result.reason});return result;
  }
  for(const account of accounts){
    const author=account.handle;
    try{
      const failure=await durable.get('x-public-cooldown');
      if(failure?.until>now()){feeds.push({author,...empty('cooldown','Shared X retrieval is paused after a provider error.'),retry_at:new Date(failure.until).toISOString()});continue;}
      const result=await durable.cached('x-public-feed#'+author,1800,async(context={})=>{
        if(durable.kind==='postgres'&&typeof context.publishRecord!=='function')throw Object.assign(new Error('Durable cursor fencing is unavailable'),{status:503,code:'CACHE_FENCE_UNAVAILABLE'});
        const user=await durable.cached('x-user-v2#'+author,2592000,async()=>{
          if(!await reserve(10))throw Object.assign(new Error('Shared X lookup allowance reached'),{status:429,code:'X_BUDGET_REACHED'});
          const response=await get('X public account lookup','https://api.x.com/2/users/by/username/'+author,{ttl:2592000,headers:{Authorization:'Bearer '+env.X_BEARER_TOKEN},maximumBytes:50000});
          if(!/^\d+$/.test(response.data.data?.id||'')||String(response.data.data.username).toLowerCase()!==author.toLowerCase())throw new Error('Public account identity was not established');
          return {id:response.data.data.id,username:response.data.data.username};
        });
        if(user.unavailable)throw Object.assign(new Error('A prior budget-failure identity cache is invalid'),{status:503,code:'X_IDENTITY_UNAVAILABLE'});
        if(!await reserve(25,5))throw Object.assign(new Error('Shared X post allowance reached'),{status:429,code:'X_BUDGET_REACHED'});
        const previous=await durable.get('x-cursor#'+author),params=new URLSearchParams({max_results:'5','tweet.fields':'created_at,public_metrics','exclude':'retweets,replies'});
        if(/^\d+$/.test(previous?.newest_id||''))params.set('since_id',previous.newest_id);
        const response=await get(topic==='music'?'X public chart news':'X selected-trade news',`https://api.x.com/2/users/${user.id}/tweets?${params}`,{ttl:1,headers:{Authorization:'Bearer '+env.X_BEARER_TOKEN},maximumBytes:100000});
        const rows=(response.data.data||[]).filter(p=>/^\d+$/.test(p.id)&&typeof p.text==='string'&&Number.isFinite(Date.parse(p.created_at))&&Date.parse(p.created_at)<=now()+300000).map(p=>({id:p.id,author,title:p.text.slice(0,220),excerpt:p.text.slice(0,900),created_at:p.created_at,as_of:p.created_at,platform:'x',publisher:account.name,metrics:p.public_metrics||{},url:`https://x.com/${author}/status/${p.id}`}));
        const merged=[...new Map([...rows,...(previous?.posts||[])].map(p=>[p.id,p])).values()].filter(p=>now()-Date.parse(p.created_at)<7*86400000).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,20);
        const cursor={pk:'x-cursor#'+author,sk:'value',newest_id:rows[0]?.id||previous?.newest_id,posts:merged,expires_epoch:Math.floor(now()/1000)+7*86400};
        if(typeof context.publishRecord==='function')await context.publishRecord(cursor);else await durable.save(cursor,true);
        return {status:'available',posts:merged,as_of:response.as_of};
      });
      feeds.push({author,...result});
    }catch(error){
      if(error.code==='X_BUDGET_REACHED'){feeds.push({author,...empty('budget_reached','Shared X lookup, post-read or monetary allowance reached.')});continue;}
      if(error.code==='CACHE_LEASE_LOST'||error.code==='CACHE_LEASE_BUSY'){feeds.push({author,...empty('refreshing','The shared refresh lease ended before publication. Retry shortly; no stale cursor was published.')});continue;}
      if(error.code==='CACHE_FENCE_UNAVAILABLE'||error.code==='X_IDENTITY_UNAVAILABLE'){feeds.push({author,...empty('unavailable','The shared public feed cache cannot safely publish this refresh.')});continue;}
      const status=Number(error.status),seconds=status===402?86400:status===429?900:status===401||status===403?3600:60,reported=Date.parse(error.retry_at),until=Math.max(now()+seconds*1000,Number.isFinite(reported)?reported:0);
      await durable.save({pk:'x-public-cooldown',sk:'value',until,expires_epoch:Math.ceil(until/1000)},true).catch(()=>{});
      feeds.push({author,...empty('unavailable',Number.isInteger(status)?'Public X retrieval returned HTTP '+status+'.':'Public X retrieval or its quota store is unavailable.')});
    }
  }
  const result={status:feeds.some(f=>f.status==='available')?'available':feeds[0]?.status||'not_queried',posts:feeds.flatMap(f=>f.posts),feeds:feeds.map(({posts,...rest})=>rest),
    note:'At most two curated account feeds per topic, shared for 30 minutes. Five possible post reads and account lookups are reserved before paid requests. Account identity is not a dated accuracy record; posts never change the forecast.'};
  recordProviderStatus('X selected-trade news',{status:result.status,detail:result.note});return result;
}

const communities={nfl:'nfl',nba:'nba',epl:'soccer',music:'popheads',film:'boxoffice'};
export function filterRedditPosts(payload,{now=Date.now()}={}){
  const rejected={},posts=[],seen=new Set(),reject=reason=>{rejected[reason]=(rejected[reason]||0)+1;};
  for(const row of (payload?.data?.children||[]).slice(0,25)){
    const p=row.data||{},text=String(p.title||'').trim(),author=String(p.author||''),date=Number(p.created_utc)*1000,url=safePublicURL('https://www.reddit.com'+String(p.permalink||'')),link=safePublicURL(p.url);
    let reason=null;
    if(!/^t3_[a-z0-9]+$/.test(p.name||'')||!/^\/r\/[a-z0-9_]+\/comments\/[a-z0-9]+\//i.test(p.permalink||'')||!url||!Number.isFinite(date)||date>now+300000||now-date>3*86400000)reason='invalid_or_stale';
    else if(!author||author==='[deleted]'||p.removed_by_category||p.is_robot_indexable===false||p.over_18||p.stickied)reason='unavailable_or_unsuitable';
    else if(/(?:^automoderator$|bot$|_bot\b)/i.test(author)||/\b(i am a bot|automated message|beep boop)\b/i.test(text))reason='automation_heuristic';
    else if(!Number.isFinite(p.score)||p.score<3||!Number.isFinite(p.upvote_ratio)||p.upvote_ratio<.65)reason='low_vote_support';
    else if(text.length<35||p.is_self||!link||new URL(link).hostname.endsWith('reddit.com')||/\b(unpopular opinion|my prediction|i think|hot take|who wins|upvote|giveaway|parlay|lock of the day|guaranteed)\b/i.test(text))reason='opinion_or_low_evidence';
    else if(seen.has(text.toLowerCase())||seen.has(link))reason='duplicate';
    if(reason){reject(reason);continue;}seen.add(text.toLowerCase());seen.add(link);
    posts.push({id:p.name,title:text.slice(0,500),excerpt:'Public link-post title; linked article and comment thread have not been read.',url,linked_source_url:link,author,platform:'reddit',publisher:'r/'+p.subreddit,as_of:new Date(date).toISOString(),metrics:{score:p.score,upvote_ratio:p.upvote_ratio,comments:p.num_comments||0},limitations:['Possible automation and low-evidence posts are filtered using fallible heuristics. A surviving post is not certified human or accurate.']});
  }
  return {posts,rejected,examined:Math.min(25,payload?.data?.children?.length||0)};
}
export async function redditEvidence(market,{enabled=false,selectedTicker,sports}={},dependencies={}){
  if(!enabled||selectedTicker!==market?.ticker)return empty('not_queried','Reddit is fetched only when enabled for the exact selected trade.');
  const env=dependencies.env||process.env,get=dependencies.sourceJSON||sourceJSON;
  const topic=evidenceTopic(market),community=communities[topic],entities=evidenceSearchTerms(market,{sports}).slice(0,4).sort();
  if(!community||!entities.length)return empty('not_applicable','There is no scoped subreddit search for this outcome.');
  const now=dependencies.now||Date.now,day=new Date(now()).toISOString().slice(0,10),query=entities.map(e=>'"'+e.replace(/[^\p{L}\p{N} ]/gu,' ').slice(0,36).trim()+'"').join(' OR ');
  const params=new URLSearchParams({q:query,restrict_sr:'on',sort:'new',t:'week',limit:'25',raw_json:'1'});
  const search_url='https://www.reddit.com/r/'+community+'/search/?'+params;
  if(env.REDDIT_DATA_API_APPROVED!=='true'||!env.REDDIT_ACCESS_TOKEN||!env.REDDIT_USER_AGENT)
    return {...empty('not_configured','Automatic retrieval requires approved Reddit Data API access. Open the focused search to see public discussion.'),search_url};
  const durable=dependencies.store||(cloudEnabled()?store():null),key=createHash('sha256').update(community+'\n'+query).digest('hex').slice(0,32);
  if(!durable||['get','save','cached','consume'].some(k=>typeof durable[k]!=='function'))return {...empty('unavailable','Reddit feed is unavailable. Open the public search to review discussion directly.'),search_url};
  try{const result=await durable.cached('reddit-oauth-selected#'+key,900,async()=>{
    const cooldown=await durable.get('reddit-public-cooldown');if(cooldown?.until>now())return {...empty('cooldown','Shared Reddit reads are paused after a provider limit.'),retry_at:new Date(cooldown.until).toISOString()};
    const limit=boundedInteger(env.REDDIT_DAILY_REQUEST_LIMIT,100,1000);
    if(!await durable.consume('reddit-public#'+day,limit,1,3*86400))return empty('budget_reached','Shared daily Reddit request allowance reached.');
    const response=await get('Reddit selected-trade context','https://oauth.reddit.com/r/'+community+'/search?'+params,{ttl:1,headers:{Authorization:'Bearer '+env.REDDIT_ACCESS_TOKEN,'User-Agent':env.REDDIT_USER_AGENT},maximumBytes:180000,timeoutMs:3500});
    if(!Array.isArray(response.data?.data?.children))return empty('unavailable','Public post listing schema was unavailable; retrieval stopped.');
    const result=filterRedditPosts(response.data,{now:now()});return {status:result.posts.length?'available':'empty',...result,posts:result.posts.map(({author,...row})=>({...row,retrieved_at:response.as_of})),community,query,as_of:response.as_of,note:'Up to 25 public link posts are reviewed. Posts that pass the vote and spam filters remain unverified context.'};
  });return {...result,search_url};}catch(error){
    if(['CACHE_LEASE_LOST','CACHE_LEASE_BUSY'].includes(error.code))return {...empty('refreshing','A shared Reddit search is refreshing.'),search_url};
    const status=Number(error.status),seconds=status===429?900:status===401||status===403?3600:60,reported=Date.parse(error.retry_at),until=Math.max(now()+seconds*1000,Number.isFinite(reported)?reported:0);
    await durable.save({pk:'reddit-public-cooldown',sk:'value',until,expires_epoch:Math.ceil(until/1000)},true).catch(()=>{});
    return {...empty('unavailable',Number.isInteger(status)?'Public Reddit retrieval returned HTTP '+status+'.':'The Reddit feed is temporarily unavailable.'),search_url};}
}
