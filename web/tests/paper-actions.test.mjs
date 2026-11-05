import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createMarketServer} from '../cloud/server.mjs';
import {makePostgresStore} from '../lib/postgres-store.mjs';
import {guestSession, sealSession} from '../lib/workspace/account.mjs';
import {createPaperScenarioActions, paperActionError, paperRequestInput} from '../lib/workspace/paper-actions.mjs';
import {POST} from '../app/api/workspace/paper-scenarios/route.js';

const ticker = 'TEST-PAPER-YES', other = 'TEST-OTHER-YES', origin = 'https://azure-paper.example';
const edge = 'fixture-edge-'.repeat(5), service = 'fixture-service-'.repeat(5), secret = 'fixture-account-'.repeat(5);
const cookie = (now = Date.now()) => '__Host-market_guest=' + sealSession(guestSession(null, now), secret, 'guest');
const preview = {scenario: {
  controls: {hmm: true, kalman: true, brownian_mc: true, optional_stopping: true},
  context_scores: [.1, -.2, .5, .7],
  score: {margin: 3, remaining_seconds: 500, drift_points_per_minute: .1, volatility_points_per_sqrt_minute: 2, simulations: 1000},
  stopping: {initial_probability: .55, quantity: 10, assumptionsAcknowledged: true},
}};
const fixtureStorage = {get: async () => null, consume: async () => true, transaction: async () => {
  throw new Error('Preview must not persist a scenario');
}};

function env(t) {
  const values = {PREDICTIR_MODE: 'live', APP_ORIGIN: origin, ACCOUNT_COOKIE_SECRET: secret};
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('paper actions require current authentic guest cookies and bound hypothetical controls', async () => {
  const now = Date.now();
  const options = {storage: fixtureStorage, secret, ticker, now: () => now};
  for (const forged of ['', 'market_guest=forged', cookie(now - 6 * 3600_000), cookie(now) + '; ' + cookie(now)]) {
    assert.throws(() => createPaperScenarioActions({...options, cookie: forged}), /current guest workspace/);
  }
  const actions = createPaperScenarioActions({...options, cookie: cookie(now)});
  const draft = await actions.preview(preview);
  assert.equal(draft.scenario.result.paper_only, true);
  assert.equal(draft.scenario.result.affects_forecast, false);
  assert.equal(draft.scenario.result.score.source, 'supplied_scenario');
  assert.equal(draft.scenario.result.score.monte_carlo.parameters.simulations, 1000);
  assert.equal(draft.scenario.result.context.kalman.available, true);
  assert.equal(draft.scenario.result.stopping.available, true);
  assert.equal(draft.scenario.confirmation_expires_at, now + 600_000);
  assert.ok(!JSON.stringify(draft).includes('mcp-paper#'));
  assert.deepEqual(await actions.list(), {status: 'available', scenarios: []});
  await assert.rejects(actions.preview({scenario: {...preview.scenario, account_balance: 100}}), /valid bounded/);
  await assert.rejects(actions.save({draft_token: draft.draft_token, confirmed: false}), /Confirm/);
  await assert.rejects(actions.save({draft_token: draft.draft_token + 'A', confirmed: true}), /unavailable/);
  await assert.rejects(createPaperScenarioActions({...options, cookie: cookie(now)}).save({draft_token: draft.draft_token, confirmed: true}), /unavailable/);
  assert.equal(paperRequestInput.safeParse({operation: 'save', ticker, draft_token: draft.draft_token}).success, false);
  assert.equal(paperActionError(new Error('secret-database-sentinel')).status, 503);
  assert.doesNotMatch(paperActionError(new Error('secret-database-sentinel')).error, /sentinel/);
});

test('normal MCP stays read-only and Azure action transport requires origin, two service proofs, and guest session', async t => {
  env(t);
  const server = createMarketServer({production: true, edgeSecret: edge, serviceSecret: service, logger: () => {},
    storageEnabled: () => true, storage: () => fixtureStorage});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port + '/mcp';
  const headers = {Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
    Authorization: 'Bearer ' + service, Origin: origin, 'X-Market-Ticker': ticker, 'X-Market-Country': 'US',
    'X-Market-Edge-Secret': edge, Cookie: cookie()};
  const actionHeaders = {...headers, 'X-Market-Paper-Action': '1'};
  const call = (headers, method, params) => fetch(url, {method: 'POST', headers, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
  const names = async headers => (await (await call(headers, 'tools/list', {})).json()).result.tools;
  const regular = await names(headers);
  assert.equal(regular.length, 6);
  assert.ok(regular.every(tool => tool.annotations.readOnlyHint === true));
  const actionTools = await names(actionHeaders);
  assert.equal(actionTools.length, 10);
  assert.equal(actionTools.find(tool => tool.name === 'save_paper_scenario').annotations.readOnlyHint, false);
  assert.equal(actionTools.find(tool => tool.name === 'discard_paper_scenario').annotations.destructiveHint, true);
  const params = {name: 'preview_paper_scenario', arguments: {ticker, ...preview}};
  assert.equal((await call({...actionHeaders, Authorization: ''}, 'tools/call', params)).status, 401);
  assert.equal((await call({...actionHeaders, Cookie: ''}, 'tools/call', params)).status, 401);
  assert.equal((await call({...actionHeaders, Origin: ''}, 'tools/call', params)).status, 403);
  assert.equal((await call({...actionHeaders, 'X-Market-Edge-Secret': ''}, 'tools/call', params)).status, 403);
  assert.equal((await call({...actionHeaders, 'X-Market-Country': 'RU'}, 'tools/call', params)).status, 403);
  const scoped = await (await call(actionHeaders, 'tools/call', {...params, arguments: {...params.arguments, ticker: other}})).json();
  assert.equal(scoped.result.isError, true);
  const packet = await (await call(actionHeaders, 'tools/call', params)).json();
  assert.equal(JSON.parse(packet.result.content[0].text).status, 'draft');
});

test('public scenario endpoint rejects cross-origin, missing cookie, and implicit confirmation before calling a backend', async t => {
  env(t);
  const request = (headers, data) => new Request(origin + '/api/workspace/paper-scenarios', {
    method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body: JSON.stringify(data),
  });
  assert.equal((await POST(request({Origin: 'https://wrong.example'}, {operation: 'list', ticker}))).status, 403);
  assert.equal((await POST(request({Origin: origin}, {operation: 'list', ticker}))).status, 401);
  assert.equal((await POST(request({Origin: origin, Cookie: cookie()}, {operation: 'save', ticker, draft_token: 'fake'}))).status, 400);
});

const database = process.env.PAPER_ACTION_TEST_DATABASE_URL;
test('Postgres save is idempotent under concurrency and discard fences a prior confirmation', {skip: !database}, async t => {
  const target = new URL(database);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.endsWith('_test'), 'Use a disposable loopback fixture');
  const storage = makePostgresStore({connectionString: database});
  t.after(() => storage.close());
  const sessionCookie = cookie();
  const options = {storage, secret, ticker, cookie: sessionCookie};
  const actions = createPaperScenarioActions(options);
  const draft = await actions.preview(preview);
  const args = {draft_token: draft.draft_token, confirmed: true};
  const wrongTicker = createPaperScenarioActions({...options, ticker: other});
  const wrongSession = createPaperScenarioActions({...options, cookie: cookie()});
  await assert.rejects(wrongTicker.save(args), /unavailable/);
  await assert.rejects(wrongSession.save(args), /unavailable/);
  const results = await Promise.all(Array.from({length: 6}, () => actions.save(args)));
  for (const result of results) assert.deepEqual(result, results[0]);
  const [{id}] = (await actions.list()).scenarios;
  assert.equal(id, draft.scenario.id);
  assert.deepEqual((await wrongTicker.list()).scenarios, []);
  assert.deepEqual((await wrongSession.list()).scenarios, []);
  await wrongTicker.discard({scenario_id: id, confirmed: true});
  await wrongSession.discard({scenario_id: id, confirmed: true});
  assert.equal((await actions.list()).scenarios.length, 1);
  assert.deepEqual((await actions.list()).scenarios[0].inputs, draft.scenario.inputs);
  const discard = {scenario_id: id, confirmed: true};
  const discarded = await Promise.all([actions.discard(discard), actions.discard(discard)]);
  assert.deepEqual(discarded[0], discarded[1]);
  assert.deepEqual((await actions.list()).scenarios, []);
  await assert.rejects(actions.save(args), /Preview the scenario again/);
  const expired = createPaperScenarioActions({...options, now: () => Date.now() + 601_000});
  await assert.rejects(expired.save(args), /Preview the scenario again/);
});
