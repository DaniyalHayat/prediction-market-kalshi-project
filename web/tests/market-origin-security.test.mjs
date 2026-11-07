import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateKeyPairSync} from 'node:crypto';
import {BASE, marketDataURL, request} from '../lib/live.mjs';

test('public market paths and query parameters cannot change the configured origin or path prefix', () => {
  const url = new URL(marketDataURL('/series/KXCPI/markets/KXCPI-26NOV-T0.2/candlesticks', {cursor: 'https://other.test/?a=b#x', limit: 10}));
  assert.equal(url.origin, new URL(BASE).origin);
  assert.equal(url.pathname, '/trade-api/v2/series/KXCPI/markets/KXCPI-26NOV-T0.2/candlesticks');
  assert.equal(url.searchParams.get('cursor'), 'https://other.test/?a=b#x');
  for (const path of ['/markets/../events', '/markets/.', '/markets/%2f%2fother.test', '/markets/A?url=https://other.test', '/markets/A#x', '//other.test/markets', '/markets/A\\B', '/markets/A\n', '/markets/A/']) {
    assert.throws(() => marketDataURL(path), RangeError, path);
  }
  for (const base of ['https://user:secret@data.example/api', 'https://data.example/api?url=x', 'https://data.example/#x', 'http://169.254.169.254', 'file:///tmp']) {
    assert.throws(() => marketDataURL('/markets', {}, base), RangeError);
  }
  assert.equal(new URL(marketDataURL('/markets/A', {}, 'https://data.example/public/v2')).pathname, '/public/v2/markets/A');
});

test('signed public market reads reject redirects without contacting the redirect destination', async t => {
  let redirectedReads = 0, sourceReads = 0;
  const destination = createServer((_request, response) => { redirectedReads++; response.end('{}'); });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  t.after(() => new Promise(resolve => destination.close(resolve)));
  const source = createServer((incoming, response) => {
    sourceReads++;
    assert.equal(incoming.headers['kalshi-access-key'], 'fixture-key-only');
    response.writeHead(307, {Location: `http://127.0.0.1:${destination.address().port}/private`}); response.end();
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  t.after(() => new Promise(resolve => source.close(resolve)));
  const previous = {KALSHI_API_KEY_ID: process.env.KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY: process.env.KALSHI_PRIVATE_KEY};
  process.env.KALSHI_API_KEY_ID = 'fixture-key-only';
  process.env.KALSHI_PRIVATE_KEY = generateKeyPairSync('ed25519').privateKey.export({type: 'pkcs8', format: 'pem'});
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await assert.rejects(request('/markets/REDIRECT-FIXTURE', {}, (url, options) => {
    assert.equal(new URL(url).origin, new URL(BASE).origin);
    assert.equal(options.redirect, 'error');
    return fetch(`http://127.0.0.1:${source.address().port}${new URL(url).pathname}`, options);
  }), /fetch failed/);
  assert.equal(sourceReads, 1);
  assert.equal(redirectedReads, 0);
});

test('rejected paths never reserve a provider read or invoke the transport', async () => {
  for (const path of ['/markets/A%2fB', '/events/A?redirect=https://other.test', '/series/A/../B']) {
    await assert.rejects(request(path, {}, () => assert.fail('Invalid path reached provider')), RangeError);
  }
  const result = await request('/markets/VALID-FIXTURE', {ticker: 'https://other.test'}, async (url, options) => {
    assert.equal(new URL(url).origin, new URL(BASE).origin);
    assert.equal(new URL(url).searchParams.get('ticker'), 'https://other.test');
    assert.equal(options.redirect, 'error');
    return Response.json({market: {ticker: 'VALID-FIXTURE'}});
  });
  assert.equal(result.data.market.ticker, 'VALID-FIXTURE');
});

