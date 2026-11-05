import {wilson} from '../intelligence/math.mjs';
import {fitTeamWinModel} from './sports-math.mjs';

export const NFL_MODEL_NAME = 'NFL recency-weighted team strength with separate tie rate';
export const NFL_RESULT_LAG_MS = 36 * 3600000;
const OUTCOMES = ['home', 'away', 'tie'];
const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
const point = (p, tie) => ({home: p * (1 - tie), away: (1 - p) * (1 - tie), tie});
const target = game => game.home_score > game.away_score ? 'home' : game.home_score < game.away_score ? 'away' : 'tie';

export function fitNFL(games) {
  if (games.length < 150 || games.filter(game => target(game) !== 'tie').length < 150) return null;
  const model = fitTeamWinModel(games, {halfLifeDays: 365, neutralAware: true});
  const ties = games.filter(game => target(game) === 'tie').length;
  const tie = (ties + .5) / (games.length + 1);
  const tieInterval = wilson(ties, games.length);
  const counts = Object.fromEntries(OUTCOMES.map(side => [side, games.filter(game => target(game) === side).length]));
  const neutralGames = games.filter(game => game.neutral);
  const neutralTies = neutralGames.filter(game => target(game) === 'tie').length;
  const baseline = neutral => neutral ? {
    home: (neutralGames.length - neutralTies + 1) / (2 * (neutralGames.length + 1.5)),
    away: (neutralGames.length - neutralTies + 1) / (2 * (neutralGames.length + 1.5)),
    tie: (neutralTies + .5) / (neutralGames.length + 1.5)
  } : Object.fromEntries(OUTCOMES.map(side => [side, (counts[side] + .5) / (games.length + 1.5)]));
  return {
    baseline,
    predict(game, side = 'home') {
      const value = model.predict(game.home_id, game.away_id, game.neutral);
      if (!value || !['home', 'away'].includes(side)) return null;
      const all = point(value.home, tie);
      const conditionalRange = side === 'home' ? value.interval : [1 - value.interval[1], 1 - value.interval[0]];
      const corners = conditionalRange.flatMap(p => tieInterval.map(t => ({
        win: p * (1 - t),
        settlement: p * (1 - t) + .5 * t
      })));
      const win = all[side], settlement = win + .5 * tie;
      return {
        probability: win,
        interval: [Math.min(win, ...corners.map(row => row.win)), Math.max(win, ...corners.map(row => row.win))],
        expected_settlement_value: settlement,
        settlement_value_interval: [Math.min(settlement, ...corners.map(row => row.settlement)),
          Math.max(settlement, ...corners.map(row => row.settlement))],
        outcomes: {win, loss: all[side === 'home' ? 'away' : 'home'], tie},
        all,
        tie_interval: tieInterval,
        interval_kind: 'Team-strength parameter sensitivity and a historical tie-frequency interval. Roster effects and model error are outside this range.'
      };
    }
  };
}

export function earlierNFLGames(games, asOf, kickoff = asOf) {
  const cutoff = Math.min(asOf, kickoff) - NFL_RESULT_LAG_MS;
  return games.filter(game => game.completed === true && Date.parse(game.played_at) <= cutoff);
}

export function validateNFL(games, season = 2025) {
  const ordered = [...games].sort((a, b) => a.played_at.localeCompare(b.played_at));
  const test = ordered.filter(game => game.season === season && game.completed === true);
  const fits = new Map(), rows = [], blocks = new Map();
  for (const game of test) {
    const start = Date.parse(game.played_at);
    const earlier = earlierNFLGames(ordered, start);
    if (!fits.has(earlier.length)) fits.set(earlier.length, fitNFL(earlier));
    const fit = fits.get(earlier.length), estimate = fit?.predict(game);
    if (!estimate) continue;
    const base = fit.baseline(game.neutral), label = target(game);
    const brier = probabilities => mean(OUTCOMES.map(side => (probabilities[side] - Number(label === side)) ** 2));
    const actualSettlement = label === 'tie' ? .5 : Number(label === 'home');
    const row = {
      id: game.id,
      played_at: game.played_at,
      week: game.week,
      training_games: earlier.length,
      last_training_kickoff: earlier.at(-1)?.played_at,
      label,
      probabilities: estimate.all,
      baseline: base,
      brier: brier(estimate.all),
      baseline_brier: brier(base),
      log_loss: -Math.log(estimate.all[label]),
      baseline_log_loss: -Math.log(base[label]),
      payout_squared_error: (estimate.expected_settlement_value - actualSettlement) ** 2,
      baseline_payout_squared_error: (base.home + .5 * base.tie - actualSettlement) ** 2
    };
    rows.push(row);
    if (!blocks.has(game.week)) blocks.set(game.week, []);
    blocks.get(game.week).push(row.baseline_brier - row.brier);
  }
  if (!rows.length) return {validation: {passed: false, n: 0, coverage: 0}, rows};
  let seed = 582913;
  const weeks = [...blocks.values()];
  const replicates = Array.from({length: 2000}, () => {
    let total = 0, n = 0;
    for (let i = 0; i < weeks.length; i++) {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      const sample = weeks[Math.floor(seed / 4294967296 * weeks.length)];
      total += sample.reduce((sum, value) => sum + value, 0);
      n += sample.length;
    }
    return total / n;
  }).sort((a, b) => a - b);
  const coverage = rows.length / test.length;
  const brier = mean(rows.map(row => row.brier)), baselineBrier = mean(rows.map(row => row.baseline_brier));
  const lower = replicates[50], upper = replicates[1949];
  const bins = Array.from({length: 5}, () => []);
  for (const row of rows) bins[Math.min(4, Math.floor(row.probabilities.home * 5))].push(row);
  return {
    validation: {
      n: rows.length, coverage, tested_games: test.length, weekly_blocks: weeks.length, holdout_season: season,
      passed: rows.length >= 200 && weeks.length >= 16 && coverage >= .95 && lower > 0,
      brier, baseline_brier: baselineBrier, brier_skill: 1 - brier / baselineBrier,
      mean_loss_improvement: baselineBrier - brier, improvement_95_lower: lower, improvement_95_upper: upper,
      log_loss: mean(rows.map(row => row.log_loss)), baseline_log_loss: mean(rows.map(row => row.baseline_log_loss)),
      payout_mse: mean(rows.map(row => row.payout_squared_error)),
      baseline_payout_mse: mean(rows.map(row => row.baseline_payout_squared_error)),
      ties_observed: rows.filter(row => row.label === 'tie').length,
      train_end: rows[0].last_training_kickoff, test_start: rows[0].played_at, test_end: rows.at(-1).played_at,
      calibration: bins.filter(bin => bin.length).map(bin => ({
        n: bin.length, predicted: mean(bin.map(row => row.probabilities.home)),
        actual: mean(bin.map(row => Number(row.label === 'home')))
      })),
      brier_definition: 'Mean squared error across the home-win, away-win and tie outcomes.',
      protocol: 'Fixed model and league-outcome baseline replay every regular-season game in the held-out year. Each fit uses games scheduled at least 36 hours earlier. Paired uncertainty resamples 18 whole NFL weeks. The result archive does not contain historical final-publication timestamps.'
    },
    rows
  };
}
