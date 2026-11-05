import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {enqueuePipeline,runPipelineJob} from '../cloud/pipeline.mjs';
import {applyTestSchema} from './database-fixture.mjs';

const url=process.env.MARKET_TEST_DATABASE_URL;
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
test('durable pipeline PostgreSQL queue behavior',{skip:!url,timeout:30000},async t=>{
  if(!new URL(url).pathname.endsWith('_test'))throw new Error('Use a dedicated _test database');
  const store=makePostgresStore({connectionString:url}),table='market_lab.test_jobs_'+randomUUID().replaceAll('-','');
  const s={db:{query:(sql,values)=>{if(!sql.includes('market_lab.jobs'))throw new Error('Pipeline query escaped its isolated test table');return store.db.query(sql.replaceAll('market_lab.jobs',table),values);}}};
  try{
    await applyTestSchema(store.db);
    await store.db.query(`CREATE TABLE ${table}(LIKE market_lab.jobs INCLUDING ALL); ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await t.test('replayed and concurrent scheduler ticks preserve job identities and completed states',async()=>{
      const now=Date.parse('2110-01-01T12:01:00Z');await Promise.all(Array.from({length:8},()=>enqueuePipeline(s,now)));
      const initial=await store.db.query(`SELECT * FROM ${table}`);assert.equal(initial.rowCount,10);assert.equal(new Set(initial.rows.map(r=>r.key)).size,10);
      const catalog=initial.rows.filter(r=>r.kind==='catalog');assert.equal(catalog.length,8);assert.equal(new Set(catalog.map(r=>r.input.category)).size,8);
      const key=initial.rows[0].key;await store.db.query(`UPDATE ${table} SET state='complete',attempts=2,finished_at=now() WHERE key=$1`,[key]);
      await enqueuePipeline(s,now);assert.equal((await store.db.query(`SELECT state FROM ${table} WHERE key=$1`,[key])).rows[0].state,'complete');
      await enqueuePipeline(s,now+15*60000);assert.equal((await store.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,11);
      await store.db.query(`TRUNCATE ${table}`);
    });
    await t.test('simultaneous workers claim each available job once while locks are held',async()=>{
      const count=12,started=deferred(),release=deferred(),seen=new Map();
      for(let i=0;i<count;i++)await store.db.query(`INSERT INTO ${table}(key,kind,input) VALUES($1,'parallel',$2)`,['parallel-'+i,{id:i}]);
      const handler=async({id})=>{seen.set(id,(seen.get(id)||0)+1);if(seen.size===count)started.resolve();await release.promise;};
      const workers=Array.from({length:24},()=>runPipelineJob(s,{parallel:handler}));await started.promise;
      const locked=await store.db.query(`SELECT state,attempts,owner FROM ${table}`);assert.equal(locked.rows.filter(r=>r.state==='running').length,count);assert.ok(locked.rows.every(r=>r.attempts===1));assert.equal(new Set(locked.rows.map(r=>r.owner)).size,count);
      release.resolve();const results=await Promise.all(workers);assert.equal(results.filter(Boolean).length,count);assert.ok(results.filter(Boolean).every(r=>r.status==='complete'));assert.ok([...seen.values()].every(n=>n===1));
      assert.equal((await store.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE state='complete' AND finished_at IS NOT NULL AND locked_until IS NULL`)).rows[0].n,count);
      await store.db.query(`TRUNCATE ${table}`);
    });
    await t.test('handler rollback leaves no partial data, schedules bounded retries, then stops after four failures',async()=>{
      await store.db.query(`INSERT INTO ${table}(key,kind) VALUES('failing','rollback')`);
      const marker=randomUUID(),error=Object.assign(new Error('private exception body must not be persisted'),{code:'TEST_SOURCE_ERROR'}),delays=[];
      const handler=async()=>store.transaction(async c=>{await c.query("INSERT INTO market_lab.operational_events(kind,details) VALUES('pipeline-test',$1)",[{marker}]);throw error;});
      for(let attempt=1;attempt<=4;attempt++){
        const result=await runPipelineJob(s,{rollback:handler});assert.equal(result.status,attempt===4?'failed':'retry_scheduled');
        const row=(await store.db.query(`SELECT *,extract(epoch FROM available_at-now()) AS delay FROM ${table} WHERE key='failing'`)).rows[0];
        assert.equal(row.attempts,attempt);assert.equal(row.error_code,'TEST_SOURCE_ERROR');assert.equal(row.locked_until,null);assert.equal(row.finished_at,null);assert.ok(Number(row.delay)>30&&Number(row.delay)<=3600);delays.push(Number(row.delay));
        assert.equal(await runPipelineJob(s,{rollback:handler}),null);
        await store.db.query(`UPDATE ${table} SET available_at=now()-interval '1 second' WHERE key='failing'`);
      }
      assert.ok(delays.every((v,i)=>!i||v>delays[i-1]));assert.equal(await runPipelineJob(s,{rollback:handler}),null);
      assert.equal((await store.db.query("SELECT count(*)::int AS n FROM market_lab.operational_events WHERE details->>'marker'=$1",[marker])).rows[0].n,0);
      await store.db.query(`TRUNCATE ${table}`);
    });
    await t.test('expired or replaced workers cannot complete or reschedule the new owner’s job',async()=>{
      await store.db.query(`INSERT INTO ${table}(key,kind) VALUES('reclaimed','ownership')`);
      const firstStarted=deferred(),secondStarted=deferred(),releaseOld=deferred(),releaseNew=deferred();let executions=0;
      const handler=async()=>{if(++executions===1){firstStarted.resolve();await releaseOld.promise;}else{secondStarted.resolve();await releaseNew.promise;}};
      const old=runPipelineJob(s,{ownership:handler});await firstStarted.promise;
      const prior=(await store.db.query(`SELECT owner FROM ${table} WHERE key='reclaimed'`)).rows[0].owner;
      await store.db.query(`UPDATE ${table} SET locked_until=now()-interval '1 second' WHERE key='reclaimed'`);
      const replacement=runPipelineJob(s,{ownership:handler});await secondStarted.promise;
      const next=(await store.db.query(`SELECT owner FROM ${table} WHERE key='reclaimed'`)).rows[0].owner;assert.notEqual(prior,next);
      releaseOld.resolve();assert.equal((await old).status,'lease_lost');
      const stillRunning=(await store.db.query(`SELECT state,owner,finished_at FROM ${table} WHERE key='reclaimed'`)).rows[0];assert.equal(stillRunning.state,'running');assert.equal(stillRunning.owner,next);assert.equal(stillRunning.finished_at,null);
      releaseNew.resolve();assert.equal((await replacement).status,'complete');assert.equal((await store.db.query(`SELECT attempts FROM ${table} WHERE key='reclaimed'`)).rows[0].attempts,2);
      await store.db.query(`TRUNCATE ${table}`);
      await store.db.query(`INSERT INTO ${table}(key,kind) VALUES('expired','expired')`);
      const expired=await runPipelineJob(s,{expired:async()=>{await store.db.query(`UPDATE ${table} SET locked_until=now()-interval '1 second' WHERE key='expired'`);}});assert.equal(expired.status,'lease_lost');assert.equal((await store.db.query(`SELECT state FROM ${table} WHERE key='expired'`)).rows[0].state,'running');
      await store.db.query(`TRUNCATE ${table}`);
      await store.db.query(`INSERT INTO ${table}(key,kind) VALUES('stale-error','stale_error')`);
      const successor=randomUUID(),stale=await runPipelineJob(s,{stale_error:async()=>{await store.db.query(`UPDATE ${table} SET owner=$1,locked_until=now()+interval '5 minutes' WHERE key='stale-error'`,[successor]);throw Object.assign(new Error('late failure'),{code:'STALE_ERROR'});}});
      assert.equal(stale.status,'lease_lost');
      const preserved=(await store.db.query(`SELECT state,owner,error_code FROM ${table} WHERE key='stale-error'`)).rows[0];assert.equal(preserved.state,'running');assert.equal(preserved.owner,successor);assert.equal(preserved.error_code,null);
    });
  }finally{await store.db.query(`DROP TABLE IF EXISTS ${table}`);await store.close();}
});
