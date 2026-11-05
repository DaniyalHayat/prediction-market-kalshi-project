import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {applyTestSchema} from './database-fixture.mjs';

const url=process.env.MARKET_TEST_DATABASE_URL;
const pause=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function waitForLock(pool,tag){
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",['query-fixture-'+tag])).rowCount)return;await pause(5);}
  assert.fail('The test statement did not reach its controlled row-lock wait');
}
async function fixture(t){
  if(!new URL(url).pathname.endsWith('_test')||!['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname))throw new Error('Query tests require a loopback disposable _test database');
  const tag=randomUUID(),pool=new pg.Pool({connectionString:url,max:4,application_name:'query-fixture-'+tag}),store=makePostgresStore({connectionString:url,pool,storageURL:null,storageKey:null});
  await applyTestSchema(pool);t.after(()=>store.close());return {store,pool,tag};
}

test('identical record overwrite avoids a new tuple while changed payload, expiry and strict insertion retain their semantics',{skip:!url},async t=>{
  const {store,pool,tag}=await fixture(t),item={pk:'noop#'+tag,sk:'value',value:{a:1,b:2},expires_epoch:Math.floor(Date.now()/1000)+300};
  await store.save(item,true);const inspect=async()=> (await pool.query('SELECT xmin::text,ctid::text,payload,expires_at FROM market_lab.records WHERE pk=$1 AND sk=$2',[item.pk,item.sk])).rows[0];
  const before=await inspect();await store.save({...item,value:{b:2,a:1}},true);const identical=await inspect();
  assert.equal(identical.xmin,before.xmin);assert.equal(identical.ctid,before.ctid);
  await store.save({...item,value:{a:3,b:2}},true);const changed=await inspect();assert.notEqual(changed.xmin,before.xmin);assert.equal(changed.payload.value.a,3);
  await store.save({...item,expires_epoch:item.expires_epoch+60},true);const refreshed=await inspect();assert.equal(refreshed.expires_at.getTime(),(item.expires_epoch+60)*1000);
  await assert.rejects(store.put(item),{name:'ConditionalCheckFailedException'});
});

test('quota admission remains atomic for weighted concurrent requests and different limits/amounts cannot share a denial',{skip:!url},async t=>{
  const {store,pool,tag}=await fixture(t),key='weighted#'+tag;
  const admitted=await Promise.all(Array.from({length:24},()=>store.consume(key,10,3,60)));assert.equal(admitted.filter(Boolean).length,3);
  assert.equal((await pool.query('SELECT used::int FROM market_lab.quotas WHERE key=$1',[key])).rows[0].used,9);
  assert.equal(await store.consume(key,10,2,60),false);assert.equal(await store.consume(key,10,1,60),true);
  assert.equal(await store.consume(key,10,1,60),false);assert.equal(await store.consume(key,20,1,60),true);
  for(const amount of [0,-1,11,NaN,1.5])await assert.rejects(store.consume('invalid#'+tag,10,amount),RangeError);
});

test('expired quota windows, external refunds and transaction rollbacks immediately restore admissible capacity',{skip:!url},async t=>{
  const {store,pool,tag}=await fixture(t),key='expiry#'+tag;
  assert.equal(await store.consume(key,1,1,1),true);assert.equal(await store.consume(key,1,1,1),false);
  await pool.query("UPDATE market_lab.quotas SET expires_at=clock_timestamp()-interval '1 second' WHERE key=$1",[key]);
  assert.equal(await store.consume(key,1,1,1),true);
  assert.equal(await store.consume(key,1,1,1),false);await pool.query('UPDATE market_lab.quotas SET used=0 WHERE key=$1',[key]);assert.equal(await store.consume(key,1,1,1),true);
  const client=await pool.connect(),transactionStore=makePostgresStore({pool:{query:(...args)=>client.query(...args),end:async()=>{}},storageURL:null,storageKey:null});
  try{
    await pool.query('UPDATE market_lab.quotas SET used=0 WHERE key=$1',[key]);
    await client.query('BEGIN');assert.equal(await transactionStore.consume(key,1,1,60),true);assert.equal(await transactionStore.consume(key,1,1,60),false);await client.query('ROLLBACK');
    assert.equal(await transactionStore.consume(key,1,1,60),true);
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
});

test('accepted quota usage deliberately retains sliding expiry rather than silently changing to a fixed window',{skip:!url},async t=>{
  const {store,pool,tag}=await fixture(t),key='sliding#'+tag;
  await store.consume(key,3,1,60);await pool.query("UPDATE market_lab.quotas SET expires_at=clock_timestamp()+interval '10 seconds' WHERE key=$1",[key]);
  assert.equal(await store.consume(key,3,1,60),true);
  const row=(await pool.query('SELECT used::int,extract(epoch FROM expires_at-clock_timestamp())::float8 AS remaining FROM market_lab.quotas WHERE key=$1',[key])).rows[0];assert.equal(row.used,2);assert.ok(row.remaining>55&&row.remaining<=60);
});

test('lease deadline is assigned after conflict-lock waiting and old release cannot remove a successor',{skip:!url,timeout:15000},async t=>{
  const {store,pool,tag}=await fixture(t),key='lock#'+tag,blocker=await pool.connect();let release;
  try{
    await blocker.query('INSERT INTO market_lab.leases(key,owner,expires_at) VALUES($1,$2,clock_timestamp()-interval \'1 second\')',[key,randomUUID()]);await blocker.query('BEGIN');await blocker.query('SELECT key FROM market_lab.leases WHERE key=$1 FOR UPDATE',[key]);
    const acquiring=store.lease(key,.2);await waitForLock(pool,tag);await pause(350);await blocker.query('COMMIT');release=await acquiring;assert.ok(release);
    const remaining=Number((await pool.query('SELECT extract(epoch FROM expires_at-clock_timestamp()) AS seconds FROM market_lab.leases WHERE key=$1',[key])).rows[0].seconds);assert.ok(remaining>.1,'Lease must retain usable lifetime after the lock is released');
    await pool.query("UPDATE market_lab.leases SET expires_at=clock_timestamp()-interval '1 second' WHERE key=$1",[key]);const successor=await store.lease(key,30);assert.ok(successor);await release();assert.equal((await pool.query('SELECT 1 FROM market_lab.leases WHERE key=$1',[key])).rowCount,1);await successor();
  }finally{await blocker.query('ROLLBACK').catch(()=>{});await release?.();blocker.release();}
});

test('expired cache producers cannot overwrite a fresh successor and still return its retained result',{skip:!url,timeout:15000},async t=>{
  const {store,pool,tag}=await fixture(t),key='fenced#'+tag,pk='cache#'+createHash('sha256').update(key).digest('hex');let finish,started;
  const producing=new Promise(resolve=>{started=resolve;}),result=new Promise(resolve=>{finish=resolve;});
  const old=store.cached(key,60,async()=>{started();await result;return {generation:'old'};});await producing;
  await pool.query("UPDATE market_lab.leases SET expires_at=clock_timestamp()-interval '1 second' WHERE key=$1",[pk]);
  assert.deepEqual(await store.cached(key,60,async()=>({generation:'new'})),{generation:'new'});finish();
  assert.deepEqual(await old,{generation:'new'});assert.deepEqual((await store.get(pk)).value,{generation:'new'});
});

test('a held refresh lease reports typed local contention without starting another producer',{skip:!url,timeout:15000},async t=>{
  const {store,tag}=await fixture(t),key='busy#'+tag,pk='cache#'+createHash('sha256').update(key).digest('hex'),release=await store.lease(pk,30);let calls=0;
  assert.ok(release);
  try{await assert.rejects(store.cached(key,60,async()=>{calls++;return {unexpected:true};}),{status:429,code:'CACHE_LEASE_BUSY'});assert.equal(calls,0);assert.equal(await store.get(pk),undefined);}
  finally{await release();}
});

test('a delayed initial cache miss is rechecked after lease acquisition without spending another upstream request',{skip:!url,timeout:15000},async t=>{
  const {store,pool,tag}=await fixture(t),key='recheck#'+tag;let continueMiss,missRead,first=true,produced=0;
  const paused=new Promise(resolve=>{continueMiss=resolve;}),read=new Promise(resolve=>{missRead=resolve;});
  const delayed=makePostgresStore({storageURL:null,storageKey:null,pool:{query:async(sql,args)=>{const result=await pool.query(sql,args);if(first&&sql.startsWith('SELECT payload FROM market_lab.records')){first=false;missRead();await paused;}return result;},end:async()=>{}}});
  const pending=delayed.cached(key,60,async()=>{produced++;return {version:'obsolete'};});await read;
  assert.deepEqual(await store.cached(key,60,async()=>({version:'retained'})),{version:'retained'});continueMiss();
  assert.deepEqual(await pending,{version:'retained'});assert.equal(produced,0);
});

test('cache producer side records are fenced and expiry is checked after obtaining the lease row lock',{skip:!url,timeout:15000},async t=>{
  const {store,pool,tag}=await fixture(t),key='side-record#'+tag,pk='cache#'+createHash('sha256').update(key).digest('hex'),cursor='cursor#'+tag;let finish,started;
  const producing=new Promise(resolve=>{started=resolve;}),done=new Promise(resolve=>{finish=resolve;});
  const old=store.cached(key,60,async context=>{started();await done;await context.publishRecord({pk:cursor,sk:'value',version:'old'});return {version:'old'};});await producing;
  const blocker=await pool.connect();
  try{
    await pool.query("UPDATE market_lab.leases SET expires_at=clock_timestamp()+interval '.2 seconds' WHERE key=$1",[pk]);
    await blocker.query('BEGIN');await blocker.query('SELECT key FROM market_lab.leases WHERE key=$1 FOR UPDATE',[pk]);finish();
    const rejected=assert.rejects(old,{code:'CACHE_LEASE_LOST'});await waitForLock(pool,tag);await pause(350);await blocker.query('COMMIT');await rejected;
    assert.equal(await store.get(cursor),undefined);assert.equal(await store.get(pk),undefined);
  }finally{finish();await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
});

test('wall-clock TTL checks do not reuse transaction-start time for records, quotas or new leases',{skip:!url,timeout:15000},async t=>{
  const {store,pool,tag}=await fixture(t),client=await pool.connect(),view=makePostgresStore({pool:{query:(...args)=>client.query(...args),end:async()=>{}},storageURL:null,storageKey:null});
  const record={pk:'clock#'+tag,sk:'value',value:'fixture'},quota='clock-quota#'+tag;
  try{
    await store.put(record);await store.consume(quota,1,1,60);
    await client.query('BEGIN');await client.query("UPDATE market_lab.records SET expires_at=transaction_timestamp()+interval '.05 seconds' WHERE pk=$1",[record.pk]);
    await client.query("UPDATE market_lab.quotas SET expires_at=transaction_timestamp()+interval '.05 seconds' WHERE key=$1",[quota]);await pause(100);
    assert.equal(await view.get(record.pk),undefined);assert.equal(await view.consume(quota,1,1,60),true);
    const release=await view.lease('clock-lease#'+tag,.2);assert.ok(release);
    const remaining=Number((await client.query('SELECT extract(epoch FROM expires_at-clock_timestamp()) AS seconds FROM market_lab.leases WHERE key=$1',['clock-lease#'+tag])).rows[0].seconds);assert.ok(remaining>.1);
    await release();await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
});
