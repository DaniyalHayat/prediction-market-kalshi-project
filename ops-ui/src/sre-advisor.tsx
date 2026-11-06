import {useEffect, useState} from 'react'
import {Badge, Button, Spinner} from '@fluentui/react-components'
import {capturedDate} from './grids'
import {readOperatorJson} from './reviews'
import {parseSreReport, type SreFinding, type SreReport, type SreUsage} from './sre'

const sources: Record<string, string> = {
  retained_log: 'Retained log sample',
  process_counter: 'Process-lifetime counter',
  azure_monitor: 'Azure Monitor',
  process_samples: 'Process samples',
  operator_probe: 'Operator probe',
  private_allowances: 'Private allowance snapshot',
}
const units: Record<string, string> = {ms: 'ms', bytes: 'bytes', work_units: 'work units', percent: '%'}
const labels: Record<string, string> = {
  stream_minutes: 'Stream time',
  stream_egress_bytes: 'Stream egress',
  archive_bytes: 'Archive storage',
  assistant_milliusd: 'Assistant budget',
  x_post_reads: 'X post reads',
  daily_work: 'Daily application work',
  daily_cpu_ms: 'Daily CPU time',
  azure_foundry_calls_day: 'Azure Foundry daily calls',
  azure_foundry_calls_month: 'Azure Foundry monthly calls',
}
const quantity = new Intl.NumberFormat(undefined, {maximumFractionDigits: 2})
const currency = new Intl.NumberFormat(undefined, {style: 'currency', currency: 'USD', maximumFractionDigits: 3})
const label = (value: string) => value.replaceAll('_', ' ')
const formatted = (value: number, unit?: string) => unit === 'milliusd' ? currency.format(value / 1000) :
  quantity.format(value) + (unit ? ' ' + (units[unit] ?? label(unit)) : '')

function Finding({item}: {item: SreFinding}) {
  const status = item.status_code ?? item.status_family
  const details = [
    sources[item.source] ?? label(item.source),
    item.layer === 'front' ? 'Frontend' : item.layer === 'backend' ? 'Backend' : undefined,
    status ? 'HTTP ' + status : undefined,
    item.count === undefined ? undefined : quantity.format(item.count) + ' observations',
    item.value === undefined ? undefined : formatted(item.value, item.unit),
  ].filter(Boolean)
  return <li className="sre-finding">
    <div className="sre-finding-meta">
      <Badge shape="rounded" appearance="tint" color={item.certainty === 'observed' ? 'informative' : 'warning'}>
        {item.certainty === 'observed' ? 'Observed evidence' : 'Cause unverified'}
      </Badge>
      <small>{details.join(' · ')}</small>
    </div>
    <p className="sre-summary">{item.summary}</p>
    {(item.route || item.reason || item.dimension || item.resource) &&
      <small className="sre-detail">{[item.route, item.reason && label(item.reason), item.dimension,
        item.resource && (labels[item.resource] ?? label(item.resource))].filter(Boolean).join(' · ')}</small>}
    <p><strong>Suggested next step</strong> {item.recommendation}</p>
  </li>
}

function Usage({row}: {row: SreUsage}) {
  return <div>
    <dt>{labels[row.resource] ?? label(row.resource)}</dt>
    <dd>{formatted(row.used, row.unit)} of {formatted(row.limit, row.unit)}
      {row.percent !== null && ' · ' + quantity.format(row.percent) + '%'}</dd>
    <dd className="sre-detail">{row.scope === 'assistant_reservation' ? 'Assistant reservation' : 'Application allowance'}</dd>
  </div>
}

type Load = {report: SreReport; error?: never} | {report?: never; error: string}

export function SreAdvisor({id, token}: {id: string; token: string}) {
  const [load, setLoad] = useState<Load>()
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const path = '/api/sre?' + new URLSearchParams({review: id})
    void readOperatorJson(path, token, controller.signal).then(parseSreReport).then(report => {
      if (!controller.signal.aborted) setLoad({report})
    }).catch(() => {
      if (!controller.signal.aborted) setLoad({error: 'SRE assessment unavailable. The review evidence is still accessible.'})
    })
    return () => controller.abort()
  }, [id, token, refresh])

  const report = load?.report
  const activity = report?.operator_activity
  return <section className="surface" aria-labelledby="sre-title">
    <div className="eyebrow">Diagnose</div>
    <div className="sre-header">
      <h2 id="sre-title">SRE advisor</h2>
      <Button size="small" appearance="outline" disabled={!load} onClick={() => {
        setLoad(undefined)
        setRefresh(value => value + 1)
      }}>Refresh assessment</Button>
    </div>
    {!load && <Spinner size="tiny" label="Assessing the selected review…" />}
    {load?.error && <p className="failure" role="status">{load.error}</p>}
    {report && <div className="sre-report">
      {report.findings.length > 0 ? <ul className="sre-findings" aria-label="Reliability findings">
        {report.findings.map((item, index) => <Finding key={item.kind + ':' + index} item={item} />)}
      </ul> : <p className="empty">The available evidence did not identify an issue to investigate.</p>}
      <div className="sre-section">
        <h3>Usage and allowances</h3>
        {report.usage_as_of && <p className="sre-detail">Captured <time dateTime={report.usage_as_of}>
          {capturedDate(report.usage_as_of)}</time></p>}
        {report.usage.length > 0 ? <dl className="sre-measures">
          {report.usage.map(row => <Usage key={row.resource} row={row} />)}
        </dl> : <p className="sre-detail">Usage is unavailable for this assessment.</p>}
      </div>
      {activity && <div className="sre-section">
        <h3>Automatic operator actions</h3>
        <dl className="sre-measures">
          <div><dt>Optional probes paused</dt><dd>{activity.paused === null ? 'Unavailable' : quantity.format(activity.paused)}</dd>
            <dd className="sre-detail">Repeats skipped while a throttle delay was active.</dd></div>
          <div><dt>Observations reused</dt><dd>{activity.reused === null ? 'Unavailable' : quantity.format(activity.reused)}</dd>
            <dd className="sre-detail">Recent successful probe results reused.</dd></div>
        </dl>
      </div>}
      {report.limitations.length > 0 && <details className="sre-limits">
        <summary>Evidence limits</summary>
        <ul>{report.limitations.map(item => <li key={item}>{item}</li>)}</ul>
      </details>}
    </div>}
  </section>
}
