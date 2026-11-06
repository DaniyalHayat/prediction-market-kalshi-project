import {useCallback, useMemo, useRef, useState, type FormEvent} from 'react'
import {createRoot} from 'react-dom/client'
import {
  Badge, Button, Checkbox, Field, FluentProvider, Input, Select, Spinner, webDarkTheme,
} from '@fluentui/react-components'
import {useFormik} from 'formik'
import {capturedDate, ReviewArchive, ReviewReadings, StatusBadge} from './grids'
import {checks, parseArchive, parseReview, readOperatorJson, type Check, type Review, type ReviewSummary} from './reviews'
import {connectors, describeRule, measurementKey, measurementLabel, normalizeReadings, numericFields, validateRule, type NumericPath, type Rule, type RuleInput} from './rules'
import './operator.css'

const checkLabels: Record<Check, string> = {
  runtime: 'Runtime snapshot', azure: 'Azure platform', http: 'Public API checks', mcp: 'MCP contract check',
}
type Profile = {name: string; token: string; checks: Check[]}
type Task = 'capture' | 'archive' | 'open'
const emptyProfile: Profile = {name: 'Release verification', token: '', checks: ['http', 'mcp']}
const initialRule: RuleInput = {connector: 'api', path: 'timing.latency_ms', comparison: 'at_least', threshold: '1000', metric: ''}
const maxRules = 8

function validateToken(token: string) {
  return /^[\x21-\x7e]{32,256}$/.test(token) ? undefined : 'Enter a 32–256 character operator token without spaces.'
}

function validateProfile(values: Profile): Partial<Record<keyof Profile, string>> {
  const errors: Partial<Record<keyof Profile, string>> = {}
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{1,46}[A-Za-z0-9]$/.test(values.name.trim())) {
    errors.name = 'Use 3–48 characters, starting and ending with a letter or number.'
  }
  const token = validateToken(values.token)
  if (token) errors.token = token
  if (!values.checks.length || !values.checks.every(check => checks.includes(check))) {
    errors.checks = 'Select at least one available check.'
  }
  return errors
}

function RuleEditor({rules, add, remove, review}: {rules: Rule[]; add: (rule: Rule) => void; remove: (index: number) => void; review?: Review}) {
  const metricsFor = useCallback((connector: string) => [...new Set((review?.checks ?? [])
    .filter(row => row.connector === connector && typeof row.value === 'number' && row.unit)
    .map(row => measurementKey(row.check, row.unit)))].sort(), [review])
  const form = useFormik<RuleInput>({
    initialValues: initialRule,
    validate(values) {
      const errors = validateRule(values)
      if (values.path === 'measurement.value' && !metricsFor(values.connector).includes(values.metric ?? '')) {
        errors.metric = 'Choose a measurement and unit from the current review.'
      }
      return errors
    },
    onSubmit(values, helpers) {
      const next = {...values, threshold: Number(values.threshold)}
      if (rules.some(rule => rule.connector === next.connector && describeRule(rule) === describeRule(next))) {
        helpers.setFieldError('threshold', 'This presentation rule is already active.')
        return
      }
      add(next)
    },
  })
  const message = (key: keyof RuleInput) => form.touched[key] ? form.errors[key] : undefined
  return <details className="rule-editor">
    <summary>Conditional formatting <span>{rules.length} active</span></summary>
    <p>Flag numeric readings across reviews. Rules stay in this tab and leave the original check status intact.</p>
    <form className="rule-form" onSubmit={form.handleSubmit} noValidate>
      <Field label="Connector" validationMessage={message('connector')}>
        <Select {...form.getFieldProps('connector')} onChange={(_event, data) =>
          void form.setValues({...form.values, connector: data.value as RuleInput['connector'], metric: ''})}>
          {connectors.map(connector => <option key={connector} value={connector}>{connector.toUpperCase()}</option>)}
        </Select>
      </Field>
      <Field label="Reading" validationMessage={message('path')}>
        <Select {...form.getFieldProps('path')}>
          {(Object.keys(numericFields) as NumericPath[]).map(path => <option key={path} value={path}>{numericFields[path]}</option>)}
        </Select>
      </Field>
      {form.values.path === 'measurement.value' && <Field label="Measurement and unit"
        validationMessage={message('metric')} validationState={message('metric') ? 'error' : 'none'}>
        <Select {...form.getFieldProps('metric')}>
          <option value="">Choose a metric</option>
          {metricsFor(form.values.connector).map(key => <option key={key} value={key}>{measurementLabel(key)}</option>)}
        </Select>
      </Field>}
      <Field label="Comparison" validationMessage={message('comparison')}>
        <Select {...form.getFieldProps('comparison')}>
          <option value="at_least">At least</option>
          <option value="at_most">At most</option>
        </Select>
      </Field>
      <Field label="Threshold" validationMessage={message('threshold')} validationState={message('threshold') ? 'error' : 'none'}>
        <Input {...form.getFieldProps('threshold')} inputMode="decimal" maxLength={18} />
      </Field>
      <Button type="submit" disabled={rules.length >= maxRules}>Add rule</Button>
    </form>
    {rules.length >= maxRules && <p>Remove a rule to add another.</p>}
    {rules.length > 0 && <ul className="active-rules" aria-label="Active presentation rules">
      {rules.map((rule, index) => <li key={rule.connector + describeRule(rule)}>
        <span>{rule.connector.toUpperCase()} · {describeRule(rule)}</span>
        <Button size="small" appearance="subtle" aria-label={`Remove ${rule.connector} rule ${describeRule(rule)}`}
          onClick={() => remove(index)}>Remove</Button>
      </li>)}
    </ul>}
  </details>
}

function ReviewDetail({review, rules}: {review: Review; rules: Rule[]}) {
  const [filter, setFilter] = useState('all')
  const rows = useMemo(() => normalizeReadings(review.checks), [review.checks])
  const counts = useMemo(() => {
    const connectorCounts = new Map<string, number>()
    const statuses = {pass: 0, fail: 0, unavailable: 0}
    for (const row of rows) {
      connectorCounts.set(row.connector, (connectorCounts.get(row.connector) ?? 0) + 1)
      statuses[row.status]++
    }
    return {connectorCounts, statuses}
  }, [rows])
  const filtered = filter === 'all' ? rows : rows.filter(row => row.connector === filter)
  return <>
    <div className="receipt-title">
      <div><h3>{review.title}</h3><p>Captured <time dateTime={review.captured_at}>{capturedDate(review.captured_at)}</time></p></div>
      <StatusBadge status={review.status} />
    </div>
    <dl className="status-counts">
      <div><dt>Passed</dt><dd>{counts.statuses.pass}</dd></div>
      <div><dt>Failed</dt><dd>{counts.statuses.fail}</dd></div>
      <div><dt>Unavailable</dt><dd>{counts.statuses.unavailable}</dd></div>
    </dl>
    <Field label="Filter connector" className="connector-filter">
      <Select value={filter} onChange={(_, data) => setFilter(data.value)}>
        <option value="all">All connectors ({rows.length})</option>
        {[...counts.connectorCounts].map(([connector, count]) => (
          <option key={connector} value={connector}>{connector.toUpperCase()} ({count})</option>
        ))}
      </Select>
    </Field>
    <ReviewReadings items={filtered} rules={rules} />
  </>
}

function Operator() {
  const [busy, setBusy] = useState<Task | null>(null)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ReviewSummary[] | null>(null)
  const [review, setReview] = useState<Review>()
  const [rules, setRules] = useState<Rule[]>([])
  const pending = useRef<AbortController | null>(null)
  const tokenInput = useRef<HTMLInputElement>(null)

  const perform = useCallback(async (task: Task, work: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(task)
    setMessage('')
    setFailure('')
    try {
      await work(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) {
        setFailure(error instanceof DOMException ? 'The operation timed out or was interrupted.' :
          error instanceof Error ? error.message : 'The operation could not complete.')
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null
        setBusy(null)
      }
    }
  }, [])

  async function loadArchive(token: string, text: string, signal: AbortSignal) {
    return parseArchive(await readOperatorJson('/api/reviews?' + new URLSearchParams({q: text.trim()}), token, signal))
  }

  const profile = useFormik<Profile>({
    initialValues: emptyProfile,
    validate: validateProfile,
    onSubmit: values => perform('capture', async signal => {
      const result = parseReview(await readOperatorJson('/api/reviews', values.token, signal, {
        name: values.name.trim(), checks: values.checks,
      }))
      signal.throwIfAborted()
      setReview(result)
      setQuery('')
      setItems(null)
      setMessage('Review captured and archived.')
      const archive = await loadArchive(values.token, '', signal)
      signal.throwIfAborted()
      setItems(archive)
    }),
  })
  const accessToken = profile.values.token

  function reuseProfile() {
    if (!review) return
    const captured = new Set(review.checks.map(row => row.connector === 'api' ? 'http' : row.connector))
    const selected = checks.filter(check => captured.has(check))
    if (!selected.length) return
    void profile.setValues({...profile.values, name: review.profile, checks: selected}, false)
    setFailure('')
    setMessage('Profile reused. Review the checks before running again.')
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const error = validateToken(accessToken)
    if (error) {
      void profile.setFieldTouched('token', true)
      tokenInput.current?.focus()
      return
    }
    if ((query.match(/[a-z0-9_.:/-]+/gi) ?? []).length > 8) {
      setMessage('')
      setFailure('Use eight search terms or fewer.')
      return
    }
    void perform('archive', async signal => {
      const result = await loadArchive(accessToken, query, signal)
      signal.throwIfAborted()
      setItems(result)
      setMessage(result.length === 1 ? 'One review found.' : `${result.length} reviews found.`)
    })
  }

  const open = useCallback((id: string) => {
    if (validateToken(accessToken)) return
    void perform('open', async signal => {
      const result = parseReview(await readOperatorJson('/api/reviews/' + encodeURIComponent(id), accessToken, signal))
      signal.throwIfAborted()
      setReview(result)
      setMessage('Saved review opened.')
    })
  }, [accessToken, perform])

  function clearAccess() {
    pending.current?.abort()
    pending.current = null
    setBusy(null)
    setItems(null)
    setReview(undefined)
    setQuery('')
    setMessage('Operator access cleared.')
    setFailure('')
    void profile.setFieldValue('token', '', false)
    void profile.setFieldTouched('token', false, false)
    tokenInput.current?.focus()
  }

  const validation = (field: keyof Profile) => profile.touched[field] ? profile.errors[field] : undefined
  const selectionMessage = typeof validation('checks') === 'string' ? validation('checks') : undefined
  return <main className="workspace">
    <header className="workspace-header">
      <div className="identity"><span className="identity-mark" aria-hidden="true">P</span>
        <div><div className="eyebrow">Predictir</div><h1>Operations review</h1></div>
      </div>
      <Badge appearance="outline" shape="rounded">Local operator</Badge>
    </header>
    <div className="workspace-intro">
      <p>Capture a release check, review the readings, and return to the same evidence later.</p>
      <span>Read-only cloud checks · Private local archive</span>
    </div>
    <div className="announcements" aria-live="polite">
      {busy && <Spinner size="tiny" label={busy === 'capture' ? 'Capturing a review…' : 'Loading the archive…'} />}
      {message && <p role="status">{message}</p>}
      {failure && <p role="alert" className="failure">{failure}</p>}
    </div>
    <div className="workspace-layout">
      <section aria-labelledby="setup-title" className="surface setup">
        <div className="eyebrow">Capture</div>
        <h2 id="setup-title">Review profile</h2>
        <form onSubmit={profile.handleSubmit} noValidate>
          <Field label="Profile name" required validationMessage={validation('name')}
            validationState={validation('name') ? 'error' : 'none'} hint="Letters, numbers, spaces, dashes or underscores.">
            <Input {...profile.getFieldProps('name')} maxLength={48} disabled={Boolean(busy)} />
          </Field>
          <Field label="Operator token" required validationMessage={validation('token')}
            validationState={validation('token') ? 'error' : 'none'} hint="Kept in memory for this tab.">
            <Input {...profile.getFieldProps('token')} type="password" autoComplete="off" spellCheck={false}
              maxLength={256} disabled={Boolean(busy)} ref={tokenInput} onChange={event => {
                setItems(null)
                setReview(undefined)
                setMessage('')
                setFailure('')
                profile.handleChange(event)
              }} />
          </Field>
          <fieldset aria-describedby="connector-help">
            <legend>Checks to run</legend>
            <p id="connector-help">Choose from the configured connectors.</p>
            {checks.map(check => <Checkbox key={check} label={checkLabels[check]} disabled={Boolean(busy)}
              checked={profile.values.checks.includes(check)}
              onChange={(_, data) => {
                const selected = profile.values.checks.filter(value => value !== check)
                void profile.setFieldValue('checks', data.checked === true ? [...selected, check] : selected)
                void profile.setFieldTouched('checks', true, false)
              }} />)}
            {selectionMessage && <p className="failure">{selectionMessage}</p>}
          </fieldset>
          <div className="actions">
            <Button type="submit" appearance="primary" disabled={Boolean(busy)}>Run and archive</Button>
            <Button disabled={Boolean(busy) || !review} onClick={reuseProfile}>Reuse profile</Button>
            <Button appearance="subtle" disabled={!accessToken && !items && !review} onClick={clearAccess}>Clear access</Button>
          </div>
        </form>
      </section>
      <div className="workspace-results">
        <section className="surface" aria-labelledby="archive-title">
          <div className="eyebrow">Recall</div>
          <h2 id="archive-title">Saved reviews</h2>
          <form className="archive-search" onSubmit={search}>
            <Field label="Search archive" hint="Up to eight terms.">
              <Input value={query} onChange={(_, data) => setQuery(data.value)} disabled={Boolean(busy)}
                placeholder="Title, status or connector" maxLength={120} />
            </Field>
            <Button type="submit" disabled={Boolean(busy)}>Search</Button>
          </form>
          {items === null ? <p className="empty">Search with your operator token to load saved reviews.</p> :
            items.length === 0 ? <p className="empty">No saved review matched this search.</p> :
            <ReviewArchive items={items} selected={review?.id} disabled={Boolean(busy)} open={open} />}
        </section>
        <section className="surface" aria-labelledby="detail-title">
          <div className="eyebrow">Inspect</div>
          <h2 id="detail-title">Review evidence</h2>
          <RuleEditor review={review ?? undefined} rules={rules} add={rule => setRules(current => current.length < maxRules ? [...current, rule] : current)}
            remove={index => setRules(current => current.filter((_, position) => position !== index))} />
          {review ? <ReviewDetail key={review.id} review={review} rules={rules} /> :
            <p className="empty">Capture a review or open one from the archive.</p>}
        </section>
      </div>
    </div>
  </main>
}

const root = document.getElementById('operator-root')
if (root) createRoot(root).render(<FluentProvider theme={webDarkTheme}><Operator /></FluentProvider>)
