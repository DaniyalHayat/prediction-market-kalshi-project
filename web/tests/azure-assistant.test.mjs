import assert from 'node:assert/strict';
import test from 'node:test';
import {planAzureResearch, rankAzureEvidence} from '../lib/workspace/azure-assistant.mjs';

const enabled = {
  PREDICTIR_MODE: 'live',
  AZURE_FOUNDRY_ENABLED: '1',
  AZURE_FOUNDRY_ENDPOINT: 'https://predictir-fixture.openai.azure.com/openai/v1/',
  AZURE_FOUNDRY_DEPLOYMENT: 'research-ranker',
  IDENTITY_ENDPOINT: 'http://127.0.0.1:42356/msi/token',
  IDENTITY_HEADER: 'fixture-identity-header',
  AZURE_CLIENT_ID: '00000000-0000-4000-8000-000000000001',
};
const question = 'Which injuries matter for settlement? private-secret-sentinel';
const snippets = [
  'Visible depth at the last quote does not establish a forecast.',
  'Settlement depends on official results. No injuries are included in this fixture.',
  'The source for the rules is the exchange contract.',
];
const deterministic = {order: [1, 0, 2], mode: 'deterministic', attempted: false};
const token = {access_token: 'fixture.bearer.token', token_type: 'Bearer'};
const answer = (content, finish_reason = 'stop', more = {}) => Response.json({
  choices: [{finish_reason, message: {role: 'assistant', content, ...more}}],
});
const permit = async () => true;

test('intent routes to bounded read-only tools with research always included', () => {
  assert.deepEqual(planAzureResearch(question), ['search_retained_evidence', 'get_contract', 'get_research']);
  assert.deepEqual(planAzureResearch('How do the execution schedule and order flow differ?'), ['analyze_execution_lab', 'get_research']);
  assert.deepEqual(planAzureResearch('Why are the price history candles missing?'), ['get_price_history', 'get_research']);
  assert.deepEqual(planAzureResearch('What is the provider and warehouse coverage?'), ['get_source_status', 'get_research']);
  assert.deepEqual(planAzureResearch('Tell me more'), ['get_research']);
  assert.equal(planAzureResearch('depth, news, price history, contract rules, and warehouse coverage').length, 3);
});

test('disabled live and replay stay deterministic without authorization or network', async () => {
  let reservations = 0;
  let requests = 0;
  const unauthorized = () => { reservations++; return true; };
  const fetcher = () => { requests++; throw new Error('No provider call expected'); };
  for (const env of [{}, {...enabled, AZURE_FOUNDRY_ENABLED: '0'}, {...enabled, PREDICTIR_MODE: 'replay'}]) {
    assert.deepEqual(await rankAzureEvidence({question, snippets, authorize: unauthorized}, {env, fetcher}), deterministic);
  }
  assert.deepEqual(await rankAzureEvidence({question, snippets}, {env: enabled, fetcher}), deterministic);
  assert.deepEqual(await rankAzureEvidence({question, snippets, authorize: async () => false}, {env: enabled, fetcher}), deterministic);
  assert.deepEqual(await rankAzureEvidence({question, snippets, authorize: async () => ({ok: true})}, {env: enabled, fetcher}), deterministic);
  assert.equal(reservations, 0);
  assert.equal(requests, 0);
});

test('authorized Azure request uses scoped Entra identity and returns only an exact evidence order', async () => {
  const calls = [];
  const fetcher = async (url, request) => {
    calls.push({url, request});
    assert.equal(request.redirect, 'error');
    assert.equal(request.signal.aborted, false);
    if (calls.length === 1) {
      assert.equal(url.origin, 'http://127.0.0.1:42356');
      assert.equal(url.pathname, '/msi/token');
      assert.equal(url.searchParams.get('resource'), 'https://cognitiveservices.azure.com');
      assert.equal(url.searchParams.get('api-version'), '2019-08-01');
      assert.equal(url.searchParams.get('client_id'), enabled.AZURE_CLIENT_ID);
      assert.equal(request.headers['X-IDENTITY-HEADER'], enabled.IDENTITY_HEADER);
      return Response.json(token);
    }
    assert.equal(url.href, 'https://predictir-fixture.openai.azure.com/openai/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, 'Bearer ' + token.access_token);
    assert.equal(request.headers['X-IDENTITY-HEADER'], undefined);
    assert.equal(request.headers['api-key'], undefined);
    assert.equal(request.body.includes('private-secret-sentinel'), false);
    assert.equal(request.body.includes(enabled.IDENTITY_HEADER), false);
    assert.equal(request.body.includes(token.access_token), false);
    const payload = JSON.parse(request.body);
    assert.equal(payload.model, enabled.AZURE_FOUNDRY_DEPLOYMENT);
    assert.equal(payload.max_completion_tokens, 128);
    assert.equal(payload.stream, false);
    assert.equal(payload.tools, undefined);
    assert.equal(payload.response_format.json_schema.strict, true);
    assert.deepEqual(JSON.parse(payload.messages[1].content).matching_terms, ['settlement', 'injuries']);
    return answer('{"order":["E3","E2","E1"]}');
  };
  const authorize = async ({inputBytes, maxCompletionTokens, signal}) => {
    assert.equal(calls.length, 0);
    assert.ok(inputBytes > 0 && inputBytes <= 10_000);
    assert.equal(maxCompletionTokens, 128);
    assert.equal(signal.aborted, false);
    return true;
  };
  assert.deepEqual(await rankAzureEvidence({question, snippets, authorize}, {env: enabled, fetcher}),
    {order: [2, 1, 0], mode: 'azure-foundry', attempted: true});
  assert.equal(calls.length, 2);
});

test('model prose, extra properties, invalid IDs, and incomplete output never replace evidence', async () => {
  const badAnswers = [
    () => answer('Buy YES. The risk is zero.'),
    () => answer('{"order":["E2","E3","E1"],"reason":"https://fake.example"}'),
    () => answer('{"order":["E2","E2","E1"]}'),
    () => answer('{"order":["E2","E3","E4"]}'),
    () => answer('{"order":["E1","E2"]}'),
    () => answer('{"order":["E3","E2","E1"]}', 'length'),
    () => answer('{"order":["E3","E2","E1"]}', 'stop', {refusal: 'policy'}),
    () => answer('{"order":["E3","E2","E1"]}', 'stop', {tool_calls: [{id: 'fake'}]}),
    () => Response.json({error: 'rate limited'}, {status: 429}),
    () => new Response('<!doctype html>', {headers: {'Content-Type': 'text/html'}}),
    () => Response.json({filler: 'x'.repeat(17_000)}),
  ];
  for (const badAnswer of badAnswers) {
    let calls = 0;
    const fetcher = async () => ++calls === 1 ? Response.json(token) : badAnswer();
    assert.deepEqual(await rankAzureEvidence({question, snippets, authorize: permit}, {env: enabled, fetcher}),
      {...deterministic, attempted: true});
    assert.equal(calls, 2);
  }
});

test('malformed endpoint or large input fails before budget reservation and credentials', async () => {
  let reservations = 0;
  let requests = 0;
  const authorize = () => { reservations++; return true; };
  const fetcher = () => { requests++; throw new Error('No provider call expected'); };
  for (const overrides of [
    {AZURE_FOUNDRY_ENDPOINT: 'https://predictir-fixture.openai.azure.com.attacker.test'},
    {AZURE_FOUNDRY_ENDPOINT: 'https://predictir-fixture.openai.azure.com@attacker.test'},
    {AZURE_FOUNDRY_ENDPOINT: 'http://predictir-fixture.openai.azure.com'},
    {IDENTITY_ENDPOINT: 'http://127.0.0.1.attacker.test/msi/token'},
    {IDENTITY_ENDPOINT: 'http://127.0.0.1:42356/msi/token?redirect=https://attacker.test'},
    {AZURE_CLIENT_ID: 'malformed-client-id'},
  ]) {
    assert.deepEqual(await rankAzureEvidence({question, snippets, authorize}, {env: {...enabled, ...overrides}, fetcher}), deterministic);
  }
  const long = Array.from({length: 12}, () => 'x'.repeat(900));
  assert.deepEqual(await rankAzureEvidence({question, snippets: long, authorize}, {env: enabled, fetcher}),
    {order: long.map((_, i) => i), mode: 'deterministic', attempted: false});
  assert.equal(reservations, 0);
  assert.equal(requests, 0);
});

test('identity failure or cancellation cannot initiate a model call', async () => {
  for (const identity of [
    () => Response.json({error: 'unavailable'}, {status: 403}),
    () => Response.json({access_token: ['wrong.type'], token_type: 'Bearer'}),
    () => Response.json({access_token: 'invalid\r\nheader', token_type: 'Bearer'}),
  ]) {
    let calls = 0;
    const fetcher = async () => {
      assert.equal(++calls, 1);
      return identity();
    };
    assert.deepEqual(await rankAzureEvidence({question, snippets, authorize: permit}, {env: enabled, fetcher}), deterministic);
    assert.equal(calls, 1);
  }
  const controller = new AbortController();
  const authorize = async () => {
    controller.abort();
    return true;
  };
  let calls = 0;
  const fetcher = () => { calls++; throw new Error('No provider call expected'); };
  assert.deepEqual(await rankAzureEvidence({question, snippets, authorize, signal: controller.signal}, {env: enabled, fetcher}), deterministic);
  assert.equal(calls, 0);
});
