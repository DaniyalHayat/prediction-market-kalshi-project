import assert from 'node:assert/strict';
import test from 'node:test';
import {PublicBookFeed,PUBLIC_BOOK_TRANSPORT} from '../lib/cloud/public-book-feed.mjs';

const start=Date.UTC(2026,10,5,12),first='KXNFLGAME-26NOV08ARISEA-ARI',second='KXNFLGAME-26NOV08ARISEA-SEA';
const snapshot=(ticker,time)=>({ticker,as_of:new Date(time).toISOString(),
  source_url:'https://external-api.kalshi.com/trade-api/v2/markets/'+ticker+'/orderbook?depth=100',
  raw:{orderbook_fp:{yes_dollars:[['0.48','100.00']],no_dollars:[['0.50','200.00']]}}});
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function clock(){
  let now=start,sequence=0;
  const queue=new Map();
  const schedule=(run,delay)=>{const id=++sequence;queue.set(id,{run,at:now+delay});return id;};
  const cancel=id=>queue.delete(id);
  return {now:()=>now,schedule,cancel,pending:()=>queue.size,advance:async ms=>{
    const end=now+ms;
    await flush();
    while(queue.size){
      const [id,next]=[...queue].sort((a,b)=>a[1].at-b[1].at)[0];
      if(next.at>end)break;
      now=next.at;queue.delete(id);next.run();await flush();
    }
    now=end;await flush();
  }};
}

test('one ticker shares one in-flight poll across subscribers and reconnects',async ()=>{
  const c=clock(),observed=[],joined=[];
  let calls=0,finish;
  const feed=new PublicBookFeed({...c,fetchBook:async()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  const release=await feed.add(first,value=>observed.push(value));
  const other=await feed.add(first,value=>observed.push(value));
  await c.advance(0);
  assert.equal(calls,1);
  release();other();
  const reconnect=await feed.add(first,value=>joined.push(value));
  await c.advance(1000);
  assert.equal(calls,1);
  finish(snapshot(first,start));
  await flush();
  const quote=joined.find(row=>row.kind==='quote');
  assert.equal(quote.transport,PUBLIC_BOOK_TRANSPORT);
  assert.equal(quote.as_of,new Date(start).toISOString());
  assert.equal(quote.sequence,undefined);
  assert.equal(quote.received_at,undefined);
  assert.equal(observed.filter(row=>row.kind==='quote').length,0);
  await c.advance(8000);
  assert.equal(calls,2);
  finish(snapshot(first,start));
  await flush();
  assert.equal(joined.filter(row=>row.kind==='quote').length,1);
  reconnect();reconnect();
  await c.advance(30000);
  assert.equal(calls,2);
  assert.equal(feed.metrics().subscribers,0);
  assert.equal(c.pending(),0);
});

test('polls are globally spaced, capacity bounded, and stale readers do not start more work',async ()=>{
  const c=clock(),started=[],finish=[];
  const feed=new PublicBookFeed({...c,maximumTickers:2,maximumConcurrent:2,fetchBook:async ticker=>{
    started.push({ticker,at:c.now()});
    return new Promise(resolve=>finish.push(()=>resolve(snapshot(ticker,c.now()))));
  }});
  await feed.add(first,()=>{});
  await feed.add(second,()=>{});
  await assert.rejects(feed.add('KXTHIRD-FIXTURE',()=>{}),/capacity/);
  await c.advance(999);
  assert.deepEqual(started,[{ticker:first,at:start}]);
  await c.advance(1);
  assert.deepEqual(started,[{ticker:first,at:start},{ticker:second,at:start+1000}]);
  assert.equal(feed.metrics().polls_in_flight,2);
  feed.close();
  finish.forEach(resolve=>resolve());
  await c.advance(30000);
  assert.equal(started.length,2);
  assert.equal(feed.metrics().polls_in_flight,0);
  assert.equal(c.pending(),0);
});

test('upstream throttling pauses all tickers and daily quota denial does not send an upstream request',async ()=>{
  const c=clock(),seen=[],attempts=[];
  let allowed=true;
  const feed=new PublicBookFeed({...c,reserve:async()=>allowed,fetchBook:async ticker=>{
    attempts.push(ticker);
    if(attempts.length===1)throw Object.assign(new Error('Provider rate limit'),{upstream_status:429,retry_after_seconds:75});
    return snapshot(ticker,c.now());
  }});
  await feed.add(first,value=>seen.push(value));
  await feed.add(second,value=>seen.push(value));
  await c.advance(0);
  assert.equal(attempts.length,1);
  assert.equal(seen.filter(row=>row.status==='backoff').length,2);
  assert.equal(seen.find(row=>row.status==='backoff').retry_at,new Date(start+75000).toISOString());
  await c.advance(74999);
  assert.equal(attempts.length,1);
  allowed=false;
  await c.advance(1);
  assert.equal(attempts.length,1);
  assert.equal(feed.status,'allowance reached');
  await c.advance(60000);
  assert.equal(attempts.length,1);
  feed.close();
});

test('a mismatched or crossed snapshot cannot publish a quote or overwrite the source time',async ()=>{
  const c=clock(),seen=[];
  let attempts=0;
  const feed=new PublicBookFeed({...c,fetchBook:async ticker=>{
    attempts++;
    if(attempts===1)return snapshot(second,c.now());
    if(attempts===2)return {...snapshot(ticker,c.now()),raw:{orderbook_fp:{yes_dollars:[['0.8','20']],no_dollars:[['0.4','20']]}}};
    return snapshot(ticker,c.now());
  }});
  await feed.add(first,value=>seen.push(value));
  await c.advance(47999);
  assert.equal(attempts,2);
  assert.equal(seen.filter(row=>row.status==='snapshot unavailable').length,2);
  assert.equal(seen.filter(row=>row.kind==='quote').length,0);
  await c.advance(1);
  const quote=seen.find(row=>row.kind==='quote');
  assert.equal(quote.ticker,first);
  assert.equal(quote.as_of,new Date(start+48000).toISOString());
  feed.close();
});
