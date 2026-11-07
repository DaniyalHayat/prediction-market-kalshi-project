import {createHash} from 'node:crypto';
import {sourceJSON,recordProviderStatus} from './providers.mjs';
import {permittedPublicPage} from './public-pages.mjs';
import {cloudEnabled,store} from '../cloud/store.mjs';
import {SOURCE_CATALOG,evidenceSearchTerms,evidenceTopic,safePublicURL} from './source-ranking.mjs';
import {socialEvidenceEnabled,socialDisabledResult} from './social-policy.mjs';
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
  if(!socialEvidenceEnabled(dependencies.env||process.env))return socialDisabledResult();
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
const htmlText=value=>String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,entity=>{
  const named={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};
  if(named[entity.toLowerCase()])return named[entity.toLowerCase()];
  const hex=entity[2]?.toLowerCase()==='x',n=Number.parseInt(entity.slice(hex?3:2,-1),hex?16:10);
  return Number.isInteger(n)&&n>31&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):' ';
}).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
function htmlAttributes(source){
  const attributes=new Map(),pattern=/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;let match;
  while((match=pattern.exec(source)))attributes.set(match[1].toLowerCase(),htmlText(match[2]??match[3]??match[4]));
  return attributes;
}
function htmlCount(value){
  const text=String(value||'').trim().toLowerCase(),match=/^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(text);
  if(!match)return NaN;const multiplier=match[2]==='k'?1000:match[2]==='m'?1000000:1;
  const result=Math.round(Number(match[1])*multiplier);return Number.isSafeInteger(result)&&result>=0?result:NaN;
}
function redditSearchTerms(market,{sports}={}){
  const terms=evidenceSearchTerms(market,{sports}).map(value=>value.normalize('NFKC').replace(/[^\p{L}\p{N}\s'-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,64)).filter(value=>value.length>=3);
  return [...new Set(terms)].slice(0,4);
}
export function parseRedditSearchHTML(markup,{now=Date.now(),community=null,entities=[]}={}){
  if(typeof markup!=='string'||markup.length>250000)throw new RangeError('Reddit HTML response exceeds the parser limit');
  const posts=[],seen=new Set(),rejected={};const reject=reason=>{rejected[reason]=(rejected[reason]||0)+1;};
  const entityTerms=entities.map(value=>value.toLowerCase()).filter(Boolean),cards=[];
  for(const match of markup.matchAll(/<shreddit-post\b([^>]*)>/gi)){
    const attrs=htmlAttributes(match[1]);
    cards.push({id:attrs.get('id')||attrs.get('post-id')||'',title:attrs.get('post-title')||attrs.get('post_title')||'',subreddit:(attrs.get('subreddit-name')||attrs.get('subreddit_name')||'').toLowerCase(),stamp:attrs.get('created-timestamp')||attrs.get('created_timestamp')||'',score:attrs.get('score'),comments:attrs.get('comment-count')||attrs.get('comment_count'),permalink:attrs.get('permalink'),state:(attrs.get('post-state')||'').toLowerCase(),nsfw:(attrs.get('is-nsfw')||attrs.get('is_nsfw')||'false').toLowerCase()});
  }
  if(!cards.length){
    const blocks=[...markup.matchAll(/<div\b([^>]*\bdata-testid\s*=\s*(["'])search-result\2[^>]*)>([\s\S]*?)(?=<div\b[^>]*\bdata-testid\s*=\s*["']search-result["']|<\/main\b|$)/gi)];
    for(const block of blocks){
      const container=htmlAttributes(block[1]),body=block[3],entry=[...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].map(row=>({attrs:htmlAttributes(row[1]),text:htmlText(row[2])}));
      const postLink=entry.find(row=>/^\/r\/[a-z0-9_]+\/comments\/[a-z0-9]+\//i.test(new URL(row.attrs.get('href')||'/', 'https://www.reddit.com').pathname));
      const title=entry.find(row=>/\b(?:visually-hidden|title)\b/i.test(row.attrs.get('class')||'')&&row.text.length>=12)?.text||postLink?.text;
      if(!postLink||!title)continue;
      const subreddit=/^\/r\/([a-z0-9_]+)\//i.exec(postLink.attrs.get('href'))?.[1]?.toLowerCase()||'';
      const id=/\/comments\/([a-z0-9]+)\//i.exec(postLink.attrs.get('href'))?.[1]||'';
      const time=/<time\b([^>]*)>/i.exec(body),timeAttrs=htmlAttributes(time?.[1]||'');
      const scoreMatch=/([\d,.]+\s*[km]?)\s+points?/i.exec(body),commentMatch=/([\d,.]+\s*[km]?)\s+comments?/i.exec(body);
      cards.push({id,title,subreddit,stamp:timeAttrs.get('datetime'),score:scoreMatch?.[1],comments:commentMatch?.[1],permalink:postLink.attrs.get('href'),state:container.get('post-state')||'',nsfw:container.get('is-nsfw')||'false'});
    }
  }
  for(const card of cards){
    const id=card.id.replace(/^t3_/i,''),title=card.title.trim(),subreddit=card.subreddit,date=Date.parse(card.stamp),score=htmlCount(card.score),comments=htmlCount(card.comments);
    let link;try{link=new URL(card.permalink||'','https://www.reddit.com');}catch{}
    let reason=null;
    if(!/^[a-z0-9]{5,16}$/i.test(id)||!link||link.origin!=='https://www.reddit.com'||!/^\/r\/[a-z0-9_]+\/comments\/[a-z0-9]+\//i.test(link.pathname)||!title||!Number.isFinite(date)||date>now+300000||now-date>7*86400000)reason='invalid_or_stale';
    else if(community&&subreddit!==community)reason='wrong_community';
    else if(card.state.includes('removed')||card.state.includes('deleted')||card.nsfw==='true')reason='unavailable_or_unsuitable';
    else if(!Number.isFinite(score)||score<2||!Number.isFinite(comments)||comments<1)reason='low_engagement';
    else if(entityTerms.length&&!entityTerms.some(term=>title.toLowerCase().includes(term)))reason='entity_mismatch';
    else if(seen.has(id))reason='duplicate';
    if(reason){reject(reason);continue;}seen.add(id);
    posts.push({id:'t3_'+id,title:title.slice(0,300),excerpt:`Public post title · ${score} points · ${comments} comments. Post text and replies were not scraped.`,url:link.href,
      created_at:new Date(date).toISOString(),as_of:new Date(date).toISOString(),platform:'reddit',publisher:'r/'+subreddit,
      metrics:{score,comments},limitations:['Scraped public listing metadata only. Authors, post bodies and comments are excluded. Popularity is not evidence of accuracy or contract outcome.']});
    if(posts.length>=15)break;
  }
  return {posts,rejected,examined:cards.length};
}
export async function redditEvidence(market,{enabled=false,selectedTicker,sports}={},dependencies={}){
  if(!enabled||selectedTicker!==market?.ticker)return empty('not_queried','Reddit is scraped only after opt-in for the exact selected contract.');
  if(!socialEvidenceEnabled(dependencies.env||process.env))return socialDisabledResult();
  const topic=evidenceTopic(market),community=communities[topic]||null,entities=redditSearchTerms(market,{sports});
  if(!entities.length)return empty('not_applicable','No exact search entity could be established from this contract.');
  const params=new URLSearchParams({q:entities.map(value=>'"'+value+'"').join(' OR '),sort:'new',t:'week',limit:'25'});
  if(community)params.set('restrict_sr','1');
  const path=community?`/r/${community}/search/`:'/search/';
  const search_url='https://www.reddit.com'+path+'?'+params.toString();
  const getPage=dependencies.permittedPublicPage||permittedPublicPage,now=dependencies.now||Date.now;
  try{
    const page=await getPage('Reddit public web search',search_url,{ttl:600,maximumBytes:250000,timeoutMs:5000,fetcher:dependencies.fetcher,userAgent:'PredictirResearch/1.0 (+public evidence; contact: research@predictir.dev)',checkGPTBot:false});
    if(page.status!=='available')return {...empty(page.status,page.reason||'Reddit public page retrieval was not allowed.'),search_url};
    const parsed=parseRedditSearchHTML(page.data?.text,{now:now(),community,entities});
    const result={status:parsed.posts.length?'available':'empty',...parsed,posts:parsed.posts,community,query:entities,search_url,
      as_of:page.as_of,source_url:page.source_url,note:'Robots-authorized Reddit public search-page metadata. No Reddit API, login, cookies, author identities, post body or comments are used. Social popularity is unverified context and never changes a forecast.'};
    recordProviderStatus('Reddit public web search',{status:result.status,as_of:result.as_of,detail:result.note});
    return result;
  }catch(error){
    const status=Number(error.status),mapped=error.code==='PROVIDER_COOLDOWN'?'cooldown':status===401||status===403?'access_blocked':'unavailable';
    const reason=mapped==='access_blocked'?'Reddit denied automated public-page retrieval. No access restriction was bypassed.':mapped==='cooldown'?'Reddit retrieval is paused after an upstream failure.':'The robots-authorized Reddit public search page could not be verified.';
    recordProviderStatus('Reddit public web search',{status:mapped,detail:reason});
    return {...empty(mapped,reason),search_url,...(error.retry_at?{retry_at:error.retry_at}:{})};
  }
}
