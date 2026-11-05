import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {applyTestSchema} from './database-fixture.mjs';
const url=process.env.MARKET_TEST_DATABASE_URL;
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
