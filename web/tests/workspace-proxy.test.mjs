import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyBackend} from '../lib/workspace/proxy.mjs';
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
