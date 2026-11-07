const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const THROTTLE_REASONS = new Set([
  'throttle_heavy_burst',
  'throttle_general_admission',
  'throttle_runtime_disabled',
  'throttle_daily_work',
  'throttle_assistant_allowance',
  'throttle_stream_capacity',
  'throttle_stream_allowance',
]);
export function throttleReason(reason) {
  return THROTTLE_REASONS.has(reason) ? reason : 'throttle_upstream_or_unclassified';
}

class Distribution {
  constructor(sampleSize) {
    this.samples = new Float64Array(sampleSize); this.count = 0; this.sum = 0;
    this.buckets = BUCKETS.map(() => 0);
  }
  observe(value) {
    if (!Number.isFinite(value) || value < 0) return false;
    this.samples[this.count % this.samples.length] = value; this.count++; this.sum += value;
    for (let i = 0; i < BUCKETS.length; i++) if (value <= BUCKETS[i]) this.buckets[i]++;
    return true;
  }
  snapshot() {
    const values = Array.from(this.samples.subarray(0, Math.min(this.count, this.samples.length))).sort((a, b) => a - b);
    const percentile = fraction => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
    return {count: this.count, sum_ms: this.sum, window_count: values.length, p95_ms: percentile(.95), p99_ms: percentile(.99)};
  }
}

export function createRuntimeTelemetry({routes = [], providers = [], sampleSize = 4096} = {}) {
  if (!Number.isInteger(sampleSize) || sampleSize < 100 || sampleSize > 65536) throw new RangeError('sampleSize must be 100..65536');
  if (routes.length > 64 || providers.length > 32) throw new RangeError('Too many telemetry dimensions');
  const sanitize = values => new Set(values.filter(value => typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,80}$/.test(value)));
  const allowedRoutes = sanitize(routes), allowedProviders = sanitize(providers), distributions = new Map(), errors = new Map();
  const requestThrottles = new Map();
  function observe(kind, input, durationMs, failed) {
    const allow = kind === 'request' ? allowedRoutes : allowedProviders, label = allow.has(input) ? input : 'other', key = `${kind}:${label}`;
    if (!distributions.has(key)) distributions.set(key, new Distribution(sampleSize));
    if (!distributions.get(key).observe(durationMs)) return false;
    if (failed) errors.set(key, (errors.get(key) || 0) + 1);
    return true;
  }
  return {
    observeRequest({route, durationMs, status, errorCode}) {
      const recorded = observe('request', route, durationMs, status >= 500);
      if (recorded && status === 429) {
        const label = allowedRoutes.has(route) ? route : 'other', reason = throttleReason(errorCode);
        if (!requestThrottles.has(label)) requestThrottles.set(label, new Map());
        const counts = requestThrottles.get(label);
        counts.set(reason, (counts.get(reason) || 0) + 1);
      }
      return recorded;
    },
    observeProvider({provider, durationMs, failed = false}) { return observe('provider', provider, durationMs, failed); },
    snapshot() {
      return {quantile_scope: 'last bounded samples per process, not a fleet percentile', sample_capacity: sampleSize,
        request_throttles_scope: 'process lifetime, resets on restart',
        request_throttles: Object.fromEntries([...requestThrottles].map(([route, counts]) => [route, Object.fromEntries(counts)])),
        distributions: Object.fromEntries([...distributions].map(([key, value]) => [key, {...value.snapshot(), errors: errors.get(key) || 0}]))};
    },
    prometheus() {
      const rows = ['# HELP marketlab_duration_ms Duration in milliseconds.', '# TYPE marketlab_duration_ms histogram'];
      for (const [key, value] of distributions) {
        const colon = key.indexOf(':'), labels = `kind="${key.slice(0, colon)}",name="${key.slice(colon + 1)}"`;
        BUCKETS.forEach((bound, i) => rows.push(`marketlab_duration_ms_bucket{${labels},le="${bound}"} ${value.buckets[i]}`));
        rows.push(`marketlab_duration_ms_bucket{${labels},le="+Inf"} ${value.count}`, `marketlab_duration_ms_count{${labels}} ${value.count}`, `marketlab_duration_ms_sum{${labels}} ${value.sum}`);
      }
      rows.push('# TYPE marketlab_errors_total counter');
      for (const [key, count] of errors) {
        const colon = key.indexOf(':'); rows.push(`marketlab_errors_total{kind="${key.slice(0, colon)}",name="${key.slice(colon + 1)}"} ${count}`);
      }
      rows.push('# HELP marketlab_request_throttles_total Backend HTTP 429 responses by reason.', '# TYPE marketlab_request_throttles_total counter');
      for (const [route, counts] of requestThrottles) {
        for (const [reason, count] of counts) rows.push(`marketlab_request_throttles_total{route="${route}",reason="${reason}"} ${count}`);
      }
      return rows.join('\n') + '\n';
    }
  };
}

const operationalRoutes = new Set([
  '/api/health', '/api/session', '/api/account/login', '/api/account/logout', '/api/account/profile', '/api/account/portfolio',
  '/api/book', '/api/market', '/api/markets', '/api/trades', '/api/history', '/api/brief', '/api/fees', '/api/resolve',
  '/api/stream', '/api/portfolio/stream', '/api/journal', '/api/paper/size', '/api/export.xlsx',
  '/api/workspace/catalog', '/api/workspace/markets', '/api/workspace/portfolio-books', '/api/workspace/context',
  '/api/workspace/history', '/api/workspace/graphql', '/api/workspace/research', '/api/workspace/execution-research',
  '/api/workspace/opinions', '/api/workspace/recommendations', '/api/workspace/position-review', '/api/workspace/search',
  '/api/workspace/sources', '/api/workspace/attribution', '/api/workspace/evidence', '/api/workspace/evidence/search',
  '/api/intelligence', '/api/intelligence/catalog', '/api/intelligence/series', '/api/intelligence/candles',
  '/api/intelligence/execution', '/api/intelligence/forward', '/api/intelligence/forward/start', '/api/intelligence/forward/checkpoint',
  '/mcp', '/internal/diagnostics', '/internal/assistant/reserve', '/internal/assistant/reserve-azure',
  '/internal/assistant/read-azure', '/internal/assistant/settle',
]);
export function operationalRoute(path) {
  return operationalRoutes.has(path) ? path : 'other';
}
export const runtimeTelemetry = createRuntimeTelemetry({routes: [...operationalRoutes],
  providers: ['kalshi', 'espn', 'apple_music', 'x', 'spotify', 'reddit', 'kworb', 'federal_reserve', 'nhc', 'hacker_news', 'supabase_auth', 'postgres']});

export async function observeProviderAttempt(provider, run, telemetry = runtimeTelemetry) {
  const started = performance.now(); let failed = true;
  try { const result = await run(); failed = Boolean(result?.error || result?.ok === false); return result; }
  finally { telemetry.observeProvider({provider, durationMs: performance.now() - started, failed}); }
}
