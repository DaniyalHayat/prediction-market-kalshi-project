import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {applyTestSchema} from './database-fixture.mjs';
import {marketAttribution} from '../lib/workspace/warehouse.mjs';
const url=process.env.MARKET_TEST_DATABASE_URL;
test('closing the database store releases its actual LISTEN session without a reconnect callback',{skip:!url,timeout:15000},async()=>{
  if(!new URL(url).pathname.endsWith('_test')||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Use a loopback disposable _test database');
  const storage=makePostgresStore({connectionString:url}),observer=makePostgresStore({connectionString:url});let closeListener,disconnections=0;
  const listeners=async()=>(await observer.db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='market-lab-job-listener'")).rows.map(row=>row.pid);
  try{
    const before=await listeners();closeListener=await storage.listenJobs(()=>{},()=>{disconnections++;});
    const own=(await listeners()).filter(pid=>!before.includes(pid));assert.equal(own.length,1);
    await Promise.all([storage.close(),storage.close()]);
    assert.ok((await listeners()).every(pid=>!own.includes(pid)));assert.equal(disconnections,0);
    await closeListener();
  }finally{await closeListener?.();await storage.close();await observer.close();}
});
test('database safety, nested full-text search and commit-time wakeups use actual PostgreSQL',{skip:!url,timeout:30000},async()=>{
  if(!new URL(url).pathname.endsWith('_test'))throw new Error('Use a dedicated _test database');
  const storage=makePostgresStore({connectionString:url}),tag=randomUUID(),client=await storage.db.connect();let closeListener;
  try{
    await applyTestSchema(storage.db);
    await client.query('BEGIN');
    await client.query("INSERT INTO market_lab.archives(key,sha256,payload) VALUES($1,$2,'{}')",[tag,'a'.repeat(64)]);
    const batch=(await client.query("INSERT INTO market_lab.source_batches(provider,source_url,sha256,archive_key,schema_version,row_count) VALUES($1,'https://example.com/public-source',$2,$3,1,2) RETURNING id",['runtime-fixture-'+tag,'a'.repeat(64),tag])).rows[0].id;
    await client.query("INSERT INTO market_lab.market_snapshots(ticker,observed_at,event_ticker,title,category,yes_bid,yes_ask,batch_id,quality_flags) VALUES($1,now()-interval '1 hour','FIXTURE-EVENT','Solar flare observation','science',.4,.45,$2,ARRAY['fixture_only']),($1,now()-interval '30 minutes','FIXTURE-EVENT','Solar flare observation','science',.41,.46,$2,ARRAY['fixture_only'])",['FIXTURE-'+tag,batch]);
    const view=makePostgresStore({pool:{query:(...args)=>client.query(...args),end:async()=>{}}});
    const earlier=await client.query('SELECT * FROM market_lab.market_attribution ORDER BY abs(observed_price_change) DESC NULLS LAST,last_observed DESC,ticker LIMIT 30');
    assert.deepEqual((await marketAttribution(view)).rows,earlier.rows);
    const search=await view.searchMarkets('solar flare');const own=search.rows.filter(row=>row.ticker==='FIXTURE-'+tag);
    assert.equal(own.length,1);assert.equal(own[0].yes_bid,.41);assert.equal(own[0].source.url,'https://example.com/public-source');assert.deepEqual(own[0].quality_flags,['fixture_only']);
    await assert.rejects(()=>view.searchMarkets('x'),RangeError);await assert.rejects(()=>view.searchMarkets('solar',{limit:1000}),RangeError);
    await view.searchMarkets("'; DROP TABLE market_lab.archives; --");assert.equal((await client.query('SELECT count(*)::int AS n FROM market_lab.archives WHERE key=$1',[tag])).rows[0].n,1);
    await client.query('ROLLBACK');
    let wake,notifications=0;const notified=new Promise(resolve=>{wake=resolve;});closeListener=await storage.listenJobs(()=>{notifications++;wake();});
    await client.query('BEGIN');await client.query("INSERT INTO market_lab.jobs(key,kind) VALUES($1,'runtime-notify-fixture')",[tag]);
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(notifications,0);await client.query('COMMIT');
    let timeout;await Promise.race([notified,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Commit notification was not received')),1500);})]);clearTimeout(timeout);
    const before=notifications;await client.query('UPDATE market_lab.jobs SET available_at=now() WHERE key=$1',[tag]);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(notifications,before);
    const transitions=await client.query('SELECT state FROM market_lab.job_transition_events WHERE job_key=$1',[tag]);assert.deepEqual(transitions.rows.map(row=>row.state),['pending']);
  }finally{await client.query('ROLLBACK').catch(()=>{});await closeListener?.();client.release();await storage.close();}
});
