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
  assert.equal(forecast.backtest.holdout.n, 184);
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

test('minute replay reproduces the real BTC and ETH holdouts without granting release', () => {
  assert.deepEqual(evaluateCryptoMinuteArchive(archive), receipt);
  for (const result of Object.values(receipt.by_series)) {
    assert.equal(result.holdout.n, 184);
    assert.equal(result.missing_origin_rows, 0);
    assert.ok(result.holdout.brier < result.holdout.static_brier);
    assert.equal(result.release_eligible, false);
  }
});
