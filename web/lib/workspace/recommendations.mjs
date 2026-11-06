import {executionCurve,affordableQuantity,riskConstrainedSize} from './execution-curve.mjs';
import {usableForecast} from './positions.mjs';

export function budgetScenario(curve,{budget,probability,interval,targetMultiplier=2}={}) {
  if(!Number.isFinite(budget)||budget<=0||budget>10000||!Number.isFinite(probability)||probability<0||probability>1||!Array.isArray(interval)||interval.length!==2||!interval.every(Number.isFinite)||interval[0]<0||interval[0]>probability||interval[1]<probability||interval[1]>1||!Number.isFinite(targetMultiplier)||targetMultiplier<=1||targetMultiplier>100)throw new RangeError('Review the paper budget and probability range');
  const contracts=affordableQuantity(curve,budget),execution=curve.quote(contracts),cost=execution.cash,unspent=budget-cost;
  const win=unspent+contracts,lose=unspent,target=budget*targetMultiplier;
  const hitWin=win>=target-1e-9,hitLose=lose>=target-1e-9;
  const chance=p=>(hitWin?p:0)+(hitLose?1-p:0);
  const endpoints=interval.map(chance);
  return {contracts,cost,price:execution.vwap,payout_if_win:contracts,profit_if_win:contracts-cost,loss_if_lose:cost,
    unspent_cash:unspent,win_value:win,lose_value:lose,expected_profit:probability*contracts-cost,
    expected_profit_range:interval.map(p=>p*contracts-cost),expected_return:budget?(probability*contracts-cost)/budget:null,
    chance_double:{probability:chance(probability),interval:[Math.min(...endpoints),Math.max(...endpoints)],possible:hitWin||hitLose,target,win_value:win,lose_value:lose,
      reason:hitWin?'This target is reached only if the selected side settles at $1; the probability comes from the selected independent model.':'Even a winning $1 settlement cannot reach this target after entry costs and unspent cash are included.'},
    execution,scope:'One binary settlement scenario using current ask depth and modeled entry fees. The budget includes unspent cash. It does not estimate the chance of touching a price before settlement.'};
}

export function tradeCandidates(market,book,research,{budget=20,now=Date.now(),coefficient=.07,slippage=2,bufferCents=2,experimental=false}={}) {
  if(!Number.isFinite(bufferCents)||bufferCents<0||bufferCents>25)throw new RangeError('Invalid execution buffer');
  const f=usableForecast(research,now,market.ticker),reason=f.reason||research?.opinion?.reason;
  if(research?.forecast?.outcomes)return [];
  if(!f.valid||!f.fresh)return [{ticker:market.ticker,title:market.yes_sub_title||market.title,event_ticker:market.event_ticker,side:'PASS',eligible:false,scenario_eligible:false,probability:null,interval:null,reasons:[reason||'Independent probability unavailable.']}];
  const open=['active','open'].includes(market.status)&&Date.parse(market.close_time)>now;
  const isExperimental=Boolean(research.forecast?.experimental),rows=[];
  for(const side of ['yes','no']) {
    const p=side==='yes'?f.probability:1-f.probability,range=side==='yes'?f.interval:[1-f.interval[1],1-f.interval[0]];
    try{
      const curve=executionCurve(book,market.ticker,side,'buy',{now,coefficient,slippage});
      const scenario=budgetScenario(curve,{budget,probability:p,interval:range});
      const conservativeEdge=scenario.contracts?range[0]-(scenario.cost/scenario.contracts)-bufferCents/100:null;
      const pointEdge=scenario.contracts?p-(scenario.cost/scenario.contracts)-bufferCents/100:null;
      const favorable=open&&scenario.contracts>0&&conservativeEdge>0;
      const scenarioEligible=open&&scenario.contracts>0&&pointEdge>0&&f.fresh&&experimental&&isExperimental&&
        (research.forecast.availability_feedback?.status!=='available'||favorable);
      const eligible=favorable&&f.eligible;
      const maxPrice=Math.max(0,range[0]-bufferCents/100);
      rows.push({ticker:market.ticker,title:market.yes_sub_title||market.title,event_ticker:market.event_ticker,side:side.toUpperCase(),category:market.category,
        probability:p,interval:range,probability_yes:f.probability,interval_yes:f.interval,model:f.model,experimental:isExperimental,eligible,scenario_eligible:scenarioEligible,
        ...scenario,conservative_edge:conservativeEdge,point_edge:pointEdge,max_entry_price:maxPrice,entry_price_range:scenario.contracts&&scenario.cost/scenario.contracts<=maxPrice?[scenario.cost/scenario.contracts,maxPrice]:null,
        max_entry_price_note:'All-in unit-cost ceiling, including entry fees, at the lower probability bound minus the explicit buffer. It is not a guaranteed limit-order fill.',
        risk_size:scenario.contracts?riskConstrainedSize(curve,{bankroll:budget,budget,probabilityLow:range[0]}):null,
        reasons:[!open?'The contract is not confirmed open.':!scenario.contracts?'No whole contract fits the budget and available depth.':
          scenarioEligible&&!favorable?'Experimental paper candidate: the point estimate clears costs and buffer; the lower uncertainty bound does not. Risk-constrained size may remain zero.':
          !favorable?'The lower probability bound does not clear all-in entry cost plus the buffer.':
          eligible?'The released model lower bound clears this budget-sized execution and buffer.':
          scenarioEligible?'Experimental paper candidate: the cost screen passes, but the challenger has not passed its promotion gate.':reason||'The model release gate is incomplete.'],
        quote_as_of:book.as_of,source_as_of:research.forecast.source_as_of,max_source_age_seconds:research.forecast.max_source_age_seconds,inplay:Boolean(research.forecast.inplay),classification:isExperimental?'EXPERIMENTAL_PAPER_SCENARIO':'PAPER_RESEARCH_SCENARIO',paper_only:true,estimated:true,
        entry_buffer_cents:bufferCents,fee_coefficient:coefficient,close_time:market.close_time});
    }catch(error){rows.push({ticker:market.ticker,title:market.yes_sub_title||market.title,event_ticker:market.event_ticker,side:side.toUpperCase(),probability:p,interval:range,eligible:false,scenario_eligible:false,reasons:[error.message]});}
  }
  return rows;
}

export function eventConflictGraph(candidates) {
  const groups=new Map(),nodes=candidates.map((row,index)=>({id:index,ticker:row.ticker,side:row.side,event:row.event_ticker||row.ticker})),edges=[];
  for(const node of nodes){const previous=groups.get(node.event)||[];for(const id of previous)edges.push({from:id,to:node.id,reason:'Shared event; payouts and information can overlap.'});previous.push(node.id);groups.set(node.event,previous);}
  return {nodes,edges,scope:'Known event overlap graph. One ranked exposure per event; cross-event correlations are not assumed independent.'};
}

export function rankCandidates(candidates,{experimental=false,maximum=12}={}) {
  const score=row=>experimental?row.point_edge??row.conservative_edge:row.conservative_edge;
  const sorted=[...candidates].sort((a,b)=>Number(Boolean(b.eligible||experimental&&b.scenario_eligible))-Number(Boolean(a.eligible||experimental&&a.scenario_eligible))||
    (score(b)??-Infinity)-(score(a)??-Infinity)||(b.expected_profit??-Infinity)-(a.expected_profit??-Infinity)||String(a.ticker).localeCompare(String(b.ticker)));
  const events=new Set(),ranked=[],watchlist=[];
  for(const row of sorted){const event=row.event_ticker||row.ticker;if((row.eligible||experimental&&row.scenario_eligible)&&!events.has(event)&&ranked.length<maximum){events.add(event);ranked.push(row);}else watchlist.push(row);}
  return {candidates:ranked,watchlist:watchlist.slice(0,maximum),overlap_graph:eventConflictGraph(sorted),
    ranking_method:(experimental?'Experimental point-estimate all-in edge, with lower-bound risk shown separately. ':'Conservative lower-bound all-in edge. ')+'Then expected dollars, with one exposure per known event. These are alternative per-contract budget scenarios, not a combined portfolio allocation.'};
}
