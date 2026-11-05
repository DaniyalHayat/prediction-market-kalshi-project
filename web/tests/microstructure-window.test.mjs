import test from 'node:test';
import assert from 'node:assert/strict';
import {BookReplica} from '../lib/cloud/feed.mjs';
import {MicrostructureWindow} from '../lib/cloud/microstructure-window.mjs';

const snapshot=(ticker,seq)=>({type:'orderbook_snapshot',sid:2,seq,msg:{market_ticker:ticker,yes_dollars_fp:[['0.4','10']],no_dollars_fp:[['0.5','12']]}});
test('bounded pre-throttle quote window preserves ticker-local continuity across interleaved exchange events',()=>{
  const replica=new BookReplica(),history=new MicrostructureWindow({capacity:3,clock:()=>1000});
  for(let seq=1;seq<=6;seq++){
    const ticker=seq===2?'OTHER':'SELECTED',event=seq<=2?snapshot(ticker,seq):{type:'orderbook_delta',sid:2,seq,msg:{market_ticker:ticker,side:'yes',price_dollars:'0.4',delta_fp:'1'}};
    replica.apply(event,1000000,false);history.append(ticker,replica.books.get(ticker),event);
  }
  const rows=history.read('SELECTED',3);
  assert.deepEqual(rows.map(row=>row.sequence),[3,4,5]);assert.deepEqual(rows.map(row=>row.exchange_sequence),[4,5,6]);
  assert.equal(rows[0].ask_price,.5);assert.equal(rows[0].ask_size,12);assert.equal(rows.at(-1).bid_size,14);
  rows[0].bid_size=-100;assert.equal(history.read('SELECTED',3)[0].bid_size,12);
  assert.equal(history.read('OTHER',3).length,1);
});

test('snapshot replacements, unsubscribing and one-sided books reset the research generation',()=>{
  const replica=new BookReplica(),history=new MicrostructureWindow();
  let event=snapshot('X',1);replica.apply(event,1000000,false);history.append('X',replica.books.get('X'),event);const first=history.read('X')[0];
  event=snapshot('X',2);replica.apply(event,1000000,false);history.append('X',replica.books.get('X'),event);const second=history.read('X')[0];
  assert.notEqual(first.generation,second.generation);assert.equal(second.sequence,1);
  event={type:'orderbook_delta',sid:2,seq:3,msg:{market_ticker:'X',side:'no',price_dollars:'0.5',delta_fp:'-12'}};replica.apply(event,1000000,false);history.append('X',replica.books.get('X'),event);assert.deepEqual(history.read('X'),[]);
  history.reset();assert.deepEqual(history.read('X'),[]);
});
