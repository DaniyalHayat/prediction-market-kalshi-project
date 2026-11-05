import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPostgresQueries} from '../tools/inspect_postgres_queries.mjs';

test('query inspection is read-only, parameterizes the role and tolerates unavailable statistics without leaking error details',async()=>{
  const calls=[],role="runtime-role' OR 1=1 --",client={query:async(sql,values=[])=>{
    calls.push({sql,values});
    if(sql.includes("c.relname='pg_stat_statements'"))return {rows:[{schema:'extensions',schema_usage:true,table_select:true}]};
    if(sql.includes('FROM "extensions".pg_stat_statements WHERE'))throw Object.assign(new Error('PRIVATE_CONNECTION_SENTINEL'),{code:'42501'});
    return {rows:[]};
  }};
  const output=await inspectPostgresQueries(client,{role});
  assert.equal(calls[0].sql,'BEGIN READ ONLY');assert.equal(calls.at(-1).sql,'ROLLBACK');
  assert.ok(calls.every(({sql})=>/^(SELECT|BEGIN READ ONLY|SET LOCAL|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK)/.test(sql)));
  assert.ok(calls.every(({sql})=>!sql.includes(role)));
  assert.deepEqual(calls.find(({sql})=>sql.includes('rolname=$1')).values,[role]);
  assert.deepEqual(output.queries.statement_stats,{unavailable:'42501'});
  assert.ok(calls.some(({sql})=>sql==='ROLLBACK TO SAVEPOINT query_inspection'));
  assert.ok(!JSON.stringify(output).includes('PRIVATE_CONNECTION_SENTINEL'));
});

test('restricted inspection skips known unauthorized statistics queries instead of generating permission errors',async()=>{
  for(const access of [{schema_usage:false,table_select:true},{schema_usage:true,table_select:false}]){
    const calls=[],client={query:async sql=>{
      calls.push(sql);
      if(sql.includes("c.relname='pg_stat_statements'"))return {rows:[{schema:'extensions',...access}]};
      if(sql.includes("c.relname='pg_stat_statements_info'"))return {rows:[{schema:'extensions',...access}]};
      if(sql.includes('FROM "extensions".'))throw new Error('A forbidden query must never be attempted');
      return {rows:[]};
    }};
    const output=await inspectPostgresQueries(client);
    assert.deepEqual(output.queries.statement_stats,{unavailable:'insufficient_existing_privileges',...access});
    assert.equal(output.queries.statement_stats_window.unavailable,'insufficient_existing_privileges');
    assert.ok(calls.every(sql=>!sql.includes('FROM "extensions".')));
    assert.equal(calls.at(-1),'ROLLBACK');
  }
});

test('the statistics reset view has its own privilege check',async()=>{
  const calls=[],client={query:async sql=>{
    calls.push(sql);
    if(sql.includes("c.relname='pg_stat_statements'"))return {rows:[{schema:'extensions',schema_usage:true,table_select:true}]};
    if(sql.includes("c.relname='pg_stat_statements_info'"))return {rows:[{schema:'extensions',schema_usage:true,table_select:false}]};
    return {rows:[]};
  }};
  const output=await inspectPostgresQueries(client);
  assert.deepEqual(output.queries.statement_stats,[]);
  assert.equal(output.queries.statement_stats_window.unavailable,'insufficient_existing_privileges');
  assert.ok(calls.every(sql=>!sql.includes('FROM "extensions".pg_stat_statements_info')));
});

test('an unexpected statistics schema is never interpolated as SQL',async()=>{
  const calls=[],client={query:async sql=>{calls.push(sql);return {rows:sql.includes("c.relname='pg_stat_statements'")?[{schema:'invalid";DROP SCHEMA market_lab CASCADE;--'}]:[]};}};
  const output=await inspectPostgresQueries(client);
  assert.equal(output.queries.statement_stats,undefined);assert.ok(calls.every(sql=>!sql.includes('DROP')));assert.equal(calls.at(-1),'ROLLBACK');
});
