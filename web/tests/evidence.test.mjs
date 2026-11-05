import test from 'node:test';
import assert from 'node:assert/strict';
import {contractEvidence} from '../lib/workspace/evidence.mjs';
import {rankEvidence} from '../lib/workspace/source-ranking.mjs';
import {filterRedditPosts,redditEvidence,publicXFeed} from '../lib/workspace/social.mjs';
import {robotsAllowed,permittedPublicPage} from '../lib/workspace/public-pages.mjs';
import {parseKworbUS} from '../lib/workspace/music-alternatives.mjs';
import {parsePlayerStats,playerEvidence} from '../lib/workspace/sports.mjs';
import {filmResearch} from '../lib/workspace/film.mjs';
import {retryDelay} from '../lib/workspace/providers.mjs';
const NOW=Date.parse('2026-11-05T01:00:00Z'),market={ticker:'KXNBAGAME-26NOV05LALBOS-LAL',title:'Los Angeles Lakers at Boston Celtics',yes_sub_title:'Los Angeles Lakers',rules_primary:'The Los Angeles Lakers win against the Boston Celtics.'},sports={teams:[{id:'1',name:'Los Angeles Lakers'},{id:'2',name:'Boston Celtics'}]};
function memoryStore(){const values=new Map(),cache=new Map(),quotas=new Map();return {values,quotas,get:async k=>values.get(k),save:async value=>values.set(value.pk,value),consume:async(k,limit,amount=1)=>{const used=quotas.get(k)||0;if(used+amount>limit)return false;quotas.set(k,used+amount);return true;},cached:async(k,ttl,producer)=>{if(!cache.has(k))cache.set(k,Promise.resolve().then(producer));return cache.get(k);}};}

test('selected-contract opt-in gates every evidence provider before any retrieval',async()=>{
  let calls=0;const deps={sportsNews:async()=>{calls++;},publicXFeed:async()=>{calls++;},redditEvidence:async()=>{calls++;}};
  for(const options of [{},{enabled:true,selectedTicker:'OTHER'},{selectedTicker:market.ticker}])assert.equal((await contractEvidence(market,options,deps)).status,'not_queried');
  assert.equal(calls,0);
});
test('ranked context requires exact entity tokens, bounded fresh dates and diverse attributed publishers',()=>{
  const row={title:'Los Angeles Lakers confirmed starting lineup',url:'https://www.espn.com/nba/story/1',as_of:'2026-11-05T00:00:00Z',excerpt:'Lineup context.'};
  const items=rankEvidence([row,{...row,url:'https://www.espn.com/nba/story/2'},
    {...row,title:'Boston Celtics injury update',url:'https://x.com/ShamsCharania/status/100',author:'ShamsCharania',platform:'x'},
    {...row,title:'Boston city council confirmed starting budget',url:'https://example.org/boston'},
    {...row,title:'Boston Celtics injury update yesterday',as_of:'2025-11-05',url:'https://example.org/old'},
    {...row,title:'Boston Celtics injury update tomorrow',as_of:'2026-11-06',url:'https://example.org/future'}],market,{sports,now:NOW});
  assert.equal(items.length,2);assert.ok(items.every(r=>r.score<=100&&r.score>=0));assert.ok(items.every(r=>r.limitations.join(' ').includes('not a probability')));assert.equal(items.find(i=>i.author)?.confidence,'attributed_report');
});
test('Reddit quality screen excludes likely automation, downvoted posts, opinions and duplicates without certifying survivors',()=>{
  const post={name:'t3_abc123',title:'Los Angeles Lakers confirm updated injury report before tonight',author:'sportsreporter',created_utc:NOW/1000-60,permalink:'/r/nba/comments/abc123/update/',url:'https://www.espn.com/nba/story/123',score:12,upvote_ratio:.9,subreddit:'nba',num_comments:4};
  const rows=[post,{...post,author:'AutoModerator'},{...post,score:-2},{...post,is_self:true},{...post,title:'I think the Los Angeles Lakers are a guaranteed lock tonight'},{...post,name:'t3_other'}];
  const result=filterRedditPosts({data:{children:rows.map(data=>({data}))}},{now:NOW});
  assert.equal(result.posts.length,1);assert.equal(result.rejected.automation_heuristic,1);assert.equal(result.rejected.low_vote_support,1);assert.equal(result.rejected.opinion_or_low_evidence,2);assert.equal(result.rejected.duplicate,1);assert.match(result.posts[0].limitations[0],/not certified human/);
});
test('public Reddit collection stops at robots without requesting the post listing and shares the result',async()=>{
  const durable=memoryStore();let pages=0;
  const deps={env:{},store:durable,now:()=>NOW,publicPage:async()=>{pages++;return {status:'robots_blocked',reason:'Disallow: /',as_of:new Date(NOW).toISOString()};}};
  assert.equal((await redditEvidence(market,{enabled:true,selectedTicker:'OTHER',sports},deps)).status,'not_queried');
  const options={enabled:true,selectedTicker:market.ticker,sports};
  const results=await Promise.all([redditEvidence(market,options,deps),redditEvidence(market,options,deps)]);
  assert.equal(pages,1);assert.ok(results.every(r=>r.status==='robots_blocked'&&r.search_url.startsWith('https://www.reddit.com/r/nba/search/')));
});
test('robots matching honors specific agent groups, path allowance and blocks page fetches',async()=>{
  assert.equal(robotsAllowed('User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /','/chart','GPTBot'),false);
  assert.equal(robotsAllowed('User-agent: *\nDisallow: /\nAllow: /public/','/public/chart'),true);
  let fetches=0;
  const response=await permittedPublicPage('robots fixture','https://kworb.net/robot-fixture',{fetcher:async()=>{fetches++;return new Response('User-agent: *\nDisallow: /');}});
  assert.equal(response.status,'robots_blocked');assert.equal(fetches,1);
});
test('X reserves shared paid post and lookup costs before reading, caches public feeds and closes on quota denial',async()=>{
  const durable=memoryStore();let calls=0;
  const deps={env:{X_BEARER_TOKEN:'fixture-never-live'},store:durable,now:()=>NOW,sourceJSON:async(_,url)=>{calls++;const name=url.split('/').at(-1);return {as_of:new Date(NOW).toISOString(),data:url.includes('/by/username/')?{data:{id:'123',username:name}}:{data:[{id:'111',text:'Los Angeles Lakers updated availability',created_at:new Date(NOW-60000).toISOString()}]}};}};
  await publicXFeed({topic:'nba',enabled:true},deps);await publicXFeed({topic:'nba',enabled:true},deps);
  assert.equal(calls,4);assert.equal(durable.quotas.get('x-posts#2026-11'),10);assert.equal(durable.quotas.get('x-cost-milliusd#2026-11'),70);
  const denied={...memoryStore(),consume:async()=>false};calls=0;
  const result=await publicXFeed({topic:'nba',enabled:true},{...deps,store:denied});assert.equal(calls,0);assert.equal(result.status,'budget_reached');
});
test('provider waits preserve HTTP-date and X-reset backoff rather than hammering retries',()=>{
  assert.equal(retryDelay(new Headers({'retry-after':'Wed, 05 Nov 2026 02:00:00 GMT'}),429,NOW),3600000);
  assert.equal(retryDelay(new Headers({'x-rate-limit-reset':String((NOW+120000)/1000)}),429,NOW),120000);
});
test('secondary music chart preserves date, territory, measured counts and rejects identity/schema drift',()=>{
  const rows=Array.from({length:50},(_,i)=>`<tr><td>${i+1}</td><td>=</td><td><a href="../artist/artist.html">Artist</a> - <a href="../track/${String(i).padStart(22,'0')}.html">Song ${i}</a></td><td>1</td><td>1</td><td></td><td>1,234</td><td>0</td><td>3,000</td><td>0</td><td>5,000</td></tr>`).join('');
  const html=`Spotify Daily Chart - United States - 2026/11/03<table id="spotifydaily"><th>Streams</th>${rows}</table>`,result=parseKworbUS(html,NOW);
  assert.equal(result.tracks[0].streams,1234);assert.equal(result.tracks[0].territory,'US');assert.equal(result.measurement_date,'2026-11-03');assert.match(result.note,/neither full artist totals nor Billboard/);
  assert.throws(()=>parseKworbUS(html.replace('United States -','Global -'),NOW),/identity/);assert.throws(()=>parseKworbUS(html.replace('2026/11/03','2026/11/30'),NOW),/measurement date/);
});
test('NBA player evidence includes actual DNP rows and leaves absent boxscores missing',()=>{
  const box={header:{id:'1'},boxscore:{players:[{team:{id:'A'},statistics:[{names:['MIN','PTS','REB','AST','TO'],athletes:[
    {athlete:{id:'p',displayName:'Player'},stats:['12:30','8','3','2','1'],starter:true},
    {athlete:{id:'q',displayName:'DNP'},stats:[],didNotPlay:true}]}]}]}};
  const rows=parsePlayerStats(box);assert.equal(rows[0].minutes,12.5);assert.equal(rows[0].points,8);assert.equal(rows[1].minutes,0);assert.equal(rows[1].points,null);
  const games=[{id:'1',home_id:'A',away_id:'B',home_score:100,away_score:90,played_at:'2026-11-02'},{id:'2',home_id:'A',away_id:'B',home_score:110,away_score:115,played_at:'2026-11-03'}],result=playerEvidence(games,rows,'A',{cutoff:NOW});
  assert.equal(result[0].games_expected,2);assert.equal(result[0].games_observed,1);assert.equal(result[0].comparison.low.n,1);assert.equal(result[0].comparison.regular.n,0);assert.equal(result[1].averages.points,null);assert.equal(result[0].low_minutes_games[0].won,true);
});
test('film critic weighting remains user preference and never invents missing demand or a trade probability',()=>{
  const filmMarket={ticker:'KXFILM-X',title:'Movie opening weekend box office',yes_sub_title:'Example Film',custom_strike:{Film:'Example Film'}},critic={film:'Example Film',kind:'critic_score',value:80,metric:'positive_review_percentage',sample_size:50,territory:'US',publisher:'Fixture critics',source_url:'https://example.org/critics',measured_at:'2026-11-04T01:00:00Z'};
  const missing=filmResearch(filmMarket,{observations:[critic],now:NOW});assert.equal(missing.preference_index.value,null);assert.equal(missing.preference_index.probability,null);
  const complete=filmResearch(filmMarket,{observations:[critic,{...critic,kind:'demand_index',value:60,metric:'demand_percentile_0_100'}],now:NOW});
  assert.equal(complete.preference_index.value,75.5);assert.equal(complete.preference_index.affects_forecast,false);assert.match(complete.weight_basis,/User preference/);
  assert.throws(()=>filmResearch(filmMarket,{criticWeight:.9}),/75% and 80%/);
});
