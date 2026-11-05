import {createHash, createPublicKey, verify} from 'node:crypto';
import {readJSON} from '../transport.mjs';
import {azureOrigin} from './azure-mode.mjs';

const authority = 'https://login.microsoftonline.com';
const templatedIssuer = authority + '/{tenantid}/v2.0';
const guid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const keyLifetime = 60 * 60 * 1000;
const minimumRefresh = 60 * 1000;
export const azureOwnerTokenHeader = 'x-ms-token-aad-id-token';
export const azureOwnerLogout = '/.auth/logout?post_logout_redirect_uri=%2F';

export function azureOwnerConfig(env = process.env) {
  if (env.PREDICTIR_MODE !== 'live' || env.AZURE_OWNER_AUTH_ENABLED !== '1') return null;
  const tenant = env.AZURE_OWNER_TENANT_ID;
  const object = env.AZURE_OWNER_OBJECT_ID;
  const client = env.AZURE_OWNER_CLIENT_ID;
  if (![tenant, object, client].every(value => typeof value === 'string' && guid.test(value))) return null;
  try {
    const origin = azureOrigin(env.APP_ORIGIN || '');
    if (!origin) return null;
    const tenantId = tenant.toLowerCase();
    return {
      origin,
      tenant: tenantId,
      object: object.toLowerCase(),
      client: client.toLowerCase(),
      issuer: authority + '/' + tenantId + '/v2.0',
    };
  } catch {
    return null;
  }
}

function ownerKey({tenant, object}) {
  const bytes = createHash('sha256').update('predictir-entra-owner\0' + tenant + '\0' + object).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
}

function jwtPart(part) {
  if (!/^[a-z\d_-]+$/i.test(part)) throw new Error('Invalid token encoding');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error('Invalid token encoding');
  return bytes;
}

function eligibleKey(key, kid, issuer) {
  return key?.kid === kid && key.kty === 'RSA' && key.use === 'sig' &&
    (!key.alg || key.alg === 'RS256') && (!key.issuer || key.issuer === issuer || key.issuer === templatedIssuer);
}

export function makeAzureOwnerVerifier({fetcher = fetch, now = Date.now} = {}) {
  let cache;
  async function signingKey(config, kid) {
    if (cache?.tenant !== config.tenant) cache = {tenant: config.tenant, keys: [], fetched: -Infinity};
    const current = cache;
    const key = () => current.keys.find(row => eligibleKey(row, kid, config.issuer));
    const elapsed = now() - current.fetched;
    const existing = key();
    if (existing && elapsed < keyLifetime) return existing;
    if (!current.loading && elapsed < minimumRefresh) return null;
    if (!current.loading) {
      current.fetched = now();
      current.loading = (async () => {
        const response = await fetcher(authority + '/' + config.tenant + '/discovery/v2.0/keys', {
          headers: {Accept: 'application/json'}, redirect: 'error', signal: AbortSignal.timeout(4000),
        });
        const {data} = await readJSON(response, {source: 'Microsoft identity keys', maximumBytes: 262_144});
        current.keys = Array.isArray(data.keys) ? data.keys.slice(0, 64) : [];
      })().catch(() => { current.keys = []; }).finally(() => { current.loading = null; });
    }
    await current.loading;
    return key();
  }

  return async function verifyAzureOwner(request, config) {
    const token = request.headers.get(azureOwnerTokenHeader);
    if (!config || !token || token.length > 12_000) return null;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [head, body, signature] = parts.map(jwtPart);
      const header = JSON.parse(head.toString('utf8'));
      const claims = JSON.parse(body.toString('utf8'));
      const current = Math.floor(now() / 1000);
      if (header?.alg !== 'RS256' || header.crit !== undefined || header.b64 !== undefined ||
          typeof header.kid !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(header.kid) ||
          claims?.ver !== '2.0' || claims.iss !== config.issuer || claims.aud !== config.client ||
          claims.tid !== config.tenant || claims.oid !== config.object || typeof claims.sub !== 'string' || !claims.sub ||
          claims.idtyp === 'app' || claims.scp !== undefined ||
          !Number.isSafeInteger(claims.exp) || claims.exp <= current || !Number.isSafeInteger(claims.iat) || claims.iat > current + 30 ||
          (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > current + 30))) return null;
      const key = await signingKey(config, header.kid);
      if (!key || claims.exp <= Math.floor(now() / 1000)) return null;
      const publicKey = createPublicKey({key, format: 'jwk'});
      if (!verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), publicKey, signature)) return null;
      const id = ownerKey(config);
      return {id, key: id, display_name: 'Microsoft owner'};
    } catch {
      return null;
    }
  };
}

export const verifyAzureOwner = makeAzureOwnerVerifier();
