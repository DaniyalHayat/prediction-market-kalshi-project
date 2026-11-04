import test from 'node:test';
import assert from 'node:assert/strict';
import {setCostGate} from '../cloud/worker.mjs';
test('cost allowance and missing billing data stop endpoint admission, then permit recovery',async()=>{
  let value;const updates=[];
  const storage={base:{TableName:'test'},get:async()=>value,client:{send:async command=>{value=command.input.Item;}}};
  const endpoint={send:async command=>{updates.push(command.input);}};
  assert.equal(await setCostGate(8,{storage,endpoint}),true);
  assert.equal(updates.at(-1).throttleConfig.rateLimit,0);
  assert.equal(value.disabled,true);
  assert.equal(await setCostGate(null,{storage,endpoint}),true);
  assert.equal(updates.at(-1).throttleConfig.rateLimit,0);
  assert.equal(await setCostGate(0,{storage,endpoint}),false);
  assert.equal(updates.at(-1).throttleConfig.rateLimit,100);
  await setCostGate(1,{storage,endpoint});assert.equal(updates.at(-1).throttleConfig.rateLimit,100);
});
