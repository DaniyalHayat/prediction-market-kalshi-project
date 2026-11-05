import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketServer} from '../cloud/server.mjs';
import {createRuntimeTelemetry,observeProviderAttempt} from '../lib/runtime/telemetry.mjs';
import {proxyBackend} from '../lib/workspace/proxy.mjs';

const edgeSecret='fixture-edge-secret-'.repeat(3),serviceSecret='fixture-service-secret-'.repeat(3),headers={'x-market-edge-secret':edgeSecret,'x-market-country':'US','x-market-client-ip':'198.51.100.80'};
async function server(t,options={}){
  const instance=createMarketServer({production:true,edgeSecret,serviceSecret,storageEnabled:()=>false,logger:()=>{},...options});
  await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));t.after(async()=>{instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));});
  return 'http://127.0.0.1:'+instance.address().port;
}

test('runtime percentiles, sampled logs and Prometheus remain available only behind service authorization',async t=>{
  const telemetry=createRuntimeTelemetry({routes:['/api/health','/internal/diagnostics'],providers:['fixture']}),url=await server(t,{telemetry});
  await fetch(url+'/api/health');await observeProviderAttempt('fixture',async()=>({ok:true}),telemetry);
  const body=JSON.stringify({operation:'runtime_snapshot'}),request={method:'POST',headers:{'Content-Type':'application/json'},body};
  assert.equal((await fetch(url+'/internal/diagnostics',request)).status,401);
  assert.equal((await fetch(url+'/api/internal/diagnostics',{...request,headers:{...request.headers,...headers}})).status,404);
  const snapshot=await (await fetch(url+'/internal/diagnostics',{...request,headers:{...request.headers,Authorization:'Bearer '+serviceSecret}})).json();
  assert.ok(snapshot.telemetry.distributions['request:/api/health'].count>=1);assert.equal(snapshot.telemetry.distributions['provider:fixture'].count,1);
  assert.equal(snapshot.log_filter.errors_per_minute,120);assert.ok(!JSON.stringify(snapshot).includes(serviceSecret));assert.ok(!JSON.stringify(snapshot).includes(edgeSecret));
  const metrics=await fetch(url+'/internal/diagnostics',{...request,headers:{...request.headers,Authorization:'Bearer '+serviceSecret},body:JSON.stringify({operation:'runtime_metrics'})});
  assert.match(metrics.headers.get('content-type'),/text\/plain/);assert.match(await metrics.text(),/marketlab_duration_ms_bucket/);
});

test('backend returns a private guest cookie and retains strict CSRF at its account boundary',async t=>{
  const url=await server(t);
  assert.equal((await fetch(url+'/api/session')).status,403);
  const response=await fetch(url+'/api/session',{headers});assert.equal(response.status,200);assert.equal((await response.json()).kind,'guest');
  assert.match(response.headers.getSetCookie()[0],/^__Host-market_guest=/);assert.match(response.headers.getSetCookie()[0],/HttpOnly; SameSite=Strict;.*Secure/);
  assert.equal((await fetch(url+'/api/account/logout',{method:'POST',headers})).status,403);
  assert.equal((await fetch(url+'/api/account/logout',{method:'POST',headers:{...headers,Origin:'https://predictir.dev'}})).status,200);
});

test('proxy forwards private cookies and validated CSRF metadata without exposing internal diagnostics',async t=>{
  const keys=['MARKET_BACKEND_URL','MARKET_EDGE_SECRET','VERCEL'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.MARKET_BACKEND_URL='https://backend.example';process.env.MARKET_EDGE_SECRET=edgeSecret;process.env.VERCEL='1';
  t.after(()=>{for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];});
  let observed,calls=0;const fetcher=async(_url,init)=>{calls++;observed=init;const out=Response.json({ok:true});out.headers.append('Set-Cookie','__Host-market_guest=guest; Path=/; HttpOnly; Secure; SameSite=Strict');out.headers.append('Set-Cookie','__Host-market_owner=owner; Path=/; HttpOnly; Secure; SameSite=Strict');return out;};
  const incoming={Origin:'https://predictir.dev','Sec-Fetch-Site':'same-origin','Content-Type':'application/json','x-vercel-ip-country':'US',Cookie:'__Host-market_owner=encrypted'};
  const response=await proxyBackend(new Request('https://predictir.dev/api/account/portfolio',{method:'PUT',headers:incoming,body:'{}'}),['account','portfolio'],{fetcher});
  assert.equal(observed.headers.Origin,'https://predictir.dev');assert.equal(observed.headers['Sec-Fetch-Site'],'same-origin');assert.equal(observed.headers.Cookie,incoming.Cookie);assert.equal(response.headers.getSetCookie().length,2);
  assert.equal((await proxyBackend(new Request('https://predictir.dev/api/account/logout',{method:'POST',headers:{'x-vercel-ip-country':'US'}}),['account','logout'],{fetcher})).status,403);
  assert.equal((await proxyBackend(new Request('https://predictir.dev/api/internal/diagnostics',{headers:incoming}),['internal','diagnostics'],{fetcher})).status,404);assert.equal(calls,1);
});
