import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCategorySnapshots} from '../lib/workspace/catalog.mjs';

test('shares refreshes, preserves timestamps and drops closed contracts during refresh',async()=>{
  let now=Date.now(),loads=0,finish;
  const start=now;
  const row=(ticker,close)=>({ticker,close_time:new Date(start+close).toISOString()});
  const first={as_of:new Date(now).toISOString(),markets:[row('A',1000),row('B',600000)]};
  const catalog=createCategorySnapshots({now:()=>now,storage:()=>null,load:async()=>{
    if(++loads===1)return first;
    return new Promise(resolve=>{finish=resolve;});
  }});
  await Promise.all([catalog('sports'),catalog('sports')]);
  assert.equal(loads,1);
  now+=46000;
  const [a,b]=await Promise.all([catalog('sports'),catalog('sports')]);
  assert.equal(loads,2);
  assert.deepEqual(a,b);
  assert.equal(a.stale,true);
  assert.equal(a.as_of,first.as_of);
  assert.deepEqual(a.markets.map(market=>market.ticker),['B']);
  finish({as_of:new Date(now).toISOString(),markets:[row('C',600000)]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual((await catalog('sports')).markets.map(market=>market.ticker),['C']);
});

test('restores a durable snapshot after restart and stays available through rate limiting',async()=>{
  let now=Date.now(),record,calls=0;
  const row={ticker:'B',close_time:new Date(now+3600000).toISOString()};
  const storage=()=>({get:async()=>record,save:async value=>{record=value;}});
  const options={now:()=>now,storage,load:async()=>{
    if(++calls===1)return {as_of:new Date(now).toISOString(),markets:[row]};
    throw Object.assign(new Error('Rate limited'),{retry_after_seconds:60});
  }};
  await createCategorySnapshots(options)('sports');
  const restarted=createCategorySnapshots(options);
  assert.equal((await restarted('sports')).stale,false);
  assert.equal(calls,1);
  now+=50000;
  assert.equal((await restarted('sports')).stale,true);
  await new Promise(resolve=>setImmediate(resolve));
  now+=10000;
  assert.equal((await restarted('sports')).stale,true);
  assert.equal(calls,2);
});
