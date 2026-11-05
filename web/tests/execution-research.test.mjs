import test from 'node:test';
import assert from 'node:assert/strict';
import {executionResearch,normalizeExecutionControls,almgrenChrissSchedule} from '../lib/workspace/execution-research.mjs';
import {contiguousBookHistory,exponentialHawkesLikelihood,fitOrderFlowChallenger,quoteArrivalResearch} from '../lib/workspace/microstructure-model.mjs';
import {executionCurve} from '../lib/workspace/execution-curve.mjs';

const NOW=Date.parse('2026-11-05T03:00:00Z');
const fixture=(category='sports')=>({market:{ticker:'FIXTURE-'+category,category,status:'active'},book:{ticker:'FIXTURE-'+category,as_of:new Date(NOW).toISOString(),raw:{orderbook_fp:{yes_dollars:[['0.48','100'],['0.46','50']],no_dollars:[['0.48','100'],['0.46','50']]}}},forecast:{valid:true,fresh:true,eligible:true,probability:.65,interval:[.61,.69],model:'supplied fixture',source_as_of:new Date(NOW).toISOString()},now:NOW});
const event=(sequence,bid_price=.48,bid_size=100,ask_price=.52,ask_size=100,time_seconds=sequence,generation='a')=>({sequence,bid_price,bid_size,ask_price,ask_size,time_seconds,generation});

function signalHistory({count=512,seed=127,signal=true,clustered=false}={}){
  let state=seed>>>0,mid=.5,previousImbalance=0,time=0;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;},rows=[];
  for(let i=0;i<count;i++){
    mid=Math.max(.2,Math.min(.8,mid+(signal?.004*previousImbalance:0)+(random()-.5)*.001));
    const imbalance=(random()-.5)*1.5;time+=clustered?(i%8===0?4:.015):.1+random();rows.push(event(i,mid-.01,100*(1+imbalance),mid+.01,100*(1-imbalance),time));previousImbalance=imbalance;
  }
  return rows;
}

test('OFI matches independent price-change and same-price queue arithmetic and resets only the contiguous segment',()=>{
  const parsed=contiguousBookHistory([event(0),event(1,.48,130,.52,90),event(2,.49,50,.53,70),event(3,.48,80,.52,90)]);
  assert.deepEqual(parsed.rows.map(row=>row.ofi),[null,40,140,-140]);
  assert.equal(contiguousBookHistory([event(0),event(2)]).rows.length,1);
  assert.equal(contiguousBookHistory([event(0),event(1,.48,100,.52,100,1,'b')]).rows.length,1);
  const tied=contiguousBookHistory([event(0),event(1,.48,120,.52,80,0)]);assert.equal(tied.rows.length,2);assert.equal(tied.timestamp_ties,1);assert.equal(tied.rows[1].ofi,40);
  assert.equal(contiguousBookHistory([event(0,.48,1e308,.52,1e308)]).rows.length,0);
});

test('Hawkes recursive likelihood and compensator equal an independent quadratic implementation including pre-window history',()=>{
  const times=[1,1.2,1.7,3,4.5],history=[-.8,-.2],parameters={mu:.7,alpha:.5,beta:1.2,start:0,end:6,history};
  const expected=times.reduce((sum,time)=>sum+Math.log(parameters.mu+parameters.alpha*[...history,...times.filter(previous=>previous<time)].reduce((s,previous)=>s+Math.exp(-parameters.beta*(time-previous)),0)),0)-parameters.mu*6-parameters.alpha/parameters.beta*(history.reduce((sum,time)=>sum+Math.exp(parameters.beta*time)*(1-Math.exp(-parameters.beta*6)),0)+times.reduce((sum,time)=>sum+1-Math.exp(-parameters.beta*(6-time)),0));
  assert.ok(Math.abs(exponentialHawkesLikelihood(times,parameters).log_likelihood-expected)<1e-12);
  for(const bad of [{...parameters,alpha:2},{...parameters,beta:0},{...parameters,end:1}])assert.throws(()=>exponentialHawkesLikelihood(times,bad),RangeError);
});

test('discrete execution optimum agrees with exhaustive coarse-grid search, conserves quantity and includes timing-risk cost',()=>{
  const p={contracts:10,horizon_seconds:180,steps:3,risk_aversion:.4,temporary_impact:.05,volatility:.2},optimal=almgrenChrissSchedule(p),twap=almgrenChrissSchedule({...p,optimal:false});
  const objective=(x,y)=>.05*((10-x)**2+(x-y)**2+y*y)+.4*.2**2*(x*x+y*y);
  let exhaustive=Infinity;for(let x=0;x<=10.0001;x+=.05)for(let y=0;y<=x+.0001;y+=.05)exhaustive=Math.min(exhaustive,objective(x,y));
  assert.ok(optimal.objective<=exhaustive+1e-9);assert.ok(optimal.objective<twap.objective);
  assert.ok(Math.abs(optimal.rows.reduce((sum,row)=>sum+row.contracts,0)-10)<1e-9);assert.equal(optimal.rows.at(-1).remaining,0);
  assert.ok(optimal.rows.every((row,i)=>row.contracts>=0&&(!i||row.remaining<=optimal.rows[i-1].remaining)));
  assert.deepEqual(almgrenChrissSchedule({...p,risk_aversion:0}).rows,almgrenChrissSchedule({...p,risk_aversion:0,optimal:false}).rows);
  assert.ok(almgrenChrissSchedule({...p,risk_aversion:10,temporary_impact:1e-8,volatility:1,steps:60}).rows.every(row=>Number.isFinite(row.contracts)&&row.contracts>=0));
});

test('next-quote challenger uses chronological splits and future holdout outcomes cannot change fitted parameters',()=>{
  const rows=signalHistory(),model=fitOrderFlowChallenger(rows);assert.equal(model.available,true);assert.equal(model.evaluation.passed,true);assert.equal(model.applied,true);
  assert.equal(model.affects_settlement_probability,false);assert.ok(model.evaluation.holdout_n>=30);
  const mutated=rows.map((row,i)=>i>450?{...row,bid_price:row.bid_price+.05,ask_price:row.ask_price+.05}:row),again=fitOrderFlowChallenger(mutated);assert.deepEqual(model.parameters,again.parameters);
  const disabled=fitOrderFlowChallenger(rows,{enabled:false});assert.equal(disabled.applied_next_mid_change,0);assert.equal(disabled.validation_status,'disabled');
  const empty=fitOrderFlowChallenger(Array.from({length:200},(_,i)=>event(i)));assert.equal(empty.applied,false);assert.equal(empty.evaluation.zero_change_baseline_mse,0);
});

test('quote-arrival clustering changes the explicit risk scenario only when enabled and validated; tied times withhold fitting',()=>{
  const rows=signalHistory({clustered:true}),on=quoteArrivalResearch(rows),off=quoteArrivalResearch(rows,{enabled:false});
  assert.equal(on.available,true);assert.equal(on.evaluation.passed,true);assert.ok(on.branching_ratio>=0&&on.branching_ratio<1);assert.notEqual(on.risk_multiplier,1);assert.equal(off.risk_multiplier,1);
  const tied=rows.map((row,i)=>i===1?{...row,time_seconds:rows[0].time_seconds}:row);assert.equal(quoteArrivalResearch(tied).validation_status,'tied_receive_timestamps');
  const upperBound=executionResearch({...fixture(),book_history:rows,controls:{volatility:1}});assert.ok(upperBound.assumptions.effective_volatility>1);assert.ok(upperBound.schedule.rows.every(row=>Number.isFinite(row.contracts)));
});

test('first held-out arrival time cannot alter Hawkes fitted parameters or the training Poisson rate',()=>{
  const rows=signalHistory({clustered:true}),split=Math.floor((rows.length-1)*.7),firstHeldout=split+1,mutated=rows.map((row,i)=>i===firstHeldout?{...row,time_seconds:rows[firstHeldout-1].time_seconds+.001}:row),before=quoteArrivalResearch(rows),after=quoteArrivalResearch(mutated);
  assert.deepEqual(before.parameters,after.parameters);assert.equal(before.poisson_rate_per_second,after.poisson_rate_per_second);assert.equal(before.evaluation.training_end_time,after.evaluation.training_end_time);
  assert.notEqual(before.evaluation.holdout_log_likelihood_gain,after.evaluation.holdout_log_likelihood_gain);
});

test('observed connected idle time decays the current arrival intensity without refitting on future observations',()=>{
  const rows=signalHistory({clustered:true}),latest=rows.at(-1).time_seconds,active=quoteArrivalResearch(rows,{observation_end_seconds:latest}),idle=quoteArrivalResearch(rows,{observation_end_seconds:latest+90});
  assert.deepEqual(active.parameters,idle.parameters);assert.ok(idle.intensity_per_second<active.intensity_per_second);assert.equal(idle.observed_idle_seconds,90);assert.equal(idle.intensity_reference,'end_of_observed_connected_window');
  assert.throws(()=>quoteArrivalResearch(rows,{observation_end_seconds:latest-1}),RangeError);
});

test('all eight categories and both sides preserve the independent probability while controls change actual scenario calculations',()=>{
  for(const category of ['sports','macro','crypto','travel','weather','science','climate','culture'])for(const side of ['yes','no']){
    const input={...fixture(category),book_history:signalHistory({clustered:true}),controls:{side,inventory:100,risk_aversion:.1}},on=executionResearch(input),off=executionResearch({...input,controls:{...input.controls,enabled:false}});
    assert.equal(on.forecast.probability,.65);assert.equal(off.forecast.probability,.65);assert.deepEqual(on.forecast.interval,[.61,.69]);
    assert.notEqual(on.schedule.rows[0].contracts,off.schedule.rows[0].contracts);assert.notEqual(on.inventory_quotes.reservation_price,off.inventory_quotes.reservation_price);
    assert.equal(on.immediate_execution.cash,executionCurve(input.book,input.market.ticker,side,'buy',{now:NOW,coefficient:.07,slippage:2}).quote(20).cash);
    assert.ok(on.schedule.objective<=on.schedule.benchmark_twap.objective+1e-8);assert.ok(on.inventory_quotes.bid>=0&&on.inventory_quotes.ask<=1&&on.inventory_quotes.bid<=on.inventory_quotes.ask);
    assert.equal(on.settlement.probability,side==='yes'?.65:.35);assert.equal(off.order_flow.applied,false);assert.equal(off.arrival_model.applied,false);
  }
});

test('missing history, unavailable or unapproved forecasts and partial depth remain explicit rather than producing fabricated decisions',()=>{
  const initial=fixture(),missing=executionResearch({...initial,forecast:null});assert.equal(missing.order_flow.available,false);assert.equal(missing.arrival_model.available,false);assert.equal(missing.settlement.decision,'REVIEW');assert.equal(missing.forecast.probability,null);
  const stale=executionResearch({...initial,forecast:{...initial.forecast,fresh:false}});assert.equal(stale.settlement.available,false);
  const experimental=executionResearch({...initial,forecast:{...initial.forecast,eligible:false}});assert.equal(experimental.settlement.decision,'REVIEW');assert.equal(experimental.settlement.scenario_decision,'HOLD');
  const partial=executionResearch({...initial,controls:{contracts:1000}});assert.equal(partial.exit_execution.complete,false);assert.equal(partial.settlement.sell_now_value,null);assert.equal(partial.settlement.decision,'REVIEW');
  assert.throws(()=>executionResearch({...initial,book:{...initial.book,ticker:'OTHER'}}),/exact contract/);
  assert.throws(()=>executionResearch({...initial,now:NOW+91000}),/90 seconds/);
});

test('control validation rejects coercion, unknown controls, oversized computation and malformed booleans',()=>{
  for(const value of [{contracts:'20'},{contracts:true},{contracts:10001},{steps:1000},{horizon_seconds:10},{volatility:NaN},{risk_aversion:-1},{order_flow:'false'},{api_key:'not-accepted'},null,[]])assert.throws(()=>normalizeExecutionControls(value),RangeError);
  assert.equal(normalizeExecutionControls({enabled:false}).enabled,false);
});
