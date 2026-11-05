import test from 'node:test';
import assert from 'node:assert/strict';
import {paperCapital} from '../ui/paper-capital.mjs';
import {adjustPaperCash,initializePaperAccount,DEFAULT_PAPER_BALANCE} from '../ui/paper-state.mjs';
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
  assert.deepEqual(paperCapital(ledger,50),{startingBalance:50,cashAdjustments:0,committed:60,realized:-10,available:0,shortfall:20});
  assert.equal(JSON.stringify(ledger),before);
  for(const balance of [NaN,Infinity,0,-1])assert.throws(()=>paperCapital(ledger,balance));
  for(const remaining_basis of [NaN,Infinity,-1])assert.throws(()=>paperCapital({positions:[{remaining_basis,realized_pnl:0}]},100));
});

test('new and existing paper ledgers receive 20,000 starting funds while recorded positions are retained',()=>{
  const empty=initializePaperAccount(engine.emptyLedger());assert.equal(empty.starting_balance,20000);assert.equal(DEFAULT_PAPER_BALANCE,20000);
  const legacy=engine.applyOpen(engine.emptyLedger(),execution('buy',120),{id:'one'}),migrated=initializePaperAccount(legacy);
  assert.equal(migrated.positions,legacy.positions);assert.equal(paperCapital(migrated,migrated.starting_balance).available,19880);
  assert.equal(initializePaperAccount(migrated),migrated);
});

test('cash deposits and decreases reconcile separately from realized P/L through partial close and settlement',()=>{
  let ledger=initializePaperAccount(engine.emptyLedger());
  ledger=adjustPaperCash(ledger,'add',500,{id:'deposit'});
  ledger=engine.applyOpen(ledger,execution('buy',120),{id:'one'});
  ledger=adjustPaperCash(ledger,'decrease',1000,{id:'withdrawal'});
  assert.equal(paperCapital(ledger,ledger.starting_balance).available,19380);
  assert.equal(paperCapital(ledger,ledger.starting_balance).realized,0);
  ledger=engine.applyClose(ledger,'one',execution('sell',70,5),{id:'partial'});
  const value=paperCapital(ledger,ledger.starting_balance);assert.equal(value.available,19450);assert.equal(value.realized,10);assert.equal(value.cashAdjustments,-500);
  assert.deepEqual(engine.readLedger(JSON.stringify(ledger)),JSON.parse(JSON.stringify(ledger)));
  assert.throws(()=>adjustPaperCash(ledger,'decrease',value.available+.01,{id:'overdraw'}),/available paper cash/);
  ledger=adjustPaperCash(ledger,'decrease',value.available,{id:'empty-cash'});assert.equal(paperCapital(ledger,ledger.starting_balance).available,0);
  assert.equal(ledger.positions[0].remaining_quantity,5);
});

test('cash adjustment recovery rejects invalid or duplicate journal rows rather than dropping them',()=>{
  const ledger=adjustPaperCash(initializePaperAccount(engine.emptyLedger()),'add',50,{id:'one'});
  for(const amount of [-1,0,NaN,Infinity,.001,1e9+1])assert.throws(()=>adjustPaperCash(ledger,'add',amount,{id:'two'}));
  assert.throws(()=>adjustPaperCash(ledger,'add',10,{id:'one'}),/unique/);
  for(const cash_movements of [[...ledger.cash_movements,...ledger.cash_movements],[{...ledger.cash_movements[0],amount:NaN}],[{...ledger.cash_movements[0],action:'credit'}]])assert.throws(()=>engine.readLedger({...ledger,cash_movements}),/journal is invalid/);
});
