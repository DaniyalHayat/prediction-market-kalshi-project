'use client';
import React, {useRef, useState} from 'react';
import {evaluateQuantScenario, normalizeQuantControls} from '../lib/workspace/quant-context.mjs';
import {dollars, percent} from './api.mjs';
import {fetchJSON} from '../lib/transport.mjs';

const features = [
  ['hmm', 'Hidden Markov filter', 'Estimate the context regime from a regularly spaced series.'],
  ['kalman', 'Kalman filter', 'Smooth noisy context measurements and show the resulting estimate.'],
  ['brownian_mc', 'Brownian Monte Carlo', 'Compare sampled terminal score margins with the analytic result.'],
  ['optional_stopping', 'Optional stopping policy', 'Compare an early-exit policy with holding under stated risk and costs.'],
];
const defaults = {margin: 3, minutes: 12, drift: .1, volatility: 2.3, probability: .55, cost: .02};
const format = value => Number.isFinite(value) ? value.toFixed(3) : 'Unavailable';
const stageName = {
  baseline: 'Baseline', hmm: 'Add HMM', kalman: 'Add Kalman', brownian_analytic: 'Analytic score model',
  brownian_mc: 'Add Monte Carlo', optional_stopping: 'Add stopping policy',
};

function scenarioObservations(text) {
  if (!text.trim()) return [];
  const values = text.split(',').map(value => value.trim());
  if (values.length > 60 || values.some(value => !value || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1)) {
    throw new RangeError('Enter up to 60 comma-separated scores between −1 and 1');
  }
  return values.map((value, index) => ({
    observed_at: new Date(Date.UTC(2000, 0, 1, 0, index)).toISOString(), score: Number(value),
  }));
}

export default function QuantScenarios({scoreCase = null, workspaceTicker = null}) {
  const [controls, setControls] = useState(() => normalizeQuantControls());
  const [inputs, setInputs] = useState(defaults);
  const [context, setContext] = useState('0.15, 0.48, 0.12, 0.52, 0.35, 0.62, 0.42, 0.58');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  function change(update) {
    setResult(null);
    setDraft(null);
    setMessage('');
    setError('');
    update();
  }
  async function action(operation, data = {}) {
    return fetchJSON('/api/workspace/paper-scenarios', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', timeoutMs: 22_000,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ticker: workspaceTicker, operation, ...data}),
    });
  }
  async function perform(work) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try { await work(); }
    catch (failure) { setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  }
  function run(event) {
    event.preventDefault();
    return perform(async () => {
      setResult(null);
      setDraft(null);
      const context_observations = scenarioObservations(context);
      const score = scoreCase ?? {
          margin: Number(inputs.margin), remaining_seconds: Number(inputs.minutes) * 60,
          drift_points_per_minute: Number(inputs.drift), volatility_points_per_sqrt_minute: Number(inputs.volatility),
          baseline_probability: .5, simulations: 10000,
      };
      const stopping = {initial_probability: Number(inputs.probability), quantity: 10, steps: 8,
        probability_step: .04, exit_cost_per_contract: Number(inputs.cost), risk_aversion: .1, assumptionsAcknowledged: true};
      if (workspaceTicker) {
        const packet = await action('preview', {scenario: {controls, context_scores: context_observations.map(row => row.score), score, stopping}});
        setResult(packet.scenario.result);
        setDraft(packet.draft_token);
      } else {
        setResult(evaluateQuantScenario({controls, context_observations, score, score_source: scoreCase ? 'observed' : 'supplied_scenario', stopping}));
      }
    });
  }
  return <section className="quant-scenarios" aria-label="Quantitative scenario comparison">
    <div className="execution-result-heading"><div><span className="eyebrow">Independent research</span><h4>Quantitative scenarios</h4></div><span className="tag">Paper only</span></div>
    <p className="execution-note">Run any component alone or compare the selected components in sequence. Context, score probabilities and hypothetical exit proceeds are separate outputs. The contract forecast and paper account are unaffected.</p>
    <form className="execution-form" onSubmit={run} aria-busy={busy}>
      <fieldset><legend>Model components</legend><div className="execution-toggles">
        {features.map(([key, title, detail]) => <label key={key}><input type="checkbox" disabled={busy} checked={controls[key]} onChange={event => change(() => setControls({...controls, [key]: event.target.checked}))}/><span><strong>{title}</strong><small>{detail}</small></span></label>)}
      </div></fieldset>
      <label>Context scores at equal intervals <small>Illustrative inputs. No social feed is queried.</small>
        <input value={context} maxLength={600} disabled={busy} onChange={event => change(() => setContext(event.target.value))}/></label>
      <div className="execution-assumption-grid">
        {[
          ...(!scoreCase ? [['margin', 'Home lead · points', '-100', '100', '1'], ['minutes', 'Minutes remaining', '1', '48', '1'],
            ['drift', 'Expected margin change per minute', '-10', '10', '.1'], ['volatility', 'Volatility · points / √min', '.1', '30', '.1']] : []),
          ['probability', 'Starting exit-scenario mark', '.01', '.99', '.01'], ['cost', 'Exit cost per contract · USD', '0', '.25', '.01'],
        ].map(([key, label, min, max, step]) => <label key={key}>{label}<input type="number" value={inputs[key]} min={min} max={max} step={step} disabled={busy} required onChange={event => change(() => setInputs({...inputs, [key]: event.target.value}))}/></label>)}
      </div>
      <p className="execution-note">The exit experiment uses a bounded fair-price tree for 10 contracts and a fixed risk preference. It does not read an executable book.</p>
      <div className="execution-run"><button type="submit" className="primary" disabled={busy}>{workspaceTicker ? 'Preview paper scenario' : 'Run comparison'}</button><button type="button" className="secondary" disabled={busy} onClick={() => change(() => setControls(Object.fromEntries(features.map(([key]) => [key, true]))))}>Enable all</button><button type="button" className="secondary" disabled={busy} onClick={() => change(() => setControls(normalizeQuantControls()))}>Baseline only</button></div>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
    {result && <div className="execution-results" aria-live="polite">
      <div className="execution-metrics">
        <div><small>Selected context score</small><strong>{format(result.context.selected_score)}</strong></div>
        <div><small>Scenario P(home lead at regulation)</small><strong>{Number.isFinite(result.score.selected_probability) ? percent(result.score.selected_probability) : 'Unavailable'}</strong></div>
        <div><small>Exit policy · first action</small><strong>{result.stopping.first_action || 'Hold baseline'}</strong></div>
      </div>
      {result.score.reason && <p className="execution-note">{result.score.reason}</p>}
      {result.context.reason && <p className="execution-note">{result.context.reason}</p>}
      {result.stopping.reason && <p className="execution-note">{result.stopping.reason}</p>}
      <div className="table-scroll"><table><caption>Cumulative comparison</caption><thead><tr><th scope="col">Stage</th><th scope="col">Context score</th><th scope="col">Score probability</th><th scope="col">Risk-adjusted proceeds</th></tr></thead>
        <tbody>{result.cumulative.map(row => <tr key={row.stage}><th scope="row">{stageName[row.stage] || row.stage}{row.applied === false ? ' · off' : ''}</th><td>{format(row.context_score)}</td><td>{Number.isFinite(row.score_probability) ? percent(row.score_probability) : 'Unavailable'}</td><td>{Number.isFinite(row.stopping_certainty_equivalent) ? dollars(row.stopping_certainty_equivalent) : 'Unavailable'}</td></tr>)}</tbody>
      </table></div>
      {draft && <div className="execution-run">
        <button type="button" className="primary" disabled={busy} onClick={() => perform(async () => {
          await action('save', {draft_token: draft, confirmed: true});
          setDraft(null);
          setSaved(null);
          setMessage('Scenario saved for this guest session.');
        })}>Save reviewed scenario</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => {setDraft(null); setResult(null);}}>Discard preview</button>
      </div>}
    </div>}
    {workspaceTicker && <div className="execution-results">
      <p className="execution-note">Saved scenarios stay with this browser session for up to six hours. They do not change your paper positions or balance.</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => perform(async () => setSaved((await action('list')).scenarios))}>Load saved scenarios</button>
      {message && <p role="status">{message}</p>}
      {saved?.length === 0 && <p>No saved scenarios for this contract.</p>}
      {saved?.map(scenario => <details key={scenario.id} className="execution-feature-result">
        <summary>Saved {new Date(scenario.saved_at).toLocaleString()}</summary>
        <p>Score probability {percent(scenario.score_probability)} · Context {format(scenario.context_score)} · Exit policy {scenario.stopping_action || 'Unavailable'}</p>
        <p>Risk-adjusted proceeds {dollars(scenario.stopping_certainty_equivalent_usd)}. Active models {features.filter(([key]) => scenario.inputs.controls?.[key]).map(([, label]) => label).join(', ') || 'Baseline'}.</p>
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          if (!window.confirm('Discard this saved paper scenario?')) return;
          perform(async () => {
            await action('discard', {scenario_id: scenario.id, confirmed: true});
            setSaved(rows => rows.filter(row => row.id !== scenario.id));
            setMessage('Saved scenario discarded.');
          });
        }}>Discard saved scenario</button>
      </details>)}
    </div>}
    <p className="execution-note"><a href="/research/quant-scenario-validation.json">Backtest data and validation results</a></p>
  </section>;
}
