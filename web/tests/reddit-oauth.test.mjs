import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRedditSearchHTML,redditEvidence} from '../lib/workspace/social.mjs';

const NOW=Date.parse('2026-11-07T00:00:00Z');
const market={ticker:'KXNBAGAME-26NOV06PHICLE-PHI',title:'Philadelphia wins',yes_sub_title:'Philadelphia 76ers'};
const sports={teams:[{name:'Philadelphia 76ers'},{name:'Cleveland Cavaliers'}]};
const article=(id,subreddit='nba',title='Philadelphia 76ers report updated starting lineup before tipoff',created='2026-11-06T23:59:00Z',extras='')=>`<shreddit-post id="${id}" subreddit-name="${subreddit}" post-title="${title}" created-timestamp="${created}" score="32" comment-count="8" permalink="/r/${subreddit}/comments/${id}/story/" ${extras}></shreddit-post>`;

test('public Reddit HTML parser extracts allowlisted metadata and drops authors, bodies and malformed records',()=>{
  const html=article('abc123')+article('def456','nba','Cleveland Cavaliers injury report changes before game')+article('abc123')+article('ghi789','nfl')+
    article('bad000','nba','Philadelphia 76ers report updated starting lineup before tipoff','2026-11-06T23:59:00Z','author="private-author" post-body="secret body" is-nsfw="true"')+
    article('stale1','nba','Philadelphia 76ers report updated starting lineup before tipoff','2026-10-01T00:00:00Z');
  const result=parseRedditSearchHTML(html,{now:NOW,community:'nba',entities:['Philadelphia 76ers','Cleveland Cavaliers']});
  assert.equal(result.posts.length,2);
  assert.deepEqual(result.posts.map(row=>row.publisher),['r/nba','r/nba']);
  assert.equal(result.posts[0].platform,'reddit');
  assert.equal(Object.hasOwn(result.posts[0],'author'),false);
  assert.doesNotMatch(JSON.stringify(result),/private-author|secret body/);
  assert.equal(result.rejected.duplicate,1);
  assert.equal(result.rejected.wrong_community,1);
  assert.equal(result.rejected.unavailable_or_unsuitable,1);
  assert.equal(result.rejected.invalid_or_stale,1);
  assert.throws(()=>parseRedditSearchHTML('x'.repeat(250001)),/limit/);
});

test('Reddit scraper is opt-in, exact-ticker bound, robots-gated and does not use API auth or bypass blocks',async()=>{
  let calls=0;
  const deps={env:{PREDICTIR_SOCIAL_EVIDENCE_ENABLED:'1'},now:()=>NOW,permittedPublicPage:async(name,url,options)=>{
    calls++;const parsed=new URL(url);
    assert.equal(parsed.origin,'https://www.reddit.com');
    assert.equal(parsed.pathname,'/r/nba/search/');
    assert.equal(options.maximumBytes,250000);
    assert.equal(options.timeoutMs,5000);
    assert.equal(options.checkGPTBot,false);
    assert.match(options.userAgent,/PredictirResearch/);
    return {status:'available',as_of:new Date(NOW).toISOString(),source_url:url,data:{text:article('abc123')}};
  }};
  assert.equal((await redditEvidence(market,{enabled:false,selectedTicker:market.ticker,sports},deps)).status,'not_queried');
  assert.equal((await redditEvidence(market,{enabled:true,selectedTicker:'OTHER',sports},deps)).status,'not_queried');
  const result=await redditEvidence(market,{enabled:true,selectedTicker:market.ticker,sports},{...deps,env:{PREDICTIR_SOCIAL_EVIDENCE_ENABLED:'1'}});
  assert.equal(calls,1);
  assert.equal(result.status,'available');
  assert.equal(result.posts.length,1);
  assert.equal(result.posts[0].publisher,'r/nba');
  const blocked=await redditEvidence(market,{enabled:true,selectedTicker:market.ticker,sports},{...deps,permittedPublicPage:async()=>({status:'robots_blocked',reason:'robots disallow'})});
  assert.equal(blocked.status,'robots_blocked');
  assert.equal(blocked.posts.length,0);
});
