import test from 'node:test';
import assert from 'node:assert/strict';
import {paperCapital} from '../ui/paper-capital.mjs';
import '../public/dashboard/paper.js';
const engine=globalThis.KalshiPaper;
const execution=(action,cash,filled=10)=>({action,cash,filled,ticker:'KXTEST-26NOV-X',side:'yes',notional:cash,fee:0,assumptions:{coefficient:0}});

test('cash capacity reconciles purchases and partial/full close proceeds without double-counting released basis',()=>{
  let ledger=engine.emptyLedger();
  ledger=engine.applyOpen(ledger,execution('buy',120),{id:'one'});
  assert.equal(paperCapital(ledger,1000).available,880);
  ledger=engine.applyOpen(ledger,execution('buy',200),{id:'two'});
  assert.equal(paperCapital(ledger,1000).available,680);
  ledger=engine.applyClose(ledger,'one',execution('sell',70,5),{id:'partial'});
  assert.equal(paperCapital(ledger,1000).available,750);
  ledger=engine.applyClose(ledger,'one',execution('sell',55,5),{id:'complete'});
  assert.equal(paperCapital(ledger,1000).available,805);
  ledger=engine.applyClose(ledger,'two',execution('sell',180),{id:'loss'});
  const value=paperCapital(ledger,1000);
  assert.equal(value.available,985);assert.equal(value.committed,0);assert.equal(value.realized,-15);
});
test('cash capacity rejects corrupt money, preserves input and prevents negative available cash after a balance change',()=>{
  const ledger={positions:[{remaining_basis:60,realized_pnl:-10}]},before=JSON.stringify(ledger);
  assert.deepEqual(paperCapital(ledger,50),{startingBalance:50,committed:60,realized:-10,available:0,shortfall:20});
  assert.equal(JSON.stringify(ledger),before);
  for(const balance of [NaN,Infinity,0,-1])assert.throws(()=>paperCapital(ledger,balance));
  for(const remaining_basis of [NaN,Infinity,-1])assert.throws(()=>paperCapital({positions:[{remaining_basis,realized_pnl:0}]},100));
});
