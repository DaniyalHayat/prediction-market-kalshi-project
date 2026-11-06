const maximumSourceAge = 20 * 60_000;
const minimumDnp = 3;
const minimumRegular = 4;
const priorGames = 4;
const maximumShift = .12;
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const mean = rows => rows.reduce((total, row) => total + row.residual, 0) / rows.length;
const scope = 'One-player pregame sensitivity from historical DNP versus at least 20 minutes played, adjusted for opponent and home court by an earlier team-strength model. Player absences can coincide, DNP reasons can differ, and no injury effect or calibrated probability has been established.';
const interval = forecast => {
  const {probability: center, interval: range} = forecast || {};
  return probability(center) && Array.isArray(range) && range.length === 2 && range.every(probability) &&
    range[0] <= center && center <= range[1] ? range : null;
};

function datedEventSource(source, game, now) {
  const stamp = Date.parse(source?.retrieved_at);
  if (!Number.isFinite(stamp) || stamp > now || now - stamp > maximumSourceAge) return null;
  try {
    const url = new URL(source.url);
    if (url.origin !== 'https://site.api.espn.com' || url.username || url.password ||
      url.pathname !== '/apis/site/v2/sports/basketball/nba/summary' ||
      url.searchParams.getAll('event').length !== 1 || url.searchParams.get('event') !== game.id ||
      [...url.searchParams.keys()].some(key => key !== 'event') || url.hash) return null;
    return {url: url.href, retrieved_at: new Date(stamp).toISOString()};
  } catch {
    return null;
  }
}

function uniqueRows(rows, key) {
  const index = new Map();
  for (const row of rows) {
    const identity = key(row);
    index.set(identity, index.has(identity) ? null : row);
  }
  return [...index.values()].filter(Boolean);
}

export function nbaAvailabilityFeedback({game, selection, forecast, current, games = [], playerRows = [], baseline, now = Date.now()} = {}) {
  const baseInterval = interval(forecast);
  const result = {status: 'unavailable', fixture_id: game?.id ?? null, source: null, baseline_probability: baseInterval ? forecast.probability : null,
    decision_interval: baseInterval, scenarios: [], scope};
  if (!baseInterval || forecast.outcomes || forecast.inplay || !['home', 'away'].includes(selection) ||
    !id(game?.id) || !id(game.home_id) || !id(game.away_id) || game.home_id === game.away_id ||
    (game.league && game.league !== 'nba') || game.completed !== false || !Number.isFinite(now) ||
    !(Date.parse(game.played_at) > now)) {
    return {...result, reason: 'A matching pregame NBA binary estimate is required.'};
  }
  const source = datedEventSource(current?.source, game, now);
  if (!source) return {...result, reason: 'A current availability snapshot for this exact ESPN fixture is required.'};
  result.source = source;
  const teams = new Set([game.home_id, game.away_id]);
  const reported = Array.isArray(current.rows) ? current.rows : [];
  const currentRows = uniqueRows(reported.filter(row => id(row?.player_id) && teams.has(row.team_id)), row => row.player_id)
    .filter(row => typeof row.status === 'string' && /^(?:out|suspended)$/i.test(row.status.trim()) &&
      typeof row.name === 'string' && row.name.trim()).slice(0, 16);
  if (!currentRows.length) return {...result, reason: 'No unique confirmed Out or Suspended player was reported for either team.'};
  if (typeof baseline?.predict !== 'function') return {...result, reason: 'A pre-sample team-strength fit is unavailable.'};

  const history = new Map(uniqueRows(games.filter(row => row && id(row.id)), row => row.id)
    .filter(row => row.completed === true && row.id !== game.id && Date.parse(row.played_at) < now &&
      id(row.home_id) && id(row.away_id) && row.home_id !== row.away_id && (!row.league || row.league === 'nba') &&
      Number.isInteger(row.home_score) && Number.isInteger(row.away_score) && row.home_score >= 0 &&
      row.away_score >= 0 && row.home_score !== row.away_score).map(row => [row.id, row]));
  const selections = new Set(currentRows.map(row => row.team_id + ':' + row.player_id));
  const appearances = uniqueRows(playerRows.filter(row => row && selections.has(row.team_id + ':' + row.player_id)),
    row => [row.game_id, row.team_id, row.player_id].join(':'));
  const predictions = new Map();
  const forTeam = selection === 'home' ? game.home_id : game.away_id;
  const trainingEnd = baseline.trained_through === undefined ? -Infinity : Date.parse(baseline.trained_through);

  for (const player of currentRows) {
    const dnp = [], regular = [];
    for (const row of appearances) {
      if (row.team_id !== player.team_id || row.player_id !== player.player_id) continue;
      const fixture = history.get(row.game_id);
      if (!fixture || !(Date.parse(fixture.played_at) > trainingEnd) ||
        ![fixture.home_id, fixture.away_id].includes(row.team_id)) continue;
      const group = row.did_not_play === true && row.minutes === 0 ? dnp :
        row.did_not_play === false && Number.isFinite(row.minutes) && row.minutes >= 20 && row.minutes <= 75 ? regular : null;
      if (!group) continue;
      if (!predictions.has(fixture.id)) predictions.set(fixture.id, baseline.predict(fixture.home_id, fixture.away_id)?.home);
      const pHome = predictions.get(fixture.id);
      if (!probability(pHome)) continue;
      const atHome = fixture.home_id === row.team_id;
      const won = fixture.home_score > fixture.away_score;
      group.push({game_id: fixture.id, residual: Number(atHome === won) - (atHome ? pHome : 1 - pHome)});
    }
    if (dnp.length < minimumDnp || regular.length < minimumRegular) continue;
    const dnpResidual = mean(dnp), regularResidual = mean(regular);
    const effectiveGames = dnp.length * regular.length / (dnp.length + regular.length);
    const shrinkage = effectiveGames / (effectiveGames + priorGames);
    const effect = clamp((dnpResidual - regularResidual) * shrinkage, -maximumShift, maximumShift);
    const delta = player.team_id === forTeam ? effect : -effect;
    const conditional = clamp(forecast.probability + delta, 0, 1);
    result.scenarios.push({
      player_id: player.player_id, team_id: player.team_id, name: player.name.trim().slice(0, 100), status: player.status.trim(),
      conditional_probability: conditional, probability_delta: conditional - forecast.probability,
      scenario_interval: baseInterval.map(bound => clamp(bound + delta, 0, 1)),
      dnp_games: dnp.length, regular_games: regular.length, dnp_residual: dnpResidual, regular_residual: regularResidual, shrinkage,
      historical_fixture_ids: [...dnp, ...regular].map(row => row.game_id).sort()
    });
  }
  if (!result.scenarios.length) return {...result, reason: 'The confirmed player reports lack enough comparable, dated DNP and regular-minutes results.'};
  return {...result, status: 'available', decision_interval: [
    Math.min(baseInterval[0], ...result.scenarios.map(row => row.scenario_interval[0])),
    Math.max(baseInterval[1], ...result.scenarios.map(row => row.scenario_interval[1]))
  ]};
}

export function screenAvailabilityForecast(forecast, feedback) {
  const original = interval(forecast), next = feedback?.decision_interval;
  if (!original || forecast.outcomes || forecast.inplay || feedback?.status !== 'available' ||
    feedback.baseline_probability !== forecast.probability || !Array.isArray(next) || next.length !== 2 ||
    !next.every(probability) || next[0] > original[0] || next[1] < original[1]) return forecast;
  return {...forecast, interval: next, base_interval: original,
    interval_kind: 'Original model range plus separately stressed single-player availability scenarios', availability_feedback: feedback};
}
