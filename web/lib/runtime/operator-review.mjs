import {readJSON} from '../transport.mjs';
import {buildOperatorReport} from './operator.mjs';

export const reviewChecks = ['runtime', 'azure', 'http', 'mcp'];
export const reviewName = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,46}[A-Za-z0-9]$/;

export function parseReviewProfile(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== 2 ||
      typeof input.name !== 'string' || !reviewName.test(input.name) ||
      !Array.isArray(input.checks) || !input.checks.length ||
      new Set(input.checks).size !== input.checks.length || input.checks.some(check => !reviewChecks.includes(check))) {
    throw new RangeError('Use a 3–48 character profile name and one or more available checks.');
  }
  return {name: input.name, checks: reviewChecks.filter(check => input.checks.includes(check))};
}

function reading(connector, check, status, fields = {}) {
  return {connector, check, status, ...fields};
}

function observed(connector, check, dimension, value, unit, status = 'pass', sampleCount) {
  return Number.isFinite(value) && value >= 0 ? reading(connector, check, status, {
    dimension, value, unit, ...(Number.isSafeInteger(sampleCount) && sampleCount >= 0 ? {sample_count: sampleCount} : {}),
  }) :
    reading(connector, check, 'unavailable', {dimension});
}

export function azureReadings(snapshot, stamp) {
  const azure = snapshot?.azure;
  const age = (stamp - Date.parse(azure?.collected_at)) / 60_000;
  if (azure?.schema_version !== 1 || !Array.isArray(azure.apps) || !(age >= -1 && age <= 30)) {
    return [reading('azure', 'metrics_snapshot', 'unavailable')];
  }
  const checks = [observed('azure', 'snapshot_age', 'monitor', Math.max(0, age), 'minutes')];
  for (const role of ['front', 'backend']) {
    const app = azure.apps.find(row => row?.role === role);
    const ready = typeof app?.latest_revision === 'string' && typeof app.ready_revision === 'string';
    const ingress = typeof app?.external_ingress === 'boolean';
    checks.push(reading('azure', 'revision_ready', !ready ? 'unavailable' :
      app.latest_revision === app.ready_revision && app.running_status === 'Running' ? 'pass' : 'fail', {dimension: role}));
    if (ingress) checks.push(reading('azure', 'expected_ingress', app.external_ingress === (role === 'front') ? 'pass' : 'fail', {dimension: role}));
    checks.push(
      observed('azure', 'requests', role, app?.requests, 'count', 'pass', app?.coverage?.requests),
      observed('azure', 'requests_5xx', role, app?.errors_5xx, 'count', app?.errors_5xx > 0 ? 'fail' : 'pass', app?.coverage?.errors_5xx),
      observed('azure', 'requests_429', role, app?.requests_429, 'count', 'pass', app?.coverage?.requests_429),
      observed('azure', 'requests_429_peak', role, app?.requests_429_peak_per_minute, 'count'),
      observed('azure', 'cpu_average', role, app?.cpu_nanocores_avg, 'nanocores', 'pass', app?.coverage?.cpu_nanocores_avg),
      observed('azure', 'memory_average', role, app?.memory_bytes_avg, 'bytes', 'pass', app?.coverage?.memory_bytes_avg),
      observed('azure', 'replicas_average', role, app?.replicas_avg, 'replicas', 'pass', app?.coverage?.replicas_avg),
    );
  }
  return checks;
}

export function runtimeReadings(snapshot) {
  const report = buildOperatorReport(snapshot ?? {});
  const entries = Object.entries(report.percentiles.distributions)
    .sort(([left, a], [right, b]) => (b.window_count ?? 0) - (a.window_count ?? 0) || left.localeCompare(right))
    .slice(0, 8);
  if (!entries.length) return [reading('runtime', 'runtime_snapshot', 'unavailable')];
  const checks = entries.flatMap(([dimension, row]) => [
    observed('runtime', 'p95', dimension, row.p95_ms, 'ms', 'pass', row.window_count),
    observed('runtime', 'p99', dimension, row.p99_ms, 'ms', 'pass', row.window_count),
    observed('runtime', 'sample_count', dimension, row.window_count, 'count'),
  ]);
  const throttles = (Array.isArray(snapshot?.logs) ? snapshot.logs : []).slice(-1000)
    .filter(row => row?.event === 'request.finished' && row.status === 429);
  checks.push(observed('runtime', 'retained_throttles', 'retained_log_window', throttles.length, 'count'));
  for (const route of ['/api/workspace/evidence', '/api/workspace/graphql', '/api/workspace/execution-research', '/api/workspace/recommendations']) {
    const count = throttles.filter(row => row.route === route).length;
    if (count) checks.push(observed('runtime', 'retained_throttles', route, count, 'count'));
  }
  return checks;
}

function publicOrigin(input) {
  if (!input) return null;
  const url = new URL(input);
  if (url.origin !== input || url.protocol !== 'https:' || url.port ||
      !/^[a-z0-9-]+-front\.[a-z0-9-]+\.[a-z0-9-]+\.azurecontainerapps\.io$/.test(url.hostname)) {
    throw new TypeError('Set OPERATOR_APP_ORIGIN to the public Predictir Azure Container Apps origin.');
  }
  return url.origin;
}

async function readText(response, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error('Response exceeded the check limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createOperatorReview({origin, readSnapshot, readAzure, fetcher = fetch, now = Date.now} = {}) {
  const target = publicOrigin(origin);

  async function probe(connector, check, path, verify, {signal, body, maximum = 131072} = {}) {
    if (!target) return {check: reading(connector, check, 'unavailable')};
    const start = performance.now();
    let statusCode;
    try {
      const response = await fetcher(new URL(path, target), {
        method: body ? 'POST' : 'GET',
        headers: body ? {'Content-Type': 'application/json', Origin: target, 'Sec-Fetch-Site': 'same-origin'} : {Accept: 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        redirect: 'error',
      });
      statusCode = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        return {check: reading(connector, check, statusCode === 429 || statusCode === 403 ? 'unavailable' : 'fail',
          {status_code: statusCode, latency_ms: Math.round(performance.now() - start)})};
      }
      const packet = body ? await readText(response, maximum) : (await readJSON(response, {maximumBytes: maximum})).data;
      return {check: reading(connector, check, verify(packet, response.headers) ? 'pass' : 'fail',
        {status_code: statusCode, latency_ms: Math.round(performance.now() - start)}), packet};
    } catch {
      return {check: reading(connector, check, statusCode ? 'fail' : 'unavailable',
        {status_code: statusCode, latency_ms: Math.round(performance.now() - start)})};
    }
  }

  async function mcpCheck(signal) {
    const markets = await probe('mcp', 'open_contract', '/api/workspace/markets?category=sports',
      value => value.category === 'sports' && Array.isArray(value.markets), {signal, maximum: 3 * 1024 * 1024});
    if (markets.check.status !== 'pass') return [markets.check];
    const market = markets.packet.markets.find(row => /^[A-Za-z0-9_.-]{1,140}$/.test(row?.ticker || '') &&
      ['open', 'active'].includes(row.status) && Date.parse(row.close_time) > now() + 120_000);
    if (!market) return [reading('mcp', 'open_contract', 'unavailable')];
    const coverage = await probe('mcp', 'source_status', '/api/assistant', (answer, headers) =>
      /Warehouse coverage:/i.test(answer) && headers.get('content-type')?.startsWith('text/plain') &&
      ['MCP In-Process', 'MCP Streamable HTTP'].includes(headers.get('x-research-transport')) &&
      headers.get('x-research-model') === 'azure-deterministic',
    {signal, body: {ticker: market.ticker, messages: [{role: 'user', content: 'What is the provider and warehouse coverage?'}]}});
    return [markets.check, coverage.check];
  }

  return async function runReview(input, {signal} = {}) {
    const profile = parseReviewProfile(input);
    const captured_at = new Date(now()).toISOString();
    const tasks = {
      runtime: async () => runtimeReadings(await readSnapshot?.()),
      azure: async () => azureReadings(await readAzure?.(), now()),
      http: async () => {
        const results = await Promise.all([
          probe('api', 'health', '/api/health', value => value.status === 'ok' && value.runtime === 'Azure Container Apps', {signal}),
          probe('api', 'catalog', '/api/workspace/catalog', value => Array.isArray(value.categories) && value.categories.length >= 8, {signal}),
        ]);
        return results.map(result => result.check);
      },
      mcp: () => mcpCheck(signal),
    };
    const groups = await Promise.all(profile.checks.map(async key => {
      try { return await tasks[key](); }
      catch { return [reading(key === 'http' ? 'api' : key, 'connector_read', 'unavailable')]; }
    }));
    signal?.throwIfAborted();
    return {profile: profile.name, captured_at, checks: groups.flat()};
  };
}
