import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {proxyBackend,STREAM_CONNECT_TIMEOUT_MS,STREAM_LIFETIME_MS} from '../lib/workspace/proxy.mjs';
import config from '../next.config.mjs';
function environment(t){const keys=['MARKET_BACKEND_URL','MARKET_EDGE_SECRET','VERCEL'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.MARKET_BACKEND_URL='https://backend.example';process.env.MARKET_EDGE_SECRET='private-proxy-test-'.repeat(4);process.env.VERCEL='1';
  t.after(()=>{for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];});
}
const headers={Origin:'https://predictir.dev','x-vercel-ip-country':'US','x-vercel-forwarded-for':'198.51.100.8'};
test('proxy accepts only named public routes and prevents origin/country bypass before fetch',async t=>{
  environment(t);let calls=0;const options={fetcher:async()=>{calls++;return Response.json({ok:true});}};
  for(const path of [['portfolio','orders'],['..','mcp'],['workspace','secret'],['mcp']])assert.equal((await proxyBackend(new Request('https://predictir.dev/api/x',{headers}),path,options)).status,404);
  for(const country of ['CN','IN','RU',''])assert.equal((await proxyBackend(new Request('https://predictir.dev/api/book',{headers:{...headers,'x-vercel-ip-country':country}}),['book'],options)).status,403);
  assert.equal((await proxyBackend(new Request('https://predictir.dev/api/book',{headers:{...headers,Origin:'https://attacker.example'}}),['book'],options)).status,403);
  assert.equal(calls,0);
});
test('proxy supplies only trusted edge identity and forwards journal authorization selectively',async t=>{
  environment(t);const observed=[];const options={fetcher:async(url,init)=>{observed.push({url:String(url),init});return Response.json({ok:true});}};
  const incoming={...headers,Authorization:'Bearer private-journal','x-market-edge-secret':'attacker','x-market-country':'CN','x-market-client-ip':'1.1.1.1'};
  await proxyBackend(new Request('https://predictir.dev/api/book?ticker=TEST-YES',{headers:incoming}),['book'],options);
  assert.equal(observed[0].init.headers['x-market-country'],'US');assert.equal(observed[0].init.headers['x-market-client-ip'],'198.51.100.8');assert.equal(observed[0].init.headers['x-market-edge-secret'],process.env.MARKET_EDGE_SECRET);assert.equal(observed[0].init.headers.Authorization,undefined);assert.equal(observed[0].url,'https://backend.example/api/book?ticker=TEST-YES');
  await proxyBackend(new Request('https://predictir.dev/api/journal',{headers:incoming}),['journal'],options);assert.equal(observed[1].init.headers.Authorization,'Bearer private-journal');
});
test('chunked oversized proxy requests cancel reading before forwarding or allocating the remainder',async t=>{
  environment(t);let cancelled=false,calls=0,pulls=0;
  const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(15000));},cancel(){cancelled=true;}});
  const request=new Request('https://predictir.dev/api/journal',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body,duplex:'half'});
  const response=await proxyBackend(request,['journal'],{fetcher:async()=>{calls++;return Response.json({ok:true});}});
  assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(pulls<=3);assert.equal(calls,0);
});
test('proxy converts HTML provider failures into JSON and never follows redirects',async t=>{
  environment(t);
  const response=await proxyBackend(new Request('https://predictir.dev/api/book',{headers}),['book'],{fetcher:async(url,init)=>{assert.equal(init.redirect,'error');return new Response('<!doctype html>proxy failure',{status:502,headers:{'Content-Type':'text/html'}});}});
  assert.equal(response.status,502);assert.match(response.headers.get('content-type'),/json/);assert.match((await response.json()).error,/web page/);
});
test('public response headers contain bounded source policy and no framing or evaluation in production',async()=>{
  const values=(await config.headers())[0].headers,byKey=Object.fromEntries(values.map(({key,value})=>[key,value]));
  assert.equal(byKey['X-Frame-Options'],'DENY');assert.equal(byKey['X-Content-Type-Options'],'nosniff');
  assert.match(byKey['Content-Security-Policy'],/frame-ancestors 'none'/);assert.match(byKey['Content-Security-Policy'],/https:\/\/www\.googletagmanager\.com/);
  if(process.env.NODE_ENV!=='development')assert.ok(!byKey['Content-Security-Policy'].includes("'unsafe-eval'"));
  assert.ok(!byKey['Content-Security-Policy'].includes('connect-src https:'));assert.match(byKey['Strict-Transport-Security'],/max-age=31536000/);
});

test('SSE rotation fits the paid Fluid route duration with room for the separate connect deadline',async()=>{
  const route=await readFile(new URL('../app/api/[...path]/route.js',import.meta.url),'utf8'),duration=Number(route.match(/export const maxDuration = (\d+)/)?.[1]);
  assert.equal(duration,800);assert.equal(STREAM_LIFETIME_MS,750000);assert.equal(STREAM_CONNECT_TIMEOUT_MS,5000);
  assert.ok(STREAM_LIFETIME_MS+STREAM_CONNECT_TIMEOUT_MS<duration*1000);
});

test('SSE rotation ends actual upstream HTTP streams cleanly instead of piping a timed-out body',async t=>{
  environment(t);const errors=[],closed=[];let allClosed;
  const released=new Promise(resolve=>{allClosed=resolve;});
  const server=createServer((request,response)=>{
    response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: {"kind":"heartbeat"}\n\n');
    response.on('close',()=>{closed.push(request.url);if(closed.length===2)allClosed();});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  for(const path of [['stream'],['portfolio','stream']]){
    let signal;
    const response=await proxyBackend(new Request('https://predictir.dev/api/'+path.join('/'),{headers}),path,{streamLifetimeMs:50,streamConnectTimeoutMs:1000,onStreamError:error=>errors.push(error),
      fetcher:(url,init)=>{signal=init.signal;return fetch(`http://127.0.0.1:${server.address().port}/`+path.join('/'),init);}});
    assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);assert.equal(response.headers.get('x-accel-buffering'),'no');
    assert.equal(await response.text(),'data: {"kind":"heartbeat"}\n\n');assert.equal(signal.aborted,true);
  }
  let deadline;try{await Promise.race([released,new Promise((resolve,reject)=>{deadline=setTimeout(()=>reject(new Error('Upstream sockets were not released')),1000);})]);}finally{clearTimeout(deadline);}
  assert.deepEqual(errors,[]);
  assert.deepEqual(closed.sort(),['/portfolio/stream','/stream']);
});

test('request abort and downstream cancellation release SSE readers without logging expected disconnects',async t=>{
  environment(t);
  for(const reason of ['request','consumer']){
    const abort=new AbortController(),errors=[];let cancelled=0,signal;
    const source=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: first\n\n'));},cancel(){cancelled++;}});
    const response=await proxyBackend(new Request('https://predictir.dev/api/stream',{headers,signal:abort.signal}),['stream'],{onStreamError:error=>errors.push(error),
      fetcher:async(url,init)=>{signal=init.signal;return new Response(source,{headers:{'Content-Type':'text/event-stream'}});}});
    const reader=response.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'data: first\n\n');
    if(reason==='request'){const pending=reader.read();abort.abort();assert.equal((await pending).done,true);}else await reader.cancel();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(signal.aborted,true);assert.equal(cancelled,1);assert.equal(source.locked,false);assert.deepEqual(errors,[]);
  }
});

test('unexpected SSE read failures retain a safe diagnostic and close the public stream normally',async t=>{
  environment(t);let control,signal;const errors=[];
  const source=new ReadableStream({start(controller){control=controller;controller.enqueue(new TextEncoder().encode('data: first\n\n'));}});
  const response=await proxyBackend(new Request('https://predictir.dev/api/stream',{headers}),['stream'],{onStreamError:error=>errors.push(error),
    fetcher:async(url,init)=>{signal=init.signal;return new Response(source,{headers:{'Content-Type':'text/event-stream'}});}});
  const reader=response.body.getReader();await reader.read();control.error(new Error('PRIVATE_UPSTREAM_DETAIL'));
  assert.equal((await reader.read()).done,true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(signal.aborted,true);assert.equal(source.locked,false);assert.equal(errors.length,1);assert.equal(errors[0].error_code,'UPSTREAM_STREAM_INTERRUPTED');assert.equal(errors[0].route,'/stream');
  assert.ok(!JSON.stringify(errors).includes('PRIVATE_UPSTREAM_DETAIL'));
});

test('SSE connection timeouts finish before headers and non-SSE errors retain their status',async t=>{
  environment(t);let signal;
  const failed=await proxyBackend(new Request('https://predictir.dev/api/stream',{headers}),['stream'],{streamConnectTimeoutMs:10,fetcher:async(url,init)=>{
    signal=init.signal;return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}});
  assert.equal(failed.status,503);assert.equal(signal.aborted,true);assert.match((await failed.json()).error,/temporarily unavailable/);
  const denied=await proxyBackend(new Request('https://predictir.dev/api/stream',{headers}),['stream'],{fetcher:async()=>Response.json({error:'Stream capacity reached'},{status:429,headers:{'Retry-After':'15'}})});
  assert.equal(denied.status,429);assert.equal(denied.headers.get('retry-after'),'15');assert.deepEqual(await denied.json(),{error:'Stream capacity reached'});
});

test('the SSE relay reads only bounded demand when the downstream consumer is paused',async t=>{
  environment(t);let pulls=0,cancelled=0;
  const source=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array([10]));},cancel(){cancelled++;}},{highWaterMark:0});
  const response=await proxyBackend(new Request('https://predictir.dev/api/stream',{headers}),['stream'],{fetcher:async()=>new Response(source,{headers:{'Content-Type':'text/event-stream'}})});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(pulls,1);
  const reader=response.body.getReader();await reader.read();await new Promise(resolve=>setImmediate(resolve));assert.equal(pulls,2);
  await reader.cancel();assert.equal(cancelled,1);assert.equal(source.locked,false);
});
