import assert from 'node:assert/strict';
import test from 'node:test';
import {nbaAvailabilityFeedback, screenAvailabilityForecast} from '../lib/workspace/nba-availability-feedback.mjs';

const now = Date.parse('2026-11-06T18:00:00Z');
const fixtureSource = (event = '900', observed = now - 5000) => ({
  url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=' + event,
  retrieved_at: new Date(observed).toISOString()
});

function input() {
  const games = Array.from({length: 7}, (_, index) => {
    const atHome = index % 2 === 0, win = index >= 3, homeWin = atHome === win;
    return {id: String(index + 1), league: 'nba', completed: true,
      played_at: new Date(now - (8 - index) * 86400000).toISOString(),
      home_id: atHome ? '1' : '3', away_id: atHome ? '3' : '1', home_score: homeWin ? 110 : 100, away_score: homeWin ? 100 : 110};
  });
  return {
    game: {id: '900', league: 'nba', completed: false, home_id: '1', away_id: '2', played_at: new Date(now + 3600000).toISOString()},
    selection: 'home', forecast: {probability: .6, interval: [.52, .68], eligible: true},
    current: {source: fixtureSource(), rows: [{player_id: '8', team_id: '1', name: 'Roster Player', status: 'Out'}]},
    games, playerRows: games.map((game, index) => ({
      game_id: game.id, team_id: '1', player_id: '8', minutes: index < 3 ? 0 : 28, did_not_play: index < 3
    })),
    baseline: {predict: () => ({home: .55}), trained_through: new Date(now - 9 * 86400000).toISOString()}, now
  };
}

test('a confirmed exact-game absence changes a scenario and only widens the action range', () => {
  const value = input(), result = nbaAvailabilityFeedback(value), [scenario] = result.scenarios;
  assert.equal(result.status, 'available');
  assert.deepEqual(result.source, value.current.source);
  assert.equal(result.fixture_id, value.game.id);
  assert.equal(scenario.conditional_probability, .48);
  assert.equal(scenario.probability_delta, -.12);
  assert.deepEqual(scenario.historical_fixture_ids, ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(scenario.dnp_games, 3);
  assert.equal(scenario.regular_games, 4);
  assert.deepEqual(result.decision_interval, [.4, .68]);
  const widened = screenAvailabilityForecast(value.forecast, result);
  assert.deepEqual(widened.interval, result.decision_interval);
  assert.equal(widened.probability, .6);
  assert.equal(widened.eligible, true);
  assert.deepEqual(value.forecast.interval, [.52, .68]);

  const otherSide = nbaAvailabilityFeedback({...value, selection: 'away', forecast: {probability: .4, interval: [.32, .48]}});
  assert.equal(otherSide.scenarios[0].conditional_probability, .52);
  assert.deepEqual(otherSide.decision_interval, [.32, .6]);
});

test('stale, wrong-event and narrative inputs cannot affect a forecast', () => {
  const value = input();
  for (const current of [
    {...value.current, source: fixtureSource('901')},
    {...value.current, source: fixtureSource('900', now - 20 * 60_000 - 1)},
    {...value.current, source: fixtureSource('900', now + 1)},
    {...value.current, source: {...fixtureSource(), url: 'https://www.espn.com/nba/story/_/id/1'}},
    {...value.current, rows: [{title: 'LeBron James asks betting app to stop using his likeness', status: 'Out'}]},
    {...value.current, rows: [{...value.current.rows[0], status: {code: 'Out'}}]},
    {...value.current, rows: [{...value.current.rows[0], status: 'Questionable'}]},
    {...value.current, rows: [{...value.current.rows[0], team_id: '3'}]},
    {...value.current, rows: [value.current.rows[0], {...value.current.rows[0], status: 'Available'}]}
  ]) {
    const result = nbaAvailabilityFeedback({...value, current});
    assert.equal(result.status, 'unavailable');
    assert.equal(screenAvailabilityForecast(value.forecast, result), value.forecast);
  }
});

test('opponent-adjusted residuals are calculated independently for each player', () => {
  const value = input();
  const games = value.games.map((game, index) => {
    const atHome = game.home_id === '1', opponent = index < 3 ? '3' : '4';
    const homeWin = atHome === (index === 3);
    return {...game, home_id: atHome ? '1' : opponent, away_id: atHome ? opponent : '1',
      home_score: homeWin ? 110 : 100, away_score: homeWin ? 100 : 110};
  });
  const current = {...value.current, rows: [value.current.rows[0], {...value.current.rows[0], player_id: '9', name: 'Second Player'}]};
  const playerRows = [...value.playerRows, ...value.playerRows.map(row => ({...row, player_id: '9'}))];
  const result = nbaAvailabilityFeedback({...value, games, current, playerRows, baseline: {...value.baseline,
    predict(home, away) {
      const atHome = home === '1', opponent = atHome ? away : home, own = opponent === '3' ? .2 : .8;
      return {home: atHome ? own : 1 - own};
    }
  }});
  assert.equal(result.scenarios.length, 2);
  assert.ok(result.scenarios.every(row => row.probability_delta > 0));
  assert.equal(result.decision_interval[1], result.scenarios[0].scenario_interval[1]);
});

test('duplicate, post-cutoff and ambiguous historical rows cannot supply minimum support', () => {
  const value = input();
  for (const altered of [
    {playerRows: [...value.playerRows, value.playerRows[0]]},
    {playerRows: value.playerRows.map((row, i) => i ? row : {...row, did_not_play: false})},
    {games: [...value.games, value.games[0]]},
    {games: value.games.map((row, i) => i ? row : {...row, played_at: new Date(now + 1).toISOString()})},
    {baseline: {...value.baseline, trained_through: value.games[0].played_at}},
    {game: {...value.game, played_at: new Date(now).toISOString()}},
    {forecast: {...value.forecast, inplay: true}}
  ]) {
    assert.equal(nbaAvailabilityFeedback({...value, ...altered}).status, 'unavailable');
  }
});

test('the trading consumer rejects ranges that would strengthen a recommendation', () => {
  const {forecast} = input();
  const result = nbaAvailabilityFeedback(input());
  assert.equal(screenAvailabilityForecast(forecast, {...result, decision_interval: [.56, .65]}), forecast);
  assert.equal(screenAvailabilityForecast(forecast, {...result, baseline_probability: .65}), forecast);
  assert.equal(screenAvailabilityForecast({...forecast, eligible: false}, result).eligible, false);
});
