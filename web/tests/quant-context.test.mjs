import test from 'node:test';
import assert from 'node:assert/strict';
import {kalmanContext,hmmContext,simulateScoreDiffusion,martingaleDrawdownBounds} from '../lib/workspace/quant-context.mjs';
const observations=scores=>scores.map((score,i)=>({observed_at:new Date(Date.UTC(2026,0,1,i)).toISOString(),score,source_id:'synthetic-'+i}));
const near=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);

test('Kalman updates agree with the exact conjugate Gaussian posterior and reduce low-precision influence',()=>{
  const value=kalmanContext(observations([1,1]),{priorMean:0,priorVariance:1,observationVariance:1,processVariancePerHour:0});
  near(value.states[0].filtered_context_score,.5);near(value.states[0].posterior_variance,.5);near(value.states[1].filtered_context_score,2/3);near(value.states[1].posterior_variance,1/3);
  const noisy=kalmanContext([{...observations([1])[0],measurement_variance:10}],{priorVariance:1});assert.ok(noisy.latest.filtered_context_score<value.states[0].filtered_context_score);assert.equal(value.probability_adjustment,null);assert.equal(value.affects_forecast,false);
});
test('context filtering is causal and refuses duplicate timestamps or unbounded scores',()=>{
  const prefix=observations([.2,-.1,.5]),full=[...prefix,...observations([-.9]).map(row=>({...row,observed_at:'2026-01-01T03:00:00Z'}))];
  assert.deepEqual(kalmanContext(prefix).states,kalmanContext(full).states.slice(0,3));assert.deepEqual(hmmContext(prefix).states,hmmContext(full).states.slice(0,3));
  assert.throws(()=>kalmanContext([prefix[0],prefix[0]]),/increasing timestamps/);assert.throws(()=>kalmanContext(observations([1.2])),/Context score/);
});
test('HMM forward probabilities normalize, respect sign symmetry and reject irregular observation spacing',()=>{
  const positive=hmmContext(observations([.5,.7,.8])),negative=hmmContext(observations([-.5,-.7,-.8]));
  for(const row of positive.states)near(Object.values(row.state_posterior).reduce((s,p)=>s+p,0),1);
  near(positive.latest.state_posterior.positive_context,negative.latest.state_posterior.negative_context);near(positive.latest.filtered_context_score,-negative.latest.filtered_context_score);
  assert.ok(positive.latest.state_posterior.positive_context>.8);assert.equal(positive.affects_forecast,false);
  assert.throws(()=>hmmContext(observations([.1,.2,.3]).map((row,i)=>i===2?{...row,observed_at:'2026-01-01T05:00:00Z'}:row)),/regular observation cadence/);
  assert.throws(()=>hmmContext(observations([0]),{transition:[[1,1,1],[0,1,0],[0,0,1]]}),/normalized probabilities/);
});
test('seeded diffusion matches Brownian terminal moments and increases monotonically with the starting lead',()=>{
  const parameters={margin:5,remaining_seconds:720,drift_points_per_minute:.5,volatility_points_per_sqrt_minute:2,simulations:100000,seed:71893},value=simulateScoreDiffusion(parameters);
  near(value.terminal_margin.model_mean,11);near(value.terminal_margin.model_variance,48,1e-10);near(value.terminal_margin.mean,11,.08);near(value.terminal_margin.variance,48,.5);
  assert.deepEqual(value,simulateScoreDiffusion(parameters));assert.ok(simulateScoreDiffusion({...parameters,margin:6}).scenario_home_lead_probability>=value.scenario_home_lead_probability);
  assert.equal(value.classification,'conditional_simulation_not_live_forecast');assert.match(value.note,/not the settled NBA game-win event/);assert.equal(value.probability_adjustment,null);
});
test('zero-time diffusion preserves observed ties rather than inventing an overtime win',()=>{
  const value=simulateScoreDiffusion({margin:0,remaining_seconds:0,drift_points_per_minute:0,volatility_points_per_sqrt_minute:2,simulations:100});
  assert.equal(value.scenario_tie_probability,1);assert.equal(value.scenario_home_lead_probability,0);assert.equal(value.scenario_away_lead_probability,0);
  assert.throws(()=>simulateScoreDiffusion({margin:0,remaining_seconds:-1,drift_points_per_minute:0,volatility_points_per_sqrt_minute:2}),/Remaining regulation/);
});
test('martingale bounds dominate exhaustive finite-path probabilities and distinguish initial loss from peak drawdown',()=>{
  const bounds=Array(8).fill(1),threshold=6;let initial=0,drawdown=0;
  for(let mask=0;mask<2**bounds.length;mask++){
    let value=0,peak=0,minimum=0,maximumDrawdown=0;
    for(let i=0;i<bounds.length;i++){value+=(mask>>i&1)?1:-1;peak=Math.max(peak,value);minimum=Math.min(minimum,value);maximumDrawdown=Math.max(maximumDrawdown,peak-value);}
    if(minimum<=-threshold)initial++;if(maximumDrawdown>=threshold)drawdown++;
  }
  const value=martingaleDrawdownBounds({increment_bounds:bounds,drawdown:threshold,assumptionsAcknowledged:true});
  assert.ok(initial<drawdown);assert.ok(value.maximum_loss_from_initial_upper_bound>=initial/256);assert.ok(value.peak_to_trough_drawdown_upper_bound>=drawdown/256);assert.ok(value.peak_to_trough_drawdown_upper_bound<1);assert.ok(value.peak_to_trough_drawdown_upper_bound>=value.maximum_loss_from_initial_upper_bound);
  assert.equal(martingaleDrawdownBounds({increment_bounds:bounds,drawdown:9,assumptionsAcknowledged:true}).peak_to_trough_drawdown_upper_bound,0);
  assert.equal(martingaleDrawdownBounds({increment_bounds:bounds,drawdown:6}).available,false);
  assert.throws(()=>martingaleDrawdownBounds({increment_bounds:[Infinity],drawdown:1}),/absolute increment bounds/);
});
