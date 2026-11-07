import assert from 'node:assert/strict';
import test from 'node:test';
import {redditAccessToken,redditAuthConfigured} from '../lib/workspace/reddit-oauth.mjs';
import {redditEvidence} from '../lib/workspace/social.mjs';

const NOW=Date.parse('2026-11-07T00:00:00Z');
const config=()=>({REDDIT_DATA_API_APPROVED:'true',REDDIT_USER_AGENT:'Predictir test',REDDIT_CLIENT_ID:'fixture-id',REDDIT_CLIENT_SECRET:'fixture-secret'});
const tokenReply=(access_token,scope='read')=>Response.json({access_token,scope,expires_in:3600,token_type:'bearer'});

test('an approved app renews its read token and shares the exchange across concurrent requests',async()=>{
  let time=NOW,calls=0;
  const env={...config(),REDDIT_REFRESH_TOKEN:'fixture-refresh'},now=()=>time;
  const fetcher=async(url,options)=>{
    assert.equal(url,'https://www.reddit.com/api/v1/access_token');
    assert.equal(options.method,'POST');
    assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Basic '+Buffer.from('fixture-id:fixture-secret').toString('base64'));
    assert.equal(options.body.get('grant_type'),'refresh_token');
    assert.equal(options.body.get('refresh_token'),'fixture-refresh');
    return tokenReply('token-'+(++calls));
  };
  assert.deepEqual(await Promise.all([redditAccessToken(env,{fetcher,now}),redditAccessToken(env,{fetcher,now})]),['token-1','token-1']);
  time+=3550_000;
  assert.equal(await redditAccessToken(env,{fetcher,now}),'token-1');
  time+=25_000;
  assert.equal(await redditAccessToken(env,{fetcher,now}),'token-2');
});

test('the approval gate remains required for both client credentials and existing bearer tokens',async()=>{
  const env=config();
  assert.equal(redditAuthConfigured({...env,REDDIT_DATA_API_APPROVED:'false'}),false);
  assert.equal(redditAuthConfigured({...env,REDDIT_USER_AGENT:''}),false);
  const fixed={...env,REDDIT_CLIENT_ID:'',REDDIT_CLIENT_SECRET:'',REDDIT_ACCESS_TOKEN:'fixture-fixed'};
  assert.equal(await redditAccessToken(fixed,{fetcher:()=>assert.fail('A static token does not make an exchange')}),'fixture-fixed');
  await assert.rejects(redditAccessToken({...env,REDDIT_DATA_API_APPROVED:''},{fetcher:()=>assert.fail('An unapproved app does not make an exchange')}),{status:401});
  assert.equal(await redditAccessToken(env,{fetcher:async(_,options)=>{
    assert.equal(options.body.get('grant_type'),'client_credentials');
    assert.equal(options.body.has('refresh_token'),false);
    return tokenReply('app-token','*');
  }}),'app-token');
});

test('Reddit opt-in sends a bounded scoped read and only persists sanitized same-community rows',async()=>{
  const market={ticker:'KXNBAGAME-26NOV06PHICLE-PHI',title:'Philadelphia wins',yes_sub_title:'Philadelphia 76ers'};
  const sports={teams:[{name:'Philadelphia 76ers'},{name:'Cleveland Cavaliers'}]};
  const post={name:'t3_abc123',title:'Philadelphia 76ers report updated starting lineup before tipoff',author:'private-test-author',created_utc:NOW/1000-60,
    permalink:'/r/nba/comments/abc123/report/',url:'https://www.espn.com/nba/story/123',subreddit:'nba',score:12,upvote_ratio:.9};
  const values=[];
  const result=await redditEvidence(market,{enabled:true,selectedTicker:market.ticker,sports},{env:config(),now:()=>NOW,
    tokenFetcher:async()=>tokenReply('app-token','*'),
    store:{get:async()=>null,consume:async()=>true,save:async()=>{},cached:async(_,ttl,load)=>{
      assert.equal(ttl,900);
      const value=await load();values.push(value);return value;
    }},
    sourceJSON:async(_,url,options)=>{
      const parsed=new URL(url);
      assert.equal(parsed.origin,'https://oauth.reddit.com');
      assert.equal(parsed.pathname,'/r/nba/search');
      assert.equal(parsed.searchParams.get('limit'),'25');
      assert.equal(options.headers.Authorization,'Bearer app-token');
      assert.equal(options.sharedCache,false);
      return {as_of:new Date(NOW).toISOString(),data:{data:{children:[{data:post},{data:{...post,subreddit:'nfl'}},null]}}};
    }
  });
  assert.equal(result.status,'available');
  assert.equal(result.posts.length,1);
  assert.equal(result.rejected.wrong_community,1);
  assert.equal(result.rejected.invalid_or_stale,1);
  assert.doesNotMatch(JSON.stringify(values),/private-test-author|app-token/);
});

test('an OAuth rate limit applies its retry window without making or caching a listing request',async()=>{
  const market={ticker:'KXNBAGAME-26NOV06PHICLE-PHI',title:'Philadelphia wins',yes_sub_title:'Philadelphia 76ers'};
  const sports={teams:[{name:'Philadelphia 76ers'},{name:'Cleveland Cavaliers'}]};
  const opts={enabled:true,selectedTicker:market.ticker,sports};
  let cooldown,calls=0,successfulCacheWrites=0;
  const deps={env:config(),now:()=>NOW,tokenFetcher:async()=>{
    calls++;
    return new Response(null,{status:429,headers:{'Retry-After':'1200'}});
  },sourceJSON:async()=>assert.fail('A rate-limited token cannot request a listing'),
    store:{get:async()=>cooldown,save:async value=>{cooldown=value;},consume:async()=>true,cached:async(_,__,load)=>{
      const value=await load();successfulCacheWrites++;return value;
    }}};
  assert.equal((await redditEvidence(market,opts,deps)).status,'unavailable');
  const retry=await redditEvidence(market,opts,deps);
  assert.equal(retry.status,'cooldown');
  assert.equal(retry.retry_at,new Date(NOW+1200_000).toISOString());
  assert.equal(calls,1);
  assert.equal(successfulCacheWrites,0);
});

test('a token exchange with no read scope fails without exposing the provider body',async()=>{
  await assert.rejects(redditAccessToken(config(),{fetcher:async()=>tokenReply('private-test-token','identity')}),error=>{
    assert.equal(error.status,403);
    assert.doesNotMatch(error.message,/private-test-token/);
    return true;
  });
});
