import type {Reading} from './reviews'

export const numericFields = {
  'timing.latency_ms': 'Latency (ms)',
  'response.status_code': 'HTTP status',
  'measurement.sample_count': 'Sample count',
  'measurement.value': 'Numeric value',
} as const
export type NumericPath = keyof typeof numericFields
export const connectors = ['mcp', 'api', 'azure', 'runtime'] as const
export type Connector = typeof connectors[number]
export type RuleInput = {
  connector: Connector
  path: NumericPath
  comparison: 'at_least' | 'at_most'
  threshold: string
  metric?: string
}
export type Rule = Omit<RuleInput, 'threshold'> & {threshold: number}

export type ReviewRow = {
  id: string
  connector: string
  check: string
  status: Reading['status']
  timing: {latency_ms?: number}
  response: {status_code?: number}
  measurement: {value?: number | string | null; unit?: string; sample_count?: number; dimension?: string}
}

export function normalizeReadings(readings: Reading[]): ReviewRow[] {
  return readings.map((reading, index) => ({
    id: String(index),
    connector: reading.connector,
    check: reading.check,
    status: reading.status,
    timing: {latency_ms: reading.latency_ms},
    response: {status_code: reading.status_code},
    measurement: {
      value: reading.value,
      unit: reading.unit,
      sample_count: reading.sample_count,
      dimension: reading.dimension,
    },
  }))
}

const numericValue: Record<NumericPath, (row: ReviewRow) => unknown> = {
  'timing.latency_ms': row => row.timing.latency_ms,
  'response.status_code': row => row.response.status_code,
  'measurement.sample_count': row => row.measurement.sample_count,
  'measurement.value': row => row.measurement.value,
}

export function ruleApplies(rule: Rule, row: ReviewRow): boolean {
  if (row.connector !== rule.connector) return false
  if (rule.path === 'measurement.value' && (!rule.metric || rule.metric !== measurementKey(row.check, row.measurement.unit))) return false
  const value = numericValue[rule.path](row)
  return typeof value === 'number' && Number.isFinite(value) &&
    (rule.comparison === 'at_least' ? value >= rule.threshold : value <= rule.threshold)
}

export function describeRule(rule: Rule): string {
  const name = rule.path === 'measurement.value' && rule.metric ? measurementLabel(rule.metric) : numericFields[rule.path]
  return name + (rule.comparison === 'at_least' ? ' at least ' : ' at most ') + rule.threshold
}

export const measurementKey = (check: string, unit?: string) => check + '|' + (unit ?? '')

export function measurementLabel(key: string): string {
  const [check, unit] = key.split('|')
  return check.replaceAll('_', ' ') + (unit ? ' (' + unit + ')' : '')
}

export function validateRule(values: RuleInput): Partial<Record<keyof RuleInput, string>> {
  const errors: Partial<Record<keyof RuleInput, string>> = {}
  if (!connectors.includes(values.connector)) errors.connector = 'Choose a known connector.'
  if (!Object.hasOwn(numericFields, values.path)) errors.path = 'Choose a numeric field.'
  if (values.path === 'measurement.value' && !/^[a-z][a-z0-9_-]{0,63}\|(?:count|ms|bytes|nanocores|percent|replicas|minutes)$/.test(values.metric ?? '')) {
    errors.metric = 'Choose a measurement and unit from the current review.'
  }
  if (values.comparison !== 'at_least' && values.comparison !== 'at_most') errors.comparison = 'Choose a comparison.'
  const threshold = Number(values.threshold)
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(values.threshold) || !Number.isFinite(threshold) || Math.abs(threshold) > 1e12) {
    errors.threshold = 'Enter a decimal between −1 trillion and 1 trillion.'
  } else if (values.path === 'response.status_code' && (!Number.isInteger(threshold) || threshold < 100 || threshold > 599)) {
    errors.threshold = 'Enter a whole HTTP status from 100 to 599.'
  } else if (values.path === 'measurement.sample_count' && (!Number.isInteger(threshold) || threshold < 0)) {
    errors.threshold = 'Enter a nonnegative whole sample count.'
  } else if (values.path === 'timing.latency_ms' && threshold < 0) {
    errors.threshold = 'Enter a nonnegative latency.'
  }
  return errors
}
