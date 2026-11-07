import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import test from 'node:test';
import {categoryById} from '../lib/intelligence/catalog.mjs';
import {distribution} from '../lib/intelligence/index.mjs';
import {estimateMinuteCrypto, minuteCryptoContract, minuteCryptoForecast, parseClosedMinuteBars} from '../lib/intelligence/crypto-minute.mjs';
import {evaluateCryptoMinuteArchive} from '../tools/validate_crypto_minute.mjs';

const archive = JSON.parse(gunzipSync(readFileSync(new URL('../research-data/crypto-minute-archive.json.gz', import.meta.url))));
const receipt = JSON.parse(readFileSync(new URL('../public/research/crypto-minute.json', import.meta.url)));
const market = {series: 'KXBTC15M', event_ticker: 'KXBTC15M-26NOV062130', ticker: 'KXBTC15M-26NOV062130-30',
  strike_type: 'greater_or_equal', floor_strike: 75991.09, close_time: '2026-11-07T02:30:00Z',
  rules_primary: "If the simple average of the sixty seconds of CF Benchmarks' BRTI before 9:30 PM EST on Nov 6, 2026 is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before 9:15 PM EST on November 6, 2026, then the market resolves to Yes."};

test('minute forecast recognizes only exact index, time zone, strike and reference window', () => {
  const contract = minuteCryptoContract(market);
  assert.equal(new Date(contract.open).toISOString(), '2026-11-07T02:15:00.000Z');
  assert.equal(new Date(contract.close).toISOString(), market.close_time.replace('Z', '.000Z'));
  assert.equal(minuteCryptoContract({...market, rules_primary: market.rules_primary.replace('9:15 PM', '9:14 PM')}), null);
  assert.equal(minuteCryptoContract({...market, rules_primary: market.rules_primary.replaceAll('BRTI', 'ETHUSDRTI')}), null);
  assert.equal(minuteCryptoContract({...market, floor_strike: null}), null);
  assert.equal(minuteCryptoContract({...market, strike_type: 'greater'}), null);
  const now = contract.close - 480000;
  const bars = Array.from({length: 300}, (_, i) => [now - (299 - i) * 60000, 76000 + Math.sin(i) * 30 + i / 10, 76000 + Math.sin(i - .2) * 30 + i / 10]);
  const forecast = distribution(market, categoryById('crypto'), {sources: [{series: market.series, bars}]}, new Map(), now);
  assert.equal(forecast.inputs.horizon_minutes, 8);
  assert.equal(forecast.backtest.holdout.n, 1985);
  assert.deepEqual(forecast.inputs.calibrated_profile, receipt.by_series.KXBTC15M.selected_profile);
  assert.equal(minuteCryptoForecast(contract, bars, now - 60000, receipt.by_series.KXBTC15M.selected_profile).calibrated_profile, null);
  assert.equal(forecast.eligible, false);
  assert.equal(forecast.independent_forecast, true);
  assert.match(estimateMinuteCrypto(market, {series:'KXETH15M', bars}, now).reason, /matching/i);
});

test('completed candles and retrospective forecasts reject future values and reference gaps', () => {
  const {outcomes, bars} = archive.series.KXBTC15M, contract = outcomes.at(-10);
  const now = contract.close - archive.lead_ms, future = bars.map(row => row[0] > now ? [row[0], 1, 1] : row);
  const original = minuteCryptoForecast(contract, bars, now);
  assert.ok(original);
  assert.deepEqual(minuteCryptoForecast(contract, future, now), original);
  assert.equal(minuteCryptoForecast(contract, bars.filter(row => row[0] !== contract.open), now), null);
  assert.deepEqual(parseClosedMinuteBars([[60, 9, 13, 10, 12], [0, 9, 12, 10, 11]], 60000), [[60000, 11, 10.5]]);
});

test('minute replay reproduces both independently timed holdouts and checks fee-adjusted releases', () => {
  assert.deepEqual(evaluateCryptoMinuteArchive(archive), receipt);
  for (const result of Object.values(receipt.by_series)) {
    assert.ok(result.holdout.n >= 1978);
    assert.equal(result.held_out_days, 21);
    assert.ok(result.missing_origin_rows <= 2);
    assert.ok(result.holdout.brier < result.holdout.baseline_brier);
    assert.ok(result.holdout.paired_brier_gain_95[0] > 0);
    assert.equal(result.midpoint_benchmark.n, result.holdout.n);
    assert.ok(result.midpoint_benchmark.baseline_brier < result.midpoint_benchmark.brier);
    assert.ok(result.paper_replay.net_pnl_dollars < 0);
    assert.equal(result.release_gates.verified_historical_depth, false);
    assert.equal(result.release_eligible, false);
  }
});
