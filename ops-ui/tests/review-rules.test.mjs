import assert from 'node:assert/strict'
import {test} from 'node:test'
import {normalizeReadings, ruleApplies, validateRule} from '../src/rules.ts'
import {parseArchive, parseReview} from '../src/reviews.ts'
import {parseSreReport} from '../src/sre.ts'

test('normalizes nested operational readings and applies only same-connector numeric rules', () => {
  const rows = normalizeReadings([
    {connector: 'api', check: 'market', status: 'pass', latency_ms: 1000, status_code: 200, sample_count: 0},
    {connector: 'api', check: 'detail', status: 'unavailable', status_code: 429},
    {connector: 'api', check: 'coverage', status: 'pass', value: '1000'},
    {connector: 'mcp', check: 'market', status: 'pass', latency_ms: 1000},
    {connector: 'azure', check: 'requests_429', status: 'pass', value: 200, unit: 'count'},
    {connector: 'azure', check: 'requests', status: 'pass', value: 900, unit: 'count'},
    {connector: 'azure', check: 'cpu_average', status: 'pass', value: 2000000, unit: 'nanocores'},
  ])
  assert.deepEqual(rows[0].timing, {latency_ms: 1000})
  assert.deepEqual(rows[0].response, {status_code: 200})
  assert.equal(rows[0].measurement.sample_count, 0)
  const latency = {connector: 'api', path: 'timing.latency_ms', comparison: 'at_least', threshold: 1000}
  assert.deepEqual(rows.filter(row => ruleApplies(latency, row)).map(row => row.check), ['market'])
  assert.equal(ruleApplies({...latency, path: 'response.status_code', threshold: 429}, rows[1]), true)
  assert.equal(ruleApplies({...latency, path: 'measurement.value'}, rows[2]), false)
  assert.equal(ruleApplies({...latency, path: 'measurement.sample_count', comparison: 'at_most', threshold: 0}, rows[0]), true)
  const throttles = {connector: 'azure', path: 'measurement.value', comparison: 'at_least', threshold: 100, metric: 'requests_429|count'}
  assert.deepEqual(rows.filter(row => ruleApplies(throttles, row)).map(row => row.check), ['requests_429'])
  assert.ok(validateRule({...throttles, threshold: '100', metric: ''}).metric)
})

test('rejects arbitrary paths and malformed thresholds', () => {
  const base = {connector: 'mcp', path: 'response.status_code', comparison: 'at_least', threshold: '400'}
  assert.deepEqual(validateRule(base), {})
  assert.ok(validateRule({...base, path: '__proto__'}).path)
  assert.ok(validateRule({...base, connector: 'arbitrary'}).connector)
  assert.ok(validateRule({...base, threshold: '399.5'}).threshold)
  assert.ok(validateRule({...base, threshold: ''}).threshold)
  assert.ok(validateRule({...base, path: 'timing.latency_ms', threshold: '-2'}).threshold)
})

test('receipt response requires a timestamp, total, and typed readings', () => {
  const summary = {id: 'c'.repeat(64), version: 1, captured_at: '2026-11-06T12:00:00Z',
    profile: 'Test review', title: 'Test review', status: 'pass', check_count: 1}
  const review = {...summary, checks: [{connector: 'api', check: 'catalog', status: 'pass', latency_ms: 0}]}
  assert.deepEqual(parseArchive({items: [summary]}), {items: [summary], source: 'local'})
  assert.deepEqual(parseArchive({items: [summary], source: 'azure-search'}), {items: [summary], source: 'azure-search'})
  assert.deepEqual(parseReview(review), review)
  assert.throws(() => parseArchive({items: [{...summary, captured_at: 'bad'}]}), /unreadable/)
  assert.throws(() => parseReview({...review, check_count: 2}), /unreadable/)
  assert.throws(() => parseReview({...review, checks: [{...review.checks[0], latency_ms: '0'}]}), /unreadable/)
})

test('validates SRE outcomes and preserves the difference between missing and zero usage', () => {
  const report = {
    findings: [{kind: 'throttle_cause', certainty: 'observed', source: 'retained_log',
      summary: 'A known limit was reached.', recommendation: 'Review the calling pattern.', count: 1}],
    usage: [{resource: 'daily_work', unit: 'work_units', scope: 'application_allowance', used: 0, limit: 5, percent: 0}],
    usage_as_of: null,
    operator_activity: {paused: null, reused: 0},
    limitations: ['Counters describe the current process.'],
  }
  assert.deepEqual(parseSreReport(report), report)
  assert.throws(() => parseSreReport({...report, operator_activity: {paused: -1, reused: 0}}), /unreadable/)
  assert.throws(() => parseSreReport({...report, findings: [{...report.findings[0], certainty: 'inferred'}]}), /unreadable/)
})
