import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceJSON,providerStatus} from '../lib/workspace/providers.mjs';

test('provider failures expose availability without database roles, credentials or raw upstream content',async()=>{
  const id='ESPN failure fixture',secret='private-connection-credential-sentinel';
  await assert.rejects(sourceJSON(id,'https://site.api.espn.com/failure-fixture',{fetcher:async()=>{throw new Error('database role leaked with '+secret);}}),error=>{
    assert.equal(error.status,503);assert.match(error.message,/temporarily unavailable/);assert.ok(!error.message.includes(secret));assert.ok(!error.message.includes('database role'));return true;
  });
  const status=providerStatus().find(row=>row.id===id);assert.equal(status.status,'unavailable');assert.ok(!JSON.stringify(status).includes(secret));
});
test('safe upstream failure status remains visible without echoing its response body',async()=>{
  await assert.rejects(sourceJSON('ESPN HTTP fixture','https://rss.marketingtools.apple.com/http-fixture',{fetcher:async()=>{throw Object.assign(new Error('private upstream body'),{status:502});}}),error=>{
    assert.equal(error.status,502);assert.match(error.message,/HTTP 502/);assert.ok(!error.message.includes('private upstream body'));return true;
  });
});
test('network failures enter host backoff before another request can leave the app',async()=>{
  let requests=0;const fetcher=async()=>{requests++;throw new Error('upstream timeout');};
  await assert.rejects(sourceJSON('Spotify timeout fixture','https://api.spotify.com/timeout-fixture',{fetcher}),error=>error.status===503&&Number.isFinite(Date.parse(error.retry_at)));
  await assert.rejects(sourceJSON('Spotify timeout retry','https://api.spotify.com/timeout-retry',{fetcher}),error=>error.status===503&&/cooling down/.test(error.message));
  assert.equal(requests,1);
});
