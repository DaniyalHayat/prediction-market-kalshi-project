import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {drainMarketRuntime} from '../cloud/shutdown.mjs';
import {makePostgresStore} from '../lib/postgres-store.mjs';

test('shutdown drains actual HTTP work and the running pipeline before closing storage',async t=>{
  let response,arrived,finishPipeline,closed=0;
  const received=new Promise(resolve=>{arrived=resolve;}),pipeline=new Promise(resolve=>{finishPipeline=resolve;});
  const server=createServer((request,res)=>{response=res;arrived();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const request=fetch(`http://127.0.0.1:${server.address().port}`);await received;
  const shutdown=drainMarketRuntime({server,stopPipeline:()=>pipeline,closeStorage:async()=>{closed++;},timeoutMs:2000});
  response.end('done');assert.equal(await(await request).text(),'done');assert.equal(closed,0);
  finishPipeline();assert.equal(await shutdown,'drained');assert.equal(closed,1);
});

test('shutdown has a bounded exit when a connection will not drain',async()=>{
  let forced=0,closed=0;
  const result=await drainMarketRuntime({server:{close(){},closeAllConnections(){forced++;}},stopPipeline:async()=>{},closeStorage:async()=>{closed++;},timeoutMs:20});
  assert.equal(result,'deadline');assert.equal(forced,1);assert.equal(closed,0);
});

test('a pipeline shutdown failure still closes storage and surfaces failure',async()=>{
  let closed=0;
  await assert.rejects(drainMarketRuntime({server:{close:done=>done()},stopPipeline:async()=>{throw new Error('fixture');},closeStorage:async()=>{closed++;},timeoutMs:2000}),/fixture/);
  assert.equal(closed,1);
});

test('database store closure is idempotent',async()=>{
  let ends=0;const storage=makePostgresStore({pool:{end:async()=>{ends++;}},storageURL:null,storageKey:null});
  await Promise.all([storage.close(),storage.close(),storage.close()]);assert.equal(ends,1);
  await assert.rejects(storage.listenJobs(()=>{}),/closing/);
});
