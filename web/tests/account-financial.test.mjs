import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePortfolio} from '../lib/workspace/account.mjs';
import {paperCapital} from '../ui/paper-capital.mjs';

const engine=globalThis.PredictirPaper,ticker='KXTEST-YES',base=Date.UTC(2026,10,4,12),iso=seconds=>new Date(base+seconds*1000).toISOString();
const book=(seconds,yes='.40',no='.55')=>({ticker,as_of:iso(seconds),source_url:'https://external-api.kalshi.com/trade-api/v2/markets/'+ticker,raw:{orderbook_fp:{yes_dollars:[[yes,'100']],no_dollars:[[no,'100']]}}});
const check=ledger=>validatePortfolio({revision:0,watchlist:[],ledger}).ledger;
test('the client and server can retain 48 open paper lots',()=>{
  const quote=book(1),fill=engine.estimate(quote,ticker,'yes','buy',1,{now:base+1000});
  let ledger={...engine.emptyLedger(),starting_balance:20000};
  for(let i=0;i<48;i++)ledger=engine.applyOpen(ledger,fill,{id:'p'+i,time:iso(i+1)});
  assert.equal(check(ledger).positions.length,48);
  assert.throws(()=>engine.applyOpen(ledger,fill,{id:'overflow',time:iso(50)}),/maximum 48/);
});
function opened(){
  const start={...engine.emptyLedger(),starting_balance:100,cash_movements:[{id:'add',action:'add',amount:50,occurred_at:iso(0)}]},execution=engine.estimate(book(1),ticker,'yes','buy',10,{now:base+1000});
  return engine.applyOpen(start,execution,{id:'p',time:iso(1)});
}
function partial(){return engine.applyClose(opened(),'p',engine.estimate(book(2,'.50','.45'),ticker,'yes','sell',4,{now:base+2000}),{id:'close',time:iso(2)});}
function settled(){
  const ledger={...partial(),cash_movements:[...partial().cash_movements,{id:'decrease',action:'decrease',amount:20,occurred_at:iso(3)}]};
  return engine.applySettlement(ledger,'p',{market:{ticker,status:'settled',result:'yes',market_type:'binary'},as_of:iso(4),source_url:book(4).source_url},{id:'settle',time:iso(4),now:base+4000});
}

test('backend replay preserves actual UI entry, proportional partial close and binary settlement with cash adjustments',()=>{
  const entry=check(opened());assert.equal(entry.positions[0].entry_cost,4.5);assert.equal(entry.positions[0].entry_fee,.18);assert.equal(entry.positions[0].remaining_basis,4.68);assert.equal(paperCapital(entry,100).available,145.32);
  const partlyClosed=check(partial());assert.equal(partlyClosed.trades[1].released_basis,1.872);assert.equal(partlyClosed.positions[0].remaining_quantity,6);assert.equal(partlyClosed.positions[0].remaining_basis,2.808);assert.equal(partlyClosed.positions[0].realized_pnl,.058);assert.equal(paperCapital(partlyClosed,100).available,147.25);
  const completed=check(settled());assert.equal(completed.trades[2].cash,6);assert.equal(completed.positions[0].remaining_basis,0);assert.equal(completed.positions[0].realized_pnl,3.25);assert.equal(paperCapital(completed,100).available,133.25);
});

test('backend rejects the concrete fabricated-capital payload and independently tampered financial fields',()=>{
  const exploit={version:1,starting_balance:100,positions:[{id:'p',ticker,side:'yes',original_quantity:1,remaining_quantity:1,entry_cost:-500,entry_fee:-1,remaining_basis:1,realized_pnl:1000000}],trades:[{id:'t',position_id:'p',ticker,side:'yes',action:'buy',filled:100,cash:-500,fee:-1}]};
  assert.throws(()=>check(exploit),/reconcile/);
  const mutations=[ledger=>{ledger.positions[0].entry_cost=-1;},ledger=>{ledger.positions[0].entry_fee=-1;},ledger=>{ledger.positions[0].realized_pnl=1000000;},ledger=>{ledger.positions[0].remaining_quantity=8;},ledger=>{ledger.positions[0].remaining_basis=0;},ledger=>{ledger.trades[0].filled=100;},ledger=>{ledger.trades[0].fee=-1;},ledger=>{ledger.trades[0].cash=-1;},ledger=>{ledger.trades[0].notional=11;},ledger=>{ledger.trades[0].fills[0].price=2;},ledger=>{ledger.trades[1].released_basis=0;},ledger=>{ledger.trades[1].realized_pnl=123;},ledger=>{ledger.trades[1].cash=999;},ledger=>{ledger.cash_movements.push({id:'overdraft',action:'decrease',amount:1000,occurred_at:iso(3)});}];
  for(const mutate of mutations){const ledger=structuredClone(partial());mutate(ledger);assert.throws(()=>check(ledger));}
});

test('valid modeled sell fees may exceed proceeds and retain an honest cash shortfall',()=>{
  const first=engine.estimate(book(1),ticker,'yes','buy',1,{now:base+1000});
  let ledger=engine.applyOpen({...engine.emptyLedger(),starting_balance:1,cash_movements:[]},first,{id:'p',time:iso(1)});
  const exit=engine.estimate(book(2,'.10','.80'),ticker,'yes','sell',1,{now:base+2000,coefficient:1,multiplier:100});
  assert.equal(exit.cash,-8.9);ledger=engine.applyClose(ledger,'p',exit,{id:'expensive-close',time:iso(2)});
  const accepted=check(ledger);assert.equal(accepted.positions[0].realized_pnl,-9.37);assert.equal(paperCapital(accepted,1).available,0);assert.equal(paperCapital(accepted,1).shortfall,8.37);
});

test('replay preserves fractional quantities, rounded multi-level VWAP and losing settlement',()=>{
  const deep={...book(1),raw:{orderbook_fp:{yes_dollars:[['.35','1000000']],no_dollars:[['.60','100000'],['.59','200000']]}}},large=engine.estimate(deep,ticker,'yes','buy',300000,{now:base+1000});
  const largeLedger=engine.applyOpen({...engine.emptyLedger(),starting_balance:1000000,cash_movements:[]},large,{id:'large',time:iso(1)});assert.equal(check(largeLedger).positions[0].entry_cost,122000);
  const fractional={...book(1),raw:{orderbook_fp:{yes_dollars:[['.35','1']],no_dollars:[['.60','.12']]}}},fraction=engine.estimate(fractional,ticker,'yes','buy',1,{now:base+1000});
  let ledger=engine.applyOpen({...engine.emptyLedger(),starting_balance:100,cash_movements:[]},fraction,{id:'fraction',time:iso(1)});assert.equal(check(ledger).positions[0].remaining_basis,.058);
  ledger=engine.applySettlement(ledger,'fraction',{market:{ticker,status:'settled',result:'no',market_type:'binary'},as_of:iso(4),source_url:book(4).source_url},{id:'loss',time:iso(4),now:base+4000});
  assert.equal(check(ledger).positions[0].realized_pnl,-.058);assert.equal(paperCapital(ledger,100).available,99.942);
});

test('truncated or reordered histories fail explicitly and a settlement cannot invent a payout or source',()=>{
  const missingBuy=partial();missingBuy.trades=missingBuy.trades.slice(1);assert.throws(()=>check(missingBuy),/Complete trade history/);
  const reordered=partial();reordered.trades.reverse();assert.throws(()=>check(reordered));
  for(const mutate of [ledger=>{ledger.trades[2].settlement_result='no';},ledger=>{ledger.trades[2].quote_source='https://attacker.test/markets/'+ticker;},ledger=>{ledger.trades[2].filled=100;},ledger=>{ledger.positions[0].realized_pnl+=1;}]){const ledger=settled();mutate(ledger);assert.throws(()=>check(ledger));}
});
