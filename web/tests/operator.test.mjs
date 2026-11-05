import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {buildOperatorReport, createOperatorServer} from '../lib/runtime/operator.mjs';

test('operator report uses safe evidence, labels hypotheses and disables execution', () => {
  const report = buildOperatorReport({telemetry: {distributions: {'provider:kalshi': {count: 100, window_count: 100, p99_ms: 900, secret: 'PRIVATE'}}}, logs: [
    {event: 'request.failed', level: 'error', status: 500, body: 'PRIVATE', pool_waiting: 2, trace_id: 'a'.repeat(32)}]});
  assert.equal(report.change_execution, 'disabled'); assert.equal(report.proposals.length, 2);
  assert.ok(report.proposals.every(row => row.approval_required)); assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});

test('operator surface requires separate bearer access and rejects writes, cross-origin and DNS rebinding hosts', async t => {
  const token = 'operator-test-only-'.repeat(3), server = createOperatorServer({token, readSnapshot: async () => ({})});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port, headers = {Authorization: 'Bearer ' + token};
  assert.equal((await fetch(url + '/api/report')).status, 401);
  assert.equal((await fetch(url + '/api/report', {headers})).status, 200);
  assert.equal((await fetch(url + '/api/report', {method: 'POST', headers})).status, 405);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = request(url + '/api/report', {headers: {...headers, Host: 'attacker.example'}}, response => { response.resume(); resolve(response.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(url + '/api/report', {headers: {...headers, Origin: 'https://attacker.example'}})).status, 403);
  assert.equal((await fetch(url + '/api/apply', {headers})).status, 404);
});
