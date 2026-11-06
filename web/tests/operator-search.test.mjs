import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createOperatorSearch, OPERATOR_SEARCH_API_VERSION, OPERATOR_SEARCH_SCOPE} from '../lib/runtime/operator-search.mjs';

const endpoint = 'https://predictir-test.search.windows.net';
const index = 'predictir-operator-v1';
const receipt = {
  id: 'a'.repeat(64), captured_at: '2026-11-06T12:00:00.000Z',
  title: 'private operator title', profile: 'operator-specific-credential',
  logs: 'PRIVATE LOG', status: 'pass',
  checks: [
    {connector: 'azure', check: 'requests_429_peak', dimension: 'sensitive-host', status: 'pass', value: 5, unit: 'count'},
    {connector: 'mcp', check: 'source_status', status: 'fail', message: 'provider-credential'},
    {connector: 'runtime', check: 'unknown-sensitive-label', status: 'unavailable'},
  ],
};
const known = {
  id: receipt.id, captured_at: receipt.captured_at, status: 'fail', connectors: ['azure', 'mcp', 'runtime'],
  check_count: 3, passed_count: 1, failed_count: 1, unavailable_count: 1,
};

function harness(respond) {
  const calls = [], credentials = [];
  const adapter = createOperatorSearch({endpoint, getToken: async options => {
    credentials.push(options);
    return 'fixture-entra-token-for-operator-tests';
  }, fetcher: async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({url, options, body});
    assert.equal(url.origin, endpoint);
    assert.equal(url.searchParams.get('api-version'), '2026-04-01');
    assert.equal(options.headers.Authorization, 'Bearer fixture-entra-token-for-operator-tests');
    assert.equal(options.headers['api-key'], undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    return respond(calls.at(-1));
  }});
  return {adapter, calls, credentials};
}

test('creates the dedicated stable index with a precondition and verifies existing schema without writes', async () => {
  let schema;
  const {adapter, calls, credentials} = harness(({url, options, body}) => {
    assert.equal(url.pathname, "/indexes('predictir-operator-v1')");
    if (options.method === 'GET') return schema ? Response.json(schema) : new Response('', {status: 404});
    assert.equal(options.method, 'PUT');
    assert.equal(options.headers['If-None-Match'], '*');
    assert.equal(options.headers.Prefer, 'return=representation');
    assert.equal(body.name, index);
    assert.equal(body.fields.find(item => item.name === 'id').key, true);
    assert.equal(body.fields.find(item => item.name === 'terms').searchable, true);
    assert.equal(body.fields.find(item => item.name === 'terms').retrievable, false);
    assert.ok(!body.fields.some(item => ['title', 'profile', 'logs', 'checks', 'dimension'].includes(item.name)));
    schema = body;
    return Response.json(body, {status: 201});
  });
  assert.equal(OPERATOR_SEARCH_API_VERSION, '2026-04-01');
  assert.deepEqual(await adapter.ensureIndex(), {index, created: true});
  assert.deepEqual(await adapter.ensureIndex(), {index, created: false});
  assert.deepEqual(calls.map(row => row.options.method), ['GET', 'PUT', 'GET']);
  assert.ok(credentials.every(row => row.scope === OPERATOR_SEARCH_SCOPE && row.signal instanceof AbortSignal));
  schema.fields = schema.fields.filter(item => item.name !== 'terms');
  await assert.rejects(adapter.ensureIndex(), {code: 'OPERATOR_SEARCH_SCHEMA'});
  assert.equal(calls.filter(row => row.options.method === 'PUT').length, 1);
});

test('handles a concurrent index creation without overwriting the winning index', async () => {
  let competing;
  const {adapter, calls} = harness(({options, body}) => {
    if (options.method === 'GET') return competing ? Response.json(competing) : new Response('', {status: 404});
    competing = body;
    return new Response('', {status: 412});
  });
  assert.deepEqual(await adapter.ensureIndex(), {index, created: false});
  assert.deepEqual(calls.map(row => row.options.method), ['GET', 'PUT', 'GET']);
});

test('uploads a projected immutable record, batching retries by digest and rejecting partial responses', async () => {
  let reject = false;
  const {adapter, calls} = harness(({url, options, body}) => {
    assert.equal(url.pathname, "/indexes('predictir-operator-v1')/docs/search.index");
    assert.equal(options.method, 'POST');
    assert.ok(body.value.length <= 50);
    const first = body.value[0];
    assert.equal(first['@search.action'], 'mergeOrUpload');
    const {terms, ...metadata} = first;
    assert.match(terms, /throttle/);
    assert.doesNotMatch(JSON.stringify(body), /private operator title|operator-specific|PRIVATE LOG|sensitive-host|provider-credential|unknown-sensitive-label/);
    if (first.id === receipt.id) {
      delete metadata['@search.action'];
      assert.deepEqual(metadata, known);
    }
    return Response.json({value: body.value.map(item => ({key: item.id, status: !reject, statusCode: reject ? 400 : 200,
      errorMessage: reject ? 'PRIVATE ERROR' : null}))}, {status: reject ? 207 : 200});
  });
  assert.equal(await adapter.upsert([receipt, receipt]), 1);
  const many = Array.from({length: 101}, (_, i) => ({...receipt, id: createHash('sha256').update(String(i)).digest('hex')}));
  assert.equal(await adapter.upsert(many), 101);
  assert.deepEqual(calls.map(row => row.body.value.length), [1, 50, 50, 1]);
  reject = true;
  await assert.rejects(adapter.upsert(receipt), error => error.code === 'OPERATOR_SEARCH_WRITE' &&
    !error.message.includes('PRIVATE ERROR'));
});

test('queries only known operational terms and returns redacted metadata for local hydration', async () => {
  const {adapter, calls, credentials} = harness(({url, options, body}) => {
    assert.equal(url.pathname, "/indexes('predictir-operator-v1')/docs/search.post.search");
    assert.equal(options.method, 'POST');
    assert.deepEqual(body, {search: 'azure requests 429', queryType: 'simple', searchMode: 'all',
      searchFields: 'terms', select: 'id,captured_at,status,connectors,check_count,passed_count,failed_count,unavailable_count',
      orderby: 'captured_at desc,id asc', top: 8});
    return Response.json({value: [{...known, captured_at: '2026-11-06T12:00:00Z', '@search.score': 2,
      title: 'remote title is never trusted'}]});
  });
  for (const query of ['private operator title', 'azure OR runtime', 'api*', 'sensitive-host', 'azure foo+bar', 'abc'.repeat(36)]) {
    assert.equal(await adapter.search({query}), null);
  }
  assert.equal(calls.length, 0);
  assert.equal(credentials.length, 0);
  assert.deepEqual(await adapter.search({query: 'Azure requests_429', limit: 8}), [known]);
  assert.equal(calls.length, 1);
});

test('rejects untrusted hosts, malformed metadata, and redacts Azure errors', async () => {
  const getToken = async () => 'fixture-entra-token-for-operator-tests';
  for (const host of ['http://predictir-test.search.windows.net', endpoint + '/wrong', endpoint + '@example.com',
    endpoint + '.example.com', endpoint + ':443', endpoint + '?secret=hidden', 'https://search.azure.com']) {
    assert.throws(() => createOperatorSearch({endpoint: host, getToken}), TypeError);
  }
  assert.throws(() => createOperatorSearch({endpoint, index: 'another-app', getToken}), TypeError);
  const malformed = harness(() => Response.json({value: [{...known, id: [known.id]}]})).adapter;
  await assert.rejects(malformed.search(), {code: 'OPERATOR_SEARCH_RESPONSE'});
  await assert.rejects(malformed.search({limit: 51}), TypeError);
  const partial = harness(() => Response.json({'@search.coverage': 90, value: [known]})).adapter;
  await assert.rejects(partial.search(), {code: 'OPERATOR_SEARCH_RESPONSE'});
  const forbidden = harness(() => Response.json({error: {message: 'PRIVATE KEY'}}, {status: 403})).adapter;
  await assert.rejects(forbidden.search(), error => error.code === 'OPERATOR_SEARCH_HTTP' &&
    error.status === 403 && !error.message.includes('PRIVATE KEY'));
});
