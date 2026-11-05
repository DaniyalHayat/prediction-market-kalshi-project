import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {
  evaluateQuantScenario,
  hmmContext,
  kalmanContext,
  martingaleDrawdownBounds
} from '../lib/workspace/quant-context.mjs';
import {inverseNormal} from '../lib/workspace/nba-inplay-math.mjs';
import {fitBasketball} from '../lib/workspace/sports-math.mjs';
import {optionalStoppingScenario} from '../lib/workspace/stopping-scenario.mjs';

const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const sha = value => createHash('sha256').update(value).digest('hex');
const sum = values => values.reduce((total, value) => total + value, 0);
const stableQuantile = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)];
const controls = ['hmm', 'kalman', 'brownian_mc', 'optional_stopping'];
const replayPath = new URL('../research-data/nba-quarter-replay-2026-11-04.json.gz', import.meta.url);
const gamesPath = new URL('../research-data/nba-completed-games-2026-11-04.json.gz', import.meta.url);
const receiptPath = new URL('../public/research/quant-scenario-validation.json', import.meta.url);

function uniform(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return (state + .5) / 4294967296;
  };
}

function normal(random) {
  return Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
}

function contextFixture(kind, seed) {
  const random = uniform(seed);
  const means = [-.65, 0, .65];
  const transitions = [[.85, .14, .01], [.1, .8, .1], [.01, .14, .85]];
  const observations = [];
  const latent = [];
  let regime = 1;
  for (let i = 0; i < 360; i++) {
    const draw = random();
    const row = transitions[regime];
    regime = kind === 'rapid_reversals' ? Math.floor(i / 3) % 3 :
      draw < row[0] ? 0 : draw < row[0] + row[1] ? 1 : 2;
    const value = kind === 'independent_noise' ? means[Math.floor(random() * 3)] : means[regime];
    const signal = kind === 'independent_noise' ? 0 : value;
    latent.push(value);
    observations.push({
      observed_at: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(),
      score: Math.min(1, Math.max(-1, signal + .35 * normal(random)))
    });
  }
  return {observations, latent};
}

function evaluateContext() {
  const seeds = [127, 271, 761, 981, 2026, 2513, 7433, 9487];
  const warmup = 120;
  const cases = ['persistent_regimes', 'rapid_reversals', 'independent_noise'].map(kind => {
    const runs = seeds.map(seed => {
      const {observations, latent} = contextFixture(kind, seed);
      const h = hmmContext(observations).states.map(row => row.filtered_context_score);
      const k = kalmanContext(observations).states.map(row => row.filtered_context_score);
      const forecasts = {
        raw: observations.map(row => row.score),
        zero_reference: observations.map(() => 0),
        hmm: h,
        kalman: k,
        equal_blend: h.map((value, i) => (value + k[i]) / 2)
      };
      const mse = Object.fromEntries(Object.entries(forecasts).map(([model, values]) => [
        model, average(values.slice(warmup).map((value, i) => (value - latent[i + warmup]) ** 2))
      ]));
      return {seed, mse};
    });
    return {
      fixture: kind,
      mse: Object.fromEntries(Object.keys(runs[0].mse).map(model => [model, average(runs.map(run => run.mse[model]))])),
      runs
    };
  });
  return {
    provenance: 'seeded_synthetic_latent_context',
    warmup_points_per_run: warmup,
    chronological_evaluation_points_per_run: 360 - warmup,
    fixed_parameters: true,
    cases,
    scope: 'Same-time latent score reconstruction in each later segment. The persistent case uses planted Markov regimes, the rapid case reverses more often, and the independent case disconnects observations from the target. The zero reference distinguishes smoothing toward zero from extracting signal.'
  };
}

function nbaStates(game) {
  const home = game.home_period_scores;
  const away = game.away_period_scores;
  const regulation = sum(home.slice(0, 4)) - sum(away.slice(0, 4));
  return [1, 2, 3].map(quarter => ({
    id: game.game_id,
    quarter,
    remaining: 1 - quarter / 4,
    margin: sum(home.slice(0, quarter)) - sum(away.slice(0, quarter)),
    regulation,
    pregame: game.pregame_home_probability
  }));
}

function fitScale(rows) {
  let squared = 0;
  let cross = 0;
  for (const row of rows) {
    const future = row.regulation - row.margin;
    squared += future ** 2 / row.remaining;
    cross += future * inverseNormal(row.pregame);
  }
  return (-cross + Math.sqrt(cross ** 2 + 4 * rows.length * squared)) / (2 * rows.length);
}

function loss(probability, label) {
  const bounded = Math.max(1e-6, Math.min(1 - 1e-6, probability));
  return {brier: (probability - label) ** 2, log_loss: -Math.log(label ? bounded : 1 - bounded)};
}

async function evaluateScore() {
  const [archive, gamesArchive] = await Promise.all([readFile(replayPath), readFile(gamesPath)]);
  const replay = JSON.parse(gunzipSync(archive));
  const capturedGames = JSON.parse(gunzipSync(gamesArchive)).games;
  const training = replay.games.filter(game => game.split === 'calibration');
  const testing = replay.games.filter(game => game.split === 'test');
  assert.ok(training.length >= 30 && testing.length >= 15);
  const trainingEnd = training.map(game => game.played_at).sort().at(-1);
  const testStart = testing.map(game => game.played_at).sort()[0];
  assert.ok(trainingEnd < testStart);
  assert.equal(new Set(replay.games.map(game => game.game_id)).size, replay.games.length);
  for (const game of replay.games) {
    assert.ok(Date.parse(game.prior_cutoff) <= Date.parse(game.played_at) - 8 * 3600000);
    assert.ok(game.home_period_scores.length >= 4 && game.away_period_scores.length >= 4);
    const priorGames = capturedGames.filter(row => Date.parse(row.played_at) < Date.parse(game.prior_cutoff));
    assert.equal(priorGames.length, game.prior_training_games);
    const prior = fitBasketball(priorGames).predict(game.home_id, game.away_id).home;
    assert.ok(Math.abs(prior - game.pregame_home_probability) < 1e-12);
  }
  const sigma = fitScale(training.flatMap(nbaStates));
  const rows = testing.flatMap(nbaStates).map((row, index) => {
    const score = evaluateQuantScenario({
      controls: {brownian_mc: true},
      score_source: 'observed',
      score: {
        margin: row.margin,
        remaining_seconds: row.remaining * 2880,
        baseline_probability: row.pregame,
        drift_points_per_minute: sigma * inverseNormal(row.pregame) / 48,
        volatility_points_per_sqrt_minute: sigma / Math.sqrt(48),
        simulations: 8192,
        seed: 91273 + index
      }
    }).score;
    const label = Number(row.regulation > 0);
    return {
      id: row.id,
      quarter: row.quarter,
      pregame_reference: loss(row.pregame, label),
      brownian_analytic: loss(score.analytic_probability, label),
      brownian_mc: loss(score.selected_probability, label),
      absolute_mc_error: Math.abs(score.selected_probability - score.analytic_probability)
    };
  });
  const summarize = subset => Object.fromEntries(['pregame_reference', 'brownian_analytic', 'brownian_mc'].map(model => [
    model, {
      brier: average(subset.map(row => row[model].brier)),
      log_loss: average(subset.map(row => row[model].log_loss))
    }
  ]));
  const byGame = testing.map(game => {
    const states = rows.filter(row => row.id === game.game_id);
    return average(states.map(row => row.pregame_reference.brier - row.brownian_analytic.brier));
  });
  const random = uniform(174137);
  const boot = Array.from({length: 2000}, () => average(
    Array.from({length: byGame.length}, () => byGame[Math.floor(random() * byGame.length)])
  )).sort((a, b) => a - b);
  return {
    provenance: 'observed_historical_nba_quarter_replay',
    archive_sha256: sha(archive),
    prior_games_archive_sha256: sha(gamesArchive),
    verified_pregame_reconstructions: replay.games.length,
    capture_as_of: replay.captured_at,
    calibration_games: training.length,
    calibration_end: trainingEnd,
    heldout_games: testing.length,
    heldout_start: testStart,
    heldout_states: rows.length,
    heldout_regulation_ties: testing.filter(game => nbaStates(game)[0].regulation === 0).length,
    regulation_scale: sigma,
    monte_carlo_draws_per_state: 8192,
    monte_carlo_seed_start: 91273,
    score_target: 'Home leads after four regulation periods. Tied regulation scores count as no lead.',
    scores: summarize(rows),
    quarter_scores: [1, 2, 3].map(quarter => ({quarter, ...summarize(rows.filter(row => row.quarter === quarter))})),
    paired_brier_improvement: average(byGame),
    game_cluster_interval_95: [stableQuantile(boot, .025), stableQuantile(boot, .975)],
    maximum_mc_probability_error: Math.max(...rows.map(row => row.absolute_mc_error)),
    scope: 'The 40 earlier calibration games fit the regulation score scale. The 20 later games contribute three quarter-end states each. Final-game pregame priors serve as fixed references on this regulation-lead target. The same states score the analytic model and its Monte Carlo approximation. The archived prior cutoff is eight hours before each game.'
  };
}

function evaluateStopping() {
  const scenarios = [
    {initial_probability: .5, risk_aversion: 0, exit_cost_per_contract: .03},
    {initial_probability: .5, risk_aversion: .01, exit_cost_per_contract: .03},
    {initial_probability: .5, risk_aversion: .08, exit_cost_per_contract: .03},
    {initial_probability: .25, risk_aversion: .015, exit_cost_per_contract: .03}
  ];
  const paths = 12000;
  const cases = scenarios.map(config => {
    const parameters = {probability_step: .25, quantity: 20, steps: 6,
      assumptionsAcknowledged: true, ...config};
    const exact = optionalStoppingScenario(parameters);
    const decisions = new Map();
    const random = uniform(538129);
    const differences = [];
    const stoppedMarks = [];
    let exitCount = 0;
    for (let i = 0; i < paths; i++) {
      const draws = Array.from({length: parameters.steps}, random);
      const settlement = random();
      let price = parameters.initial_probability;
      let execution = null;
      let markAtExit = null;
      for (let time = 0; time < draws.length; time++) {
        if (price === 0 || price === 1) break;
        if (execution === null) {
          const key = time + ':' + price;
          if (!decisions.has(key)) {
            decisions.set(key, optionalStoppingScenario({...parameters, initial_probability: price,
              steps: parameters.steps - time}).first_action);
          }
          if (decisions.get(key) === 'EXIT') {
            execution = parameters.quantity * Math.max(0, price - parameters.exit_cost_per_contract);
            markAtExit = parameters.quantity * price;
            exitCount++;
          }
        }
        price += draws[time] < .5 ? -.25 : .25;
      }
      const held = settlement < price ? parameters.quantity : 0;
      differences.push((execution ?? held) - held);
      stoppedMarks.push(markAtExit ?? parameters.quantity * price);
    }
    const paired = average(differences);
    const error = Math.sqrt(average(differences.map(value => (value - paired) ** 2)) / paths);
    assert.ok(Math.abs(exact.comparison.gross_martingale_residual) < 1e-9);
    assert.ok(exact.policy.certainty_equivalent >= exact.baseline.certainty_equivalent - 1e-9);
    assert.ok(exact.policy.expected_proceeds <= exact.baseline.expected_proceeds + 1e-9);
    return {
      parameters: config,
      first_action: exact.first_action,
      baseline: exact.baseline,
      policy: exact.policy,
      comparison: exact.comparison,
      simulated: {
        paired_cash_change: paired,
        paired_cash_monte_carlo_interval_95: [paired - 1.96 * error, paired + 1.96 * error],
        average_gross_stopped_mark: average(stoppedMarks),
        early_exit_fraction: exitCount / paths
      }
    };
  });
  return {
    provenance: 'seeded_synthetic_bounded_martingale',
    fresh_paths_per_case: paths,
    common_seed: 538129,
    cases,
    drawdown_bound_check: martingaleDrawdownBounds({increment_bounds: Array(8).fill(1), drawdown: 6, assumptionsAcknowledged: true}),
    scope: 'The exact policy is fixed before the fresh paths. Each simulated action uses only the current state and remaining horizon. The same path and settlement draw score policy and hold, with assumed exit costs and no historical fill claim.'
  };
}

function evaluateToggleMatrix() {
  const {observations} = contextFixture('persistent_regimes', 127);
  const input = {
    context_observations: observations.slice(0, 40),
    score: {margin: 5, remaining_seconds: 720, baseline_probability: .52,
      drift_points_per_minute: .5, volatility_points_per_sqrt_minute: 2, simulations: 4096, seed: 71893},
    stopping: {initial_probability: .5, quantity: 20, steps: 6, probability_step: .25,
      exit_cost_per_contract: .03, risk_aversion: .08, assumptionsAcknowledged: true}
  };
  const results = Array.from({length: 2 ** controls.length}, (_, mask) => {
    const selection = Object.fromEntries(controls.map((key, index) => [key, Boolean(mask & (1 << index))]));
    const result = evaluateQuantScenario({...input, controls: selection});
    return {
      controls: selection,
      context_score: result.context.selected_score,
      score_probability: result.score.selected_probability,
      stopping_certainty_equivalent: result.stopping.policy.certainty_equivalent
    };
  });
  const combined = evaluateQuantScenario({...input, controls: Object.fromEntries(controls.map(key => [key, true]))});
  return {
    provenance: 'synthetic_integration_fixture',
    results,
    cumulative: combined.cumulative,
    affects_forecast: combined.affects_forecast,
    scope: 'All 16 toggle combinations share one fixture. Cumulative rows preserve three different units and do not aggregate them into one performance score.'
  };
}

const receipt = {
  version: 'quant-scenario-validation-v1',
  reproducible_command: 'node tools/validate_quant_scenarios.mjs',
  empirical_promotion: false,
  context: evaluateContext(),
  score: await evaluateScore(),
  stopping: evaluateStopping(),
  toggles: evaluateToggleMatrix(),
  limits: [
    'There is no frozen, labeled historical context archive for a settlement-forecast ablation.',
    'The NBA replay uses 20 held-out games and three quarter-end states per game. The game-cluster interval is descriptive and repeated teams can remain dependent.',
    'Monte Carlo adds simulation noise to the analytic result. Sampling intervals omit model and data uncertainty.',
    'The stopping replay is an assumed bounded process with modeled future exit costs. Empirical validation requires timestamped executable books and a frozen policy.',
    'The combined fixture checks actual toggle effects. The empirical score result, synthetic context metrics and simulated utility have different targets.',
    'This run uses local inputs and no provider requests.'
  ]
};
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({
  score: receipt.score.scores,
  heldout_games: receipt.score.heldout_games,
  brier_gain_interval: receipt.score.game_cluster_interval_95,
  context_cases: receipt.context.cases.map(({fixture, mse}) => ({fixture, mse})),
  stopping_cases: receipt.stopping.cases.map(({parameters, first_action, comparison}) => ({parameters, first_action, comparison})),
  toggles: receipt.toggles.results.length
}, null, 2));
