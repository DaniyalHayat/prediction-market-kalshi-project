import test from 'node:test';
import assert from 'node:assert/strict';
import {makeStore} from '../lib/cloud/store.mjs';
import {ownerKey,validatePrediction,scoreForecast,binaryOutcome} from '../lib/cloud/journal.mjs';
test('private journals require distinct unguessable owner tokens',()=>{
  assert.throws(()=>ownerKey('test'),/256-bit/);
  assert.notEqual(ownerKey('a'.repeat(64)),ownerKey('b'.repeat(64)));
});
test('predictions cannot be outside their registered interval',()=>{
  assert.throws(()=>validatePrediction({ticker:'TEST',probability:.8,probability_low:.2,probability_high:.6}),/Probability/);
  assert.throws(()=>validatePrediction({ticker:'TEST',probability:true,probability_low:0,probability_high:1}),/Probability/);
});
test('settlement scores are calculated from the frozen forecast and observed outcome',()=>{
  const score=scoreForecast({probability:.7,probability_low:.6,probability_high:.8,market_midpoint:.5},1);
  assert.ok(Math.abs(score.brier-.09)<1e-12);assert.equal(score.market_brier,.25);
  assert.throws(()=>scoreForecast({},.5),/binary/);
});
test('only final binary exchange resolutions can settle a prediction',()=>{
  assert.equal(binaryOutcome({status:'finalized',result:'yes'}),1);
  assert.equal(binaryOutcome({status:'settled',result:'no'}),0);
  assert.equal(binaryOutcome({status:'closed',result:'yes'}),null);
  assert.equal(binaryOutcome({status:'finalized',result:'void'}),null);
});
test('global quotas use atomic conditional increments and fail closed on database outages',async()=>{
  const commands=[],client={send:async command=>{commands.push(command);throw Object.assign(new Error(),{name:'ConditionalCheckFailedException'});}};
  const s=makeStore(client,{table:'test',now:()=>12345});
  assert.equal(await s.consume('daily',10,2),false);
  assert.match(commands[0].input.ConditionExpression,/threshold/);
  assert.equal(commands[0].input.ExpressionAttributeValues[':threshold'],8);
  assert.equal(await s.consume('daily',10,2),false);assert.equal(commands.length,1);
  const down=makeStore({send:async()=>{throw new Error('database unavailable');}},{table:'test'});
  await assert.rejects(()=>down.consume('daily',10),/unavailable/);
});
test('checkpoint leases cannot release another worker ownership',async()=>{
  const commands=[],s=makeStore({send:async command=>{commands.push(command);return {};}},{table:'test'});
  const release=await s.lease('checkpoint');await release();
  assert.match(commands[1].input.ConditionExpression,/owner/);
  assert.ok(commands[1].input.ExpressionAttributeValues[':owner']);
});
