import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

let serial=0;
const fresh = async()=>import(new URL('../cloud/egress-proof.mjs?test='+serial++,import.meta.url));
const env={PREDICTIR_EGRESS_PROOF_TAG:'predictir-egress-test-00000001',DATABASE_URL:'postgresql://market_lab_app.project:fixture_private_value@aws-0-us-east-2.pooler.supabase.com:5432/postgres',DATABASE_CA_CERT:'-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----'};
const row={current_user:'market_lab_app',session_user:'market_lab_app',backend_application_name:'Supavisor',read_only:true,backend_pid:17,pooler_to_pg_hop:'2001:db8::1',pooler_to_pg_tls:{ssl:true,version:'TLSv1.3'},flags:{superuser:false,create_db:false,create_role:false,replication:false,bypass_rls:false}};
function fixture({result=row,error,stall=false}={}){
  const queries=[],records=[];let ended=0,destroyed=0,config;
  const client={connection:{stream:{encrypted:true,authorized:true,getProtocol:()=>'TLSv1.3',remoteFamily:'IPv4',destroy:()=>{destroyed++;}}},
    connect:async()=>{if(error)throw error;if(stall)await new Promise(()=>{});},
    query:async sql=>{queries.push(sql);return{rows:[result]};},end:async()=>{ended++;}};
  return {client,queries,records,createClient:async value=>{config=value;return client;},get config(){return config;},get ended(){return ended;},get destroyed(){return destroyed;}};
}

test('disabled gate creates no client and startup does not await the optional probe',async()=>{
  const {runDatabaseEgressProof}=await fresh();let called=false;
  assert.equal((await runDatabaseEgressProof({env:{},createClient:()=>{called=true;}})).result,'disabled');
  assert.equal(called,false);
  const source=await readFile(new URL('../cloud/railway.mjs',import.meta.url),'utf8');
  assert.match(source,/const stop=startPipeline\(\);[\s\S]*void runDatabaseEgressProof\(\);/);
  assert.doesNotMatch(source,/await runDatabaseEgressProof/);
});

test('fresh TLS APP probe is metadata only and pooler app-name rewrite is accounted for',async()=>{
  const {runDatabaseEgressProof}=await fresh(),f=fixture();
  const result=await runDatabaseEgressProof({env,createClient:f.createClient,write:r=>f.records.push(r)});
  assert.equal(result.result,'ok');assert.equal(result.database_application_name,'Supavisor');
  assert.equal(f.config.application_name,env.PREDICTIR_EGRESS_PROOF_TAG);
  assert.equal(f.config.ssl.rejectUnauthorized,true);assert.equal(f.config.ssl.minVersion,'TLSv1.2');assert.equal(f.config.ssl.ca,env.DATABASE_CA_CERT);
  assert.equal(f.queries[0],'BEGIN READ ONLY');assert.equal(f.queries.at(-1),'ROLLBACK');
  assert.ok(f.queries[1].startsWith('SELECT clock_timestamp()'));
  assert.equal(f.records.length,1);assert.ok(f.ended>=1);assert.equal(f.destroyed,0);
  const log=JSON.stringify(f.records);
  for(const privateValue of ['fixture_private_value',env.DATABASE_URL,env.DATABASE_CA_CERT])assert.ok(!log.includes(privateValue));
  assert.equal((await runDatabaseEgressProof({env,createClient:f.createClient})).result,'already_attempted');
});

test('invalid configuration and failed auth never leak provider messages or credentials',async()=>{
  const {runDatabaseEgressProof}=await fresh(),f=fixture({error:Object.assign(new Error('fixture_private_value'),{code:'28P01'})});
  const result=await runDatabaseEgressProof({env,createClient:f.createClient,write:r=>f.records.push(r)});
  assert.equal(result.result,'failed');assert.equal(result.error_code,'28P01');assert.equal(f.records.length,1);
  assert.ok(!JSON.stringify(f.records).includes('fixture_private_value'));
  for(const extra of [{DATABASE_URL:env.DATABASE_URL+'?sslmode=disable'},{DATABASE_URL:env.DATABASE_URL.replace('aws-0-us-east-2.pooler.supabase.com','untrusted.invalid')},{DATABASE_CA_CERT:''}]){
    const instance=await fresh();let created=false;
    const invalid=await instance.runDatabaseEgressProof({env:{...env,...extra},createClient:()=>{created=true;},write:()=>{}});
    assert.equal(invalid.error_code,'INVALID_PROOF_CONNECTION');assert.equal(created,false);
  }
});

test('a stalled connection is bounded, destroys only the fresh probe socket and emits once',async()=>{
  const {runDatabaseEgressProof}=await fresh(),f=fixture({stall:true});
  const result=await runDatabaseEgressProof({env,createClient:f.createClient,write:r=>f.records.push(r),timeoutMs:25});
  assert.equal(result.result,'timeout');assert.equal(f.records.length,1);assert.ok(f.ended>=1);assert.equal(f.destroyed,1);
  assert.ok(result.duration_ms<500);assert.deepEqual(f.queries,[]);
});

test('unauthorized or downgraded TLS and unexpected IP family stop before any SQL',async()=>{
  for(const change of [stream=>{stream.authorized=false;},stream=>{stream.getProtocol=()=>'TLSv1.1';},stream=>{stream.remoteFamily='IPv6';}]){
    const {runDatabaseEgressProof}=await fresh(),f=fixture();change(f.client.connection.stream);
    const result=await runDatabaseEgressProof({env,createClient:f.createClient,write:r=>f.records.push(r)});
    assert.equal(result.result,'failed');assert.equal(result.error_code,'TLS_VERIFICATION_FAILED');assert.deepEqual(f.queries,[]);assert.ok(f.ended>=1);
  }
});

test('elevated or missing role metadata fails without issuing writes',async()=>{
  for(const flags of [{...row.flags,bypass_rls:true},{...row.flags,superuser:true},{...row.flags,create_role:undefined}]){
    const {runDatabaseEgressProof}=await fresh(),f=fixture({result:{...row,flags}});
    const result=await runDatabaseEgressProof({env,createClient:f.createClient,write:r=>f.records.push(r)});
    assert.equal(result.result,'verification_failed');assert.equal(f.records.length,1);
    assert.ok(f.queries.every(q=>! /INSERT|UPDATE|DELETE|CREATE|GRANT/.test(q)));
  }
});

test('application names fit the Postgres63-byte limit and invalid tags are not echoed',async()=>{
  const prefix='predictir-egress-',valid=prefix+'a'.repeat(46),tooLong=prefix+'a'.repeat(47);
  assert.equal(Buffer.byteLength(valid),63);
  const accepted=await fresh(),f=fixture();
  const ok=await accepted.runDatabaseEgressProof({env:{...env,PREDICTIR_EGRESS_PROOF_TAG:valid},createClient:f.createClient,write:r=>f.records.push(r)});
  assert.equal(ok.result,'ok');assert.equal(f.config.application_name,valid);
  const rejected=await fresh(),records=[];
  const invalid=await rejected.runDatabaseEgressProof({env:{...env,PREDICTIR_EGRESS_PROOF_TAG:tooLong},write:r=>records.push(r)});
  assert.equal(invalid.error_code,'INVALID_PROOF_TAG');assert.equal(records[0].tag,'invalid_tag');
  assert.ok(!JSON.stringify(records).includes(tooLong));
});
