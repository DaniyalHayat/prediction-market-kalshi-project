import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sportsResearch} from '../lib/workspace/sports.mjs';
import {matchNFLFixture, nflContractIdentity, parseNFLScoreboard} from '../lib/workspace/nfl-source.mjs';
import {earlierNFLGames, fitNFL, NFL_RESULT_LAG_MS} from '../lib/workspace/nfl-math.mjs';
import archive from '../lib/workspace/models/nfl-results.json' with {type: 'json'};
import validation from '../lib/workspace/models/nfl-validation.json' with {type: 'json'};
import holdout from '../research-data/nfl-heldout-predictions-2025.json' with {type: 'json'};

const now = () => Date.parse('2026-11-05T10:56:00Z');
const ticker = 'KXNFLGAME-26NOV08ARISEA';
const market = {
  ticker: ticker + '-ARI', event_ticker: ticker, title: 'Arizona wins', yes_sub_title: 'Arizona',
  rules_primary: 'If Arizona wins the Arizona vs Seattle Pro Football game originally scheduled for Nov 8, 2026, then the market resolves to Yes.',
  rules_secondary: 'If the game ends in a tie, the market will resolve to $0.50 for each team.'
};
const fixture = {
  id: '401873048', played_at: '2026-11-08T21:25:00.000Z', season: 2026, week: 9, neutral: false,
  away_id: 'ARI', home_id: 'SEA', away_name: 'Arizona Cardinals', home_name: 'Seattle Seahawks',
  away_espn_id: '22', home_espn_id: '26', completed: false
};
function providerEvent(game) {
  const status = game.completed ? {completed: true, state: 'post', name: 'STATUS_FINAL'} :
    {completed: false, state: 'pre', name: 'STATUS_SCHEDULED'};
  return {
    id: game.id, date: game.played_at, season: {year: game.season, type: 2}, week: {number: game.week},
    competitions: [{
      id: game.id, neutralSite: game.neutral, status: {type: status},
      competitors: ['home', 'away'].map(side => ({homeAway: side, score: game[side + '_score'] ?? '0',
        team: {id: game[side + '_espn_id'], abbreviation: game[side + '_id'], displayName: game[side + '_name']}}))
    }]
  };
}
const payload = games => ({leagues: [{slug: 'nfl'}], events: games.map(providerEvent)});
function provider({resultsUnavailable = false} = {}) {
  const requests = [];
  const getter = async (name, url, options) => {
    requests.push({name, url, options});
    const dateOnly = url.endsWith('dates=20261108');
    if (resultsUnavailable && !dateOnly) throw new Error('Controlled upstream failure');
    const records = dateOnly ? [fixture] : archive.games.filter(row => row.played_at.startsWith('2026')).concat(fixture);
    return {data: payload(records), source_url: url, as_of: new Date(now()).toISOString()};
  };
  return {getter, requests};
}

test('Arizona ticker, rule, title and calendar date resolve the exact pregame NFL fixture', () => {
  const identity = nflContractIdentity(market);
  assert.equal(identity.yes_code, 'ARI');
  assert.deepEqual(identity.team_codes, ['ARI', 'SEA']);
  assert.equal(identity.date, '2026-11-08');
  assert.equal(identity.tie_payout_verified, true);
  const {games} = parseNFLScoreboard(payload([fixture]));
  assert.equal(matchNFLFixture(identity, games).side, 'away');
  assert.equal(matchNFLFixture(identity, games).game.nfl_game_url, 'https://www.nfl.com/games/cardinals-at-seahawks-2026-reg-9');
  assert.equal(matchNFLFixture(identity, [games[0], {...games[0], id: '123'}]).game, undefined);
  assert.equal(matchNFLFixture(identity, [{...games[0], played_at: '2026-11-09T21:25:00.000Z'}]).game, undefined);
  assert.equal(nflContractIdentity({...market, title: 'Seattle wins'}).available, false);
  assert.equal(nflContractIdentity({...market, ticker: ticker + '-SEA'}).available, false);
  assert.equal(nflContractIdentity({...market, rules_primary: market.rules_primary.replace('Nov 8', 'Nov 9')}).available, false);
  assert.equal(nflContractIdentity({...market, event_ticker: ticker + 'X'}).available, false);
  assert.equal(nflContractIdentity({...market, rules_primary: market.rules_primary.replace('Arizona vs Seattle', 'New York vs Seattle')}).available, false);
});

test('sports research reports three mutually exclusive outcomes and the verified half-tie expected payout', async () => {
  const {getter, requests} = provider();
  const result = await sportsResearch(market, {getter, now});
  assert.equal(result.event.id, fixture.id);
  assert.equal(result.event.home_espn_id, '26');
  assert.equal(result.event.away_espn_id, '22');
  assert.equal(result.coverage.partial, false);
  assert.equal(requests.length, 2);
  assert.equal(result.model.validation.n, 272);
  assert.equal(result.forecast.model_release_passed, true);
  assert.equal(result.forecast.eligible, false);
  const {outcomes, expected_settlement_value: payout} = result.forecast;
  assert.ok(outcomes.tie > 0);
  assert.ok(Math.abs(outcomes.win + outcomes.loss + outcomes.tie - 1) < 1e-12);
  assert.equal(result.forecast.probability, outcomes.win);
  assert.equal(payout, outcomes.win + .5 * outcomes.tie);
  assert.ok(result.forecast.settlement_value_interval[0] <= payout && result.forecast.settlement_value_interval[1] >= payout);
  assert.equal(result.teams.find(row => row.id === 'ARI').espn_team_id, '22');
});

test('uncertain payout, kickoff, and source failure gates preserve honest availability', async () => {
  const normal = provider();
  const unsupported = await sportsResearch({...market, rules_secondary: 'A tie resolves No.'}, {getter: normal.getter, now});
  assert.equal(unsupported.forecast, null);
  assert.equal(normal.requests.length, 0);
  const started = await sportsResearch(market, {getter: normal.getter, now: () => Date.parse(fixture.played_at)});
  assert.equal(started.forecast, null);
  assert.match(started.reason, /pregame only/);
  const fallback = await sportsResearch(market, {getter: provider({resultsUnavailable: true}).getter, now});
  assert.ok(fallback.forecast);
  assert.equal(fallback.coverage.partial, true);
  assert.equal(fallback.forecast.model_release_passed, false);
});

test('the archived validation forecasts only from results with the fixed 36-hour availability gap', () => {
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(digest(archive.games), validation.archive_sha256);
  assert.equal(digest(holdout), validation.prediction_rows_sha256);
  assert.equal(holdout.length, 272);
  assert.equal(new Set(holdout.map(row => row.week)).size, 18);
  for (const row of holdout) {
    assert.ok(Date.parse(row.last_training_kickoff) <= Date.parse(row.played_at) - NFL_RESULT_LAG_MS);
  }
  const first = holdout[0];
  const firstGame = archive.games.find(game => game.id === first.id);
  const prior = earlierNFLGames(archive.games, Date.parse(first.played_at));
  assert.equal(prior.length, first.training_games);
  assert.deepEqual(fitNFL(prior).predict(firstGame).all, first.probabilities);
  assert.ok(validation.brier < validation.baseline_brier);
});
