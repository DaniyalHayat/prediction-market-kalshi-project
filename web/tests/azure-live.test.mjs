import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {getCACertificates} from 'node:tls';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {validateAzureLive, verifyAzureDatabase, verifyAzurePrivateDNS} from '../cloud/azure-live.mjs';
import {createMarketServer} from '../cloud/server.mjs';
import {handleMCP} from '../lib/workspace/mcp.mjs';
import {AZURE_STREAM_LIFETIME_MS, validateAzureFrontend} from '../lib/workspace/azure-mode.mjs';

const origin = 'https://fixture.front.eastus2.azurecontainerapps.io';
const privateOrigin = 'https://fixture-backend.internal.front.eastus2.azurecontainerapps.io';
const host = 'fixture.postgres.database.azure.com';
const edge = 'azure-edge-fixture-'.repeat(3), assistant = 'azure-research-fixture-'.repeat(3), account = 'azure-account-fixture-'.repeat(3);
const front = {PREDICTIR_MODE: 'live', APP_ORIGIN: origin, MARKET_BACKEND_URL: privateOrigin, MARKET_EDGE_SECRET: edge, ASSISTANT_SERVICE_SECRET: assistant};
const backend = {PREDICTIR_MODE: 'live', APP_ORIGIN: origin, MARKET_EDGE_SECRET: edge, ASSISTANT_SERVICE_SECRET: assistant,
  ACCOUNT_COOKIE_SECRET: account, PREDICTIR_DATABASE_HOST: host, DATABASE_URL: 'postgresql://market_lab_app:test-only@' + host + ':5432/predictir',
  DATABASE_CA_CERT: getCACertificates('bundled')[0]};

test('Azure front enforces the built edition, private ingress, and separate server-only credentials', () => {
  assert.deepEqual(validateAzureFrontend(front, 'live'), {mode: 'live', backendOrigin: privateOrigin});
  assert.throws(() => validateAzureFrontend(front, 'replay'), /match the image/);
  assert.throws(() => validateAzureFrontend({...front, MARKET_BACKEND_URL: 'https://public.example'}, 'live'), /private Azure backend/);
  assert.throws(() => validateAzureFrontend({...front, MARKET_BACKEND_URL: privateOrigin + '/mcp'}, 'live'), /private Azure backend/);
  assert.throws(() => validateAzureFrontend({...front, CONTAINER_APP_ENV_DNS_SUFFIX: 'another.eastus2.azurecontainerapps.io'}, 'live'), /this Azure Container Apps environment/);
  assert.throws(() => validateAzureFrontend({...front, DATABASE_URL: backend.DATABASE_URL}, 'live'), /cannot receive/);
  assert.throws(() => validateAzureFrontend({...front, ASSISTANT_SERVICE_SECRET: edge}, 'live'), /distinct/);
  const local = {...front, MARKET_BACKEND_URL: 'http://127.0.0.1:8780', PREDICTIR_AZURE_LOCAL: '1'};
  assert.equal(validateAzureFrontend(local, 'live').backendOrigin, local.MARKET_BACKEND_URL);
  assert.throws(() => validateAzureFrontend({...local, CONTAINER_APP_NAME: 'fixture-front'}, 'live'), /private Azure backend/);
  assert.equal(validateAzureFrontend({PREDICTIR_MODE: 'replay', MARKET_BACKEND_URL: local.MARKET_BACKEND_URL}, 'replay').mode, 'replay');
  assert.ok(AZURE_STREAM_LIFETIME_MS < 240000);
});

test('Azure live rejects admin, other databases, TLS overrides, weak keys and half-configured streaming', () => {
  assert.deepEqual(validateAzureLive(backend), {host, database: 'predictir', login: 'market_lab_app', pipelineEnabled: false});
  for (const url of [
    backend.DATABASE_URL.replace('market_lab_app', 'predictir_admin'),
    backend.DATABASE_URL.replace(host, 'other.postgres.database.azure.com'),
    backend.DATABASE_URL.replace('predictir', 'postgres'),
    backend.DATABASE_URL + '?sslmode=disable',
    backend.DATABASE_URL + '?sslrootcert=other.pem',
    backend.DATABASE_URL + '#note',
  ]) assert.throws(() => validateAzureLive({...backend, DATABASE_URL: url}), /expected private Azure host and app login/);
  assert.throws(() => validateAzureLive({...backend, DATABASE_CA_CERT: 'not a CA'}), /CA certificate/);
  assert.throws(() => validateAzureLive({...backend, ASSISTANT_SERVICE_SECRET: ''}), /distinct/);
  assert.throws(() => validateAzureLive({...backend, ACCOUNT_COOKIE_SECRET: assistant}), /distinct/);
  assert.throws(() => validateAzureLive({...backend, SUPABASE_URL: 'https://supabase.example'}), /own application origin and provider/);
  assert.throws(() => validateAzureLive({...backend, KALSHI_API_KEY_ID: 'only-id'}), /both optional/);
  assert.throws(() => validateAzureLive({...backend, KALSHI_API_KEY_ID: 'fixture-id', KALSHI_PRIVATE_KEY: 'invalid'}), /private key is invalid/);
});

test('private DNS and database preflight reject public answers, absent TLS and nonrestricted roles', async () => {
  await verifyAzurePrivateDNS(host, async () => [{address: '10.1.2.3', family: 4}, {address: '172.31.1.2', family: 4}]);
  await assert.rejects(verifyAzurePrivateDNS(host, async () => [{address: '10.1.2.3', family: 4}, {address: '8.8.8.8', family: 4}]), /only to private/);
  await assert.rejects(verifyAzurePrivateDNS(host, async () => []), /only to private/);
  const config = validateAzureLive({...backend, MARKET_PIPELINE_ENABLED: '1'});
  const good = {database: 'predictir', login: 'market_lab_app', tls: true, restricted: true, schema_access: true, tables_ready: true};
  let queries = 0;
  await verifyAzureDatabase({query: async (sql, [tables]) => {
    queries++;
    assert.match(sql, /pg_stat_ssl/);
    assert.match(sql, /row_security_active/);
    assert.match(sql, /FROM pg_policy/);
    const grants = Object.fromEntries(JSON.parse(tables).map(table => [table.name, table.privileges]));
    assert.deepEqual(grants.jobs, ['SELECT', 'INSERT', 'UPDATE']);
    assert.ok(grants.leases.includes('DELETE') && !grants.records.includes('DELETE'));
    return {rows: [good]};
  }}, config);
  assert.equal(queries, 1);
  for (const patch of [{tls: false}, {restricted: false}, {schema_access: false}, {tables_ready: false}, {login: 'predictir_admin'}]) {
    await assert.rejects(verifyAzureDatabase({query: async () => ({rows: [{...good, ...patch}]})}, config), /not ready/);
  }
});

test('Azure live app paths require edge authorization and MCP remains a separate scoped read-only service', {timeout: 12000}, async t => {
  const env = {PREDICTIR_MODE: process.env.PREDICTIR_MODE, APP_ORIGIN: process.env.APP_ORIGIN, ACCOUNT_COOKIE_SECRET: process.env.ACCOUNT_COOKIE_SECRET,
    MARKET_BACKEND_URL: process.env.MARKET_BACKEND_URL};
  Object.assign(process.env, {PREDICTIR_MODE: 'live', APP_ORIGIN: origin, ACCOUNT_COOKIE_SECRET: account});
  delete process.env.MARKET_BACKEND_URL;
  t.after(() => { for (const [name, value] of Object.entries(env)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const ticker = 'KX-AZURE-FIXTURE', counters = {tools: 0, removals: 0};
  const server = createMarketServer({production: true, edgeSecret: edge, serviceSecret: assistant, logger: () => {},
    storageEnabled: () => true, storage: () => ({consume: async () => true}),
    feed: {status: 'fixture', add: async (seen, listener) => {
      assert.equal(seen, ticker);
      queueMicrotask(() => listener({kind: 'quote', ticker, as_of: new Date().toISOString()}));
      return () => { counters.removals++; };
    }},
    mcp: (request, response, body, options) => handleMCP(request, response, body, {...options, dependencies: {
      marketDetails: async () => { counters.tools++; return {market: {ticker, title: 'Fixture market'}, as_of: new Date().toISOString()}; },
      book: async () => ({raw: {}, metrics: {book_ask: .42}, as_of: new Date().toISOString()}),
    }}),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = {'x-market-edge-secret': edge, 'x-market-country': 'US', Origin: origin};
  assert.equal((await (await fetch(base + '/api/health')).json()).runtime, 'Azure Container Apps');
  assert.equal((await fetch(base + '/api/workspace/markets')).status, 403);
  assert.equal((await fetch(base + '/api/workspace/markets', {headers: {...headers, Origin: 'https://other.example'}})).status, 403);
  assert.equal((await fetch(base + '/api/workspace/markets', {headers: {...headers, 'x-market-country': 'RU'}})).status, 403);
  const catalog = await fetch(base + '/api/intelligence/catalog', {headers});
  assert.equal(catalog.status, 200);
  assert.ok(Array.isArray((await catalog.json()).categories));

  const stream = await fetch(base + '/api/stream?ticker=' + ticker, {headers, signal: AbortSignal.timeout(3000)});
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /KX-AZURE-FIXTURE/);
  await reader.cancel();

  const mcpURL = new URL('/mcp', base), request = {method: 'POST', headers: {Authorization: 'Bearer ' + edge, 'Content-Type': 'application/json'}, body: '{}'};
  assert.equal((await fetch(mcpURL, request)).status, 401);
  const client = new Client({name: 'azure-fixture', version: '1'});
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(mcpURL, {requestInit: {headers: {
    Authorization: 'Bearer ' + assistant, 'x-market-ticker': ticker,
  }}}));
  const {tools} = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'analyze_execution_lab', 'get_contract', 'get_price_history', 'get_research', 'get_source_status', 'search_retained_evidence',
  ]);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const result = await client.callTool({name: 'get_contract', arguments: {ticker}});
  assert.equal(JSON.parse(result.content[0].text).quotes.yes_ask_usd, .42);
  const rejected = await client.callTool({name: 'get_contract', arguments: {ticker: 'KX-WRONG'}});
  assert.equal(rejected.isError, true);
  assert.equal(counters.tools, 1);
  assert.equal(counters.removals, 1);
});
