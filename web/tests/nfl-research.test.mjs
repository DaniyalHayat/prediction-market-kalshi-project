import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sportsResearch} from '../lib/workspace/sports.mjs';
import {matchNFLFixture, nflContractIdentity, parseNFLScoreboard} from '../lib/workspace/nfl-source.mjs';
import {earlierNFLGames, fitNFL, NFL_RESULT_LAG_MS} from '../lib/workspace/nfl-math.mjs';
import {evaluatePaperPosition,usableForecast} from '../lib/workspace/positions.mjs';
import {positionIdeaCandidates} from '../lib/workspace/router.mjs';
import {tradeCandidates} from '../lib/workspace/recommendations.mjs';
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

test('position review uses released NFL payout ranges for both sides without changing binary eligibility',async()=>{
  const open={...market,status:'active',close_time:fixture.played_at};
  const sports=await sportsResearch(open,{getter:provider().getter,now});
  const research={ticker:open.ticker,market:open,forecast:sports.forecast,extensions:{sports}};
  const book={ticker:open.ticker,as_of:new Date(now()).toISOString(),raw:{orderbook_fp:{yes_dollars:[['.08','20']],no_dollars:[['.91','20']]}}};
  const review=side=>evaluatePaperPosition({ticker:open.ticker,side,remaining_quantity:10,remaining_basis:5},book,research,{now:now()});
  const yes=review('yes'),no=review('no');
  assert.equal(usableForecast(research,now(),open.ticker).eligible,false);
  assert.equal(yes.action,'HOLD');
  assert.ok(yes.unrealized_pnl<0);
  assert.equal(no.action,'EXIT');
  assert.equal(yes.probability,null);
  assert.equal(no.probability,null);
  assert.equal(yes.nfl_settlement.win_probability,sports.forecast.outcomes.win);
  assert.equal(no.nfl_settlement.win_probability,sports.forecast.outcomes.loss);
  assert.equal(no.nfl_settlement.tie_payout,.5);
  assert.ok(Math.abs(yes.nfl_settlement.expected_per_contract+no.nfl_settlement.expected_per_contract-1)<1e-10);
  assert.ok(Math.abs(yes.fair_value_range[0]+no.fair_value_range[1]-10)<1e-10);
  assert.ok(Math.abs(yes.fair_value_range[1]+no.fair_value_range[0]-10)<1e-10);
});

test('position review withholds NFL actions for altered rules, bad payout data and a failed gate',async()=>{
  const open={...market,status:'open',close_time:fixture.played_at};
  const sports=await sportsResearch(open,{getter:provider().getter,now});
  const research={ticker:open.ticker,market:open,forecast:sports.forecast,extensions:{sports}};
  const book={ticker:open.ticker,as_of:new Date(now()).toISOString(),raw:{orderbook_fp:{yes_dollars:[['.08','20']],no_dollars:[['.91','20']]}}};
  const lot={ticker:open.ticker,side:'yes',remaining_quantity:10,remaining_basis:5};
  const evaluate=(overrides={},fixtureOverrides={},current=open)=>evaluatePaperPosition(lot,book,
    {...research,forecast:{...sports.forecast,...overrides},extensions:{sports:{...sports,...fixtureOverrides}}},
    {market:current,now:now(),experimental:true});
  assert.match(evaluate({},{},{...open,rules_secondary:open.rules_secondary.replace('$0.50','$0.25')}).reason,/did not verify/);
  for(const forecast of [{outcomes:{win:.5,loss:.5,tie:.1}},{expected_settlement_value:.95},{settlement_value_interval:[.95,1]},
    {settlement_value_interval:[-1,1]}])assert.match(evaluate(forecast).reason,/did not reconcile/);
  for(const forecast of [{model_release_passed:false},{validation:{...sports.forecast.validation,passed:false}},
    {validation:{...sports.forecast.validation,payout_mse:1}},{experimental:true},{source_as_of:'2026-10-01T00:00:00Z'}])
    assert.equal(evaluate(forecast).action,'REVIEW');
  for(const fixtureChange of [{coverage:{partial:true}},{selection:{code:'SEA'}},{event:{...sports.event,state:'in'}},
    {event:{...sports.event,played_at:new Date(now()-1000).toISOString()}}])
    assert.equal(evaluate({},fixtureChange).action,'REVIEW');
});

test('position replacements rank validated NFL tie-adjusted payouts only when the lower bound beats the fee-inclusive entry',async()=>{
  const open={...market,category:'sports',status:'active',close_time:fixture.played_at};
  const sports=await sportsResearch(open,{getter:provider().getter,now});
  const research={ticker:open.ticker,market:open,forecast:sports.forecast,extensions:{sports}};
  const {expected_settlement_value:expected,outcomes}=sports.forecast;
  const depth=(yes,no)=>({ticker:open.ticker,as_of:new Date(now()).toISOString(),
    raw:{orderbook_fp:{yes_dollars:[[String(yes),'20']],no_dollars:[[String(no),'20']]}}});
  const alternatives=(book,forecast={},exact=open,extras={})=>positionIdeaCandidates(exact,book,
    {...research,...extras,forecast:{...sports.forecast,...forecast}},{now:now(),budget:20});
  assert.deepEqual(tradeCandidates(open,depth(.08,.91),research,{now:now()}),[]);
  const [yes]=alternatives(depth(.08,.91)),[no]=alternatives(depth(.91,.08));
  for(const [row,side,value,win] of [[yes,'YES',expected,outcomes.win],[no,'NO',1-expected,outcomes.loss]]){
    assert.equal(row.side,side);
    assert.equal(row.eligible,true);
    assert.equal(row.probability,null);
    assert.equal(row.probability_yes,null);
    assert.equal(row.settlement_value,value);
    assert.equal(row.win_probability,win);
    assert.equal(row.tie_probability,outcomes.tie);
    assert.equal(row.tie_payout,.5);
    assert.ok(row.fee>0&&row.cost<=20&&row.expected_profit>0);
    assert.equal(row.conservative_edge,row.settlement_value_range[0]-row.cost/row.contracts-.02);
    assert.ok(row.conservative_edge>0);
  }
  assert.deepEqual(alternatives(depth(expected-.01,1-expected-.01)),[]);
  for(const forecast of [{experimental:true},{model_release_passed:false},{expected_settlement_value:.95},
    {validation:{...sports.forecast.validation,payout_mse:1}},{source_as_of:'2026-10-01T00:00:00Z'}])
    assert.deepEqual(alternatives(depth(.08,.91),forecast),[]);
  assert.deepEqual(alternatives(depth(.08,.91),{},{...open,rules_secondary:'A tie resolves No.'}),[]);
  assert.deepEqual(alternatives(depth(.08,.91),{},{...open,status:'closed'}),[]);
  assert.deepEqual(alternatives(depth(.08,.91),{},open,{extensions:{sports:{...sports,coverage:{partial:true}}}}),[]);
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
