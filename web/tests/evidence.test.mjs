import test from 'node:test';
import assert from 'node:assert/strict';
import {contractEvidence,sportsNews} from '../lib/workspace/evidence.mjs';
import {rankEvidence} from '../lib/workspace/source-ranking.mjs';
import {filterRedditPosts,redditEvidence,publicXFeed} from '../lib/workspace/social.mjs';
import {robotsAllowed,permittedPublicPage} from '../lib/workspace/public-pages.mjs';
import {parseKworbUS} from '../lib/workspace/music-alternatives.mjs';
import {parsePlayerStats,playerEvidence} from '../lib/workspace/sports.mjs';
import {filmResearch} from '../lib/workspace/film.mjs';
import {retryDelay} from '../lib/workspace/providers.mjs';
const NOW=Date.parse('2026-11-05T01:00:00Z'),market={ticker:'KXNBAGAME-26NOV05LALBOS-LAL',title:'Los Angeles Lakers at Boston Celtics',yes_sub_title:'Los Angeles Lakers',rules_primary:'The Los Angeles Lakers win against the Boston Celtics.'},sports={teams:[{id:'1',name:'Los Angeles Lakers'},{id:'2',name:'Boston Celtics'}]};
const nflMarket={ticker:'KXNFLGAME-26NOV08ARISEA-ARI',event_ticker:'KXNFLGAME-26NOV08ARISEA',title:'Arizona wins',yes_sub_title:'Arizona',
  rules_primary:'If Arizona wins the Arizona vs Seattle Pro Football game originally scheduled for Nov 8, 2026, then the market resolves to Yes.'};
const nflSports={teams:[{id:'ARI',espn_team_id:'22',name:'Arizona Cardinals'},{id:'SEA',espn_team_id:'26',name:'Seattle Seahawks'}],
  event:{id:'401873048',nfl_game_url:'https://www.nfl.com/games/cardinals-at-seahawks-2026-reg-9'}};
function memoryStore(){const values=new Map(),cache=new Map(),quotas=new Map();return {values,quotas,get:async k=>values.get(k),save:async value=>values.set(value.pk,value),consume:async(k,limit,amount=1)=>{const used=quotas.get(k)||0;if(used+amount>limit)return false;quotas.set(k,used+amount);return true;},cached:async(k,ttl,producer)=>{if(!cache.has(k))cache.set(k,Promise.resolve().then(producer));return cache.get(k);}};}

test('selected-contract opt-in gates every evidence provider before any retrieval',async()=>{
  let calls=0;const deps={sportsNews:async()=>{calls++;},publicXFeed:async()=>{calls++;},redditEvidence:async()=>{calls++;}};
  for(const options of [{},{enabled:true,selectedTicker:'OTHER'},{selectedTicker:market.ticker}])assert.equal((await contractEvidence(market,options,deps)).status,'not_queried');
  assert.equal(calls,0);
});
test('NFL team feeds are scoped, deduplicated and still render when one team request fails',async()=>{
  const requests=[];
  const result=await sportsNews('nfl',{sports:nflSports,get:async(name,url,options)=>{
    requests.push({name,url,options});
    if(url.includes('team=22'))throw new Error('Fixture source unavailable');
    const match={id:12,headline:'Seattle Seahawks quarterback update ahead of Arizona Cardinals game',description:'Fixture update.',published:new Date(NOW-60000).toISOString(),links:{web:{href:'https://www.espn.com/nfl/story/_/id/12'}}};
    return {as_of:new Date(NOW).toISOString(),source_url:url,data:{articles:[match,match,{...match,id:13,links:{web:{href:'https://espn.com.untrusted.example/'}}}]}};
  }});
  assert.deepEqual(requests.map(row=>new URL(row.url).searchParams.get('team')),['22','26']);
  assert.ok(requests.every(row=>row.options.timeoutMs===4500&&row.options.ttl===900));
  assert.equal(result.status,'partial');assert.equal(result.articles.length,1);
});
test('NFL brief distinguishes the exact matchup, related team reports and official references',async()=>{
  let socialCalls=0;
  const row={publisher:'ESPN',platform:'publisher_metadata',as_of:new Date(NOW-60000).toISOString()};
  const value=await contractEvidence(nflMarket,{enabled:true,selectedTicker:nflMarket.ticker,sports:nflSports},{
    now:()=>NOW,sportsNews:async()=>({status:'available',articles:[
      {...row,title:'Seahawks QB ruled out for Arizona Cardinals matchup',excerpt:'Fixture report names both clubs and the quarterback change.',url:'https://www.espn.com/nfl/story/_/id/1'},
      {...row,title:'Cardinals trade update at quarterback',url:'https://www.espn.com/nfl/story/_/id/2'},
      {...row,title:'Arizona Cardinals vs Dallas Cowboys game recap',url:'https://www.espn.com/nfl/story/_/id/3'},
      {...row,title:'Seattle Seahawks guaranteed lock of the day',url:'https://www.espn.com/nfl/story/_/id/4'}
    ]}),publicXFeed:async()=>{socialCalls++;},redditEvidence:async()=>{socialCalls++;}
  });
  assert.equal(socialCalls,0);
  assert.equal(value.items.length,1);assert.equal(value.related_items.length,1);
  assert.equal(value.items[0].claim_type,'availability_report');
  assert.match(value.news_summary,/quarterback change/);
  assert.deepEqual(value.news_sections.slice(0,2).map(section=>section.heading),['What changed','Why it matters']);
  assert.equal(value.source_links[1].url,'https://www.nfl.com/injuries/league/2026/reg9');
  assert.ok(value.feeds.some(feed=>feed.kind==='reddit'&&feed.status==='opt_in'));
});
test('without dated reports, category sources and settlement checks remain usable',async()=>{
  const cpi={ticker:'KXCPI-26NOV',title:'US Consumer Price Index',rules_primary:'The contract settles on the October CPI release.'};
  const value=await contractEvidence(cpi,{enabled:true,selectedTicker:cpi.ticker},{
    now:()=>NOW,sportsNews:async()=>({status:'not_applicable',articles:[]})
  });
  assert.equal(value.status,'context_available');
  assert.equal(value.items.length,0);
  assert.match(value.news_summary,/BLS CPI release schedule/);
  assert.ok(value.news_sections.some(section=>section.heading==='Settlement check'));
  assert.equal(value.source_links[0].status,'reference');
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
test('matched player availability can qualify team news while city-only headlines remain excluded',()=>{
  const value=rankEvidence([{title:'LeBron James ruled out with injury',url:'https://www.espn.com/nba/story/lebron',as_of:new Date(NOW-60000).toISOString()},
    {title:'Lakers confirm starting lineup',url:'https://www.espn.com/nba/story/lakers',as_of:new Date(NOW-60000).toISOString()},
    {title:'Los Angeles budget update',url:'https://example.org/city',as_of:new Date(NOW-60000).toISOString()}],market,{sports:{...sports,availability:[{name:'LeBron James'}]},now:NOW});
  assert.equal(value.length,2);assert.ok(value.every(row=>row.claim_type==='availability_report'));assert.ok(value.some(row=>row.matched_entities.includes('LeBron James')));
});
test('a newly indexed historical or different-opponent game page is excluded from current selected-trade news',()=>{
  const selected={ticker:'KXNBAGAME-26NOV04ATLWAS-WAS',title:'Washington wins',yes_sub_title:'Washington Wizards'},context={teams:[{name:'Atlanta Hawks'},{name:'Washington Wizards'}]},base={publisher:'NBA.com',as_of:new Date(NOW-60000).toISOString(),time_basis:'provider_first_seen'};
  const result=rankEvidence([{...base,title:'Washington Wizards vs Charlotte Hornets Mar 9, 2015 Game Details - NBA.com',url:'https://www.nba.com/game/was-vs-cha-0021400938'},
    {...base,title:'Washington Wizards vs Charlotte Hornets Nov 4, 2026 Game Details - NBA.com',url:'https://www.nba.com/game/was-vs-cha-fixture'},
    {...base,title:'Atlanta Hawks vs Washington Wizards Nov 4, 2026 Game Preview',url:'https://www.nba.com/game/atl-vs-was-fixture'},
    {...base,title:'Washington Wizards reported player availability update',url:'https://www.espn.com/nba/story/availability'}],selected,{sports:context,now:NOW});
  assert.equal(result.length,2);assert.ok(result.every(row=>!row.url.includes('cha')));assert.ok(result.some(row=>row.title.includes('availability')));
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
test('Postgres X cursors use fenced producer publication and budget failures cannot poison identity caches',async()=>{
  const durable=memoryStore(),cache=new Map();let allowed=false,published=0,calls=0;durable.kind='postgres';durable.consume=async()=>allowed;
  durable.cached=async(key,ttl,producer)=>{if(cache.has(key))return cache.get(key);const task=Promise.resolve().then(()=>producer({publishRecord:async item=>{published++;await durable.save(item);}}));cache.set(key,task);try{return await task;}catch(error){cache.delete(key);throw error;}};
  const deps={env:{X_BEARER_TOKEN:'fixture-never-live'},store:durable,now:()=>NOW,sourceJSON:async(_,url)=>{calls++;return {as_of:new Date(NOW).toISOString(),data:url.includes('/by/username/')?{data:{id:'123',username:url.split('/').at(-1)}}:{data:[{id:'111',text:'Los Angeles Lakers availability update',created_at:new Date(NOW-60000).toISOString()}]}};}};
  assert.equal((await publicXFeed({topic:'nba',maximumAccounts:1,enabled:true},deps)).status,'budget_reached');assert.equal(calls,0);assert.equal(cache.size,0);
  cache.set('x-user#ShamsCharania',Promise.resolve({unavailable:true}));
  allowed=true;assert.equal((await publicXFeed({topic:'nba',maximumAccounts:1,enabled:true},deps)).status,'available');assert.equal(calls,2);assert.equal(published,1);assert.equal((await durable.get('x-cursor#ShamsCharania')).newest_id,'111');assert.ok(cache.has('x-user-v2#ShamsCharania'));
});
test('a lost Postgres lease cannot publish an X cursor or trigger a provider rate-limit cooldown',async()=>{
  const durable=memoryStore();durable.kind='postgres';let calls=0;
  durable.cached=async(key,ttl,producer)=>producer({publishRecord:async()=>{throw Object.assign(new Error('Lost synthetic lease'),{status:429,code:'CACHE_LEASE_LOST'});}});
  const value=await publicXFeed({topic:'nba',maximumAccounts:1,enabled:true},{env:{X_BEARER_TOKEN:'fixture-never-live'},store:durable,now:()=>NOW,sourceJSON:async(_,url)=>{calls++;return {as_of:new Date(NOW).toISOString(),data:url.includes('/by/username/')?{data:{id:'123',username:url.split('/').at(-1)}}:{data:[{id:'111',text:'Los Angeles Lakers availability update',created_at:new Date(NOW-60000).toISOString()}]}};}});
  assert.equal(calls,2);assert.equal(value.status,'refreshing');assert.equal(await durable.get('x-cursor#ShamsCharania'),undefined);assert.equal(await durable.get('x-public-cooldown'),undefined);
});
test('a busy shared X refresh is not an upstream rate limit and cannot create a global cooldown',async()=>{
  const durable=memoryStore();let calls=0;durable.cached=async()=>{throw Object.assign(new Error('Synthetic shared refresh contention'),{status:429,code:'CACHE_LEASE_BUSY'});};
  const value=await publicXFeed({topic:'nba',maximumAccounts:1,enabled:true},{env:{X_BEARER_TOKEN:'fixture-never-live'},store:durable,now:()=>NOW,sourceJSON:async()=>{calls++;}});
  assert.equal(value.status,'refreshing');assert.equal(calls,0);assert.equal(await durable.get('x-public-cooldown'),undefined);
});
test('provider waits preserve HTTP-date and X-reset backoff rather than hammering retries',()=>{
  assert.equal(retryDelay(new Headers({'retry-after':'Wed, 05 Nov 2026 02:00:00 GMT'}),429,NOW),3600000);
  assert.equal(retryDelay(new Headers({'x-rate-limit-reset':String((NOW+120000)/1000)}),429,NOW),120000);
});
test('X persists a longer upstream retry deadline across processes',async()=>{
  const durable=memoryStore(),until=NOW+7200000;
  await publicXFeed({topic:'nba',enabled:true,maximumAccounts:1},{env:{X_BEARER_TOKEN:'fixture-never-live'},store:durable,now:()=>NOW,sourceJSON:async()=>{throw Object.assign(new Error('rate limited'),{status:429,retry_at:new Date(until).toISOString()});}});
  assert.equal((await durable.get('x-public-cooldown')).until,until);
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
