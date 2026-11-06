import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {azureSearchToken, createOperatorArchiveSearch, createOperatorLogReader, parseOperatorAllowanceExport} from '../tools/operator-sources.mjs';

const stamp = Date.parse('2026-11-06T11:30:00Z');
const timestamp = new Date(stamp).toISOString();
const record = {event: 'request.finished', time: timestamp, status: 429, route: '/api/workspace/graphql',
  error_code: 'throttle_heavy_burst', trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), raw: 'PRIVATE_BODY'};
const usage = {event: 'operator.allowances', as_of: timestamp, allowances: [{resource: 'daily_work', used: 100, limit: 6000,
  secret: 'PRIVATE_BODY'}]};
const envelope = (row, prefix = '') => JSON.stringify({TimeStamp: timestamp, Log: prefix + JSON.stringify(row)});

test('Azure console and drain samples are sanitized, deduplicated and cached together', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-sources-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const drainPath = join(directory, 'filtered.ndjson');
  await writeFile(drainPath, 'x'.repeat(600000) + '\n' + JSON.stringify(record) + '\n');
  let calls = 0;
  const read = createOperatorLogReader({group: 'demo-rg', app: 'demo-backend', drainPath, now: () => stamp,
    cli: async args => {
      calls++;
      assert.deepEqual(args.slice(0, 7), ['containerapp', 'logs', 'show', '-g', 'demo-rg', '-n', 'demo-backend']);
      return {stdout: envelope(record, 'F ') + '\n' + envelope(usage, 'F ')};
    }});
  const [first, second] = await Promise.all([read(), read()]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(first.logs.length, 1);
  assert.equal(first.logs[0].error_code, 'throttle_heavy_burst');
  assert.deepEqual(first.allowances, {as_of: timestamp, allowances: [{resource: 'daily_work', used: 100, limit: 6000}]});
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_BODY/);
  assert.deepEqual(await read(), first);
  assert.equal(calls, 1);
  assert.equal(parseOperatorAllowanceExport(JSON.stringify({...usage, as_of: 'invalid'})), undefined);
  assert.equal(parseOperatorAllowanceExport(envelope(usage, 'P ')), undefined);
  assert.throws(() => createOperatorLogReader({group: 'test & whoami', app: 'demo-backend'}), TypeError);
});

test('Search token caching and archive fallback preserve the local canonical receipt', async () => {
  const scope = 'https://search.azure.com/.default';
  let credentialCalls = 0;
  const getToken = azureSearchToken({now: () => stamp, cli: async args => {
    credentialCalls++;
    assert.ok(args.includes(scope));
    return {stdout: JSON.stringify({accessToken: 'test-access-token', expires_on: (stamp + 300000) / 1000})};
  }});
  assert.equal(await getToken({scope}), 'test-access-token');
  assert.equal(await getToken({scope}), 'test-access-token');
  assert.equal(credentialCalls, 1);
  await assert.rejects(() => getToken({scope: 'untrusted'}));

  const local = {id: 'local', captured_at: timestamp};
  const cloud = {id: 'cloud', captured_at: timestamp};
  const evidence = {search: async () => [local], read: async id => id === 'cloud' ? {...cloud, checks: []} : null};
  const archive = createOperatorArchiveSearch({evidence, search: {search: async ({query}) => {
    if (query === 'private') return null;
    if (query === 'outage') throw new Error('cloud unavailable');
    return [cloud, local, {id: 'missing'}];
  }}});
  assert.deepEqual(await archive.find({query: 'health'}), {items: [cloud, local], source: 'azure-search'});
  assert.deepEqual(await archive.find({query: 'private'}), {items: [local], source: 'local'});
  assert.deepEqual(await archive.find({query: 'outage'}), {items: [local], source: 'local-fallback'});
});
