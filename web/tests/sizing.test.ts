import test from 'node:test';
import assert from 'node:assert/strict';
import { sizePaperPosition, type SizingInput } from '../lib/paper/risk';
const now=Date.parse('2026-11-04T12:00:00Z');
const fixture: SizingInput={ticker:'TEST',quoteTicker:'TEST',asOf:new Date(now).toISOString(),bankroll:100,
  budget:30,probabilityLow:.6,probabilityHigh:.7,riskFraction:.3,levels:[{price:.4,quantity:100}],feeCoefficient:0,maxContracts:100};
test('sizing matches an independent exhaustive one-level calculation',()=>{
  const result=sizePaperPosition(fixture,now);
  const candidates=Array.from({length:76},(_,q)=>({q,value:.6*Math.log(100+q*.6)+.4*Math.log(100-q*.4)}));
  candidates.sort((a,b)=>b.value-a.value);
  assert.equal(result.contracts,candidates[0].q);
  assert.ok(result.cost<=30);
});
test('negative worst-case edge chooses no position',()=>assert.equal(sizePaperPosition({...fixture,probabilityLow:.2},now).contracts,0));
test('stale, mismatched and ruinous inputs are rejected',()=>{
  for(const input of [{...fixture,asOf:new Date(now-91000).toISOString()},{...fixture,quoteTicker:'OTHER'},
    {...fixture,riskFraction:1},{...fixture,levels:[{price:NaN,quantity:5}]}])assert.throws(()=>sizePaperPosition(input,now));
});
test('fractional depth and fees cannot exceed budget',()=>{
  const result=sizePaperPosition({...fixture,levels:[{price:.4,quantity:2.5},{price:.6,quantity:3.5}],feeCoefficient:.07},now);
  assert.ok(result.contracts<=6 && result.cost<=30);
});
