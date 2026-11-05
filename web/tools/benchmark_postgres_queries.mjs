import pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

const address=process.env.MARKET_QUERY_BENCH_DATABASE_URL;
if(!address)throw new Error('Set MARKET_QUERY_BENCH_DATABASE_URL to a separate disposable local *_test database.');
let parsed;try{parsed=new URL(address);}catch{throw new Error('Supply a valid local test database address; configured addresses are never logged.');}
let database;try{database=decodeURIComponent(parsed.pathname.slice(1));}catch{throw new Error('Supply a valid local test database name.');}
if(!['postgres:','postgresql:'].includes(parsed.protocol)||!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!/^query_[a-z0-9_]*_test$/.test(database)||database==='engineering_test')throw new Error('Benchmark refuses non-loopback or non-query_*_test targets.');
const scale=Number(process.env.QUERY_BENCH_SCALE||100000),trials=Number(process.env.QUERY_BENCH_TRIALS||41),warmups=5;
if(!Number.isSafeInteger(scale)||scale<1000||scale>200000||!Number.isInteger(trials)||trials<21||trials>101)throw new Error('Use scale 1000..200000 and 21..101 measured trials.');
const schema='query_ab_'+randomUUID().replaceAll('-','').slice(0,12),client=new pg.Client({connectionString:address,application_name:'predictir-local-query-benchmark'});
const percentile=(values,q)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*q)-1)];};
const summary=values=>({p50:percentile(values,.5),p95:percentile(values,.95),min:Math.min(...values),max:Math.max(...values),mean:values.reduce((sum,value)=>sum+value,0)/values.length});
const metricNames=['Node Type','Relation Name','Index Name','Plan Rows','Actual Rows','Actual Loops','Rows Removed by Filter','Rows Removed by Conflict Filter','Tuples Inserted','Conflicting Tuples','Shared Hit Blocks','Shared Read Blocks','Shared Dirtied Blocks','Shared Written Blocks','Local Hit Blocks','Local Read Blocks','Local Dirtied Blocks','Local Written Blocks','WAL Records','WAL FPI','WAL Bytes'];
function sanitizedPlan(plan){const output=Object.fromEntries(metricNames.filter(key=>plan[key]!==undefined).map(key=>[key,plan[key]]));if(plan.Plans)output.Plans=plan.Plans.map(sanitizedPlan);return output;}
async function explain(sql,values=[]){
  const started=performance.now(),result=await client.query('EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, FORMAT JSON) '+sql,values),plan=result.rows[0]['QUERY PLAN'][0],root=plan.Plan;
  return {execution_ms:plan['Execution Time'],planning_ms:plan['Planning Time'],round_trip_ms:Math.round((performance.now()-started)*1e6)/1e6,shared_hit_blocks:root['Shared Hit Blocks']||0,shared_read_blocks:root['Shared Read Blocks']||0,shared_dirtied_blocks:root['Shared Dirtied Blocks']||0,wal_records:root['WAL Records']||0,wal_fpi:root['WAL FPI']||0,wal_bytes:root['WAL Bytes']||0,plan:sanitizedPlan(root)};
}
function aggregate(rows){
  const metrics={};for(const key of ['execution_ms','planning_ms','round_trip_ms','shared_hit_blocks','shared_read_blocks','shared_dirtied_blocks','wal_records','wal_fpi','wal_bytes'])metrics[key]=summary(rows.map(row=>row[key]));
  return {trials:rows.length,metrics,representative_plan:rows[Math.floor(rows.length/2)].plan,observations:rows.map(({plan,...row})=>row)};
}
async function paired(variants,parameters,{firstTouch=false}={}){
  const collected=Object.fromEntries(variants.map(variant=>[variant.name,[]])),first={};
  if(firstTouch)for(const variant of variants)first[variant.name]=await explain(variant.sql,parameters(0,variant));
  for(let repeat=-warmups;repeat<trials;repeat++){
    const offset=((repeat%variants.length)+variants.length)%variants.length,rotated=[...variants.slice(offset),...variants.slice(0,offset)],order=Math.floor(repeat/variants.length)%2===0?rotated:[...rotated].reverse();
    for(const variant of order){const row=await explain(variant.sql,parameters(repeat+warmups+1,variant));if(repeat>=0)collected[variant.name].push(row);}
  }
  return {first_touch_after_population:firstTouch?first:undefined,variants:Object.fromEntries(variants.map(variant=>[variant.name,aggregate(collected[variant.name])]))};
}
async function sizes(table){return (await client.query('SELECT pg_relation_size($1)::bigint AS heap_bytes,pg_indexes_size($1)::bigint AS index_bytes,pg_total_relation_size($1)::bigint AS total_bytes',[table])).rows[0];}
async function stats(tables){
  await client.query('SELECT pg_stat_force_next_flush()');await client.query('SELECT pg_stat_clear_snapshot()');
  return (await client.query('SELECT relname,n_tup_ins,n_tup_upd,n_tup_hot_upd,n_dead_tup FROM pg_stat_user_tables WHERE schemaname=$1 AND relname=ANY($2::text[])',[schema,tables])).rows;
}
function statDelta(before,after){const prior=new Map(before.map(row=>[row.relname,row]));return after.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,key==='relname'?value:Number(value)-Number(prior.get(row.relname)?.[key]||0)])));}
async function populate(name,rows){
  await client.query(`CREATE TABLE ${schema}.${name}(pk text NOT NULL,sk text NOT NULL,payload jsonb NOT NULL,expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(pk,sk)) WITH(autovacuum_enabled=false)`);
  await client.query(`INSERT INTO ${schema}.${name}(pk,sk,payload,expires_at) SELECT CASE WHEN i%5=0 THEN 'journal#'||lpad((i/100)::text,8,'0') ELSE 'cache#'||md5(i::text)||md5('salt-'||i::text) END,CASE WHEN i%5=0 THEN 'forecast#'||lpad(i::text,10,'0') ELSE 'value' END,jsonb_build_object('fixture',true,'ordinal',i,'padding',repeat('x',256),'status',CASE WHEN i%25=0 THEN 'pending' ELSE 'complete' END,'pending_sk',lpad(i::text,10,'0')),CASE WHEN i%10=0 THEN now()-interval '1 day' WHEN i%3=0 THEN NULL ELSE now()+interval '1 day' END FROM generate_series(1,$1::int) AS i`,[rows]);
  await client.query(`CREATE INDEX ${name}_expiry ON ${schema}.${name}(expires_at) WHERE expires_at IS NOT NULL`);
  await client.query(`CREATE INDEX ${name}_pending ON ${schema}.${name}((payload->>'pending_sk')) WHERE payload->>'status'='pending'`);
}
function entropy(bytes){let output='';for(let index=0;output.length<bytes;index++)output+=createHash('sha256').update('deterministic-synthetic-'+index).digest('base64url');return output.slice(0,bytes);}
const payloads=[{name:'small_compressible_256',padding:'x'.repeat(256)},{name:'toast_compressible_16384',padding:'x'.repeat(16384)},{name:'toast_incompressible_16384',padding:entropy(16384)},{name:'toast_incompressible_32768',padding:entropy(32768)}];
const report={created_at:new Date().toISOString(),scope:'Synthetic local PostgreSQL query microbenchmark. Repeated warm/server-first-touch observations, not deployed latency or a production p95 guarantee.',runtime:process.version,configuration:{rows:[256,scale],trials,warmups,paired_order:'Rotating variant order with alternating reversal; each variant appears in each position',autovacuum:'Disabled only on disposable fixture tables for stable tuple/WAL comparisons',cache_scope:'No shared-buffer or OS-cache flush. First-touch follows population and is not disk-cold.',fixture:'80% unique cache keys, 20% multi-row journal keys; 256-character synthetic payload padding; realistic composite, expiry and pending indexes'},profiles:[],quota_denial:{}};
await client.connect();let schemaCreated=false;
try{
  const actual=(await client.query('SELECT current_database() AS name,current_setting(\'server_version\') AS version')).rows[0];
  if(actual.name!==database||!actual.version.startsWith('17.'))throw new Error('Benchmark requires the selected disposable PostgreSQL 17 database.');
  report.postgresql_version=actual.version;await client.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;
  await client.query("SET statement_timeout='60s'; SET lock_timeout='5s'");
  for(const rows of [256,scale]){
    const base='records_pk_'+rows,extra='records_extra_'+rows,guard='records_guard_'+rows,preserve='records_preserve_'+rows;
    for(const table of [base,extra,guard,preserve])await populate(table,rows);
    await client.query(`CREATE INDEX ${extra}_pk_only ON ${schema}.${extra}(pk)`);
    for(const table of [base,extra,guard,preserve])await client.query(`ANALYZE ${schema}.${table}`);
    const cacheKeys=(await client.query(`SELECT pk,sk FROM ${schema}.${base} WHERE pk LIKE 'cache#%' ORDER BY pk LIMIT 24`)).rows;
    const journalKeys=(await client.query(`SELECT DISTINCT pk FROM ${schema}.${base} WHERE pk LIKE 'journal#%' ORDER BY pk LIMIT 24`)).rows;
    const profile={rows,storage:{composite_only:await sizes(schema+'.'+base),plus_pk_index:await sizes(schema+'.'+extra)},reads:{},insert_index_cost:{},writes:[]};
    for(const [name,query,keys] of [['exact_key',table=>`SELECT payload FROM ${schema}.${table} WHERE pk=$1 AND sk=$2 AND(expires_at IS NULL OR expires_at>now())`,cacheKeys.map(row=>[row.pk,row.sk])],['pk_only',table=>`SELECT payload FROM ${schema}.${table} WHERE pk=$1`,cacheKeys.map(row=>[row.pk])],['journal_prefix',table=>`SELECT payload FROM ${schema}.${table} WHERE pk=$1 AND sk LIKE 'forecast#%' AND(expires_at IS NULL OR expires_at>now()) ORDER BY sk LIMIT 101`,journalKeys.map(row=>[row.pk])]]){
      profile.reads[name]=await paired([{name:'composite_only',sql:query(base)},{name:'plus_pk_index',sql:query(extra)}],index=>keys[index%keys.length],{firstTouch:true});
    }
    profile.insert_index_cost=await paired([{name:'composite_only',sql:`INSERT INTO ${schema}.${base}(pk,sk,payload) VALUES($1,'value',$2)`},{name:'plus_pk_index',sql:`INSERT INTO ${schema}.${extra}(pk,sk,payload) VALUES($1,'value',$2)`}],index=>['zz-insert-'+index,JSON.stringify({fixture:true,padding:'x'.repeat(256)})]);
    for(const payload of payloads)for(const operation of ['unchanged','changed_payload','expiry_only']){
      const key='zz-write-'+payload.name+'-'+operation,expiry=new Date('2027-01-01T00:00:00Z'),initial=JSON.stringify({fixture:true,revision:0,padding:payload.padding});
      for(const table of [base,guard,preserve])await client.query(`INSERT INTO ${schema}.${table}(pk,sk,payload,expires_at) VALUES($1,'value',$2,$3)`,[key,initial,expiry]);
      const before=await stats([base,guard,preserve]),identities=(await client.query(`SELECT 'baseline' AS variant,ctid::text AS tuple FROM ${schema}.${base} WHERE pk=$1 UNION ALL SELECT 'distinct_guard',ctid::text FROM ${schema}.${guard} WHERE pk=$1 UNION ALL SELECT 'preserve_toast',ctid::text FROM ${schema}.${preserve} WHERE pk=$1`,[key])).rows;
      const body=table=>`INSERT INTO ${schema}.${table}(pk,sk,payload,expires_at) VALUES($1,'value',$2,$3) ON CONFLICT(pk,sk) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at`;
      const distinct=table=>` WHERE ${schema}.${table}.payload IS DISTINCT FROM excluded.payload OR ${schema}.${table}.expires_at IS DISTINCT FROM excluded.expires_at`;
      const retained=`INSERT INTO ${schema}.${preserve}(pk,sk,payload,expires_at) VALUES($1,'value',$2,$3) ON CONFLICT(pk,sk) DO UPDATE SET payload=CASE WHEN ${schema}.${preserve}.payload IS NOT DISTINCT FROM excluded.payload THEN ${schema}.${preserve}.payload ELSE excluded.payload END,expires_at=excluded.expires_at`;
      const measured=await paired([{name:'baseline',sql:body(base)},{name:'distinct_guard',sql:body(guard)+distinct(guard)},{name:'preserve_toast',sql:retained+distinct(preserve)}],index=>[key,operation==='changed_payload'?JSON.stringify({fixture:true,revision:index,padding:payload.padding}):initial,operation==='expiry_only'?new Date(expiry.getTime()+index*1000):expiry]);
      const after=await stats([base,guard,preserve]),final=(await client.query(`SELECT 'baseline' AS variant,ctid::text AS tuple,pg_column_size(payload) AS stored_datum_bytes FROM ${schema}.${base} WHERE pk=$1 UNION ALL SELECT 'distinct_guard',ctid::text,pg_column_size(payload) FROM ${schema}.${guard} WHERE pk=$1 UNION ALL SELECT 'preserve_toast',ctid::text,pg_column_size(payload) FROM ${schema}.${preserve} WHERE pk=$1`,[key])).rows;
      profile.writes.push({payload:payload.name,logical_json_bytes:Buffer.byteLength(initial),operation,statistics_delta_including_warmups:statDelta(before,after),tuple_version_changed:Object.fromEntries(final.map(row=>[row.variant,row.tuple!==identities.find(prior=>prior.variant===row.variant).tuple])),stored_datum_bytes:Object.fromEntries(final.map(row=>[row.variant,row.stored_datum_bytes])),...measured});
    }
    report.profiles.push(profile);console.log(JSON.stringify({completed_rows:rows,read_cases:Object.keys(profile.reads).length,write_cases:profile.writes.length}));
  }
  await client.query(`CREATE TABLE ${schema}.quotas(key text PRIMARY KEY,used bigint NOT NULL CHECK(used>=0),expires_at timestamptz NOT NULL) WITH(autovacuum_enabled=false)`);
  await client.query(`INSERT INTO ${schema}.quotas SELECT 'quota-'||i,10,now()+interval '1 hour' FROM generate_series(0,4) i`);
  const quotaSQL=`INSERT INTO ${schema}.quotas(key,used,expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 second') ON CONFLICT(key) DO UPDATE SET used=CASE WHEN ${schema}.quotas.expires_at<=clock_timestamp() THEN excluded.used ELSE ${schema}.quotas.used+excluded.used END,expires_at=clock_timestamp()+$3*interval '1 second' WHERE ${schema}.quotas.expires_at<=clock_timestamp() OR ${schema}.quotas.used<=$4 RETURNING used`;
  const rejected=[];for(let repeat=-warmups;repeat<trials;repeat++){const row=await explain(quotaSQL,['quota-0',1,3600,9]);if(repeat>=0)rejected.push(row);}
  report.quota_denial.exhausted_sql=aggregate(rejected);
  const pool=new pg.Pool({connectionString:address,max:4,application_name:'predictir-local-quota-contention'});
  try{
    for(const distinctKeys of [false,true]){
      const connections=await Promise.all(Array.from({length:4},()=>pool.connect())),times=[];let accepted=0;
      try{await Promise.all(connections.map(async(connection,worker)=>{for(let repeat=0;repeat<100;repeat++){const started=performance.now(),result=await connection.query(quotaSQL,['quota-'+(distinctKeys?worker+1:0),1,3600,9]);times.push(performance.now()-started);accepted+=result.rowCount;}}));}
      finally{for(const connection of connections)connection.release();}
      report.quota_denial[distinctKeys?'four_workers_distinct_keys':'four_workers_same_key']={requests:times.length,concurrency:4,admitted:accepted,round_trip_ms:summary(times),scope:'Real rejected UPSERT round trips without a JavaScript negative cache; includes local IPC and row-lock contention.'};
    }
  }finally{await pool.end();}
  report.quota_denial.retained_counter_check=(await client.query(`SELECT count(*)::int AS keys,count(*) FILTER(WHERE used=10)::int AS unchanged_counters FROM ${schema}.quotas`)).rows[0];
}finally{
  if(schemaCreated){if(!/^query_ab_[a-f0-9]{12}$/.test(schema))throw new Error('Fixture cleanup guard failed');await client.query(`DROP SCHEMA ${schema} CASCADE`);}
  await client.end();
}
const directory=new URL('../../review/',import.meta.url);await mkdir(directory,{recursive:true});
await writeFile(new URL('query-optimization-benchmark.json',directory),JSON.stringify(report,null,2)+'\n');
const lines=[`Synthetic PostgreSQL ${report.postgresql_version} A/B benchmark: ${report.created_at}`,report.scope,`Measured trials: ${trials} per variant; warmups: ${warmups}. Variant order rotates and reverses. No cold-disk claim.`,''];
for(const profile of report.profiles){
  lines.push(`Rows: ${profile.rows}; composite indexes bytes: ${profile.storage.composite_only.index_bytes}; with extra pk index: ${profile.storage.plus_pk_index.index_bytes}`);
  for(const [name,result] of Object.entries(profile.reads))lines.push(`Read ${name}: composite p50/p95 ${result.variants.composite_only.metrics.execution_ms.p50}/${result.variants.composite_only.metrics.execution_ms.p95} ms; extra index ${result.variants.plus_pk_index.metrics.execution_ms.p50}/${result.variants.plus_pk_index.metrics.execution_ms.p95} ms`);
  for(const result of profile.writes)lines.push(`Write ${result.payload} ${result.operation}: baseline p50/p95 ${result.variants.baseline.metrics.execution_ms.p50}/${result.variants.baseline.metrics.execution_ms.p95} ms, WAL mean ${result.variants.baseline.metrics.wal_bytes.mean.toFixed(1)} bytes; DISTINCT guard ${result.variants.distinct_guard.metrics.execution_ms.p50}/${result.variants.distinct_guard.metrics.execution_ms.p95} ms, WAL mean ${result.variants.distinct_guard.metrics.wal_bytes.mean.toFixed(1)} bytes; preserve-TOAST CASE ${result.variants.preserve_toast.metrics.execution_ms.p50}/${result.variants.preserve_toast.metrics.execution_ms.p95} ms, WAL mean ${result.variants.preserve_toast.metrics.wal_bytes.mean.toFixed(1)} bytes`);
  lines.push('');
}
for(const name of ['four_workers_same_key','four_workers_distinct_keys'])lines.push(`Quota ${name}: ${report.quota_denial[name].requests} rejected requests; round-trip p50/p95 ${report.quota_denial[name].round_trip_ms.p50.toFixed(4)}/${report.quota_denial[name].round_trip_ms.p95.toFixed(4)} ms; admitted ${report.quota_denial[name].admitted}`);
await writeFile(new URL('query-optimization-benchmark.txt',directory),lines.join('\n')+'\n');
console.log(JSON.stringify({written:'review/query-optimization-benchmark.json and .txt',profiles:report.profiles.length,trials,quota_requests:800,cleanup:'Only the per-run benchmark schema was removed'}));
