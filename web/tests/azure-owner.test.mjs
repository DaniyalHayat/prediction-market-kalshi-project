import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import test from 'node:test';
import {makeAccountHandler} from '../lib/workspace/account.mjs';
import {azureOwnerConfig, azureOwnerTokenHeader, makeAzureOwnerVerifier} from '../lib/workspace/azure-owner.mjs';

const start = Date.UTC(2026, 10, 5);
const env = {
  PREDICTIR_MODE: 'live',
  AZURE_OWNER_AUTH_ENABLED: '1',
  AZURE_OWNER_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  AZURE_OWNER_OBJECT_ID: '22222222-2222-4222-8222-222222222222',
  AZURE_OWNER_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
  APP_ORIGIN: 'https://predictir-fixture.azurecontainerapps.io',
};
const config = azureOwnerConfig(env);
const claims = {
  ver: '2.0', iss: config.issuer, tid: config.tenant, oid: config.object, aud: config.client,
  sub: 'fixture-subject', iat: start / 1000, nbf: start / 1000, exp: start / 1000 + 3600,
  preferred_username: 'untrusted-email@example.test',
};
const signing = generateKeyPairSync('rsa', {modulusLength: 2048});
const nextSigning = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = (key, kid) => ({...key.publicKey.export({format: 'jwk'}), kid, alg: 'RS256', use: 'sig', issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0'});
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(overrides = {}, head = {}, key = signing) {
  const text = encode({typ: 'JWT', alg: 'RS256', kid: 'first', ...head}) + '.' + encode({...claims, ...overrides});
  return text + '.' + sign('RSA-SHA256', Buffer.from(text), key.privateKey).toString('base64url');
}
function request(path, {token, method = 'GET', origin = env.APP_ORIGIN, headers = {}, body} = {}) {
  return new Request(env.APP_ORIGIN + '/api/' + path, {
    method, headers: {...(token ? {[azureOwnerTokenHeader]: token} : {}), Origin: origin, ...headers,
      ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {}),
  });
}
function fixture() {
  let keys = [jwk(signing, 'first')], fetches = 0, time = start;
  const verify = makeAzureOwnerVerifier({
    now: () => time,
    fetcher: async (url, options) => {
      fetches++;
      assert.equal(url, 'https://login.microsoftonline.com/' + config.tenant + '/discovery/v2.0/keys');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, undefined);
      return Response.json({keys});
    },
  });
  return {verify, fetches: () => fetches, setKeys: value => {keys = value;}, advance: ms => {time += ms;}};
}

test('owner auth requires a live edition, explicit activation, exact IDs and HTTPS origin', () => {
  assert.ok(config);
  for (const change of [
    {PREDICTIR_MODE: 'replay'}, {AZURE_OWNER_AUTH_ENABLED: '0'}, {AZURE_OWNER_CLIENT_ID: 'common'},
    {AZURE_OWNER_TENANT_ID: 'common'}, {AZURE_OWNER_OBJECT_ID: 'owner@example.test'},
    {APP_ORIGIN: 'http://predictir-fixture.azurecontainerapps.io'}, {APP_ORIGIN: env.APP_ORIGIN + '/subpath'},
  ]) assert.equal(azureOwnerConfig({...env, ...change}), null);
});

test('signed owner claim is scoped to exact Entra tenant, application and owner object', async () => {
  const f = fixture();
  const principal = encode({auth_typ: 'aad', claims: [{typ: 'tid', val: config.tenant}, {typ: 'oid', val: config.object}]});
  assert.equal(await f.verify(request('session', {headers: {'x-ms-client-principal': principal}}), config), null);
  for (const overrides of [
    {tid: config.client}, {oid: config.client}, {aud: config.object}, {iss: 'https://example.test/v2.0'},
    {exp: start / 1000}, {iat: start / 1000 + 60}, {nbf: start / 1000 + 60},
    {ver: '1.0'}, {sub: ''}, {idtyp: 'app'}, {scp: 'user_impersonation'},
  ]) assert.equal(await f.verify(request('session', {token: jwt(overrides)}), config), null);
  assert.equal(await f.verify(request('session', {token: jwt({}, {alg: 'none'})}), config), null);
  assert.equal(f.fetches(), 0);
  const owner = await f.verify(request('session', {token: jwt()}), config);
  assert.match(owner.id, /^[a-f0-9-]{36}$/);
  assert.equal(owner.key, owner.id);
  assert.equal(owner.display_name, 'Microsoft owner');
  assert.equal(owner.email, undefined);
  assert.equal(await f.verify(request('session', {token: jwt({}, {}, nextSigning)}), config), null);
  assert.deepEqual(await f.verify(request('session', {token: jwt({preferred_username: 'changed@example.test'})}), config), owner);
  assert.equal(f.fetches(), 1);
});

test('signing keys rotate with a bounded refresh and cannot override the issuer', async () => {
  const f = fixture();
  assert.ok(await f.verify(request('session', {token: jwt()}), config));
  const next = request('session', {token: jwt({}, {kid: 'next', jku: 'https://example.test/keys'}, nextSigning)});
  assert.equal(await f.verify(next, config), null);
  assert.equal(f.fetches(), 1);
  f.setKeys([{...jwk(nextSigning, 'next'), issuer: 'https://other.example.test/v2.0'}]);
  f.advance(60_000);
  assert.equal(await f.verify(next, config), null);
  f.setKeys([jwk(nextSigning, 'next')]);
  f.advance(60_000);
  assert.ok(await f.verify(next, config));
  assert.equal(f.fetches(), 3);
});

test('live Azure account keeps guests and protects portfolio reads and writes without a password or new signup', async () => {
  const f = fixture();
  let ownerId;
  const storage = {
    consume: async () => true,
    readOwnerPortfolio: async id => {ownerId = id;return {ledger: null, revision: 0, watchlist: []};},
    saveOwnerPortfolio: async (id, value) => {assert.equal(id, ownerId);return {conflict: false, value: {...value, revision: 1}};},
  };
  const handler = makeAccountHandler({
    env, storage, secret: 'fixture-private-account-key-'.repeat(2), secure: true, now: () => start,
    verifyEntraOwner: f.verify, configured: true, authFactory: () => assert.fail('No Supabase authentication in Azure live'),
  });
  const call = (path, options) => handler(request(path, options), path);
  const guest = await call('session');
  assert.equal(guest.status, 200);
  assert.match(guest.headers.getSetCookie()[0], /^__Host-market_guest=/);
  const data = await guest.json();
  assert.equal(data.kind, 'guest');
  assert.equal(data.signup_enabled, false);
  assert.equal(data.login_provider, 'entra');
  assert.equal(data.login_configured, true);
  assert.equal((await call('account/portfolio')).status, 401);
  assert.equal((await call('account/portfolio', {token: jwt({oid: config.client})})).status, 401);
  assert.equal((await call('account/login', {method: 'POST'})).status, 405);
  const token = jwt();
  const owner = await call('session', {token});
  assert.equal(owner.headers.getSetCookie().length, 1);
  assert.equal(owner.headers.get('cache-control'), 'no-store');
  const ownerSession = await owner.json();
  assert.equal(ownerSession.kind, 'owner');
  assert.equal(ownerSession.owner.display_name, 'Microsoft owner');
  assert.equal(JSON.stringify(ownerSession).includes(token), false);
  assert.equal((await call('account/portfolio', {token})).status, 200);
  assert.equal(ownerId, ownerSession.owner.key);
  const body = {ledger: {version: 1, positions: [], trades: [], starting_balance: 20000, cash_movements: []}, revision: 0, watchlist: ['KXNBA-FIXTURE']};
  assert.equal((await call('account/portfolio', {token, method: 'PUT', body, origin: 'https://predictir.dev'})).status, 403);
  assert.equal((await call('account/portfolio', {token, method: 'PUT', body, headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
  const saved = await call('account/portfolio', {token, method: 'PUT', body});
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).revision, 1);
});

test('Azure auth disabled leaves a guest even when identity and Supabase settings exist', async () => {
  let calls = 0;
  const handler = makeAccountHandler({
    env: {...env, AZURE_OWNER_AUTH_ENABLED: '0'}, storage: {}, secret: 'fixture-private-account-key-'.repeat(2),
    configured: true, secure: true, now: () => start, verifyEntraOwner: async () => {calls++;},
  });
  const session = await handler(request('session', {token: jwt()}), 'session');
  assert.equal(session.status, 200);
  const data = await session.json();
  assert.equal(data.kind, 'guest');
  assert.equal(data.login_configured, false);
  assert.equal(data.login_provider, 'entra');
  assert.equal(calls, 0);
});
