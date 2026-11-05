import test from 'node:test';
import assert from 'node:assert/strict';
import {fitBasketball,fitSoccer,evaluateSports,teamForm,lowMinutesSplit} from '../lib/workspace/sports-math.mjs';
import {parseGames,parseMinutes,matchGame,sportsContractDate,bookmakerComparison} from '../lib/workspace/sports.mjs';
import {parseApple,rankPersistence,musicIdentity} from '../lib/workspace/music.mjs';
import {workspaceMarkets,inferCategory,selectSeries,WORKSPACE_CATEGORIES} from '../lib/workspace/catalog.mjs';
import {screenSportsForecast,workspaceResearch,workspaceOpinions,candleRows} from '../lib/workspace/router.mjs';

test('a fully rate-limited category preserves the provider retry interval',async()=>{
  const failure=Object.assign(new Error('Kalshi cooldown'),{upstream_status:429,retry_after_seconds:60});
  await assert.rejects(workspaceMarkets('sports',{
    maximumSeries:1,catalogGetter:async()=>({rows:[{ticker:'KXNBAGAME',category:'Sports',categories:[],volume:1}]}),
    getter:async()=>{throw failure;},
  }),error=>error===failure);
});
const NOW=Date.now(),ticker='KXNBAGAME-26NOV07SASPOR-SAS';
const market={ticker,event_ticker:'KXNBAGAME-26NOV07SASPOR',title:'San Antonio wins',yes_sub_title:'San Antonio',status:'active',
  close_time:new Date(NOW+86400000).toISOString(),rules_primary:'If San Antonio wins the San Antonio vs Portland Pro Basketball game originally scheduled for Nov 7, 2026, then the market resolves to Yes.'};
const depth={ticker,as_of:new Date(NOW).toISOString(),raw:{orderbook_fp:{yes_dollars:[['0.19','100']],no_dollars:[['0.80','100']]}}};
const forecast={probability:.85,interval:[.8,.9],eligible:true,source_as_of:new Date(NOW).toISOString()};
function syntheticGames(n=520){
  let seed=617;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  return Array.from({length:n},(_,i)=>{const h=String(i%5),a=String((i+1+Math.floor(i/5)%4)%5),p=1/(1+Math.exp(-(.2+(Number(a)-Number(h))*.45))),win=random()<p;
    return {id:String(i),played_at:new Date(Date.UTC(2023,0,1)+i*86400000).toISOString(),home_id:h,away_id:a,
      home_score:win?110:95,away_score:win?95:110};});
}
test('sports parsers preserve zero scores, reject missing/boolean scores and restrict league identity',()=>{
  const event={id:'1',date:'2026-01-01T12:00:00Z',league:{slug:'eng.1'},competitions:[{status:{type:{completed:true}},competitors:[
    {homeAway:'home',team:{id:'a',displayName:'A'},score:{value:0}},{homeAway:'away',team:{id:'b',displayName:'B'},score:'0'}]}]};
  assert.equal(parseGames({events:[event]},'epl',NOW)[0].home_score,0);
  const bad=structuredClone(event);bad.competitions[0].competitors[0].score=false;assert.equal(parseGames({events:[bad]},'epl',NOW).length,0);
  bad.league.slug='eng.fa';assert.equal(parseGames({events:[bad]},'epl',NOW).length,0);
  assert.equal(parseGames({season:{type:1},events:[event]},'nba',NOW).length,0);
});
test('sports event date includes contiguous team codes and uses the competition calendar day',()=>{
  const teams=[{id:'a',aliases:['san antonio']},{id:'b',aliases:['portland']}],game={id:'g',played_at:'2026-11-08T04:00:00Z',home_id:'a',away_id:'b'};
  assert.equal(sportsContractDate(market),'2026-11-07');
  assert.equal(sportsContractDate({...market,event_ticker:'KXNBAGAME-26FEB30SASPOR'}),null);
  const data={league:'nba',teams,scheduled:[game],games:[]};
  assert.equal(matchGame(market,data).side,'home');
  assert.match(matchGame(market,{...data,scheduled:[{...game,played_at:'2026-11-07T04:00:00Z'}]}).reason,/match/);
  assert.match(matchGame({...market,yes_sub_title:'Unknown'},data).reason,/YES outcome/);
});
test('boxscore minutes preserve explicit DNP and exclude absent or unparseable players',()=>{
  const rows=parseMinutes({header:{id:'g'},boxscore:{players:[{team:{id:'a'},statistics:[{names:['MIN'],athletes:[
    {athlete:{id:'1',displayName:'One'},stats:['12:30']},{athlete:{id:'2'},didNotPlay:true,stats:[]},{athlete:{id:'3'},stats:['—']}]}]}]}});
  assert.deepEqual(rows.map(r=>[r.player_id,r.minutes]),[['1',12.5],['2',0]]);
  const split=lowMinutesSplit([{id:'g',home_id:'a',away_id:'b',home_score:0,away_score:1}],rows,'a','2');
  assert.equal(split.low.n,1);assert.equal(split.regular.n,0);assert.match(split.note,/Missing boxscore/);
});
test('sparse matchup models produce finite normalized outcomes and chronological evaluations',()=>{
  const games=syntheticGames(),fit=fitBasketball(games),p=fit.predict('0','4');
  assert.ok(p.home>.6);assert.ok(Math.abs(p.home+p.away-1)<1e-12);assert.ok(p.interval[0]<=p.home&&p.home<=p.interval[1]);
  assert.equal(fit.predict('unknown','1'),null);
  const evaluation=evaluateSports(games,'nba');assert.ok(evaluation.train_end<evaluation.test_start);assert.ok(evaluation.n>=100);assert.ok(evaluation.weekly_blocks>=12);
  assert.ok(evaluation.brier>=0&&evaluation.brier<=1);assert.match(evaluation.protocol,/week blocks/);
  const soccer=fitSoccer(games.slice(0,100).map((g,i)=>({...g,home_score:i%4,away_score:(i+1)%3}))).predict('0','1');
  assert.ok(soccer.draw>0);assert.ok(Math.abs(soccer.home+soccer.draw+soccer.away-1)<1e-12);assert.ok(soccer.omitted_tail<1e-8);
  assert.throws(()=>fitSoccer([{...games[0],home_score:null}]),/integer scores/);
});
test('recent form excludes the cutoff and future games',()=>{
  const games=syntheticGames(20),cutoff=Date.parse(games[10].played_at),form=teamForm(games,'0',cutoff);
  assert.ok(form.games>0&&form.games<=10);
  assert.deepEqual(form,teamForm(games.map(g=>Date.parse(g.played_at)>=cutoff?{...g,home_score:999,away_score:0}:g),'0',cutoff));
});
test('bookmaker comparison removes the quoted margin and never turns a missing quote into zero',()=>{
  const result=bookmakerComparison([{provider:{name:'Example'},moneyline:{home:{close:{odds:'-110'}},away:{close:{odds:'-110'}}}}],'nba');
  assert.equal(result.probabilities.home,.5);assert.ok(result.overround>0);assert.match(result.note,/not an independent forecast/);
  assert.equal(bookmakerComparison([{moneyline:{home:{close:{odds:null}}}}],'nba'),null);
});
test('cost screen uses opposite-side uncertainty bound and fails closed for stale, partial or wrong-ticker depth',()=>{
  assert.equal(screenSportsForecast(market,forecast,depth,{now:NOW}).side,'yes');
  const noDepth={...depth,raw:{orderbook_fp:{yes_dollars:[['0.80','100']],no_dollars:[['0.19','100']]}}};
  const no=screenSportsForecast(market,{...forecast,probability:.1,interval:[.05,.15]},noDepth,{now:NOW});
  assert.equal(no.side,'no');assert.equal(no.candidates.find(c=>c.side==='no').lower_probability,.85);
  for(const bad of [{...depth,ticker:'OTHER'},{...depth,as_of:new Date(NOW-120000).toISOString()},
    {...depth,raw:{orderbook_fp:{yes_dollars:[['.19','.5']],no_dollars:[['.80','.5']]}}}]){
    assert.equal(screenSportsForecast(market,forecast,bad,{now:NOW}).side,'insufficient_edge');
  }
  assert.equal(screenSportsForecast(market,{...forecast,eligible:false},depth,{now:NOW}).side,'insufficient_edge');
});
test('passing holdout with incomplete coverage is withheld with the same precise reason in full and assistant research',async()=>{
  const coverage={schedules_expected:90,schedules_returned:88,partial:true};
  const passing={...forecast,eligible:false,validation:{passed:true,n:514,brier_skill:.17}};
  const decision=screenSportsForecast(market,passing,depth,{now:NOW,coverage});
  assert.equal(decision.side,'insufficient_edge');assert.match(decision.reasons[0],/historical holdout passed, but only 88 of 90/);assert.ok(!decision.reasons.join(' ').includes('not passed'));
  assert.equal(screenSportsForecast(market,{...passing,eligible:true},depth,{now:NOW,coverage}).side,'insufficient_edge');
  const brief={ticker,as_of:new Date().toISOString(),market,forecast:{probability:null},decision:{side:'insufficient_edge',reasons:['No independent model']},sources:[],errors:[],summary:'Evidence only'};
  const deps={marketDetails:async()=>({market}),book:async()=>depth,marketFees:async()=>({coefficient:.07}),marketBrief:async()=>brief,
    sportsResearch:async()=>({forecast:passing,coverage}),musicResearch:async()=>null,chartPosts:async()=>({posts:[]})};
  const values=await Promise.all([{}, {assistant:true}, {fast:true}].map(options=>workspaceResearch(ticker,options,deps)));
  assert.ok(values.every(value=>value.opinion.side==='PASS'&&value.opinion.reason===decision.reasons[0]));
  assert.ok(values.every(value=>value.forecast.evidence.label==='Holdout passed; source coverage incomplete'));
});
test('Apple identity, chart dates and ordinal rank history remain source-specific',()=>{
  const payload={feed:{country:'us',updated:new Date(NOW).toISOString(),results:[{id:'123',name:'Track',artistName:'Artist',url:'https://music.apple.com/us/song/123'}]}};
  const chart=parseApple(payload,NOW);assert.equal(chart.tracks[0].rank,1);assert.match(chart.note,/does not report stream counts/i);
  assert.throws(()=>parseApple({feed:{...payload.feed,country:'gb'}},NOW),/identity/);
  assert.throws(()=>rankPersistence([{date:'2026-02-30',value:1}]),/Dated/);
  assert.equal(rankPersistence([{date:'2026-01-01',value:1},{date:'2026-01-02',value:2}]).probability,null);
  const history=Array.from({length:220},(_,i)=>({date:new Date(Date.UTC(2025,0,1)+i*86400000).toISOString().slice(0,10),value:i%3===0?2:1}));
  const estimate=rankPersistence(history);assert.ok(estimate.n>=30);assert.ok(estimate.interval[0]<=estimate.probability&&estimate.probability<=estimate.interval[1]);assert.match(estimate.reason,/survivorship/);
});
test('candle nulls are not zero while real zero prices and volume survive',()=>{
  const rows=candleRows({candlesticks:[{end_period_ts:100,price:{close_dollars:null},yes_bid:{close_dollars:null},yes_ask:{close_dollars:null}},
    {end_period_ts:101,price:{close_dollars:'0'},volume_fp:'0'},{end_period_ts:999,price:{close_dollars:'.4'}}]},500);
  assert.equal(rows.length,1);assert.equal(rows[0].value,0);assert.equal(rows[0].volume,0);
});
test('catalog samples reject unknown close/status and preserve partial-source coverage',async()=>{
  const value=await workspaceMarkets('sports',{maximumSeries:1,catalogGetter:async()=>({rows:[{ticker:'KXNBAGAME',category:'Sports',categories:[],volume:1}],errors:['one source unavailable']}),getter:async()=>({as_of:new Date().toISOString(),source_url:'https://external-api.kalshi.com/trade-api/v2/markets',data:{markets:[market,{...market,ticker:'BAD',close_time:null},{...market,ticker:'BAD2',status:'closed'}]}})});
  assert.equal(value.markets.length,1);assert.equal(value.partial,true);assert.equal(inferCategory({ticker:'UNKNOWN-X'}),'other');
});
test('fast research does not call music or paid X, and assistant excludes Spotify requests',async()=>{
  let musicCalls=0,postCalls=0,musicOptions;
  const brief={ticker,as_of:new Date().toISOString(),market,forecast:{probability:null},decision:{side:'insufficient_edge',reasons:['No independent model']},sources:[],errors:[],summary:'Evidence only'};
  const deps={marketDetails:async()=>({market}),book:async()=>depth,marketFees:async()=>({coefficient:.07}),
    marketBrief:async(_,__,options)=>{assert.equal(typeof options.headlines,'function');return brief;},sportsResearch:async()=>null,
    musicResearch:async(_,options)=>{musicCalls++;musicOptions=options;return null;},chartPosts:async()=>{postCalls++;return {posts:[]};}};
  const compact=await workspaceResearch(ticker,{fast:true},deps);assert.equal(compact.opinion.side,'PASS');assert.equal(compact.opinion.supported_allocation,0);assert.equal(musicCalls,0);assert.equal(postCalls,0);
  await workspaceResearch(ticker,{assistant:true},deps);assert.equal(musicOptions.includeSpotify,false);assert.equal(postCalls,0);
});
test('opinion batches bound work, preserve identity and isolate source errors',async()=>{
  let active=0,maximum=0;
  const result=await workspaceOpinions('ONE-X,TWO-X,THREE-X',{research:async(t,options)=>{assert.equal(options.fast,true);active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,5));active--;if(t==='TWO-X')throw new Error('upstream');return {ticker:t,opinion:{side:'PASS',reason:'Evidence only'},forecast:{probability:null}};}});
  assert.deepEqual(result.opinions.map(o=>o.ticker),['ONE-X','TWO-X','THREE-X']);assert.equal(maximum,2);assert.equal(result.opinions[1].supported_allocation,0);
  await assert.rejects(workspaceOpinions(Array.from({length:9},(_,i)=>'SERIES-'+i).join(',')),/one to eight/);
});
test('active Billboard music series remains in the bounded Culture sample before high-volume film markets',()=>{
  const category=WORKSPACE_CATEGORIES.find(c=>c.id==='culture'),rows=[
    {ticker:'KXRANKLIST1SONG',title:'Billboard Hot 100 #1 song',category:'Entertainment',categories:[],volume:10},
    ...Array.from({length:12},(_,i)=>({ticker:'FILM'+i,title:'Film market',category:'Entertainment',categories:[],volume:100000-i}))];
  assert.equal(selectSeries(category,rows,8)[0].ticker,'KXRANKLIST1SONG');
  assert.ok(!category.preferred.includes('KXSPOTIFYD'));assert.ok(!category.preferred.includes('KXTOPARTIST'));
});
test('a Billboard song outcome cannot become a Spotify artist search identity',()=>{
  assert.equal(musicIdentity({ticker:'KXRANKLIST1SONG-26NOV28-THR',title:'Which song will be #1 on Billboard Hot 100?',yes_sub_title:'Thriller',rules_primary:'If Thriller is the number one song, then Yes.'}).artist,null);
  assert.equal(musicIdentity({title:'Who will be the top Spotify artist this year?',yes_sub_title:'BTS',custom_strike:{Artist:'BTS'}}).artist,'BTS');
});
