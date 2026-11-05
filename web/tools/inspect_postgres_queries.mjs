import pg from 'pg';
import {pathToFileURL} from 'node:url';

const catalog={
  server:"SELECT current_setting('server_version') AS version,current_user AS audit_role,pg_postmaster_start_time() AS started_at",
  indexes:"SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='market_lab' AND tablename IN ('records','quotas','leases') ORDER BY tablename,indexname",
  constraints:"SELECT c.relname AS table_name,con.conname,con.contype,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='market_lab' AND c.relname IN ('records','quotas','leases') ORDER BY c.relname,con.conname",
  table_stats:"SELECT relname,n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_hot_upd,n_mod_since_analyze,last_vacuum,last_autovacuum,last_analyze,last_autoanalyze,pg_total_relation_size(relid)::text AS total_bytes FROM pg_stat_user_tables WHERE schemaname='market_lab' AND relname IN ('records','quotas','leases') ORDER BY relname",
  relation_options:"SELECT relname,reloptions,relrowsecurity FROM pg_class WHERE oid IN ('market_lab.records'::regclass,'market_lab.quotas'::regclass,'market_lab.leases'::regclass) ORDER BY relname",
  records_storage:"SELECT pg_relation_size(c.oid)::text AS heap_bytes,pg_indexes_size(c.oid)::text AS index_bytes,pg_total_relation_size(c.reltoastrelid)::text AS toast_total_bytes FROM pg_class c WHERE c.oid='market_lab.records'::regclass",
  triggers:"SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgrelid IN ('market_lab.records'::regclass,'market_lab.quotas'::regclass,'market_lab.leases'::regclass) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",
  policies:"SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='market_lab' AND tablename IN ('records','quotas','leases') ORDER BY tablename,policyname",
  active_waits:"SELECT wait_event_type,wait_event,count(*) AS sessions,max(clock_timestamp()-query_start)::text AS oldest_query_age FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid() AND state<>'idle' GROUP BY wait_event_type,wait_event",
  pgss_location:"SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname='pg_stat_statements' LIMIT 1"
};

export async function inspectPostgresQueries(client,{role='market_lab_app'}={}){
  const result={observed_at:new Date().toISOString(),scope:'Read-only catalogs and aggregate statement statistics. No application rows, SQL text, bind values or credentials.',queries:{}};
  async function inspect(name,sql,values=[]){
    await client.query('SAVEPOINT query_inspection');
    try{result.queries[name]=(await client.query(sql,values)).rows;}
    catch(error){await client.query('ROLLBACK TO SAVEPOINT query_inspection');result.queries[name]={unavailable:/^[0-9A-Z]{5}$/.test(error.code||'')?error.code:'query_error'};}
    finally{await client.query('RELEASE SAVEPOINT query_inspection');}
  }
  await client.query('BEGIN READ ONLY');
  try{
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    for(const [name,sql] of Object.entries(catalog))await inspect(name,sql,name==='active_waits'?[role]:[]);
    const schema=result.queries.pgss_location?.[0]?.schema;
    if(typeof schema==='string'&&/^[a-z_][a-z0-9_]*$/.test(schema)){
      await inspect('statement_stats',`SELECT CASE WHEN query ILIKE '%market_lab.records%' THEN 'records' WHEN query ILIKE '%market_lab.quotas%' THEN 'quotas' ELSE 'leases' END AS table_family,queryid::text,calls,rows,total_exec_time,mean_exec_time,stddev_exec_time,min_exec_time,max_exec_time,shared_blks_hit,shared_blks_read,shared_blks_dirtied,shared_blks_written,wal_records,wal_fpi,wal_bytes::text FROM "${schema}".pg_stat_statements WHERE userid=(SELECT oid FROM pg_roles WHERE rolname=$1) AND (query ~* '^[[:space:]]*insert[[:space:]]+into[[:space:]]+market_lab[.](records|quotas|leases)' OR query ~* '^[[:space:]]*with[[:space:]]+locked[[:space:]]+as[[:space:]]+materialized') ORDER BY total_exec_time DESC LIMIT 12`,[role]);
      await inspect('statement_stats_window',`SELECT stats_reset FROM "${schema}".pg_stat_statements_info`);
    }
    return result;
  }finally{await client.query('ROLLBACK');}
}

async function main(){
  const connectionString=process.env.DATABASE_URL;
  if(!connectionString)throw new Error('missing_configuration');
  const address=new URL(connectionString),local=['localhost','127.0.0.1','[::1]'].includes(address.hostname);
  const client=new pg.Client({connectionString,connectionTimeoutMillis:10000,application_name:'predictir-readonly-query-inspection',...(!local?{ssl:{rejectUnauthorized:true,...(process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT}:{})}}:{})});
  try{await client.connect();process.stdout.write(JSON.stringify(await inspectPostgresQueries(client),null,2)+'\n');}
  finally{await client.end().catch(()=>{});}
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(()=>{process.stderr.write('Read-only query inspection could not complete. Check private database configuration and connectivity.\n');process.exitCode=1;});
