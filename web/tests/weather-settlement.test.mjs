import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DAY} from '../lib/intelligence/sources.mjs';
import {gfsDailyHighs, weatherSettlementContract, weatherSettlementForecast, estimateWeatherSettlement} from '../lib/intelligence/weather-settlement.mjs';
import {evaluateWeatherArchive} from '../tools/validate_weather_settlement.mjs';

const fixture = {series: 'KXHIGHNY', ticker: 'KXHIGHNY-26NOV06-T70', event_ticker: 'KXHIGHNY-26NOV06',
  rules_primary: 'If the maximum temperature recorded at New York City (CLINYC) for Nov 6, 2026, is greater than 70° fahrenheit according to The Weather Company, then the market resolves to Yes.',
  strike_type: 'greater', floor_strike: 70, close_time: '2026-11-07T06:00:00Z'};

test('same-station MOS keeps only the archived 00 UTC daytime maximum', () => {
  const csv = [
    'runtime,ftime,model,n_x,station',
    '2026-11-06 00:00:00,2026-11-06 12:00:00,GFS,65,KNYC',
    '2026-11-06 06:00:00,2026-11-07 00:00:00,GFS,81,KNYC',
    '2026-11-06 00:00:00,2026-11-07 00:00:00,GFS,72,KMIA',
    '2026-11-06 00:00:00,2026-11-07 00:00:00,GFS,74,KNYC',
  ].join('\n');
  assert.deepEqual([...gfsDailyHighs(csv, 'KNYC')], [['2026-11-06', 74]]);
});

test('daily maximum requires the exact date, settlement report, strike and type', () => {
  assert.equal(weatherSettlementContract(fixture).bounds.lower, 70.5);
  for (const change of [
    {rules_primary: fixture.rules_primary.replace('CLINYC', 'CLIMIA')},
    {rules_primary: fixture.rules_primary.replace('Nov 6', 'Nov 7')},
    {rules_primary: fixture.rules_primary.replace('The Weather Company', 'another publisher')},
    {floor_strike: 71},
    {strike_type: 'greater_or_equal'},
  ]) assert.equal(weatherSettlementContract({...fixture, ...change}), null);
});

test('weather residual calibration excludes future and still-unpublished outcomes', () => {
  const {origin, bounds} = weatherSettlementContract(fixture);
  const past = Array.from({length: 55}, (_, index) => ({
    origin: origin - (56 - index) * DAY, settled_at: origin - (55 - index) * DAY,
    high: 67 + index % 12, actual: 66 + index % 12 + index % 5,
  }));
  const expected = weatherSettlementForecast(74, bounds, origin, past);
  assert.ok(expected.baseline > 0 && expected.baseline < 1);
  const future = {origin: origin - DAY, settled_at: origin + 1, high: 74, actual: 120};
  assert.deepEqual(weatherSettlementForecast(74, bounds, origin, [...past, future]), expected);
  const packet = {day:'2026-11-06', high:74, station:'KNYC', retrieved_at: new Date(origin).toISOString(), source_url:'https://example.test/mos'};
  const live = estimateWeatherSettlement(fixture, fixture.series, packet, past, {release_reason:'Pending more validation'}, origin);
  assert.equal(live.eligible, false);
  assert.equal(live.probability, expected.baseline);
  assert.equal(estimateWeatherSettlement(fixture, fixture.series, packet, past, {}, origin - 1), null);
});

test('each station replay reproduces its public receipt and stays below the release gate', async () => {
  const [archive, receipt] = await Promise.all([
    readFile(new URL('../research-data/weather-settlement-archive.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../public/research/weather-settlement.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const result = evaluateWeatherArchive(archive);
  assert.deepEqual(result, receipt);
  assert.equal(Object.values(result.by_series).reduce((sum, row) => sum + row.holdout.contracts, 0), 900);
  assert.ok(Object.values(result.by_series).every(row => row.holdout.baseline_brier < row.holdout.raw_mos_brier && !row.release_eligible));
});
