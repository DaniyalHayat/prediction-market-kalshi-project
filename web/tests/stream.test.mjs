import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {BookReplica,websocketHeaders} from '../lib/cloud/feed.mjs';
const snapshot={type:'orderbook_snapshot',sid:2,seq:1,msg:{market_ticker:'TEST-YES',yes_dollars_fp:[['0.4','10']],no_dollars_fp:[['0.55','5.5']]}};
test('stream snapshot and fractional deltas reconstruct real depth',()=>{
  const book=new BookReplica();book.apply(snapshot,1000);
  const row=book.apply({type:'orderbook_delta',sid:2,seq:2,msg:{market_ticker:'TEST-YES',side:'yes',price_dollars:'0.4',delta_fp:'-1.25'}},2000);
  assert.equal(row.raw.orderbook_fp.yes_dollars[0][1],'8.75');assert.equal(row.as_of,new Date(2000).toISOString());
});
test('sequence gaps and deltas without snapshots are rejected',()=>{
  const book=new BookReplica();book.apply(snapshot);
  assert.throws(()=>book.apply({type:'orderbook_delta',sid:2,seq:3,msg:{market_ticker:'TEST-YES'}}),/Sequence gap/);
  const empty=new BookReplica();assert.throws(()=>empty.apply({type:'orderbook_delta',sid:2,seq:1,msg:{market_ticker:'TEST-YES'}}),/before its snapshot/);
});
test('negative and crossed depth never become executable quotes',()=>{
  const book=new BookReplica();book.apply(snapshot);
  assert.throws(()=>book.apply({type:'orderbook_delta',sid:2,seq:2,msg:{market_ticker:'TEST-YES',side:'yes',price_dollars:'.4',delta_fp:'-11'}}),/underflow/);
  const crossed=new BookReplica();assert.throws(()=>crossed.apply({...snapshot,msg:{...snapshot.msg,yes_dollars_fp:[['.9','10']]}}),/Crossed/);
});
test('stream authentication signs only the fixed official websocket path',()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const headers=websocketHeaders({id:'test-key',pem:privateKey.export({format:'pem',type:'pkcs8'})},12345);
  assert.equal(headers['KALSHI-ACCESS-TIMESTAMP'],'12345');
  assert.ok(verify(null,Buffer.from('12345GET/trade-api/ws/v2'),publicKey,Buffer.from(headers['KALSHI-ACCESS-SIGNATURE'],'base64')));
});
