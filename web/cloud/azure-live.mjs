import {X509Certificate, createPrivateKey} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {assertAzureServiceSecrets, azureOrigin} from '../lib/workspace/azure-mode.mjs';

const databaseName = 'predictir', appLogin = 'market_lab_app';
const unavailableCloudKeys = [
  'MARKET_TABLE', 'MARKET_BUCKET', 'MARKET_BACKEND_URL', 'KALSHI_SECRET_PARAMETER', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'X_BEARER_TOKEN', 'REDDIT_CLIENT_SECRET', 'SPOTIFY_CLIENT_SECRET', 'AI_GATEWAY_API_KEY', 'OPENAI_API_KEY',
  'AWS_LAMBDA_HTTP_ENDPOINT',
];

export function validateAzureLive(env = process.env) {
  if (!azureOrigin(env.APP_ORIGIN) || unavailableCloudKeys.some(key => env[key]) || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Azure live needs its own application origin and provider configuration');
  }
  assertAzureServiceSecrets(env, {account: true});
  const host = env.PREDICTIR_DATABASE_HOST;
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('Set the Azure app-role database URL'); }
  if (typeof host !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.postgres\.database\.azure\.com$/.test(host) ||
      !['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== host || !['', '5432'].includes(url.port) ||
      url.username !== appLogin || !url.password || url.pathname !== '/' + databaseName || url.search || url.hash) {
    throw new Error('The database URL must use the expected private Azure host and app login without URL options');
  }
  const ca = env.DATABASE_CA_CERT, certificates = typeof ca === 'string' && ca.length <= 65536 ?
    ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) : null;
  try {
    if (!certificates?.length || certificates.some(pem => !new X509Certificate(pem).ca) || /PRIVATE KEY/.test(ca)) throw new Error();
  } catch { throw new Error('Set the trusted Azure PostgreSQL CA certificate bundle'); }
  if (Boolean(env.KALSHI_API_KEY_ID) !== Boolean(env.KALSHI_PRIVATE_KEY)) throw new Error('Set both optional Kalshi stream credentials or neither');
  if (env.KALSHI_PRIVATE_KEY) {
    try { createPrivateKey(env.KALSHI_PRIVATE_KEY.replaceAll('\\n', '\n')); }
    catch { throw new Error('The optional Kalshi stream private key is invalid'); }
  }
  return {host, database: databaseName, login: appLogin, pipelineEnabled: env.MARKET_PIPELINE_ENABLED === '1'};
}

export async function verifyAzurePrivateDNS(host, resolve = lookup) {
  function privateIPv4({address, family}) {
    if (family !== 4) return false;
    const [first, second] = address.split('.').map(Number);
    return first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168;
  }
  const addresses = await resolve(host, {all: true});
  if (!addresses.length || !addresses.every(privateIPv4)) throw new Error('Azure PostgreSQL must resolve only to private VNet addresses');
}

export async function verifyAzureDatabase(db, {database, login, pipelineEnabled}) {
  const update = ['SELECT', 'INSERT', 'UPDATE'], append = ['SELECT', 'INSERT'];
  const requirements = {
    records: update,
    quotas: update,
    leases: [...update, 'DELETE'],
    archives: append,
    audit_heads: update,
    audit_events: append,
    source_batches: append,
    market_snapshots: append,
    source_observations: append,
    sports_games: update,
    owner_portfolios: update,
    public_evidence_chunks: [...update, 'DELETE'],
    ...(pipelineEnabled ? {jobs: update} : {}),
  };
  const tables = Object.entries(requirements).map(([name, privileges]) => ({name, privileges}));
  const {rows: [result]} = await db.query(`
    WITH required AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(name text, privileges text[])
    )
    SELECT current_database() AS database, current_user AS login,
      EXISTS(SELECT FROM pg_stat_ssl WHERE pid=pg_backend_pid() AND ssl) AS tls,
      NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND
        (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AND
      NOT EXISTS(SELECT FROM pg_roles WHERE rolname IN ('azure_pg_admin','pg_read_all_data','pg_write_all_data')
        AND pg_has_role(oid,'MEMBER')) AS restricted,
      COALESCE(has_schema_privilege(to_regnamespace('market_lab'),'USAGE') AND
        NOT has_schema_privilege(to_regnamespace('market_lab'),'CREATE'),false) AS schema_access,
      NOT EXISTS (
        SELECT FROM required r
        LEFT JOIN pg_class c ON c.relname=r.name AND c.relnamespace=to_regnamespace('market_lab')
        WHERE c.oid IS NULL OR NOT row_security_active(c.oid) OR EXISTS (
          SELECT FROM unnest(r.privileges) AS p(privilege)
          WHERE NOT has_table_privilege(c.oid,p.privilege) OR NOT EXISTS (
            SELECT FROM pg_policy pol WHERE pol.polrelid=c.oid AND pol.polpermissive
              AND pol.polcmd::text IN ('*', CASE p.privilege WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END)
              AND EXISTS (SELECT FROM unnest(pol.polroles) AS a(role)
                WHERE CASE WHEN a.role=0::oid THEN true ELSE pg_has_role(a.role,'USAGE') END)
          )
        )
      ) AS tables_ready
  `, [JSON.stringify(tables)]);
  if (!result || result.database !== database || result.login !== login || !result.tls || !result.restricted ||
      !result.schema_access || !result.tables_ready) throw new Error('Azure PostgreSQL is not ready for the restricted app role over TLS');
}
