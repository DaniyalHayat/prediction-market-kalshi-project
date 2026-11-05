import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectPostgresQueries} from '../tools/inspect_postgres_queries.mjs';

test('query inspection is read-only, parameterizes the role and tolerates unavailable statistics without leaking error details',async()=>{
  const calls=[],role="runtime-role' OR 1=1 --",client={query:async(sql,values=[])=>{
    calls.push({sql,values});
    if(sql.includes("c.relname='pg_stat_statements'"))return {rows:[{schema:'extensions'}]};
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

test('an unexpected statistics schema is never interpolated as SQL',async()=>{
  const calls=[],client={query:async sql=>{calls.push(sql);return {rows:sql.includes("c.relname='pg_stat_statements'")?[{schema:'invalid";DROP SCHEMA market_lab CASCADE;--'}]:[]};}};
  const output=await inspectPostgresQueries(client);
  assert.equal(output.queries.statement_stats,undefined);assert.ok(calls.every(sql=>!sql.includes('DROP')));assert.equal(calls.at(-1),'ROLLBACK');
});
