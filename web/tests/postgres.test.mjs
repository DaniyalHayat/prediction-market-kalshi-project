import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {makePostgresStore} from '../lib/postgres-store.mjs';
const url=process.env.MARKET_TEST_DATABASE_URL;
test('Postgres quotas, immutable evidence, audit CAS, journal isolation and rollback',{skip:!url},async()=>{
  if(!new URL(url).pathname.endsWith('_test'))throw new Error('Use a dedicated _test database');
  const s=makePostgresStore({connectionString:url}),tag=randomUUID();
  try {
    await s.db.query(await readFile(new URL('../database/001_market_lab.sql',import.meta.url),'utf8'));
    const takes=await Promise.all(Array.from({length:30},()=>s.consume('test#'+tag,7)));
    assert.equal(takes.filter(Boolean).length,7);
    const release=await s.lease('lease#'+tag,30);assert.ok(release);
    assert.equal(await s.lease('lease#'+tag,30),null);await release();assert.ok(await s.lease('lease#'+tag,1));
    const key='test/'+tag+'.json';await s.archive(key,{z:2,a:{y:3,x:4}});
    assert.deepEqual(await s.readArchive(key),{a:{x:4,y:3},z:2});
    await assert.rejects(()=>s.archive(key,{z:999}),/different content/);
    const owner='journal#'+tag,row={pk:owner,sk:'forecast#TEST',id:tag,status:'pending',freeze_hash:'frozen',pending_sk:'2026-01-01T00:00:00Z#'+tag};
    await s.put(row);await assert.rejects(()=>s.put(row),/already registered/);
    assert.equal((await s.journalRows(owner)).items.length,1);
    assert.equal((await s.journalRows(owner+'other')).items.length,0);
    await s.settle(row,{brier:.25},'2026-11-04T12:00:00Z');
    await assert.rejects(()=>s.settle(row,{brier:0},'2026-11-04T12:00:00Z'),/already changed/);
    const id=randomUUID(),freeze={type:'freeze',hash:'a'.repeat(64),previous:null,recorded_at:new Date().toISOString(),content:{example:true}};
    await s.appendAudit(id,freeze);
    await assert.rejects(()=>s.appendAudit(id,{...freeze,type:'markout',hash:'b'.repeat(64),previous:'wrong'}),/chain changed/);
    assert.equal((await s.readAudit(id)).length,1);
    await s.appendAudit(id,{...freeze,type:'markout',hash:'c'.repeat(64),previous:freeze.hash});
    assert.equal((await s.readAudit(id)).length,2);
    await assert.rejects(()=>s.transaction(async c=>{await c.query("INSERT INTO market_lab.records(pk,sk,payload) VALUES($1,'rollback','{}')",[tag]);throw new Error('deliberate transaction failure');}),/deliberate/);
    assert.equal(await s.get(tag,'rollback'),undefined);
    const rls=await s.db.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='market_lab' AND c.relkind='r' AND NOT c.relrowsecurity");
    assert.equal(rls.rows[0].n,0);
  } finally {await s.close();}
});
