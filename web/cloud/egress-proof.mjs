import {isIP} from 'node:net';

const expectedHost = 'aws-0-us-east-2.pooler.supabase.com';
const tagPattern = /^predictir-egress-[a-z0-9-]{8,46}$/;
const query = `SELECT clock_timestamp() AS checked_at,current_user,session_user,
  current_setting('application_name') AS backend_application_name,
  current_setting('transaction_read_only')='on' AS read_only,pg_backend_pid() AS backend_pid,
  inet_client_addr()::text AS pooler_to_pg_hop,
  (SELECT jsonb_build_object('ssl',ssl,'version',version) FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS pooler_to_pg_tls,
  (SELECT jsonb_build_object('superuser',rolsuper,'create_db',rolcreatedb,'create_role',rolcreaterole,
    'replication',rolreplication,'bypass_rls',rolbypassrls) FROM pg_roles WHERE rolname=current_user) AS flags`;
let attempted = false;

export async function runDatabaseEgressProof({env = process.env,createClient,write = record => process.stdout.write(JSON.stringify(record)+'\n'),timeoutMs = 8000} = {}) {
  const tag = env.PREDICTIR_EGRESS_PROOF_TAG;
  if (!tag) return {result:'disabled'};
  if (attempted) return {result:'already_attempted'};
  attempted = true;
  const started = Date.now();
  let client,deadline,finished = false,expired = false;
  const emit = values => {
    if (finished) return {result:'already_finished'};
    finished = true;
    const record = {event:'database.network_proof',time:new Date().toISOString(),
      tag:tagPattern.test(tag) ? tag : 'invalid_tag',duration_ms:Date.now()-started,...values};
    try {write(record);} catch {}
    return record;
  };
  try {
    if (!tagPattern.test(tag)) throw Object.assign(new Error(),{code:'INVALID_PROOF_TAG'});
    const url = new URL(env.DATABASE_URL || '');
    if (!['postgres:','postgresql:'].includes(url.protocol) || url.hostname !== expectedHost ||
        (url.port || '5432') !== '5432' || url.hash || [...url.searchParams.keys()].some(key=>key.toLowerCase().startsWith('ssl')) ||
        typeof env.DATABASE_CA_CERT !== 'string' || !env.DATABASE_CA_CERT.includes('-----BEGIN CERTIFICATE-----')) {
      throw Object.assign(new Error(),{code:'INVALID_PROOF_CONNECTION'});
    }
    const factory = createClient || (config => import('pg').then(({default:pg}) => new pg.Client(config)));
    client = await factory({connectionString:env.DATABASE_URL,application_name:tag,
      connectionTimeoutMillis:5000,query_timeout:2000,
      ssl:{rejectUnauthorized:true,minVersion:'TLSv1.2',ca:env.DATABASE_CA_CERT}});
    client.on?.('error',()=>{});
    const probe = async () => {
      await client.connect();
      if (expired) return {result:'already_finished'};
      const stream = client.connection?.stream;
      if (stream?.encrypted !== true || stream?.authorized !== true || !/^TLSv1\.[23]$/.test(stream?.getProtocol?.() || '') || stream?.remoteFamily !== 'IPv4') {
        throw Object.assign(new Error(),{code:'TLS_VERIFICATION_FAILED'});
      }
      await client.query('BEGIN READ ONLY');
      const {rows:[row]} = await client.query(query);
      const clientTLS = {encrypted:stream?.encrypted === true,authorized:stream?.authorized === true,
        version:/^TLSv1\.[23]$/.test(stream?.getProtocol?.() || '') ? stream.getProtocol() : null,
        family:['IPv4','IPv6'].includes(stream?.remoteFamily) ? stream.remoteFamily : null};
      const flags = Object.fromEntries(['superuser','create_db','create_role','replication','bypass_rls'].map(key=>[key,row?.flags?.[key] === true]));
      const metadata = {runtime_application_name:tag,
        database_application_name:[tag,'Supavisor'].includes(row?.backend_application_name) ? row.backend_application_name : null,
        app_role:row?.current_user === 'market_lab_app' && row?.session_user === 'market_lab_app',
        read_only:row?.read_only === true,backend_pid:Number.isSafeInteger(row?.backend_pid) ? row.backend_pid : null,
        pooler_to_pg_hop:isIP(row?.pooler_to_pg_hop || '') ? row.pooler_to_pg_hop : null,
        pooler_to_pg_tls:{ssl:row?.pooler_to_pg_tls?.ssl === true,
          version:/^TLSv1\.[23]$/.test(row?.pooler_to_pg_tls?.version || '') ? row.pooler_to_pg_tls.version : null},
        client_to_pooler_tls:clientTLS,role_flags:flags};
      await client.query('ROLLBACK');
      await client.end();
      const passed = metadata.database_application_name !== null && metadata.app_role && metadata.read_only &&
        metadata.backend_pid !== null && metadata.pooler_to_pg_tls.ssl &&
        metadata.pooler_to_pg_tls.version !== null && clientTLS.version !== null &&
        clientTLS.encrypted && clientTLS.authorized && clientTLS.family === 'IPv4' &&
        Object.values(flags).every(value=>value === false) &&
        ['superuser','create_db','create_role','replication','bypass_rls'].every(key=>typeof row?.flags?.[key] === 'boolean');
      return emit({result:passed ? 'ok' : 'verification_failed',...metadata});
    };
    return await Promise.race([probe(),new Promise(resolve=>{
      deadline = setTimeout(()=>{
        expired = true;
        try {client?.connection?.stream?.destroy();} catch {}
        resolve(emit({result:'timeout',error_code:'EGRESS_PROOF_TIMEOUT'}));
      },timeoutMs);
    })]);
  } catch (error) {
    return emit({result:'failed',error_code:/^[A-Z0-9_]{2,40}$/.test(error?.code || '') ? error.code : 'EGRESS_PROOF_FAILED'});
  } finally {
    clearTimeout(deadline);
    try {void client?.end()?.catch(()=>{});} catch {}
  }
}
