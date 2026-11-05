import test from 'node:test';
import assert from 'node:assert/strict';
import {analyticScoreDiffusion, evaluateQuantScenario, normalizeQuantControls} from '../lib/workspace/quant-context.mjs';
import {optionalStoppingScenario} from '../lib/workspace/stopping-scenario.mjs';

const observations = [.4, .6, -.25, .7].map((score, i) => ({
  observed_at: new Date(Date.UTC(2026, 10, 5, i)).toISOString(),
  score
}));
const score = {margin: 5, remaining_seconds: 720, drift_points_per_minute: .5,
  volatility_points_per_sqrt_minute: 2, baseline_probability: .52, seed: 71893};
const stopping = {initial_probability: .25, quantity: 20, steps: 6, probability_step: .25,
  exit_cost_per_contract: .03, risk_aversion: .015, assumptionsAcknowledged: true};

test('the four toggles affect only their own calculation and cumulative stages expose the fixed blend', () => {
  const input = {context_observations: observations, score, stopping};
  const baseline = evaluateQuantScenario(input);
  const hmm = evaluateQuantScenario({...input, controls: {hmm: true}});
  const kalman = evaluateQuantScenario({...input, controls: {kalman: true}});
  const all = evaluateQuantScenario({...input, controls: {hmm: true, kalman: true, brownian_mc: true, optional_stopping: true}});
  assert.equal(baseline.context.selected_score, .7);
  assert.equal(baseline.score.monte_carlo, null);
  assert.notEqual(hmm.context.selected_score, baseline.context.selected_score);
  assert.notEqual(kalman.context.selected_score, baseline.context.selected_score);
  assert.equal(all.context.selected_score, (hmm.context.selected_score + kalman.context.selected_score) / 2);
  assert.equal(hmm.score.selected_probability, baseline.score.selected_probability);
  assert.equal(all.score.analytic_probability, baseline.score.analytic_probability);
  assert.ok(Math.abs(all.score.selected_probability - all.score.analytic_probability) < .025);
  assert.ok(all.stopping.policy.certainty_equivalent > baseline.stopping.policy.certainty_equivalent);
  assert.equal(all.affects_forecast, false);
  assert.deepEqual(all.cumulative.map(row => row.stage),
    ['baseline', 'hmm', 'kalman', 'brownian_analytic', 'brownian_mc', 'optional_stopping']);
  assert.equal(all.cumulative.at(-1).score_probability, all.score.selected_probability);
});

test('missing evidence stays unavailable and irregular context can use only the Kalman filter', () => {
  const controls = {hmm: true, kalman: true, brownian_mc: true, optional_stopping: true};
  const missing = evaluateQuantScenario({controls});
  assert.equal(missing.context.available, false);
  assert.equal(missing.score.available, false);
  assert.equal(missing.stopping.available, false);
  const irregular = observations.map((row, i) => i === 3 ? {...row, observed_at: '2026-11-05T05:00:00.000Z'} : row);
  const result = evaluateQuantScenario({controls, context_observations: irregular});
  assert.equal(result.context.hmm.available, false);
  assert.equal(result.context.kalman.available, true);
  assert.equal(result.context.selected_score, result.context.kalman.latest.filtered_context_score);
  assert.throws(() => normalizeQuantControls({hmm: 'true'}), RangeError);
  assert.throws(() => evaluateQuantScenario({score: {...score, simulations: 1000000}}), RangeError);
});

test('bounded stopping matches a brute exponential-utility tree and leaves gross expectation invariant', () => {
  function oracle(price, steps) {
    const holdMoment = 1 - price + price * Math.exp(-stopping.risk_aversion * stopping.quantity);
    if (price === 0 || price === 1 || steps === 0) return holdMoment;
    const sellMoment = Math.exp(-stopping.risk_aversion * stopping.quantity * Math.max(0, price - stopping.exit_cost_per_contract));
    const continueMoment = (oracle(price - .25, steps - 1) + oracle(price + .25, steps - 1)) / 2;
    return Math.min(sellMoment, continueMoment);
  }
  const value = optionalStoppingScenario(stopping);
  const expected = -Math.log(oracle(stopping.initial_probability, stopping.steps)) / stopping.risk_aversion;
  assert.ok(Math.abs(value.policy.certainty_equivalent - expected) < 1e-10);
  assert.equal(value.first_action, 'CONTINUE');
  assert.ok(value.policy.early_exit_probability > 0 && value.policy.early_exit_probability < 1);
  assert.ok(Math.abs(value.comparison.gross_martingale_residual) < 1e-12);
  assert.ok(value.comparison.expected_proceeds_change < 0);
  assert.ok(Math.abs(value.policy.settlement_probability + value.policy.early_exit_probability - 1) < 1e-12);
  assert.equal(optionalStoppingScenario({...stopping, risk_aversion: 0}).policy.early_exit_probability, 0);
});

test('partial current depth prevents immediate exercise and exact ties stay ties', () => {
  const parameters = {...stopping, initial_probability: .5, risk_aversion: .08};
  assert.equal(optionalStoppingScenario(parameters).first_action, 'EXIT');
  assert.equal(optionalStoppingScenario({...parameters, current_exit_cash: null}).first_action, 'CONTINUE');
  assert.equal(optionalStoppingScenario({...parameters, assumptionsAcknowledged: false}).available, false);
  assert.equal(analyticScoreDiffusion({...score, margin: 0, remaining_seconds: 0}).scenario_tie_probability, 1);
});
