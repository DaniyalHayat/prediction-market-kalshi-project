import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {createAzureReplayServer} from '../cloud/azure-replay.mjs';
import {azureMode, azureOrigin} from '../lib/workspace/azure-mode.mjs';
import {proxyBackend} from '../lib/workspace/proxy.mjs';

test('the replay backend serves a held-out archive and refuses live routes and writes', async t => {
  const server = createAzureReplayServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.provider_calls, 0);
  const response = await fetch(base + '/api/workspace/replay');
  const catalog = await response.json();
  assert.equal(catalog.mode, 'replay');
  assert.equal(catalog.games.length, 6);
  assert.ok(catalog.games.every(row => row.home_period_scores.length === 4 && row.away_period_scores.length === 4));
  assert.equal((await fetch(base + '/api/workspace/research')).status, 404);
  assert.equal((await fetch(base + '/api/workspace/replay', {method: 'POST'})).status, 405);
});

test('the Azure proxy denies live fallbacks and validates configured origins', async t => {
  const names = ['PREDICTIR_MODE', 'MARKET_BACKEND_URL', 'APP_ORIGIN'];
  const original = Object.fromEntries(names.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.PREDICTIR_MODE = 'replay';
  process.env.APP_ORIGIN = 'https://front.example';
  delete process.env.MARKET_BACKEND_URL;
  const request = new Request('https://front.example/api/workspace/replay');
  assert.equal((await proxyBackend(request, ['workspace', 'replay'])).status, 503);
  process.env.MARKET_BACKEND_URL = 'https://internal.example';
  const fetcher = async url => {
    assert.equal(url.href, 'https://internal.example/api/workspace/replay');
    return Response.json({mode: 'replay'});
  };
  assert.equal((await proxyBackend(request, ['workspace', 'markets'], {fetcher})).status, 404);
  assert.equal((await proxyBackend(request, ['workspace', 'replay'], {fetcher})).status, 200);
  assert.throws(() => azureMode('typo'));
  assert.throws(() => azureOrigin('https://front.example/path'));
});
