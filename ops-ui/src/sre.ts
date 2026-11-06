export type SreFinding = {
  kind: string
  certainty: 'observed' | 'unattributed'
  source: string
  summary: string
  recommendation: string
  count?: number
  value?: number
  unit?: string
  route?: string
  reason?: string
  layer?: string
  dimension?: string
  resource?: string
  status_code?: number
  status_family?: string
}

export type SreUsage = {
  resource: string
  unit: string
  scope: 'application_allowance' | 'assistant_reservation'
  used: number
  limit: number
  percent: number | null
}

export type SreReport = {
  findings: SreFinding[]
  usage: SreUsage[]
  usage_as_of: string | null
  operator_activity: {paused: number | null; reused: number | null}
  limitations: string[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500

function finding(value: unknown): value is SreFinding {
  if (!record(value) || (value.certainty !== 'observed' && value.certainty !== 'unattributed')) return false
  return ['kind', 'source', 'summary', 'recommendation'].every(key => text(value[key])) &&
    ['unit', 'route', 'reason', 'layer', 'dimension', 'resource', 'status_family'].every(key =>
      value[key] === undefined || text(value[key])) &&
    ['count', 'status_code'].every(key => value[key] === undefined || count(value[key])) &&
    (value.value === undefined || finite(value.value))
}

function usage(value: unknown): value is SreUsage {
  return record(value) && text(value.resource) && text(value.unit) &&
    (value.scope === 'application_allowance' || value.scope === 'assistant_reservation') &&
    count(value.used) && count(value.limit) && (value.percent === null || finite(value.percent))
}

export function parseSreReport(value: unknown): SreReport {
  if (record(value) && Array.isArray(value.findings) && value.findings.length <= 60 && value.findings.every(finding) &&
    Array.isArray(value.usage) && value.usage.length <= 32 && value.usage.every(usage) &&
    (value.usage_as_of === null || typeof value.usage_as_of === 'string' && Number.isFinite(Date.parse(value.usage_as_of))) &&
    record(value.operator_activity) && (value.operator_activity.paused === null || count(value.operator_activity.paused)) &&
    (value.operator_activity.reused === null || count(value.operator_activity.reused)) &&
    Array.isArray(value.limitations) && value.limitations.length <= 16 && value.limitations.every(text)) {
    return {
      findings: value.findings, usage: value.usage, usage_as_of: value.usage_as_of,
      operator_activity: {paused: value.operator_activity.paused, reused: value.operator_activity.reused},
      limitations: value.limitations,
    }
  }
  throw new Error('The server returned an unreadable SRE assessment.')
}
