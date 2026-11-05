import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {applyTestSchema} from './database-fixture.mjs';
import {createMarketServer} from '../cloud/server.mjs';
const url=process.env.MARKET_TEST_DATABASE_URL;
test('assistant usage settlement atomically refunds unused reserve exactly once',{skip:!url,timeout:30000},async()=>{
  if(!new URL(url).pathname.endsWith('_test'))throw new Error('Use a disposable _test database');
  const storage=makePostgresStore({connectionString:url}),lock=await storage.db.connect(),tag=randomUUID(),fingerprint=value=>createHash('sha256').update(tag+value).digest('hex');
  try{
    await applyTestSchema(storage.db);await lock.query("SELECT pg_advisory_lock(hashtextextended('assistant-budget-test',0))");
    const month='2099-12',day='2099-12-01',key='assistant-reserved-milliusd#'+month;
    const current=async()=>Number((await storage.db.query('SELECT used FROM market_lab.quotas WHERE key=$1',[key])).rows[0]?.used||0),before=await current();
    assert.ok(before<9900,'The disposable fixture has enough remaining test-unit space');
    const options={month,day,monthlyUnits:before+50,reservedUnits:25,dailyLimit:20};
    const results=await Promise.allSettled(Array.from({length:20},(_,i)=>storage.reserveAssistantBudget(fingerprint(String(i)),options)));
    const accepted=results.filter(row=>row.status==='fulfilled').map(row=>row.value);assert.equal(accepted.length,2);assert.equal(await current(),before+50);
    assert.ok(results.filter(row=>row.status==='rejected').every(row=>row.reason.status===429));
    const first=await storage.settleAssistantBudget(accepted[0].reservation_id,2);assert.equal(first.refunded_units,23);assert.equal(await current(),before+27);
    const repeated=await Promise.all(Array.from({length:20},()=>storage.settleAssistantBudget(accepted[0].reservation_id,3)));
    assert.ok(repeated.every(row=>row.already_settled&&row.billed_units===2));assert.equal(await current(),before+27);
    await storage.settleAssistantBudget(accepted[1].reservation_id,3);assert.equal(await current(),before+5);
    const failed=await storage.reserveAssistantBudget(fingerprint('provider-failure'),options);assert.equal(await current(),before+30);
    await assert.rejects(()=>storage.settleAssistantBudget(failed.reservation_id,26),RangeError);
    await assert.rejects(()=>storage.settleAssistantBudget(failed.reservation_id,-1),RangeError);
    await assert.rejects(()=>storage.settleAssistantBudget(randomUUID(),1),error=>error.status===404);assert.equal(await current(),before+30);
    const dailyFingerprint=fingerprint('daily-limit'),dailyOptions={...options,monthlyUnits:before+100,dailyLimit:1};
    await storage.reserveAssistantBudget(dailyFingerprint,dailyOptions);const afterDaily=await current();
    await assert.rejects(()=>storage.reserveAssistantBudget(dailyFingerprint,dailyOptions),error=>error.status===429);assert.equal(await current(),afterDaily);
    const monthlyFingerprint=fingerprint('monthly-rollback');await assert.rejects(()=>storage.reserveAssistantBudget(monthlyFingerprint,{...options,monthlyUnits:afterDaily}),error=>error.status===429);
    const rolledBack=await storage.db.query('SELECT used FROM market_lab.quotas WHERE key=$1',['assistant-ip#'+day+'#'+monthlyFingerprint]);assert.equal(rolledBack.rowCount,0);
    assert.equal(await current(),afterDaily);
  }finally{await lock.query("SELECT pg_advisory_unlock(hashtextextended('assistant-budget-test',0))").catch(()=>{});lock.release();await storage.close();}
});
test('assistant cost settlement endpoint is service-authenticated and bounded',async t=>{
  const secret='settlement-service-test-'.repeat(3),calls=[];
  const server=createMarketServer({production:true,serviceSecret:secret,storageEnabled:()=>true,storage:()=>({settleAssistantBudget:async(id,units)=>{calls.push({id,units});return {billed_units:units};}}),logger:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const endpoint='http://127.0.0.1:'+server.address().port+'/internal/assistant/settle',body=JSON.stringify({reservation_id:randomUUID(),billed_milliusd:2});
  const denied=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body});assert.equal(denied.status,401);assert.equal(calls.length,0);
  const allowed=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret},body});assert.equal(allowed.status,200);assert.equal((await allowed.json()).billed_units,2);assert.equal(calls.length,1);
});
