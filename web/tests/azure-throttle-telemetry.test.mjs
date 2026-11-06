import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import {createMarketServer} from '../cloud/server.mjs';
import {createRuntimeTelemetry} from '../lib/runtime/telemetry.mjs';

const origin = 'https://fixture.front.eastus2.azurecontainerapps.io';
const edgeSecret = 'fixture-edge-only-'.repeat(3);
const serviceSecret = 'fixture-service-only-'.repeat(3);
const fingerprint = 'f'.repeat(64);
const clientIP = '198.51.100.66';
const asOf = Date.parse('2026-11-06T11:00:14Z');
const headers = {'x-market-edge-secret': edgeSecret, 'x-market-country': 'US', 'x-market-client-ip': clientIP};
const internalHeaders = {Authorization: 'Bearer ' + serviceSecret, 'Content-Type': 'application/json'};
const evidence = '/api/workspace/evidence';
const catalog = '/api/workspace/catalog';
const reserve = '/internal/assistant/reserve-azure';
const diagnostic = '/internal/diagnostics';
const privateMarker = 'private-research-token';

async function listen(t, {store, env = {}, captureMonitor = false, now = () => asOf, production = true} = {}) {
  const selectedEnv = {PREDICTIR_MODE: 'live', APP_ORIGIN: origin, ...env};
  const previous = Object.fromEntries(Object.keys(selectedEnv).map(name => [name, process.env[name]]));
  Object.assign(process.env, selectedEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const telemetry = createRuntimeTelemetry({routes: [evidence, catalog, reserve, diagnostic, '/api/health', '/api/stream', '/api/book']});
  const logs = [];
  let runMonitor;
  const interval = globalThis.setInterval;
  const mockTimer = captureMonitor && t.mock.method(globalThis, 'setInterval', (fn, timeout) => {
    if (timeout === 30000) runMonitor = fn;
    return interval(fn, timeout);
  });
  const server = createMarketServer({production, edgeSecret, serviceSecret, telemetry, logger: (_, entry) => logs.push(entry),
    now, feed: {status: 'fixture'},
    storageEnabled: () => Boolean(store), storage: () => store,
    getRoute: async request => new URL(request.url).pathname === '/api/book' ?
      Response.json({error: privateMarker, error_code: 'throttle_heavy_burst'}, {status: 429}) : Response.json({ok: true}),
  });
  if (mockTimer) mockTimer.mock.restore();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function send(path, options) {
    const response = await fetch(base + path, options);
    const body = await response.text();
    return {response, body};
  }
  const get = (path, extra = {}) => send(path, {headers: {...headers, ...extra}});
  const post = (path, body, extra = {}) => send(path, {method: 'POST', headers: {...internalHeaders, ...extra}, body: JSON.stringify(body)});
  return {get, post, logs, telemetry, runMonitor};
}

test('Azure distinguishes explicit request gates and removes upstream content from causal telemetry', async t => {
  let workAllowed = true;
  const {get, post, logs, telemetry, runMonitor} = await listen(t, {
    store: {get: async () => ({disabled: true}), consume: async key => key.startsWith('work#') && workAllowed},
    captureMonitor: true,
  });
  for (let i = 0; i < 12; i++) assert.equal((await get(evidence)).response.status, 200);
  const burst = await get(evidence + '?ticker=' + privateMarker);
  assert.equal(burst.response.status, 429);
  assert.equal(burst.response.headers.get('retry-after'), '46');
  assert.deepEqual(JSON.parse(burst.body), {error: 'Research requests are arriving too quickly. Retry shortly.'});

  workAllowed = false;
  assert.equal((await get(catalog)).response.status, 429);
  workAllowed = true;
  assert.equal((await post(reserve, {kind: 'research', fingerprint})).response.status, 429);
  assert.equal((await get('/api/stream?ticker=TEST')).response.status, 429);
  assert.equal((await get('/api/book?ticker=' + privateMarker)).response.status, 429);
  for (let i = 0; i < 120; i++) {
    assert.equal((await get('/api/health', {'x-market-client-ip': '198.51.100.77'})).response.status, 200);
  }
  assert.equal((await get('/api/' + privateMarker, {'x-market-client-ip': '198.51.100.77'})).response.status, 429);
  await runMonitor();
  assert.equal((await get(catalog)).response.status, 429);
  const expected = {
    [evidence]: {throttle_heavy_burst: 1},
    [catalog]: {throttle_daily_work: 1, throttle_runtime_disabled: 1},
    [reserve]: {throttle_assistant_allowance: 1},
    '/api/stream': {throttle_stream_allowance: 1},
    '/api/book': {throttle_upstream_or_unclassified: 1},
    other: {throttle_general_admission: 1},
  };
  const diagnosis = JSON.parse((await post(diagnostic, {operation: 'runtime_snapshot'})).body);
  assert.deepEqual(diagnosis.telemetry.request_throttles, expected);
  assert.deepEqual(diagnosis.logs.filter(row => row.status === 429).map(row => row.error_code), [
    'throttle_heavy_burst', 'throttle_daily_work', 'throttle_assistant_allowance',
    'throttle_stream_allowance', 'throttle_upstream_or_unclassified', 'throttle_general_admission', 'throttle_runtime_disabled',
  ]);
  const serialized = JSON.stringify(logs) + JSON.stringify(diagnosis) + telemetry.prometheus();
  for (const value of [privateMarker, fingerprint, clientIP, edgeSecret, serviceSecret]) {
    assert.ok(!serialized.includes(value));
  }
  assert.match((await post(diagnostic, {operation: 'runtime_metrics'})).body,
    /marketlab_request_throttles_total\{route="\/api\/workspace\/evidence",reason="throttle_heavy_burst"\} 1/);
});

test('throttle counters are bounded independently of log retention and reject arbitrary labels', () => {
  const telemetry = createRuntimeTelemetry({routes: [evidence], sampleSize: 100});
  for (let i = 0; i < 1000; i++) telemetry.observeRequest({
    route: privateMarker + i, errorCode: privateMarker + i, durationMs: 1, status: 429,
  });
  telemetry.observeRequest({route: evidence, errorCode: 'throttle_heavy_burst', durationMs: 2, status: 200});
  assert.deepEqual(telemetry.snapshot().request_throttles, {other: {throttle_upstream_or_unclassified: 1000}});
  assert.doesNotMatch(telemetry.prometheus(), /private-research-token|reason="throttle_heavy_burst"/);
});

test('Foundry reservations use the real Azure quota keys and remain private', async t => {
  const recorded = new Map();
  const store = {
    kind: 'postgres',
    consume: async key => { recorded.set(key, (recorded.get(key) || 0) + 1); return true; },
    db: {query: async (_, [keys]) => ({rows: keys.filter(key => recorded.has(key)).map(key => ({key, used: recorded.get(key)}))})},
  };
  const {post, telemetry} = await listen(t, {store, env: {
    AZURE_FOUNDRY_ENABLED: '1', AZURE_FOUNDRY_DAILY_CALLS: '1', AZURE_FOUNDRY_MONTHLY_CALLS: '2',
  }});
  assert.deepEqual(JSON.parse((await post(reserve, {kind: 'foundry', fingerprint})).body), {allowed: true});
  assert.equal((await post(diagnostic, {operation: 'usage_allowances'}, {Authorization: 'Bearer other'})).response.status, 401);
  const usage = JSON.parse((await post(diagnostic, {operation: 'usage_allowances'})).body);
  assert.deepEqual(usage.allowances.filter(row => row.resource.startsWith('azure_foundry')), [
    {resource: 'azure_foundry_calls_day', limit: 1, used: 1, remaining: 0, warning: true},
    {resource: 'azure_foundry_calls_month', limit: 2, used: 1, remaining: 1, warning: false},
  ]);
  assert.doesNotMatch(JSON.stringify(usage), /azure-assistant#|usage_tokens/);
  process.env.AZURE_FOUNDRY_ENABLED = '0';
  const disabled = await post(reserve, {kind: 'foundry', fingerprint});
  assert.equal(disabled.response.status, 200);
  assert.deepEqual(JSON.parse(disabled.body), {allowed: false});
  assert.deepEqual(telemetry.snapshot().request_throttles, {});
});

test('Azure console allowance observations share the private projection and do not overlap', async t => {
  let stamp=asOf, queryCalls=0;
  const firstQuery=Promise.withResolvers(), started=Promise.withResolvers();
  const day=new Date(asOf).toISOString().slice(0,10);
  const store={
    kind:'postgres',
    get:async()=>({disabled:false}),
    consume:async()=>true,
    db:{query:async(sql,[keys])=>{
      assert.match(sql,/WHERE key=ANY\(\$1::text\[\]\) AND expires_at>now\(\)/);
      assert.ok(keys.includes('work#'+day));
      queryCalls++;
      if(queryCalls===1){started.resolve();return firstQuery.promise;}
      if(queryCalls===2)throw new Error(privateMarker);
      return {rows:[{key:'work#'+day,used:47},{key:privateMarker,used:100}]};
    }},
  };
  const {get,post,logs,runMonitor}=await listen(t,{store,captureMonitor:true,now:()=>stamp});
  const projections=()=>logs.filter(row=>row.event==='operator.allowances');
  const first=runMonitor();
  await started.promise;
  stamp+=5*60*1000;
  await runMonitor();
  assert.equal(queryCalls,1,'unfinished observation keeps later health ticks from querying');
  firstQuery.resolve({rows:[{key:'work#'+day,used:11}]});
  await first;
  assert.equal(projections().length,1);
  assert.equal(projections()[0].as_of,new Date(asOf).toISOString());
  await runMonitor();
  assert.equal(queryCalls,2);
  assert.equal(projections().length,1,'failed query emits no misleading projection');
  assert.equal(JSON.parse((await get('/api/health')).body).status,'ok');
  stamp+=30*1000;
  await runMonitor();
  assert.equal(queryCalls,2,'a failed observation does not poll on the next 30-second tick');
  stamp+=270*1000;
  await runMonitor();
  assert.equal(queryCalls,3);
  const last=projections().at(-1), {event,...observed}=last;
  assert.equal(event,'operator.allowances');
  const authorized=JSON.parse((await post(diagnostic,{operation:'usage_allowances'})).body);
  assert.deepEqual(observed,authorized);
  assert.ok(last.allowances.some(row=>row.resource==='daily_work'&&row.used===47));
  assert.doesNotMatch(JSON.stringify(logs), /private-research-token|work#|stream-minutes#/);
});

test('only Azure live production schedules console allowance observations', async t => {
  let reads=0;
  const store={kind:'postgres',get:async()=>({disabled:false}),consume:async()=>true,
    db:{query:async()=>{reads++;return {rows:[]};}}};
  const {runMonitor:localMonitor}=await listen(t,{store,captureMonitor:true,production:false});
  await localMonitor();
  const {runMonitor:replayMonitor}=await listen(t,{store,captureMonitor:true,env:{PREDICTIR_MODE:'replay'}});
  await replayMonitor();
  assert.equal(reads,0);
});
