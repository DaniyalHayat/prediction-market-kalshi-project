import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {PriceIndex} from '../lib/price-index.mjs';
let seed=271828;const random=()=>((seed=(1664525*seed+1013904223)>>>0)/2**32);
const initial=Array.from({length:1000},(_,i)=>[(i+1)/10000,100+i]),updates=Array.from({length:12000},()=>[Math.floor(random()*1000+1)/10000,Math.floor(random()*200)]);
function execute(indexed){const value=indexed?new PriceIndex():new Map();for(const [p,q] of initial)value.set(p,q);let best;
 const start=performance.now();for(const [p,q] of updates){if(q)value.set(p,q);else value.delete(p);best=indexed?value.best():Math.max(...value.keys());}
 return {ms:performance.now()-start,best,top:[...value].sort((a,b)=>b[0]-a[0]).slice(0,10)};
}
execute(true);execute(false);const indexed=[],baseline=[];
for(let i=0;i<7;i++){const a=execute(true),b=execute(false);assert.deepEqual(a.top,b.top);assert.equal(a.best,b.best);indexed.push(a.ms);baseline.push(b.ms);}
const median=rows=>[...rows].sort((a,b)=>a-b)[3];
console.log(JSON.stringify({fixture:'Seeded 1000-level side, 12000 updates, current best after each update; seven timed repetitions after warmup',
 runtime:process.version,indexed_median_ms:median(indexed),map_scan_median_ms:median(baseline),ratio:median(baseline)/median(indexed),
 scope:'Local CPU microbenchmark; excludes network, full-depth serialization and exchange latency. Independent Map reference must match final depth.'},null,2));
