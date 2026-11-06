import assert from 'node:assert/strict';
import test from 'node:test';
import {collectOperatorMetrics} from '../export-operator-metrics.mjs';

const subscription = '00000000-1111-2222-3333-444444444444';
const accessToken = 'test-credential-kept-out-of-metrics'.repeat(2);
const getAccess = async () => ({subscription, accessToken});
const now = Date.parse('2026-11-06T11:00:42Z');
const first = '2026-11-06T09:58:00Z';
const second = '2026-11-06T09:59:00Z';
const inputs = {resourceGroup: 'fixture-rg', prefix: 'predictir', hours: 1};
const points = (values, field) => values.map(([timeStamp, value]) => ({timeStamp, [field]: value}));
const series = (values, field = 'total', dimensions = {}) => ({
  metadatavalues: Object.entries(dimensions).map(([name, value]) => ({name: {value: name}, value})),
  data: points(values, field),
});
const metric = (name, timeseries) => ({name: {value: name}, timeseries});
const packet = (...value) => Response.json({interval: 'PT1M', value});
const summarize = fetcher => collectOperatorMetrics(inputs, {getAccess, fetcher, now});

test('Azure inventory and observed metrics are read-only, reconciled, and credential-free', async () => {
  const calls = [];
  const result = await summarize(async (url, options) => {
    calls.push(url);
    assert.equal(url.origin, 'https://management.azure.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + accessToken);
    assert.ok(options.signal instanceof AbortSignal);
    if (!url.pathname.endsWith('/metrics')) {
      const name = url.pathname.split('/').at(-1);
      return Response.json({name, id: subscription, properties: {
        latestRevisionName: name + '--0000002', latestReadyRevisionName: name + '--0000001',
        runningStatus: 'Running', configuration: {secrets: [accessToken], ingress: {external: name.endsWith('-front')}},
      }});
    }
    assert.equal(url.searchParams.get('timespan'), '2026-11-06T09:58:00.000Z/2026-11-06T10:58:00.000Z');
    if (url.searchParams.get('aggregation') === 'Average') {
      return packet(
        metric('UsageNanoCores', [series([[first, 1e8], [second, 2e8]], 'average')]),
        metric('WorkingSetBytes', [series([[first, 6000]], 'average')]),
        metric('Replicas', [series([[first, 1], [second, 2]], 'average')]),
      );
    }
    const filter = url.searchParams.get('$filter');
    if (filter?.includes('statusCode eq')) return packet(metric('Requests', [
      series([[first, 2]], 'total', {statuscodecategory: '4xx', statuscode: '429'}),
      series([[first, 1]], 'total', {statuscodecategory: '4xx', statuscode: '404'}),
    ]));
    if (filter) return packet(metric('Requests', [
      series([[first, 4], [second, 6]], 'total', {statuscodecategory: '2xx'}),
      series([[first, 3]], 'total', {statuscodecategory: '4xx'}),
      series([[first, 1]], 'total', {statuscodecategory: '5xx'}),
    ]));
    return packet(metric('Requests', [series([
      [first, 8], [second, 6], ['2026-11-06T10:58:00Z', 800], ['2026-11-06T09:57:00Z', 800],
    ])]));
  });
  assert.equal(calls.length, 10);
  assert.equal(result.azure.window.expected_points, 60);
  assert.equal(result.azure.apps.length, 2);
  for (const row of result.azure.apps) {
    assert.equal(row.running_status, 'Running');
    assert.equal(row.external_ingress, row.role === 'front');
    assert.notEqual(row.latest_revision, row.ready_revision);
    assert.equal(row.requests, 14);
    assert.equal(row.errors_5xx, 1);
    assert.equal(row.requests_429, 2);
    assert.equal(row.requests_429_peak_per_minute, 2);
    assert.equal(row.requests_429_peak_at, '2026-11-06T09:58:00.000Z');
    assert.equal(row.cpu_nanocores_avg, 1.5e8);
    assert.equal(row.memory_bytes_avg, 6000);
    assert.equal(row.replicas_avg, 1.5);
    assert.deepEqual(row.coverage, {
      requests: 2, errors_5xx: 2, requests_429: 2, cpu_nanocores_avg: 2, memory_bytes_avg: 1, replicas_avg: 2,
    });
    assert.deepEqual(row.unavailable, []);
  }
  assert.ok(!JSON.stringify(result).includes(accessToken));
  assert.ok(!JSON.stringify(result).includes(subscription));
});

test('missing, mismatched, and split zero counts remain distinguishable', async () => {
  const {azure} = await summarize(async url => {
    const back = url.pathname.includes('predictir-backend');
    const filter = url.searchParams.get('$filter');
    if (!url.pathname.endsWith('/metrics') || url.searchParams.get('aggregation') === 'Average') {
      return Response.json({error: {message: 'PRIVATE'}}, {status: 403});
    }
    if (filter?.includes('statusCode eq')) return packet(metric('Requests', []));
    if (filter) return packet(metric('Requests', [
      series([[first, back ? 3 : 5]], 'total', {statusCodeCategory: '2xx'}),
      series([[first, back ? 0 : 1]], 'total', {statusCodeCategory: '4xx'}),
    ]));
    return packet(metric('Requests', [series([[first, back ? 3 : 6], [second, null]])]));
  });
  const [front, back] = azure.apps;
  assert.equal(front.requests, 6);
  assert.equal(front.errors_5xx, 0);
  assert.equal(front.requests_429, null);
  assert.equal(front.requests_429_peak_per_minute, null);
  assert.equal(front.requests_429_peak_at, null);
  assert.equal(front.coverage.requests_429, 0);
  assert.ok(front.unavailable.includes('client_status_breakdown'));
  assert.equal(front.cpu_nanocores_avg, null);
  assert.equal(front.coverage.cpu_nanocores_avg, 0);
  assert.equal(back.errors_5xx, 0);
  assert.equal(back.requests_429, 0);
  assert.equal(back.requests_429_peak_per_minute, 0);
  assert.equal(back.requests_429_peak_at, null);
  assert.equal(back.coverage.requests, 1);
  assert.equal(back.coverage.requests_429, 1);
  assert.ok(!JSON.stringify(azure).includes('PRIVATE'));
});

test('invalid scope never authenticates and a partial status rollup cannot become a zero', async () => {
  let credentials = 0;
  const access = async () => { credentials++; return getAccess(); };
  for (const bad of [{hours: 25}, {resourceGroup: '../unsafe'}, {prefix: 'https://anything'}]) {
    await assert.rejects(collectOperatorMetrics({...inputs, ...bad}, {getAccess: access, now}), /existing Azure resource group/);
  }
  assert.equal(credentials, 0);
  const {azure} = await summarize(async url => {
    if (url.searchParams.get('aggregation') !== 'Total') throw new Error('PRIVATE');
    if (url.searchParams.has('$filter')) return packet(metric('Requests', [
      series([[first, 8]], 'total', {statuscodecategory: '2xx'}),
    ]));
    return packet(metric('Requests', [series([[first, 10]])]));
  });
  for (const app of azure.apps) {
    assert.equal(app.requests, 10);
    assert.equal(app.errors_5xx, null);
    assert.equal(app.requests_429, null);
    assert.deepEqual(app.unavailable, ['app_status', 'status_breakdown', 'client_status_breakdown', 'utilization']);
  }
});
