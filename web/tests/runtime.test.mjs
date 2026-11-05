import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {BookReplica,MarketFeed} from '../lib/cloud/feed.mjs';
import {parseTraceparent,traceContext,validTracestate,structuredLog} from '../lib/runtime-observability.mjs';
import {createMarketServer} from '../cloud/server.mjs';

const edgeSecret='test-runtime-edge-'.repeat(4),headers={'x-market-edge-secret':edgeSecret,'x-market-country':'US','x-market-client-ip':'198.51.100.30'};
async function server(t,options={}){
  const instance=createMarketServer({production:true,edgeSecret,storageEnabled:()=>false,logger:()=>{},...options});
  await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));});
  return 'http://127.0.0.1:'+instance.address().port;
}
test('the standalone workbench keeps old dashboard links on the journal origin',async t=>{
  const url=await server(t,{production:false});
  for(const path of ['/','/dashboard','/dashboard/','/dashboard/index.html']){
    const response=await fetch(url+path+'?token=fixture',{redirect:'manual'});
    assert.equal(response.status,302);
    assert.equal(response.headers.get('location'),'/lab.html');
  }
  const workbench=await fetch(url+'/lab.html');
  assert.equal(workbench.status,200);
  assert.match(await workbench.text(),/Live contract workbench/);
  for(const path of ['/lab.js','/risk-client.js','/dashboard/paper.js','/dashboard/evidence/index.json']){
    assert.equal((await fetch(url+path,{method:'HEAD'})).status,200,path);
  }
  for(const name of ['runtime.js','data-app-build.json','cloud-navigation.js','snapshot.'+'a'.repeat(64)+'.json']){
    assert.equal((await fetch(url+'/dashboard/'+name,{method:'HEAD'})).status,404,name);
  }
});
test('the Railway API host still sends browser visitors to Predictir',async t=>{
  const url=await server(t);
  const response=await fetch(url+'/dashboard/index.html',{redirect:'manual'});
  assert.equal(response.status,302);
  assert.equal(response.headers.get('location'),'https://predictir.dev/');
});
test('trace context rejects invalid IDs and trust-boundary state, while correlating verified hops',()=>{
  const input='00-'+'a'.repeat(32)+'-'+'b'.repeat(16)+'-01';
  assert.equal(parseTraceparent(input).sampled,true);
  for(const bad of [input.toUpperCase(),input+'-extra','00-'+'0'.repeat(32)+'-'+'b'.repeat(16)+'-01','ff-'+input.slice(3)])assert.equal(parseTraceparent(bad),null);
  const trusted=traceContext({traceparent:input,tracestate:'vendor=secret',baggage:'email=private@example.com'},{trusted:true});
  assert.equal(trusted.traceId,'a'.repeat(32));assert.equal(trusted.parentId,'b'.repeat(16));assert.equal(trusted.baggageDropped,true);assert.ok(!JSON.stringify(trusted).includes('private@'));assert.ok(!JSON.stringify(trusted).includes('vendor=secret'));
  assert.notEqual(traceContext({traceparent:input}).traceId,'a'.repeat(32));
  assert.equal(validTracestate('vendor=value,other=opaque'),true);assert.equal(validTracestate('vendor=a,vendor=b'),false);assert.equal(validTracestate('bad key=value'),false);assert.equal(validTracestate('a=b=c'),false);
});
test('structured logs keep only operational fields and never include tokens, bodies, URLs or errors',()=>{
  const lines=[];const value=structuredLog('request.finished',{route:'/api/book',status:200,duration_ms:2,token:'PRIVATE',url:'?token=PRIVATE',body:'PRIVATE',error:'PRIVATE',trace_id:'a'.repeat(32)},line=>lines.push(line));
  assert.equal(value.status,200);assert.ok(!lines.join('').includes('PRIVATE'));assert.throws(()=>structuredLog('bad\nlog'),RangeError);
});
test('subscription control acknowledgements participate in sequence continuity',()=>{
  const replica=new BookReplica();replica.apply({type:'orderbook_snapshot',sid:2,seq:1,msg:{market_ticker:'TEST-A',yes_dollars_fp:[['.4','10']],no_dollars_fp:[['.55','10']]}});
  replica.apply({type:'ok',sid:2,seq:2,msg:{market_tickers:['TEST-A']}});
  const next=replica.apply({type:'orderbook_delta',sid:2,seq:3,msg:{market_ticker:'TEST-A',side:'yes',price_dollars:'.4',delta_fp:'1'}});
  assert.equal(next.raw.orderbook_fp.yes_dollars[0][1],'11');
});
test('one ticker disconnect cannot close other subscribers; obsolete deltas and late socket callbacks are safe',async()=>{
  const {privateKey}=generateKeyPairSync('ed25519');
  class Socket extends EventEmitter{readyState=0;sent=[];closed=0;send(raw){this.sent.push(JSON.parse(raw));}close(){this.closed++;this.readyState=3;this.emit('close');}}
  const socket=new Socket(),feed=new MarketFeed({credentials:async()=>({id:'fixture',pem:privateKey.export({format:'pem',type:'pkcs8'})}),socket:()=>socket}),received=[];
  const a=await feed.add('TEST-A',()=>{}),b=await feed.add('TEST-B',row=>received.push(row));
  socket.readyState=1;socket.emit('open');socket.emit('message',Buffer.from(JSON.stringify({type:'subscribed',msg:{channel:'orderbook_delta',sid:2}})));
  for(const [i,ticker] of ['TEST-A','TEST-B'].entries())socket.emit('message',Buffer.from(JSON.stringify({type:'orderbook_snapshot',sid:2,seq:i+1,msg:{market_ticker:ticker,yes_dollars_fp:[['.4','10']],no_dollars_fp:[['.55','10']]}})));
  a();a();assert.equal(socket.closed,0);assert.equal(feed.clients.size,1);assert.equal(socket.sent.at(-1).params.action,'delete_markets');
  socket.emit('message',Buffer.from(JSON.stringify({type:'orderbook_delta',sid:2,seq:3,msg:{market_ticker:'TEST-A',side:'yes',price_dollars:'.4',delta_fp:'1'}})));
  socket.emit('message',Buffer.from(JSON.stringify({type:'orderbook_delta',sid:2,seq:4,msg:{market_ticker:'TEST-B',side:'yes',price_dollars:'.4',delta_fp:'2'}})));
  feed.emitDirty();assert.equal(socket.closed,0);assert.equal(received.at(-1).raw.orderbook_fp.yes_dollars[0][1],'12');
  b();assert.equal(socket.closed,1);assert.equal(feed.clients.size,0);assert.equal(feed.replica.books.size,0);
});
test('concurrent failed credential requests release every listener and ticker slot',async()=>{
  let release;const blocked=new Promise(resolve=>{release=resolve;});
  const feed=new MarketFeed({credentials:async()=>{await blocked;return null;}}),attempts=['TEST-A','TEST-B','TEST-C'].map(ticker=>feed.add(ticker,()=>{}));
  release();const results=await Promise.allSettled(attempts);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(feed.clients.size,0);
});
test('broadcast snapshots bound materialization without losing indexed reconstruction depth',()=>{
  const replica=new BookReplica(),levels=Array.from({length:150},(_,i)=>[(.1+i/10000).toFixed(4),'10']);
  const value=replica.apply({type:'orderbook_snapshot',sid:1,seq:1,msg:{market_ticker:'TEST-A',yes_dollars_fp:levels,no_dollars_fp:[['.5','10']]}});
  assert.equal(value.raw.orderbook_fp.yes_dollars.length,100);assert.equal(value.depth_truncated,true);assert.equal(replica.books.get('TEST-A').yes.size,150);
});
test('multiplex SSE emits named latest-book events and cleans every subscription',async t=>{
  const listeners=new Map();let removed=0;
  const feed={status:'connected',add:async(ticker,fn)=>{listeners.set(ticker,fn);fn({kind:'connection',status:'connected'});for(let i=0;i<10;i++)fn({kind:'quote',ticker,sequence:i,as_of:new Date().toISOString(),raw:{orderbook_fp:{yes_dollars:[['.4',String(i+1)]],no_dollars:[['.55','10']]}}});return()=>{listeners.delete(ticker);removed++;};}};
  const url=await server(t,{feed}),response=await fetch(url+'/api/portfolio/stream?tickers=TEST-A,TEST-B',{headers,signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);const reader=response.body.getReader();let text='';
  while((text.match(/event: book/g)||[]).length<2){const value=await reader.read();text+=new TextDecoder().decode(value.value);}
  assert.equal((text.match(/event: book/g)||[]).length,2);assert.ok(text.includes('"sequence":9'));assert.ok(text.includes('event: status'));await reader.cancel();
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(listeners.size,0);assert.equal(removed,2);
});
test('portfolio admission bounds ticker lists, charges bytes once and preserves trace correlation',async t=>{
  const takes=[],logs=[];const storage={consume:async(key,limit,amount)=>{takes.push({key,limit,amount});return !key.startsWith('stream-egress');}};
  const url=await server(t,{storageEnabled:()=>true,storage:()=>storage,logger:(event,value)=>logs.push({event,...value})});
  const tooMany=await fetch(url+'/api/portfolio/stream?tickers='+Array.from({length:13},(_,i)=>'TEST-'+i).join(','),{headers});assert.equal(tooMany.status,400);
  const trace='00-'+'a'.repeat(32)+'-'+'b'.repeat(16)+'-01';
  const denied=await fetch(url+'/api/portfolio/stream?tickers=TEST-A,TEST-B',{headers:{...headers,traceparent:trace,baggage:'private=secret'}});assert.equal(denied.status,429);assert.ok(denied.headers.get('traceparent').includes('a'.repeat(32)));
  assert.equal(takes.filter(t=>t.key.startsWith('stream-egress')).length,1);assert.equal(takes.find(t=>t.key.startsWith('stream-egress')).amount,65536);
  assert.ok(!JSON.stringify(logs).includes('secret'));assert.equal(logs.at(-1).baggage_dropped,true);
});
