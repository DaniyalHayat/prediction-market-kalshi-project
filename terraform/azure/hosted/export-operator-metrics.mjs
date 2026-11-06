import {execFile} from 'node:child_process';
import {parseArgs, promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const runFile = promisify(execFile);
const armOrigin = 'https://management.azure.com';
const appNamespace = 'Microsoft.App/containerApps';
const minute = 60_000;
const interval = 'PT1M';
const maximumResponseBytes = 2 * 1024 * 1024;
const subscriptionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const statuses = new Set(['Progressing', 'Running', 'Stopped', 'Suspended', 'Ready']);
const azureArgs = ['account', 'get-access-token', '--resource-type', 'arm', '--only-show-errors', '--output', 'json'];
const usage = 'node terraform/azure/hosted/export-operator-metrics.mjs --resource-group GROUP --prefix PREFIX [--hours 1–24]';

async function cliAccess() {
  const options = {timeout: 12_000, maxBuffer: 64 * 1024, windowsHide: true};
  try {
    const {stdout} = process.platform === 'win32'
      ? await runFile('cmd.exe', ['/d', '/s', '/c', 'az ' + azureArgs.join(' ')], options)
      : await runFile('az', azureArgs, options);
    return JSON.parse(stdout);
  } catch {
    throw new Error('Azure CLI sign-in or ARM access is unavailable. Verify the active Azure subscription.');
  }
}

async function readArm(fetcher, token, path, parameters) {
  const url = new URL(path, armOrigin);
  url.search = new URLSearchParams(parameters);
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: {Authorization: 'Bearer ' + token, Accept: 'application/json'},
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || Number(response.headers.get('content-length')) > maximumResponseBytes) {
      await response.body?.cancel();
      return null;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body || []) {
      length += chunk.byteLength;
      if (length > maximumResponseBytes) return null;
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    return null;
  }
}

function seriesFor(packet, name) {
  if (packet?.interval !== interval || !Array.isArray(packet.value)) return null;
  const metric = packet.value.find(entry => entry?.name?.value === name);
  return (!metric?.errorCode || metric.errorCode === 'Success') && Array.isArray(metric?.timeseries)
    ? metric.timeseries : null;
}

function minutePoints(series, field, start, end) {
  const points = new Map();
  if (!Array.isArray(series?.data)) return points;
  for (const point of series.data) {
    const timestamp = Date.parse(point?.timeStamp);
    const value = point?.[field];
    if (!(timestamp >= start && timestamp < end && timestamp % minute === 0)) continue;
    if (!Number.isFinite(value) || value < 0 || (field === 'total' && !Number.isSafeInteger(value))) continue;
    if (points.has(timestamp)) return new Map();
    points.set(timestamp, value);
  }
  return points;
}

function observedAverage(packet, name, start, end) {
  const series = seriesFor(packet, name);
  const points = series?.length === 1 ? minutePoints(series[0], 'average', start, end) : new Map();
  let average = 0;
  let count = 0;
  for (const value of points.values()) average += (value - average) / ++count;
  return {average: count ? average : null, count};
}

function groupedCounts(packet, dimension, allowed, start, end) {
  const series = seriesFor(packet, 'Requests');
  if (!series) return null;
  const groups = new Map();
  for (const row of series) {
    if (!Array.isArray(row?.metadatavalues)) return null;
    const labels = row.metadatavalues.filter(label =>
      typeof label?.name?.value === 'string' && label.name.value.toLowerCase() === dimension);
    const name = labels.length === 1 ? labels[0].value : null;
    if (typeof name !== 'string' || !allowed.test(name) || groups.has(name.toLowerCase())) return null;
    groups.set(name.toLowerCase(), minutePoints(row, 'total', start, end));
  }
  return groups;
}

function groupSum(groups, timestamp) {
  let count = 0;
  for (const group of groups.values()) count += group.get(timestamp) ?? 0;
  return count;
}

function requestCounts(packet, byStatus, byClientStatus, start, end) {
  const totals = seriesFor(packet, 'Requests');
  const points = totals?.length === 1 ? minutePoints(totals[0], 'total', start, end) : new Map();
  const categories = groupedCounts(byStatus, 'statuscodecategory', /^[0-5]xx$/i, start, end);
  const clientCodes = groupedCounts(byClientStatus, 'statuscode', /^4[0-9]{2}$/, start, end);
  let requests = 0;
  let errors = 0;
  let limited = 0;
  let peakLimited = 0;
  let peakAt = null;
  let reconciled = 0;
  let reconciledClient = 0;
  for (const [timestamp, total] of points) {
    requests += total;
    if (!categories || groupSum(categories, timestamp) !== total) continue;
    errors += categories.get('5xx')?.get(timestamp) ?? 0;
    reconciled++;
    const clientErrors = categories.get('4xx')?.get(timestamp) ?? 0;
    if (clientErrors > 0 && (!clientCodes || groupSum(clientCodes, timestamp) !== clientErrors)) continue;
    const bucketLimited = clientErrors > 0 ? clientCodes.get('429')?.get(timestamp) ?? 0 : 0;
    limited += bucketLimited;
    if (bucketLimited > peakLimited || (bucketLimited > 0 && bucketLimited === peakLimited && timestamp < peakAt)) {
      peakLimited = bucketLimited;
      peakAt = timestamp;
    }
    reconciledClient++;
  }
  const clientStatusKnown = reconciledClient > 0 && reconciledClient === points.size && Number.isSafeInteger(limited);
  return {
    requests: points.size && Number.isSafeInteger(requests) ? requests : null,
    errors_5xx: reconciled && reconciled === points.size && Number.isSafeInteger(errors) ? errors : null,
    requests_429: clientStatusKnown ? limited : null,
    requests_429_peak_per_minute: clientStatusKnown ? peakLimited : null,
    requests_429_peak_at: clientStatusKnown && peakAt !== null ? new Date(peakAt).toISOString() : null,
    coverage: {requests: points.size, errors_5xx: reconciled, requests_429: reconciledClient},
  };
}

function revision(value, name) {
  return typeof value === 'string' && value.startsWith(name + '--') &&
    /^[a-z0-9-]{1,96}$/.test(value) ? value : null;
}

export async function collectOperatorMetrics({resourceGroup, prefix, hours = 1}, {
  getAccess = cliAccess, fetcher = fetch, now = Date.now(),
} = {}) {
  if (typeof resourceGroup !== 'string' || !/^[a-zA-Z0-9_().-]{1,90}$/.test(resourceGroup) || resourceGroup.endsWith('.') ||
      typeof prefix !== 'string' || !/^[a-z][a-z0-9]{2,17}$/.test(prefix) ||
      !Number.isInteger(hours) || hours < 1 || hours > 24 || !Number.isFinite(now)) {
    throw new Error('Supply an existing Azure resource group, a Predictir name prefix, and 1 to 24 whole hours.');
  }
  const {subscription, accessToken} = await getAccess();
  if (typeof subscription !== 'string' || !subscriptionPattern.test(subscription) ||
      typeof accessToken !== 'string' || !/^[A-Za-z0-9._~+/=-]{32,16384}$/.test(accessToken)) {
    throw new Error('The active Azure CLI session did not provide a valid ARM credential.');
  }
  const end = Math.floor(now / minute) * minute - 2 * minute;
  const start = end - hours * 60 * minute;
  const window = {
    start: new Date(start).toISOString(), end: new Date(end).toISOString(),
    hours, interval, expected_points: hours * 60,
  };
  const metricParameters = {
    'api-version': '2023-10-01', metricnamespace: appNamespace,
    timespan: window.start + '/' + window.end, interval,
  };
  const get = (path, parameters) => readArm(fetcher, accessToken, path, parameters);
  const apps = await Promise.all(['front', 'backend'].map(async role => {
    const name = prefix + '-' + role;
    const path = '/subscriptions/' + subscription + '/resourceGroups/' + encodeURIComponent(resourceGroup) +
      '/providers/' + appNamespace + '/' + name;
    const metrics = path + '/providers/Microsoft.Insights/metrics';
    const [app, totals, breakdown, clientBreakdown, utilization] = await Promise.all([
      get(path, {'api-version': '2025-07-01'}),
      get(metrics, {...metricParameters, metricnames: 'Requests', aggregation: 'Total'}),
      get(metrics, {...metricParameters, metricnames: 'Requests', aggregation: 'Total', $filter: "statusCodeCategory eq '*'", top: 10}),
      get(metrics, {...metricParameters, metricnames: 'Requests', aggregation: 'Total',
        $filter: "statusCodeCategory eq '4xx' and statusCode eq '*'", top: 100}),
      get(metrics, {...metricParameters, metricnames: 'UsageNanoCores,WorkingSetBytes,Replicas', aggregation: 'Average'}),
    ]);
    const {coverage, ...requests} = requestCounts(totals, breakdown, clientBreakdown, start, end);
    const cpu = observedAverage(utilization, 'UsageNanoCores', start, end);
    const memory = observedAverage(utilization, 'WorkingSetBytes', start, end);
    const replicas = observedAverage(utilization, 'Replicas', start, end);
    const details = app?.name === name ? app.properties : null;
    const unavailable = [];
    if (!details) unavailable.push('app_status');
    if (requests.requests === null) unavailable.push('requests');
    if (requests.errors_5xx === null) unavailable.push('status_breakdown');
    if (requests.requests_429 === null) unavailable.push('client_status_breakdown');
    if (cpu.average === null || memory.average === null || replicas.average === null) unavailable.push('utilization');
    return {
      name, role,
      latest_revision: revision(details?.latestRevisionName, name),
      ready_revision: revision(details?.latestReadyRevisionName, name),
      running_status: statuses.has(details?.runningStatus) ? details.runningStatus : null,
      external_ingress: typeof details?.configuration?.ingress?.external === 'boolean'
        ? details.configuration.ingress.external : null,
      ...requests,
      cpu_nanocores_avg: cpu.average, memory_bytes_avg: memory.average, replicas_avg: replicas.average,
      coverage: {...coverage, cpu_nanocores_avg: cpu.count, memory_bytes_avg: memory.count, replicas_avg: replicas.count},
      unavailable,
    };
  }));
  return {azure: {schema_version: 1, collected_at: new Date(now).toISOString(), window, apps}};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let flags;
  try {
    flags = parseArgs({options: {
      'resource-group': {type: 'string'}, prefix: {type: 'string'},
      hours: {type: 'string', default: '1'}, help: {type: 'boolean'},
    }}).values;
    if (flags.help) console.log(usage);
    else {
      const snapshot = await collectOperatorMetrics({
        resourceGroup: flags['resource-group'], prefix: flags.prefix,
        hours: /^\d{1,2}$/.test(flags.hours) ? Number(flags.hours) : NaN,
      });
      process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    }
  } catch (error) {
    console.error(flags ? error.message : usage);
    process.exitCode = 1;
  }
}
