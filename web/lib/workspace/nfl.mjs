import {createHash} from 'node:crypto';
import {sourceJSON} from './providers.mjs';
import {teamForm} from './sports-math.mjs';
import {earlierNFLGames, fitNFL, NFL_MODEL_NAME, NFL_RESULT_LAG_MS} from './nfl-math.mjs';
import {matchNFLFixture, nflContractIdentity, nflDateScoreboardURL, nflSeasonScoreboardURL, parseNFLScoreboard} from './nfl-source.mjs';
import archive from './models/nfl-results.json' with {type: 'json'};
import validation from './models/nfl-validation.json' with {type: 'json'};

const hashesMatch = createHash('sha256').update(JSON.stringify(archive.games)).digest('hex') === validation.archive_sha256;
const fitted = new Map();

function packet(response, label) {
  return {kind: 'sports_results', label, url: response.source_url, retrieved_at: response.as_of, sha256: response.sha256};
}

function sameEvent(a, b) {
  return a.home_id === b.home_id && a.away_id === b.away_id && a.played_at === b.played_at && a.season === b.season;
}

export async function nflResearch(market, {getter = sourceJSON, now = Date.now} = {}) {
  const base = {league: 'nfl', teams: [], head_to_head: [], forecast: null, sources: []};
  const unavailable = (reason, extra = {}) => ({...base, reason, ...extra});
  const identity = nflContractIdentity(market);
  if (!identity.available) return unavailable(identity.reason);
  if (!identity.tie_payout_verified) return unavailable('The contract’s half-dollar tie payout could not be verified.');
  if (!hashesMatch) return unavailable('The NFL results archive does not match its validation receipt.');

  const dateURL = nflDateScoreboardURL(identity.date);
  const year = new Date(now()).getUTCFullYear();
  const archiveYear = new Date(archive.as_of).getUTCFullYear();
  const years = year > archiveYear ? [year - 1, year] : [year];
  const [fixture, ...results] = await Promise.allSettled([
    getter('ESPN NFL fixtures', dateURL, {ttl: 900, maximumBytes: 1500000}),
    ...years.map(value => getter('ESPN NFL results', nflSeasonScoreboardURL(value), {ttl: 21600, maximumBytes: 8000000}))
  ]);
  if (fixture.status !== 'fulfilled') return unavailable('The official NFL schedule feed could not verify the selected fixture.');

  let match;
  try {
    match = matchNFLFixture(identity, parseNFLScoreboard(fixture.value.data).games);
  } catch {
    return unavailable('The official NFL schedule feed did not return a usable fixture.');
  }
  if (!match.game) return unavailable(match.reason);
  const game = match.game;
  const startedAt = Date.parse(game.played_at);
  const evaluatedAt = now();
  const asOf = new Date(evaluatedAt).toISOString();
  const fixtureSource = packet(fixture.value, 'ESPN NFL matched game schedule');
  if (game.completed || game.state !== 'pre' || game.status_name !== 'STATUS_SCHEDULED' || startedAt <= evaluatedAt) {
    return unavailable('This game has started, finished, or lacks a confirmed upcoming kickoff. The NFL model covers pregame only.',
      {event: game, sources: [fixtureSource], as_of: asOf});
  }
  const known = new Map(archive.games.map(row => [row.id, row]));
  const resultSources = [];
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return;
    try {
      const {games, rejected} = parseNFLScoreboard(result.value.data);
      if (!games.length || rejected.length || result.value.data.events.length >= 1000) return;
      const current = games.filter(row => row.completed);
      const byId = new Map(current.map(row => [row.id, row]));
      const archivedRows = archive.games.filter(row => new Date(row.played_at).getUTCFullYear() === years[index]);
      if (archivedRows.some(row => !byId.has(row.id) || !sameEvent(row, byId.get(row.id)))) return;
      if (current.some(row => known.has(row.id) && !sameEvent(row, known.get(row.id)))) return;
      for (const row of current) known.set(row.id, row);
      resultSources.push(packet(result.value, 'ESPN NFL recent regular-season results'));
    } catch {
      // The archived model remains available with partial coverage when the refresh fails validation.
    }
  });
  const prior = earlierNFLGames([...known.values()], evaluatedAt, startedAt)
    .sort((a, b) => a.played_at.localeCompare(b.played_at) || a.id.localeCompare(b.id));
  const latestGame = prior.at(-1);
  const coverage = {
    schedules_expected: years.length + 1,
    schedules_returned: resultSources.length + 1,
    completed_games: prior.length,
    current_season_games: prior.filter(row => row.season === game.season).length,
    archived_games: archive.games.length,
    partial: resultSources.length !== years.length,
    latest_training_kickoff: latestGame?.played_at ?? null,
    cutoff: new Date(Math.min(evaluatedAt, startedAt) - NFL_RESULT_LAG_MS).toISOString()
  };
  const model = {
    name: NFL_MODEL_NAME,
    validation,
    input_sources: archive.sources.length + resultSources.length,
    training_history_games: prior.length,
    limitation: 'Historical team strength from completed regular-season games. Starting quarterbacks, injuries and bookmaker odds are outside the model.'
  };
  const teams = [
    {id: game.home_id, name: game.home_name, espn_team_id: game.home_espn_id},
    {id: game.away_id, name: game.away_name, espn_team_id: game.away_espn_id}
  ].map(team => ({
    ...team,
    form: teamForm(prior, team.id, evaluatedAt),
    form_last_five: teamForm(prior, team.id, evaluatedAt, 5),
    last_five_games: prior.filter(row => row.home_id === team.id || row.away_id === team.id).slice(-5).reverse()
  }));
  const pair = new Set(identity.team_codes);
  const headToHead = prior.filter(row => pair.has(row.home_id) && pair.has(row.away_id)).slice(-5).reverse();
  const response = {...base, event: game, teams, head_to_head: headToHead, coverage, model, as_of: asOf,
    sources: [fixtureSource, ...resultSources, ...archive.sources]};
  const fitKey = createHash('sha256').update(JSON.stringify(prior.map(row =>
    [row.id, row.home_score, row.away_score, row.neutral]))).digest('hex');
  if (!fitted.has(fitKey)) {
    if (fitted.size >= 16) fitted.delete(fitted.keys().next().value);
    fitted.set(fitKey, fitNFL(prior));
  }
  const estimate = fitted.get(fitKey)?.predict(game, match.side);
  if (!estimate) return {...response, reason: 'The matched teams lack enough completed results for an NFL estimate.'};
  const sourceDates = [fixtureSource.retrieved_at,
    ...(resultSources.length ? resultSources.map(source => source.retrieved_at) : [archive.as_of])];
  const sourceAsOf = sourceDates.sort()[0];
  const {all, ...forecast} = estimate;
  return {
    ...response,
    reason: null,
    selection: {team: identity.yes_name, code: identity.yes_code, side: match.side, date: identity.date},
    forecast: {
      ...forecast,
      model_name: NFL_MODEL_NAME,
      validation,
      model_release_passed: validation.passed && !coverage.partial,
      source_as_of: sourceAsOf,
      source_url: fixtureSource.url,
      training_results_as_of: resultSources.map(source => source.retrieved_at).sort()[0] ?? archive.as_of,
      fixture_as_of: fixtureSource.retrieved_at,
      max_source_age_seconds: 21600,
      settlement_kind: 'win_loss_half_on_tie',
      eligible: false,
      eligibility_reason: 'NFL ties pay half a dollar. The binary recommendation gate is withheld for this payout structure.'
    }
  };
}
