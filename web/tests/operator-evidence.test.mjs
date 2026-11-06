import assert from 'node:assert/strict';
import {link, mkdtempDisposable, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createOperatorEvidenceStore} from '../lib/runtime/operator-evidence.mjs';

const when = '2026-11-06T11:00:00.000Z';
const inspect = {
  profile: 'azure-release',
  captured_at: when,
  checks: [
    {connector: 'mcp', check: 'tool_discovery', status: 'pass', latency_ms: 19, sample_count: 4},
    {connector: 'azure', check: 'server_errors', status: 'unavailable', dimension: 'front', value: 0, unit: 'count'},
    {connector: 'api', check: 'http_health', status: 'fail', status_code: 503, latency_ms: 39},
  ],
};

async function archive(t, options) {
  const directory = await mkdtempDisposable(join(tmpdir(), 'predictir-evidence-'));
  t.after(() => directory.remove());
  return {path: directory.path, store: createOperatorEvidenceStore(directory.path, options)};
}

test('maintenance evidence is canonical, immutable, and excludes supplied free text', async t => {
  const {store, path} = await archive(t);
  const other = createOperatorEvidenceStore(path);
  const input = {...inspect, password: 'DO-NOT-STORE', checks: inspect.checks.map(row => ({
    ...row, response_body: 'PRIVATE RESPONSE', account: 'secret@example.invalid',
  }))};
  const [first, second] = await Promise.all([
    store.save(input), other.save({...inspect, checks: inspect.checks.toReversed()}),
  ]);
  assert.deepEqual(first, second);
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(first.title, 'azure release maintenance review');
  assert.equal(first.status, 'fail');
  assert.equal(first.check_count, 3);
  assert.equal(first.passed_count, 1);
  assert.equal(first.failed_count, 1);
  assert.equal(first.unavailable_count, 1);
  assert.deepEqual(first.connectors, ['api', 'azure', 'mcp']);
  assert.deepEqual(await readdir(path), [first.id + '.json']);
  assert.deepEqual(await other.read(first.id), first);
  const saved = await readFile(join(path, first.id + '.json'), 'utf8');
  assert.doesNotMatch(saved, /DO-NOT-STORE|PRIVATE RESPONSE|secret@example\.invalid/);
});

test('keyword search returns only metadata, newest first, and keeps per-dimension measurements', async t => {
  const {store} = await archive(t);
  const older = await store.save(inspect);
  const newer = await store.save({
    ...inspect, profile: 'Azure Morning Release 2', captured_at: '2026-11-06T12:00:00.000Z',
    checks: [
      {connector: 'runtime', check: 'route_p99', status: 'pass', dimension: '/api/workspace/catalog', value: 84, unit: 'ms'},
      {connector: 'runtime', check: 'route_p99', status: 'pass', dimension: 'provider:kalshi', value: 110, unit: 'ms'},
    ],
  });
  const [row] = await store.search({query: 'KALSHI pass', limit: 1});
  assert.equal(row.id, newer.id);
  assert.equal(row.title, 'Azure Morning Release 2 maintenance review');
  assert.equal(row.checks, undefined);
  assert.equal(row.check_count, 2);
  assert.deepEqual((await store.search()).map(item => item.id), [newer.id, older.id]);
  assert.deepEqual((await store.search({query: 'mcp fail'})).map(item => item.id), [older.id]);
  assert.deepEqual((await store.search({query: 'azure morning release'})).map(item => item.id), [newer.id]);
  assert.deepEqual(await store.search({query: 'mcp route_p99'}), []);
  assert.equal((await store.read(newer.id)).checks[0].value, 84);
  await assert.rejects(store.search({limit: 51}), TypeError);
});

test('receipt lookup excludes path traversal, foreign files, and tampered content', async t => {
  const {store, path} = await archive(t);
  const first = await store.save(inspect);
  const privateFile = join(path, 'local.config');
  await writeFile(privateFile, 'SENSITIVE FILE');
  const invalidId = 'a'.repeat(64);
  await link(privateFile, join(path, invalidId + '.json'));
  assert.equal(await store.read(invalidId), null);
  assert.equal(await store.read('../local.config'), null);
  const tampered = {...first, checks: [{...first.checks[0], status_code: 200}, ...first.checks.slice(1)]};
  await writeFile(join(path, first.id + '.json'), JSON.stringify(tampered));
  assert.equal(await store.read(first.id), null);
  assert.deepEqual(await store.search(), []);
  await assert.rejects(store.save(inspect), {code: 'EVIDENCE_INTEGRITY'});
});

test('archive cap rejects additional files and still accepts idempotent retries', async t => {
  const {store, path} = await archive(t, {maxReceipts: 1});
  const first = await store.save(inspect);
  const alternative = {...inspect, captured_at: '2026-11-06T12:00:00.000Z'};
  await assert.rejects(store.save(alternative), {code: 'EVIDENCE_CAPACITY'});
  assert.deepEqual(await store.save(inspect), first);
  await assert.rejects(store.save({...inspect, checks: [inspect.checks[0], inspect.checks[0]]}), /Duplicate maintenance check/);
  await assert.rejects(store.save({...inspect, captured_at: '2026-02-30T12:00:00.000Z'}), /Invalid maintenance timestamp/);
  assert.deepEqual(await readdir(path), [first.id + '.json']);
});
