import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import assert from 'node:assert/strict';
import {executionCurve} from '../lib/workspace/execution-curve.mjs';
const now=Date.now(),ticker='BENCH-FIXTURE',book={ticker,as_of:new Date(now).toISOString(),raw:{orderbook_fp:{yes_dollars:[['.35','10000']],no_dollars:Array.from({length:1000},(_,i)=>[(.6-i*.0001).toFixed(4),'5.25'])}}};
const queries=Array.from({length:1000},(_,i)=>1+(i*7919)%3000),curve=executionCurve(book,ticker,'yes','buy',{now});
for(const quantity of queries){const reference=globalThis.KalshiPaper.estimate(book,ticker,'yes','buy',quantity,{now}),value=curve.quote(quantity);
  for(const key of ['cash','fee','filled'])assert.ok(Math.abs(value[key]-reference[key])<1e-8,key);}
const measure=fn=>{let sum=0;const start=performance.now();for(const quantity of queries)sum+=fn(quantity).cash;return {ms:performance.now()-start,sum};};
measure(q=>curve.quote(q));measure(q=>globalThis.KalshiPaper.estimate(book,ticker,'yes','buy',q,{now}));
const indexed=[],reference=[],construction=[];
for(let i=0;i<7;i++){const started=performance.now();executionCurve(book,ticker,'yes','buy',{now});construction.push(performance.now()-started);
  const a=measure(q=>curve.quote(q)),b=measure(q=>globalThis.KalshiPaper.estimate(book,ticker,'yes','buy',q,{now}));assert.ok(Math.abs(a.sum-b.sum)<1e-6);indexed.push(a.ms);reference.push(b.ms);}
const median=values=>[...values].sort((a,b)=>a-b)[3];
console.log(JSON.stringify({measured_at:new Date().toISOString(),cpu:cpus()[0].model,runtime:process.version,queries:queries.length,book_levels:1000,
  construction_median_ms:median(construction),prefix_median_ms:median(indexed),reparse_median_ms:median(reference),ratio:median(reference)/median(indexed),batch_ratio_including_construction:median(reference)/(median(indexed)+median(construction)),independent_cashflow_matches:true,
  complexity:'O(L log L) parse/sort plus O(L) prefix construction, then O(log L) per fill query; prior repeated parsing/sorting/scanning O(L log L) per query.',
  scope:'Local repeated-sizing CPU fixture, seven repetitions after warmup. Reuses one validated fresh book; excludes network, refresh, rendering and initial parse. This is not a whole-site latency claim.'},null,2));
