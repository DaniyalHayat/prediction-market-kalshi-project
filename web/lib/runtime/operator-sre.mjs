const causes = new Map([
  ['throttle_heavy_burst', ['The shared expensive-route burst limit rejected this request.',
    'Space out optional research calls and coalesce duplicate client requests.']],
  ['throttle_general_admission', ['The general application admission limiter rejected this request.',
    'Check client retry intervals and request concurrency before adjusting limits.']],
  ['throttle_runtime_disabled', ['The runtime disabled application work.',
    'Inspect the service cost-control state and backend health before re-enabling work.']],
  ['throttle_daily_work', ['The daily application work allowance was reached.',
    'Review work-unit usage and defer optional research until the allowance resets.']],
  ['throttle_assistant_allowance', ['An assistant allowance rejected this request.',
    'Check the assistant allowance and reuse existing results before requesting another answer.']],
  ['throttle_stream_capacity', ['The stream connection capacity limit was reached.',
    'Consolidate duplicate subscriptions and check for clients that leave connections open.']],
  ['throttle_stream_allowance', ['A streaming usage allowance was reached.',
    'Check stream minutes and egress usage before starting new streams.']],
]);
const unknownReason = 'throttle_upstream_or_unclassified';
const routes = new Set([
  '/api/health', '/api/session', '/api/account/login', '/api/account/logout', '/api/account/profile',
  '/api/account/portfolio', '/api/book', '/api/market', '/api/markets', '/api/trades', '/api/history',
  '/api/stream', '/api/portfolio/stream', '/api/journal', '/api/paper/size', '/api/assistant',
  '/api/workspace/catalog', '/api/workspace/markets', '/api/workspace/portfolio-books', '/api/workspace/context',
  '/api/workspace/history', '/api/workspace/graphql', '/api/workspace/research', '/api/workspace/execution-research',
  '/api/workspace/position-review', '/api/workspace/opinions', '/api/workspace/recommendations',
  '/api/workspace/search', '/api/workspace/evidence', '/api/workspace/evidence/search',
  '/internal/diagnostics', '/internal/assistant/reserve', '/internal/assistant/reserve-azure',
  '/internal/assistant/read-azure', '/internal/assistant/settle', '/mcp',
]);
const providers = new Set(['kalshi', 'espn', 'apple_music', 'x', 'spotify', 'reddit', 'kworb',
  'supabase_auth', 'postgres', 'foundry']);
const usageFields = new Map([
  ['stream_minutes', ['minutes', 'application_allowance']],
  ['stream_egress_bytes', ['bytes', 'application_allowance']],
  ['archive_bytes', ['bytes', 'application_allowance']],
  ['assistant_milliusd', ['milliusd', 'assistant_reservation']],
  ['x_post_reads', ['reads', 'application_allowance']],
  ['daily_work', ['work_units', 'application_allowance']],
  ['daily_cpu_ms', ['ms', 'application_allowance']],
  ['azure_foundry_calls_day', ['calls', 'assistant_reservation']],
  ['azure_foundry_calls_month', ['calls', 'assistant_reservation']],
]);
const recentWindowMs = 60 * 60 * 1000;
const knownRoute = route => routes.has(route) ? route : 'other';
const count = value => Number.isSafeInteger(value) && value >= 0;
const bounded = (rows, maximum) => Array.isArray(rows) ? rows.slice(-maximum) : [];

function throttleFindings(logs, requestThrottles, now) {
  const counters = new Map();
  const logged = new Map();
  const ids = new Set();
  for (const [inputRoute, counts] of Object.entries(requestThrottles ?? {}).slice(0, 80)) {
    if ((!routes.has(inputRoute) && inputRoute !== 'other') || !counts || typeof counts !== 'object') continue;
    const route = inputRoute;
    for (const reason of [...causes.keys(), unknownReason]) {
      if (!count(counts[reason]) || counts[reason] === 0) continue;
      const key = route + '\0' + reason;
      const previous = counters.get(key)?.count ?? 0;
      counters.set(key, {route, reason, count: Math.min(Number.MAX_SAFE_INTEGER, previous + counts[reason]), source: 'process_counter'});
    }
  }
  for (const row of bounded(logs, 1000)) {
    const stamp = typeof row?.time === 'string' ? Date.parse(row.time) : NaN;
    if (row?.event !== 'request.finished' || row.status !== 429 || !(stamp <= now && stamp >= now - recentWindowMs)) continue;
    if (/^[a-f0-9]{32}$/.test(row.trace_id ?? '') && /^[a-f0-9]{16}$/.test(row.span_id ?? '')) {
      const id = row.trace_id + row.span_id;
      if (ids.has(id)) continue;
      ids.add(id);
    }
    const route = knownRoute(row.route), reason = causes.has(row.error_code) ? row.error_code : unknownReason;
    const key = route + '\0' + reason;
    if (counters.has(key)) continue;
    const previous = logged.get(key)?.count ?? 0;
    logged.set(key, {route, reason, count: previous + 1, source: 'retained_log'});
  }
  return [...counters.values(), ...logged.values()]
    .sort((a, b) => Number(causes.has(b.reason)) - Number(causes.has(a.reason)) || b.count - a.count ||
      a.route.localeCompare(b.route) || a.reason.localeCompare(b.reason))
    .slice(0, 12)
    .map(fields => {
      const cause = causes.get(fields.reason);
      return {kind: 'throttle_cause', certainty: cause ? 'observed' : 'unattributed', status_code: 429, ...fields,
        summary: cause?.[0] ?? 'The app observed HTTP 429 without a verified limiter reason.',
        recommendation: cause?.[1] ?? 'Correlate the request with backend and upstream telemetry before assigning a cause.'};
    });
}

function checkFindings(checks) {
  const results = [];
  for (const role of ['front', 'backend']) {
    for (const [check, status] of [['requests_429', 429], ['requests_5xx', 500]]) {
      const row = checks.find(input => input?.connector === 'azure' && input.check === check && input.dimension === role &&
        input.unit === 'count' && input.status !== 'unavailable' && count(input.value) && input.value > 0);
      if (!row) continue;
      results.push({kind: 'azure_status_count', certainty: 'unattributed', source: 'azure_monitor',
        layer: role, count: row.value, ...(status === 429 ? {status_code: status} : {status_family: '5xx'}),
        summary: status === 429 ? 'Azure Monitor counted throttled responses for this layer.' :
          'Azure Monitor counted server-error responses for this layer.',
        recommendation: 'Check reason-coded records in the same interval. Azure layer totals can describe the same proxied request.'});
    }
  }
  const response = checks.find(row => row?.connector === 'mcp' && row.check === 'source_status' && row.status_code === 429);
  if (response) results.push({kind: 'mcp_probe_throttled', certainty: 'unattributed', source: 'operator_probe',
    route: '/api/assistant', status_code: 429,
    summary: 'The optional MCP source-status probe received HTTP 429.',
    recommendation: 'Leave the public API checks running and wait before trying another optional probe.'});
  const slow = checks.filter(row => {
    if (row?.connector !== 'runtime' || row.check !== 'p99' || row.unit !== 'ms' ||
        !Number.isFinite(row.value) || row.value < 1000 || !count(row.sample_count) || row.sample_count < 100 ||
        typeof row.dimension !== 'string') return false;
    return row.dimension.startsWith('request:') && routes.has(row.dimension.slice(8)) ||
      row.dimension.startsWith('provider:') && providers.has(row.dimension.slice(9));
  }).sort((a, b) => b.value - a.value).slice(0, 3);
  for (const row of slow) results.push({kind: 'runtime_tail_latency', certainty: 'observed', source: 'process_samples',
    dimension: row.dimension, value: row.value, unit: 'ms', count: row.sample_count,
    summary: 'The process-local p99 exceeded the one-second review threshold.',
    recommendation: 'Compare latency with dependency timings and cache behavior before changing capacity.'});
  return results;
}

function measuredUsage(input) {
  const records = bounded(Array.isArray(input) ? input : input?.allowances, 32);
  const result = [];
  for (const [resource, [unit, scope]] of usageFields) {
    const value = records.find(row => row?.resource === resource && count(row.used) && count(row.limit));
    if (!value) continue;
    const {used, limit} = value;
    result.push({resource, unit, scope, used, limit,
      percent: limit > 0 ? Math.round((100 * used / limit) * 10) / 10 : null});
  }
  return result;
}

export function assessOperatorSre({checks, logs, requestThrottles, allowances, activity, now = Date.now()} = {}) {
  const usage = measuredUsage(allowances);
  const usageStamp = typeof allowances?.as_of === 'string' ? Date.parse(allowances.as_of) : NaN;
  const usage_as_of = Number.isFinite(usageStamp) && usageStamp <= now ? new Date(usageStamp).toISOString() : null;
  const operator_activity = {
    paused: count(activity?.paused) ? activity.paused : null,
    reused: count(activity?.reused) ? activity.reused : null,
  };
  const findings = [
    ...throttleFindings(logs, requestThrottles, now),
    ...checkFindings(bounded(checks, 60)),
    ...usage.filter(row => row.percent !== null && row.percent >= 80).map(row => ({
      kind: 'allowance_pressure', certainty: 'observed', source: 'private_allowances', resource: row.resource,
      value: row.percent, unit: 'percent',
      summary: row.percent >= 100 ? 'The recorded application allowance is exhausted.' :
        'The recorded application allowance is at or above 80%.',
      recommendation: 'Defer optional calls and review the recorded usage before increasing the allowance.',
    })),
  ];
  return {findings, usage, usage_as_of, operator_activity, limitations: [
    'Retained log counts cover at most the most recent hour. Process counters reset on restart and cover a different interval from Azure Monitor.',
    'An explicit reason identifies the rejecting application guard for the observed records. Aggregate counts alone cannot identify traffic intent or an earlier cause.',
    'Application allowances and assistant reservations do not measure provider-billed tokens or invoices.',
  ]};
}

export function operatorProbeBackoff({check, status, retryAfter, now = Date.now()} = {}) {
  if (check !== 'source_status' || status !== 429 || !Number.isSafeInteger(now) || now < 0) return null;
  const raw = typeof retryAfter === 'string' && retryAfter.length <= 64 ? retryAfter.trim() : '';
  let seconds = 30;
  if (/^\d+$/.test(raw)) seconds = Number(raw);
  else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d\d:\d\d:\d\d GMT$/.test(raw)) {
    const date = Date.parse(raw);
    if (Number.isFinite(date)) seconds = Math.ceil((date - now) / 1000);
  }
  seconds = Math.min(86400, Math.max(1, seconds));
  if (!Number.isSafeInteger(now + seconds * 1000)) return null;
  return {check, until: now + seconds * 1000, seconds, reason: 'optional_mcp_throttled'};
}
