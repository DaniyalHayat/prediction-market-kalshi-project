import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createOperatorEvidenceStore} from '../lib/runtime/operator-evidence.mjs';
import {createOperatorReview, parseReviewProfile, azureReadings} from '../lib/runtime/operator-review.mjs';
import {createOperatorServer} from '../lib/runtime/operator.mjs';

const target = 'https://predictir-front.example.centralus.azurecontainerapps.io';
const stamp = Date.parse('2026-11-06T11:15:00Z');
const azure = {azure: {schema_version: 1, collected_at: new Date(stamp).toISOString(), apps: [
  {role: 'front', latest_revision: 'rev', ready_revision: 'rev', running_status: 'Running', external_ingress: true,
    requests: 0, errors_5xx: 0, requests_429: 0, cpu_nanocores_avg: 10, memory_bytes_avg: 100, replicas_avg: 1},
  {role: 'backend', latest_revision: 'rev-new', ready_revision: 'rev-old', running_status: 'Running',
    external_ingress: false, requests: 500, errors_5xx: null, requests_429: 7, cpu_nanocores_avg: 20},
]}};
const profile = {name: 'Release review', checks: ['runtime', 'azure', 'http', 'mcp']};

test('profiles validate nested check choices and Azure gaps remain distinct from observed zeros', () => {
  assert.deepEqual(parseReviewProfile(profile), profile);
  for (const input of [{...profile, url: 'https://untrusted.invalid'}, {...profile, name: '../path'},
    {...profile, checks: ['runtime', 'runtime']}, {...profile, checks: ['secrets']}, {...profile, checks: []}]) {
    assert.throws(() => parseReviewProfile(input), RangeError);
  }
  assert.throws(() => createOperatorReview({origin: 'https://169.254.169.254'}), /public Predictir/);
  const result = azureReadings(azure, stamp);
  assert.equal(result.find(row => row.check === 'requests' && row.dimension === 'front').value, 0);
  assert.equal(result.find(row => row.check === 'requests_5xx' && row.dimension === 'backend').status, 'unavailable');
  assert.equal(result.find(row => row.check === 'revision_ready' && row.dimension === 'backend').status, 'fail');
  assert.equal(azureReadings(azure, stamp + 31 * 60_000)[0].status, 'unavailable');
});

test('operator flow runs scoped live-style API and MCP checks and saves searchable projected evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-review-'));
  const readSnapshot = async () => ({telemetry: {distributions: {'provider:kalshi': {p95_ms: 7, p99_ms: 11, window_count: 100}}},
    logs: [{event: 'request.finished', status: 429, body: 'UNSAFE_RAW_PAYLOAD'}]});
  const calls = [];
  let clock = stamp;
  const runReview = createOperatorReview({origin: target, readSnapshot, readAzure: async () => azure, now: () => clock,
    fetcher: async (url, options) => {
      calls.push([url.pathname, options.method]);
      assert.equal(url.origin, target);
      assert.equal(options.redirect, 'error');
      if (url.pathname === '/api/health') return Response.json({status: 'ok', runtime: 'Azure Container Apps'});
      if (url.pathname === '/api/workspace/catalog') return Response.json({categories: Array(8).fill({})});
      if (url.pathname === '/api/workspace/markets') return Response.json({category: 'sports',
        markets: [{ticker: 'SPORT-TEST', status: 'open', close_time: new Date(stamp + 180000).toISOString()}]});
      assert.equal(url.pathname, '/api/assistant');
      assert.equal(options.headers.Origin, target);
      assert.equal(JSON.parse(options.body).ticker, 'SPORT-TEST');
      return new Response('Warehouse coverage: 50 public rows. UNSAFE_RAW_PAYLOAD', {headers: {
        'Content-Type': 'text/plain', 'X-Research-Transport': 'MCP In-Process', 'X-Research-Model': 'azure-deterministic',
      }});
    },
  });
  const token = 'local-operator-test-'.repeat(3);
  const server = createOperatorServer({token, readSnapshot, runReview, evidence: createOperatorEvidenceStore(directory), now: () => clock,
    assets: {js: '/* bundle */', css: 'body{}'}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const auth = {Authorization: 'Bearer ' + token};
  const post = (value, headers = {}) => fetch(base + '/api/reviews', {method: 'POST',
    headers: {...auth, Origin: base, 'Content-Type': 'application/json', ...headers}, body: JSON.stringify(value)});
  assert.match(await (await fetch(base)).text(), /operator-root/);
  assert.equal((await fetch(base + '/operator.css')).status, 200);
  assert.equal((await fetch(base + '/api/reviews')).status, 401);
  assert.equal((await post(profile, {Origin: 'https://not-local.invalid'})).status, 403);
  assert.equal((await post({...profile, endpoint: 'https://attacker.invalid'})).status, 400);
  assert.equal((await post({name: 'x'.repeat(1100), checks: ['azure']})).status, 413);
  assert.equal(calls.length, 0);
  const response = await post(profile);
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.equal(receipt.profile, 'Release review');
  assert.equal(receipt.status, 'fail');
  assert.ok(receipt.checks.some(row => row.check === 'source_status' && row.status === 'pass'));
  assert.ok(receipt.checks.some(row => row.check === 'retained_throttles' && row.value === 1));
  assert.doesNotMatch(JSON.stringify(receipt), /UNSAFE_RAW_PAYLOAD/);
  assert.equal(calls.length, 4);
  const search = await (await fetch(base + '/api/reviews?q=release+mcp', {headers: auth})).json();
  assert.deepEqual(search.items.map(row => row.id), [receipt.id]);
  assert.equal(search.items[0].checks, undefined);
  assert.deepEqual(await (await fetch(base + '/api/reviews/' + receipt.id, {headers: auth})).json(), receipt);
  assert.equal((await post(profile)).status, 429);
  assert.equal(calls.length, 4);
  clock += 10001;
  assert.equal((await post({name: 'Azure again', checks: ['azure']})).status, 201);
  assert.equal(calls.length, 4);
});
