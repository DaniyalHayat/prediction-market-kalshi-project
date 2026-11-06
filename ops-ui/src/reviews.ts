export const checks = ['runtime', 'azure', 'http', 'mcp'] as const
export type Check = typeof checks[number]

const readingStatuses = ['pass', 'fail', 'unavailable'] as const
export type ReadingStatus = typeof readingStatuses[number]

export type Reading = {
  connector: string
  check: string
  status: ReadingStatus
  latency_ms?: number
  status_code?: number
  sample_count?: number
  value?: number | string | null
  unit?: string
  dimension?: string
}

export type ReviewSummary = {
  id: string
  version: string | number
  captured_at: string
  title: string
  profile: string
  status: string
  check_count: number
}

export type Review = ReviewSummary & {checks: Reading[]}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSummary(value: unknown): value is ReviewSummary {
  return isObject(value) && typeof value.id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value.id) &&
    (typeof value.version === 'number' || typeof value.version === 'string') &&
    typeof value.captured_at === 'string' && Number.isFinite(Date.parse(value.captured_at)) &&
    typeof value.title === 'string' && typeof value.profile === 'string' &&
    typeof value.status === 'string' && isCount(value.check_count)
}

function isReading(value: unknown): value is Reading {
  if (!isObject(value) || typeof value.connector !== 'string' || typeof value.check !== 'string' ||
    !readingStatuses.some(status => value.status === status)) return false
  for (const key of ['status_code', 'sample_count']) {
    if (value[key] !== undefined && !isCount(value[key])) return false
  }
  if (value.latency_ms !== undefined &&
    (typeof value.latency_ms !== 'number' || !Number.isFinite(value.latency_ms) || value.latency_ms < 0)) return false
  if (value.value != null && typeof value.value !== 'string' &&
    (typeof value.value !== 'number' || !Number.isFinite(value.value))) return false
  return ['unit', 'dimension'].every(key => value[key] === undefined || typeof value[key] === 'string')
}

export function parseReview(value: unknown): Review {
  if (!isSummary(value) || !('checks' in value) || !Array.isArray(value.checks) ||
    !value.checks.every(isReading) || value.check_count !== value.checks.length) {
    throw new Error('The server returned an unreadable review.')
  }
  return {...value, checks: value.checks}
}

export function parseArchive(value: unknown): ReviewSummary[] {
  if (!isObject(value) || !Array.isArray(value.items) || !value.items.every(isSummary)) {
    throw new Error('The server returned an unreadable archive.')
  }
  return value.items
}

export async function readOperatorJson(path: string, token: string, signal: AbortSignal, body?: object): Promise<unknown> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ...(body ? {'Content-Type': 'application/json'} : {}),
    },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    body: body ? JSON.stringify(body) : undefined,
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('Operator access was denied. Check the token and try again.')
  }
  if (response.status === 404) throw new Error('That review is unavailable. Refresh the archive and try again.')
  if (response.status === 429) throw new Error('Wait a few seconds before capturing another review.')
  if (response.status === 507) throw new Error('The local evidence archive has reached its capacity.')
  if (!response.ok) throw new Error('The review service could not complete the request.')
  if (!(response.headers.get('content-type') || '').includes('application/json')) {
    throw new Error('The review service did not return JSON.')
  }
  return response.json()
}
