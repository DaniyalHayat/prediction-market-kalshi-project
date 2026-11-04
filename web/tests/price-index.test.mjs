import test from 'node:test';
import assert from 'node:assert/strict';
import {PriceIndex} from '../lib/price-index.mjs';
test('indexed depth matches an independent sorted map under updates, removals and fractional quantities',()=>{
  const index=new PriceIndex(),reference=new Map();let seed=271828;
  const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/2**32;};
  for(let i=0;i<4000;i++) {
    const price=Math.floor(random()*10001)/10000,value=i%7===0?0:Math.floor(random()*10000)/100;
    index.set(price,value);if(value)reference.set(price,value);else reference.delete(price);
    if(i%100===0)assert.deepEqual(index.top(12),[...reference].sort((a,b)=>b[0]-a[0]).slice(0,12));
  }
  assert.equal(index.size,reference.size);
  const expected=[...reference].filter(([p])=>p<=.5).reduce((a,[p,q])=>({quantity:a.quantity+q,cost:a.cost+p*q}),{quantity:0,cost:0});
  assert.ok(Math.abs(index.prefix(.5).quantity-expected.quantity)<1e-7);
  assert.ok(Math.abs(index.prefix(.5).cost-expected.cost)<1e-7);
  assert.throws(()=>index.set(.123456,1),/precision/);
  assert.throws(()=>index.set(.5,-1),/quantity/);
});
