import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceJSON,providerStatus,sourceFailureDetails} from '../lib/workspace/providers.mjs';
import {runtimeTelemetry} from '../lib/runtime/telemetry.mjs';

test('provider failures expose availability without database roles, credentials or raw upstream content',async()=>{
  const id='ESPN failure fixture',secret='private-connection-credential-sentinel';
  await assert.rejects(sourceJSON(id,'https://site.api.espn.com/failure-fixture',{fetcher:async()=>{throw new Error('database role leaked with '+secret);}}),error=>{
    assert.equal(error.status,503);assert.match(error.message,/temporarily unavailable/);assert.ok(!error.message.includes(secret));assert.ok(!error.message.includes('database role'));return true;
  });
  const status=providerStatus().find(row=>row.id===id);assert.equal(status.status,'unavailable');assert.ok(!JSON.stringify(status).includes(secret));
});
test('safe upstream failure status remains visible without echoing its response body',async()=>{
  await assert.rejects(sourceJSON('ESPN HTTP fixture','https://rss.marketingtools.apple.com/http-fixture',{fetcher:async()=>Response.json({error:'private upstream body'},{status:502})}),error=>{
    assert.equal(error.status,502);assert.match(error.message,/HTTP 502/);assert.ok(!error.message.includes('private upstream body'));return true;
  });
});

test('provider causes distinguish request timeout, actual HTTP failure, network and invalid JSON without secrets',async()=>{
  const cases=[
    {name:'request-timeout',fetcher:async()=>{throw new DOMException('PRIVATE_TIMEOUT_DETAIL','TimeoutError');},code:'UPSTREAM_TIMEOUT',status:503,upstream:undefined},
    {name:'actual-http-503',fetcher:async()=>Response.json({error:'PRIVATE_HTTP_BODY'},{status:503}),code:'UPSTREAM_HTTP_503',status:503,upstream:503},
    {name:'network',fetcher:async()=>{throw new TypeError('PRIVATE_NETWORK_DETAIL');},code:'UPSTREAM_NETWORK_ERROR',status:503,upstream:undefined},
    {name:'invalid-json',fetcher:async()=>new Response('PRIVATE_INVALID_BODY',{headers:{'Content-Type':'application/json'}}),code:'UPSTREAM_INVALID_JSON',status:502,upstream:200},
    {name:'body-timeout',fetcher:async()=>new Response(new ReadableStream({start(controller){controller.error(new DOMException('PRIVATE_BODY_DETAIL','AbortError'));}}),{headers:{'Content-Type':'application/json'}}),code:'UPSTREAM_BODY_TIMEOUT',status:503,upstream:200}
  ];
  for(const item of cases){
    const mod=await import('../lib/workspace/providers.mjs?failure-case='+item.name);
    const before=runtimeTelemetry.snapshot().distributions['provider:apple_music']?.errors||0;
    await assert.rejects(mod.sourceJSON(item.name,'https://rss.marketingtools.apple.com/'+item.name,{fetcher:item.fetcher}),error=>{
      assert.equal(error.code,item.code);assert.equal(error.status,item.status);assert.equal(error.upstream_status,item.upstream);assert.ok(!error.message.includes('PRIVATE_'));assert.equal(error.cause,undefined);return true;
    });
    const status=mod.providerStatus().find(row=>row.id===item.name);assert.equal(status.error_code,item.code);assert.equal(status.upstream_status,item.upstream);assert.ok(!JSON.stringify(status).includes('PRIVATE_'));
    assert.equal(runtimeTelemetry.snapshot().distributions['provider:apple_music'].errors,before+1);
  }
  assert.deepEqual(sourceFailureDetails({code:'PRIVATE_CODE_CREDENTIAL',status:503}),{error_code:'SOURCE_UNAVAILABLE'});
});
test('network failures enter host backoff before another request can leave the app',async()=>{
  let requests=0;const fetcher=async()=>{requests++;throw new Error('upstream timeout');};
  await assert.rejects(sourceJSON('Spotify timeout fixture','https://api.spotify.com/timeout-fixture',{fetcher}),error=>error.status===503&&Number.isFinite(Date.parse(error.retry_at)));
  await assert.rejects(sourceJSON('Spotify timeout retry','https://api.spotify.com/timeout-retry',{fetcher}),error=>error.status===503&&/cooling down/.test(error.message));
  assert.equal(requests,1);
});
test('lost local cache leases propagate only an allowlisted code and do not cool down a healthy provider',async()=>{
  await assert.rejects(sourceJSON('Local lease fixture','https://accounts.spotify.com/local-lease-fixture',{fetcher:async()=>{throw Object.assign(new Error('PRIVATE_DATABASE_DETAIL'),{status:429,code:'CACHE_LEASE_LOST'});}}),error=>error.status===429&&error.code==='CACHE_LEASE_LOST'&&!error.message.includes('PRIVATE_DATABASE_DETAIL'));
  await assert.rejects(sourceJSON('Busy lease fixture','https://accounts.spotify.com/busy-lease-fixture',{fetcher:async()=>{throw Object.assign(new Error('PRIVATE_DATABASE_DETAIL'),{status:429,code:'CACHE_LEASE_BUSY'});}}),error=>error.status===429&&error.code==='CACHE_LEASE_BUSY'&&!error.message.includes('PRIVATE_DATABASE_DETAIL'));
  assert.equal(providerStatus().find(row=>row.id==='Local lease fixture').status,'refreshing');
  assert.equal(providerStatus().find(row=>row.id==='Busy lease fixture').status,'refreshing');
  const value=await sourceJSON('Healthy post-lease fixture','https://accounts.spotify.com/healthy-lease-fixture',{fetcher:async()=>Response.json({status:'ok'})});assert.equal(value.data.status,'ok');
});
