import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  evaluateSettlementCalibration,
  settlementCandidate,
  settlementCalibrationDiagnostic,
  settlementObservation
} from '../lib/workspace/settlement-calibration.mjs';
import archive from '../research-data/settlement-calibration-archive.json' with {type: 'json'};
import receipt from '../public/research/settlement-calibration.json' with {type: 'json'};

test('settlement replay fits only earlier settlements and excludes overlap and duplicate events', () => {
  const cutoff = Date.parse(receipt.split.cutoff) / 1000;
  const evaluated = evaluateSettlementCalibration(archive.observations);
  const changed = archive.observations.map(row => row.observed_ts >= cutoff ? {...row, outcome: 1 - row.outcome} : row);
  assert.deepEqual(evaluateSettlementCalibration(changed).coefficients, evaluated.coefficients);
  assert.equal(evaluated.split.embargo_n, 17);
  assert.ok(evaluated.scored.every(row => row.observed_ts >= cutoff));
  assert.throws(() => evaluateSettlementCalibration([...archive.observations, archive.observations[0]]), RangeError);
});

test('the archived data and losing held-out result reproduce the public receipt', () => {
  const evaluated = evaluateSettlementCalibration(archive.observations);
  assert.equal(createHash('sha256').update(JSON.stringify(archive)).digest('hex'), receipt.archive_sha256);
  assert.deepEqual(evaluated.overall, receipt.overall);
  assert.deepEqual(evaluated.brier_gain_interval_95, receipt.brier_gain_interval_95);
  assert.ok(evaluated.overall.challenger_brier > evaluated.overall.midpoint_brier);
  assert.equal(evaluated.eligible, false);
  assert.ok(receipt.network_requests <= 35);
});

test('any interior quote can produce a labeled diagnostic including categories without replay coverage', () => {
  for (const category of ['sports', 'travel', 'weather', 'science', 'culture', 'macro', 'climate', 'crypto', 'other']) {
    for (const midpoint of [.001, .37, .999]) {
      const signal = settlementCalibrationDiagnostic(midpoint, receipt, category);
      assert.equal(signal.available, true);
      assert.ok(signal.probability > 0 && signal.probability < 1);
      assert.equal(signal.eligible, false);
      assert.equal(signal.independent_forecast, false);
      assert.equal(signal.category_coverage.holdout_n, receipt.by_category[category]?.holdout_n ?? 0);
    }
  }
  assert.equal(settlementCalibrationDiagnostic(0, receipt, 'sports').available, false);
  assert.equal(settlementCalibrationDiagnostic(NaN, receipt, 'sports').available, false);
});

test('scalar payouts and candles outside the fixed observation window are excluded', () => {
  const market = {
    ticker: 'KXNFLGAME-SAMPLE-A', event_ticker: 'KXNFLGAME-SAMPLE',
    status: 'finalized', market_type: 'binary', result: 'yes', settlement_value_dollars: '1.0000',
    open_time: '2026-10-01T00:00:00.000Z', created_time: '2026-10-01T00:00:00.000Z',
    close_time: '2026-10-02T00:00:00.000Z', settlement_ts: '2026-10-02T01:00:00.000Z'
  };
  assert.equal(settlementCandidate({...market, settlement_value_dollars: '0.5000'}, 'sports', 'KXNFLGAME'), null);
  const candidate = settlementCandidate(market, 'sports', 'KXNFLGAME');
  const candle = {end_period_ts: candidate.open_ts + 3600, volume_fp: '2.00',
    yes_bid: {close_dollars: '0.3000'}, yes_ask: {close_dollars: '0.5000'}};
  assert.equal(settlementObservation(candidate, [{...candle, end_period_ts: candidate.latest_observation_ts + 3600}]), null);
  assert.equal(settlementObservation(candidate, [{...candle, volume_fp: '0.00'}]), null);
  assert.equal(settlementObservation(candidate, [candle]).midpoint, .4);
});
