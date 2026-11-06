import assert from 'node:assert/strict';
import test from 'node:test';
import {assessOperatorSre, operatorProbeBackoff} from '../lib/runtime/operator-sre.mjs';

const now = Date.parse('2026-11-06T11:30:00Z');
const route = '/api/workspace/graphql';
const event = {event: 'request.finished', time: new Date(now - 1).toISOString(), status: 429, route};
const countCheck = (check, dimension, value) => ({connector: 'azure', check, dimension, value, unit: 'count', status: 'pass'});

test('only an explicit reason establishes the rejecting guard for the observed requests', () => {
  const tagged = {...event, error_code: 'throttle_heavy_burst', trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16)};
  const result = assessOperatorSre({
    checks: [countCheck('requests_429', 'front', 118), countCheck('requests_429', 'backend', 118),
      countCheck('requests_5xx', 'front', 5)],
    logs: [tagged, {...tagged},
      {...event, route: '/api/secret/customer-key', error_code: 'sensitive-unrecognized-code', body: 'RAW_TOKEN'},
      {...event, time: new Date(now - 7200000).toISOString(), error_code: 'throttle_general_admission'},
      {...event, time: new Date(now + 10).toISOString(), error_code: 'throttle_daily_work'},
      {...event, event: 'log.injection', error_code: 'throttle_assistant_allowance'}],
    now,
  });
  const guard = result.findings.find(row => row.reason === 'throttle_heavy_burst');
  assert.deepEqual([guard.certainty, guard.count, guard.route, guard.source], ['observed', 1, route, 'retained_log']);
  assert.equal(result.findings.filter(row => row.certainty === 'observed').length, 1);
  assert.equal(result.findings.find(row => row.reason === 'throttle_upstream_or_unclassified').certainty, 'unattributed');
  const platform = result.findings.filter(row => row.source === 'azure_monitor');
  assert.deepEqual(platform.map(row => [row.layer, row.count, row.certainty]), [
    ['front', 118, 'unattributed'], ['front', 5, 'unattributed'], ['backend', 118, 'unattributed'],
  ]);
  assert.equal(platform[1].status_family, '5xx');
  assert.equal(platform[1].status_code, undefined);
  assert.doesNotMatch(JSON.stringify(result), /customer-key|RAW_TOKEN|sensitive-unrecognized-code|aaaaaaaa/);
});

test('process counters replace matching retained records without inventing counts for absent rows', () => {
  const result = assessOperatorSre({
    requestThrottles: {[route]: {throttle_heavy_burst: 13, throttle_general_admission: 0, arbitrary: 9000},
      '/private/:name': {throttle_daily_work: 200}},
    logs: [{...event, error_code: 'throttle_heavy_burst'}, {...event, error_code: 'throttle_stream_capacity'}],
    now,
  });
  assert.deepEqual(result.findings.map(row => [row.reason, row.source, row.count]), [
    ['throttle_heavy_burst', 'process_counter', 13], ['throttle_stream_capacity', 'retained_log', 1],
  ]);
});

test('usage alerts describe recorded budgets and reservations, with no implied provider tokens', () => {
  const result = assessOperatorSre({
    allowances: {scope: 'untrusted text', as_of: new Date(now - 1000).toISOString(), allowances: [
      {resource: 'assistant_milliusd', used: 820, limit: 1000},
      {resource: 'daily_work', used: 2, limit: 4},
      {resource: 'daily_cpu_ms', used: 0, limit: 0},
      {resource: 'azure_foundry_calls_day', used: 2, limit: 2},
      {resource: 'made_up_billed_tokens', used: 1000, limit: 2000},
    ]},
    checks: [{connector: 'runtime', check: 'p99', value: 1200, sample_count: 200, dimension: 'provider:kalshi', unit: 'ms'},
      {connector: 'runtime', check: 'p99', value: 1400, sample_count: 12, dimension: 'provider:espn', unit: 'ms'}],
    activity: {paused: 2, reused: -1, untrusted: 'raw'},
    now,
  });
  assert.deepEqual(result.usage.map(row => [row.resource, row.scope, row.percent]), [
    ['assistant_milliusd', 'assistant_reservation', 82], ['daily_work', 'application_allowance', 50],
    ['daily_cpu_ms', 'application_allowance', null], ['azure_foundry_calls_day', 'assistant_reservation', 100],
  ]);
  assert.deepEqual(result.findings.map(row => row.kind), ['runtime_tail_latency', 'allowance_pressure', 'allowance_pressure']);
  assert.equal(result.usage_as_of, new Date(now - 1000).toISOString());
  assert.deepEqual(result.operator_activity, {paused: 2, reused: null});
  assert.match(result.limitations.join(' '), /do not measure provider-billed tokens/);
  assert.doesNotMatch(JSON.stringify(result), /made_up_billed_tokens|untrusted text/);
});

test('only a throttled optional MCP probe can request a finite local cooldown', () => {
  const input = {check: 'source_status', status: 429, now};
  assert.deepEqual(operatorProbeBackoff({...input, retryAfter: '17'}), {
    check: 'source_status', until: now + 17000, seconds: 17, reason: 'optional_mcp_throttled',
  });
  assert.equal(operatorProbeBackoff({...input, retryAfter: new Date(now + 9000).toUTCString()}).seconds, 9);
  assert.equal(operatorProbeBackoff({...input, retryAfter: 'invalid'}).seconds, 30);
  assert.equal(operatorProbeBackoff({...input, retryAfter: '100000'}).seconds, 86400);
  assert.equal(operatorProbeBackoff({...input, retryAfter: '0'}).seconds, 1);
  assert.equal(operatorProbeBackoff({...input, check: 'health'}), null);
  assert.equal(operatorProbeBackoff({...input, status: 503}), null);
});
