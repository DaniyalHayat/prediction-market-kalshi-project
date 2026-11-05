import {createHash} from 'node:crypto';

const numeric = new Set(['status', 'duration_ms', 'attempts', 'pool_waiting', 'pool_total', 'pool_idle', 'open_streams', 'event_loop_p99_ms', 'heap_mb', 'rss_mb']);
const identifiers = new Set(['trace_id', 'span_id', 'parent_id']);
const safeLabels = new Set(['route', 'provider', 'error_code', 'result', 'method']);
const levels = new Set(['debug', 'info', 'warn', 'error']);

export function sanitizeOperationalRecord(event, fields = {}, level = 'info') {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(event) || !levels.has(level)) throw new RangeError('Invalid operational log');
  const record = {time: new Date().toISOString(), event, level};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'baggage_dropped' && typeof value === 'boolean') record[key] = value;
    if (numeric.has(key) && Number.isFinite(value) && value >= 0) record[key] = value;
    if (identifiers.has(key) && typeof value === 'string' && new RegExp(`^[a-f0-9]{${key === 'trace_id' ? 32 : 16}}$`).test(value)) record[key] = value;
    if (safeLabels.has(key) && typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,80}$/.test(value)) record[key] = value;
  }
  return record;
}

export function createLogPipeline({write = line => process.stdout.write(line + '\n'), successSampleRate = .02, normalPerMinute = 480, errorsPerMinute = 120, clock = Date.now} = {}) {
  if (!(successSampleRate >= 0 && successSampleRate <= 1) || !Number.isInteger(normalPerMinute) || normalPerMinute < 1 || !Number.isInteger(errorsPerMinute) || errorsPerMinute < 1) throw new RangeError('Invalid log budget');
  let minute = -1, normal = 0, errors = 0, written = 0, sampled = 0, throttled = 0;
  return {
    log(event, fields = {}, level = 'info') {
      const record = sanitizeOperationalRecord(event, fields, level), nowMinute = Math.floor(clock() / 60000);
      if (nowMinute !== minute) { minute = nowMinute; normal = 0; errors = 0; }
      const important = level === 'error' || level === 'warn' || record.status >= 500;
      if (!important) {
        const key = fields.trace_id || `${event}:${written + sampled + throttled}`;
        const fraction = createHash('sha256').update(key).digest().readUInt32BE(0) / 0x100000000;
        if (fraction >= successSampleRate) { sampled++; return false; }
      }
      if (important ? errors >= errorsPerMinute : normal >= normalPerMinute) { throttled++; return false; }
      if (important) errors++; else normal++;
      write(JSON.stringify(record)); written++; return true;
    },
    snapshot() { return {written, sampled_out: sampled, throttled, normal_per_minute: normalPerMinute, errors_per_minute: errorsPerMinute}; }
  };
}
