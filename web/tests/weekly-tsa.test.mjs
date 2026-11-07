import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {categoryById} from '../lib/intelligence/catalog.mjs';
import {distribution} from '../lib/intelligence/index.mjs';
import {estimateWeeklyTsa, weeklyTsaContract, weeklyTsaForecast, weeklyTsaProbability} from '../lib/intelligence/weekly-tsa.mjs';
import {evaluateWeeklyTsaArchive} from '../tools/validate_weekly_tsa.mjs';

const now = Date.parse('2026-11-07T02:00:00Z');
const archive = JSON.parse(readFileSync(new URL('../research-data/weekly-tsa-archive.json', import.meta.url)));
const receipt = JSON.parse(readFileSync(new URL('../public/research/weekly-tsa.json', import.meta.url)));
const rows = archive.observations.map(([date, value]) => ({date, value}));
const end = Date.parse('2026-11-08T00:00:00Z');
const source = {name: 'TSA', rows, retrieved_at: new Date(now).toISOString(), latest_observation: rows.at(-1).date};
const market = {series: 'KXTSAW', event_ticker: 'KXTSAW-26NOV08', ticker: 'KXTSAW-26NOV08-A2.55',
  close_time: '2026-11-09T04:59:00Z', strike_type: 'greater', floor_strike: 2550000,
  rules_primary: 'If weekly average TSA airport screenings are above 2.55 million for the week ending November 08, 2026, according to the TSA, then the market resolves to Yes.'};

test('weekly TSA matches Sunday, exact authority and strict strike before forecasting', () => {
  assert.equal(weeklyTsaContract(market).end, end);
  assert.equal(weeklyTsaContract({...market, floor_strike: 2500000}), null);
  assert.equal(weeklyTsaContract({...market, strike_type: 'greater_or_equal'}), null);
  assert.equal(weeklyTsaContract({...market, rules_primary: market.rules_primary.replace('the TSA', 'an airport')}), null);
  const forecast = distribution(market, categoryById('travel'), {sources: [source]}, new Map(), now);
  assert.equal(forecast.eligible, false);
  assert.equal(forecast.independent_forecast, true);
  assert.equal(forecast.inputs.observed_days, 3);
  assert.equal(forecast.backtest.holdout.events, 14);
  assert.match(forecast.release_reason, /did not improve/i);
  assert.ok(forecast.interval[0] < forecast.probability && forecast.probability < forecast.interval[1]);
  assert.match(estimateWeeklyTsa(market, {...source, retrieved_at: '2026-11-06T00:00:00Z'}, now).reason, /stale/i);
});

test('weekly prediction ignores rows after the implied publication cutoff', () => {
  const before = weeklyTsaForecast(rows, end, 4);
  const later = rows.map(row => row.date > '2026-11-04' ? {...row, value: row.value * 2} : row);
  assert.deepEqual(weeklyTsaForecast(later, end, 4), before);
  assert.equal(weeklyTsaForecast(rows.filter(row => row.date !== '2026-11-04'), end, 4), null);
  assert.ok(weeklyTsaProbability(before, before.range[0]).probability > weeklyTsaProbability(before, before.range[1]).probability);
  assert.equal(weeklyTsaProbability({center: 100, errors: [-1, 0, 1]}, 100).probability, .375);
});

test('weekly replay reproduces independently scored finalized settlements and retains a failed release gate', () => {
  assert.deepEqual(evaluateWeeklyTsaArchive(archive), receipt);
  assert.equal(receipt.holdout.contracts, 294);
  assert.ok(receipt.holdout.brier > receipt.holdout.baseline_brier);
  assert.equal(receipt.release_eligible, false);
});
