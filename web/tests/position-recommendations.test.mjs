import test from 'node:test';
import assert from 'node:assert/strict';
import {executionCurve,affordableQuantity,riskConstrainedSize} from '../lib/workspace/execution-curve.mjs';
import {budgetScenario,tradeCandidates,rankCandidates,eventConflictGraph} from '../lib/workspace/recommendations.mjs';
import {evaluatePaperPosition,evaluatePaperPortfolio} from '../lib/workspace/positions.mjs';
import {workspaceRecommendations,workspaceResearch} from '../lib/workspace/router.mjs';
const now=Date.parse('2026-11-04T18:00:00Z'),ticker='TEST-26NOV04-A';
const book={ticker,as_of:new Date(now).toISOString(),raw:{orderbook_fp:{yes_dollars:[['0.38','20'],['0.37','100']],no_dollars:[['0.60','20.5'],['0.59','100']]}}};
const market={ticker,event_ticker:'TEST-26NOV04',title:'Test event',status:'active',close_time:new Date(now+3600000).toISOString()};
const research={market,as_of:new Date(now).toISOString(),forecast:{probability:.8,interval:[.7,.9],source_as_of:new Date(now).toISOString(),model_name:'Independent fixture',validation:{passed:true},evidence:{tier:2},eligible:true}};
const position={ticker,side:'yes',remaining_quantity:10,remaining_basis:4.2,realized_pnl:1,entry_assumptions:{coefficient:.07}};
test('prefix execution curve matches the independently retained paper engine across fractional price levels',()=>{
  for(const action of ['buy','sell'])for(const side of ['yes','no'])for(const quantity of [0.5,1,19,20.5,30,200]){
    const curve=executionCurve(book,ticker,side,action,{now});
    const expected=globalThis.KalshiPaper.estimate(book,ticker,side,action,quantity,{now});
    const result=curve.quote(quantity);
    for(const key of ['cash','fee','notional','filled','unfilled'])assert.ok(Math.abs(result[key]-expected[key])<1e-8,`${action}/${side}/${quantity}/${key}`);
  }
});
test('budget affordability and doubling are exact binary settlement calculations including unused cash',()=>{
  const curve=executionCurve(book,ticker,'yes','buy',{now}),scenario=budgetScenario(curve,{budget:20,probability:.8,interval:[.7,.9]});
  assert.equal(scenario.contracts,affordableQuantity(curve,20));assert.ok(scenario.cost<=20);assert.ok(curve.quote(scenario.contracts+1).cash>20);
  assert.equal(scenario.chance_double.probability,.8);assert.equal(scenario.chance_double.win_value,20-scenario.cost+scenario.contracts);
  assert.equal(scenario.chance_double.lose_value,20-scenario.cost);assert.deepEqual(scenario.chance_double.interval,[.7,.9]);
  const expensive={...book,raw:{orderbook_fp:{yes_dollars:[['0.2','100']],no_dollars:[['0.4','100']]}}};
  const impossible=budgetScenario(executionCurve(expensive,ticker,'yes','buy',{now}),{budget:20,probability:.9,interval:[.8,.95]});
  assert.equal(impossible.chance_double.probability,0);assert.equal(impossible.chance_double.possible,false);
});
test('risk-constrained enumeration matches an independent exhaustive scalar Kelly calculation',()=>{
  const curve=executionCurve(book,ticker,'yes','buy',{now}),actual=riskConstrainedSize(curve,{bankroll:100,budget:20,probabilityLow:.7});
  const lambda=Math.log(.1)/Math.log(.8);let best=0,bestGrowth=0;
  for(let q=1;q<=100;q++){const execution=globalThis.KalshiPaper.estimate(book,ticker,'yes','buy',q,{now}),cost=execution.cash;if(execution.unfilled||cost>20)continue;
    const w=(100-cost+q)/100,l=(100-cost)/100,g=.7*Math.log(w)+.3*Math.log(l),moment=.7*w**(-lambda)+.3*l**(-lambda);
    if(moment<=1+1e-10&&g>bestGrowth+1e-12){best=q;bestGrowth=g;}}
  assert.equal(actual.contracts,best);assert.ok(actual.drawdown_moment<=1+1e-10);
});
test('position action uses future payoff vs current exits, independent of an unrealized price loss',()=>{
  const marked=evaluatePaperPosition(position,book,research,{now});assert.equal(marked.action,'HOLD');assert.ok(marked.unrealized_pnl<0);assert.equal(marked.total_pnl,1+marked.unrealized_pnl);
  const poor={...research,forecast:{...research.forecast,probability:.1,interval:[.05,.2]}};
  assert.equal(evaluatePaperPosition(position,book,poor,{now}).action,'EXIT');
  assert.equal(evaluatePaperPosition(position,book,research,{now,maxPositionLoss:2}).action,'TRIM');
  assert.equal(evaluatePaperPosition(position,book,null,{now,maxPositionLoss:2}).action,'TRIM');
  assert.equal(evaluatePaperPosition(position,{...book,as_of:new Date(now-91000).toISOString()},research,{now}).action,'REVIEW');
  assert.equal(evaluatePaperPosition(position,book,{...research,forecast:{...research.forecast,eligible:false}},{now}).action,'REVIEW');
});
test('partial bid depth withholds full P/L and confirmed settlement is distinguished from a bid exit',()=>{
  const partial=evaluatePaperPosition({...position,remaining_quantity:500},book,research,{now});assert.equal(partial.status,'partial');assert.equal(partial.unrealized_pnl,null);
  const settled=evaluatePaperPosition(position,null,{...research,market:{...market,status:'settled',result:'yes'}},{now});
  assert.equal(settled.action,'SETTLE');assert.equal(settled.settlement.payout,10);assert.equal(settled.marked_value,10);
  assert.equal(evaluatePaperPosition(position,null,{...research,market:{...market,status:'active',result:'yes'}},{now}).settlement.confirmed,false);
});
test('wrong-contract, failed-refresh and expired pregame packets cannot drive an action or ranking',()=>{
  const wrong={...research,ticker:'DIFFERENT',market:{...market,ticker:'DIFFERENT'}};
  const failed={...research,error:'upstream unavailable'};
  const expired={...research,extensions:{sports:{event:{played_at:new Date(now-1000).toISOString()}}}};
  for(const packet of [wrong,failed,expired,{...expired,forecast:{...expired.forecast,experimental:true}}]){
    const mark=evaluatePaperPosition(position,book,packet,{now,experimental:true});assert.equal(mark.action,'REVIEW');assert.ok(Number.isFinite(mark.marked_value));
    const candidate=tradeCandidates(market,book,packet,{now,experimental:true})[0];assert.equal(candidate.side,'PASS');assert.equal(candidate.probability,null);
  }
});
test('multiple paper lots share bid depth and cannot duplicate the best price or total available quantity',()=>{
  const lots=[{...position,id:'a',remaining_quantity:80},{...position,id:'b',remaining_quantity:80}];
  const partial=evaluatePaperPortfolio(lots,{[ticker]:book},{[ticker]:research},{now});
  assert.equal(partial.a.status,'partial');assert.equal(partial.b.status,'partial');assert.equal(partial.a.marked_value,null);assert.equal(partial.b.marked_value,null);
  const smaller=lots.map(row=>({...row,remaining_quantity:20}));
  const values=evaluatePaperPortfolio(smaller,{[ticker]:book},{[ticker]:research},{now});
  const combined=globalThis.KalshiPaper.estimate(book,ticker,'yes','sell',40,{now});
  assert.ok(values.a.marked_value+values.b.marked_value<=combined.cash+1e-8);
  assert.ok(values.a.marked_value+values.b.marked_value<2*evaluatePaperPosition(smaller[0],book,research,{now}).marked_value);
  assert.ok(values.a.shared_lots===2&&values.b.shared_lots===2);
});
test('ranking cannot duplicate a shared-event exposure or turn invalid research into a probability',()=>{
  const candidates=tradeCandidates(market,book,research,{now,budget:20});assert.equal(candidates[0].eligible,true);
  const duplicate={...candidates[0],ticker:ticker+'B',conservative_edge:.5};
  const ranked=rankCandidates([...candidates,duplicate]);assert.equal(ranked.candidates.length,1);assert.equal(ranked.candidates[0].ticker,duplicate.ticker);
  assert.ok(eventConflictGraph([...candidates,duplicate]).edges.length>0);
  const missing=tradeCandidates(market,book,{forecast:{probability:null}},{now});assert.equal(missing[0].side,'PASS');assert.equal(missing[0].probability,null);
});
test('experimental point-edge research is selectable while the formal release gate remains false',()=>{
  const experimental={...research,forecast:{...research.forecast,probability:.6,interval:[.2,.8],eligible:false,experimental:true,evidence:{tier:1}}};
  const rows=tradeCandidates(market,book,experimental,{now,budget:20,experimental:true});
  assert.equal(rows[0].eligible,false);assert.equal(rows[0].scenario_eligible,true);assert.ok(rows[0].point_edge>0);assert.ok(rows[0].conservative_edge<0);
  assert.equal(rankCandidates(rows,{experimental:true}).candidates.length,1);
  assert.equal(rankCandidates(rows).candidates.length,0);
  assert.equal(evaluatePaperPosition(position,book,experimental,{now,experimental:true}).experimental,true);
});
test('bounded recommendation scan limits unique events and preserves whole-budget scenarios',async()=>{
  const time=Date.now(),sourceDate=new Date(time).toISOString();let reads=0;
  const rows=Array.from({length:60},(_,i)=>({...market,ticker:`KXNBAGAME-26NOV04-${i}`,event_ticker:'EVENT-'+Math.floor(i/2),close_time:new Date(time+3600000).toISOString(),volume_24h:60-i}));
  const result=await workspaceRecommendations('sports',20,'baseline',{
    markets:async()=>({markets:rows,errors:[],partial:true}),
    research:async ticker=>{reads++;return {...research,market:rows.find(row=>row.ticker===ticker),forecast:{...research.forecast,source_as_of:sourceDate}};},
    batchBooks:async tickers=>new Map(tickers.map(ticker=>[ticker,{...book,ticker,as_of:sourceDate}]))});
  assert.equal(reads,3);assert.equal(result.coverage.scanned_events,12);assert.equal(result.coverage.books_returned,12);
  assert.equal(result.candidates.length,3);assert.equal(result.paper_scenarios.length,9);
  assert.equal(new Set([...result.candidates,...result.paper_scenarios].map(row=>row.event_ticker)).size,12);
  assert.ok([...result.candidates,...result.paper_scenarios].every(row=>row.cost<=20));
  await assert.rejects(workspaceRecommendations('sports',0),/budget/);
});
test('selected challenger can supply an experimental in-play forecast without inventing a pregame baseline',async()=>{
  const challenger={available:true,probability:.6,interval:[.4,.8],eligible:false,experimental:true,inplay:true,max_source_age_seconds:30,
    model_name:'Experimental live score fixture',source_as_of:new Date().toISOString(),validation:{passed:false},promotion_reason:'Explicit experimental fixture.'};
  const packet=await workspaceResearch(ticker,{model:'challenger'},{marketDetails:async()=>({market}),book:async()=>book,marketFees:async()=>({coefficient:.07}),
    marketBrief:async()=>({ticker,market,forecast:{probability:null},decision:{side:'insufficient_edge',reasons:[]},sources:[],errors:[]}),
    sportsResearch:async()=>({forecast:null,challenger,coverage:{partial:false}}),musicResearch:async()=>null,chartPosts:async()=>({posts:[]})});
  assert.equal(packet.forecast.probability,.6);assert.equal(packet.forecast.evidence.tier,1);assert.equal(packet.model_selection.applied,'challenger');assert.equal(packet.opinion.side,'PASS');
  assert.equal(packet.forecast.evidence.label,'Experimental score-clock model');
});
test('a sports source outage cannot be mislabeled as missing model coverage or reveal internal failures',async()=>{
  const packet=await workspaceResearch(ticker,{model:'challenger'},{marketDetails:async()=>({market}),book:async()=>book,marketFees:async()=>({coefficient:.07}),
    marketBrief:async()=>({ticker,market,forecast:{probability:null},decision:{side:'insufficient_edge',reasons:['No independent model is mapped.']},sources:[],errors:[]}),
    sportsResearch:async()=>{throw new Error('private database-role failure sentinel');},musicResearch:async()=>null,chartPosts:async()=>({posts:[]})});
  assert.equal(packet.status,'unavailable');assert.equal(packet.opinion.side,'PASS');assert.match(packet.opinion.reason,/could not be refreshed/);
  assert.equal(packet.forecast.probability,null);assert.ok(!JSON.stringify(packet).includes('private database-role'));assert.ok(!packet.opinion.reason.includes('No independent model'));
});
