const HOUR = 3600;
const WEEK = 7 * 86400;
const MINIMUM_LEAD = 6 * HOUR;
const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const logit = probability => Math.log(probability / (1 - probability));
const seconds = value => Date.parse(value) / 1000;
const numeric = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) :
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const SETTLEMENT_CALIBRATION_PROTOCOL = Object.freeze({
  window_start: '2026-08-13T00:00:00.000Z',
  holdout_start: '2026-10-01T00:00:00.000Z',
  window_end: '2026-11-05T00:00:00.000Z',
  candle_period_minutes: 60,
  maximum_hours_after_open: 48,
  minimum_lead_hours: 6,
  per_category_per_week: 4,
  calibration_penalty: 10,
  series: Object.freeze({
    sports: ['KXNFLGAME', 'KXNBAGAME'],
    macro: ['KXCPI', 'KXFEDDECISION'],
    crypto: ['KXBTC', 'KXETH'],
    travel: ['KXTSAD', 'KXTSA'],
    weather: ['KXHIGHNY', 'KXHIGHCHI'],
    science: ['KXTOPMODEL', 'KXSPACEXCOUNT'],
    climate: ['KXHURRICANE', 'KXRAINNYC'],
    culture: ['KXRANKLIST1SONG', 'KXRT']
  })
});

export function settlementCandidate(market, category, series) {
  if (!SETTLEMENT_CALIBRATION_PROTOCOL.series[category]?.includes(series) ||
      !market?.ticker?.startsWith(series + '-') || !market.event_ticker?.startsWith(series + '-') ||
      !['finalized', 'settled'].includes(market.status) || market.market_type !== 'binary' ||
      !['yes', 'no'].includes(market.result)) return null;
  const label = Number(market.result === 'yes');
  if (numeric(market.settlement_value_dollars) !== label) return null;
  const opened = Math.max(seconds(market.open_time), seconds(market.created_time));
  const close = seconds(market.close_time), settled = seconds(market.settlement_ts);
  if (![opened, close, settled].every(Number.isFinite) || settled <= opened ||
      opened < seconds(SETTLEMENT_CALIBRATION_PROTOCOL.window_start) ||
      settled >= seconds(SETTLEMENT_CALIBRATION_PROTOCOL.window_end)) return null;
  const originalExpiration = seconds(market.expected_expiration_time);
  const latest = Math.min(close, settled, Number.isFinite(originalExpiration) ? originalExpiration : Infinity);
  if (latest - opened < MINIMUM_LEAD + HOUR) return null;
  return {
    ticker: market.ticker,
    event_ticker: market.event_ticker,
    category,
    series,
    open_ts: opened,
    close_ts: close,
    settled_ts: settled,
    expiry_ts: Number.isFinite(originalExpiration) ? originalExpiration : null,
    latest_observation_ts: Math.min(opened + 48 * HOUR, latest - MINIMUM_LEAD),
    outcome: label
  };
}

export function settlementObservation(candidate, candles) {
  if (!Array.isArray(candles)) return null;
  for (const candle of [...candles].sort((a, b) => a.end_period_ts - b.end_period_ts)) {
    const end = candle.end_period_ts;
    const bid = numeric(candle.yes_bid?.close_dollars), ask = numeric(candle.yes_ask?.close_dollars);
    const volume = numeric(candle.volume_fp);
    if (!Number.isSafeInteger(end) || end < candidate.open_ts + HOUR ||
        end > candidate.latest_observation_ts || volume === null || volume < 1 ||
        bid === null || ask === null || bid <= 0 || ask >= 1 || bid > ask || ask - bid > .25) continue;
    return {...candidate, observed_ts: end, bid, ask, volume, midpoint: (bid + ask) / 2};
  }
  return null;
}

export function fitSettlementCalibration(rows, penalty = SETTLEMENT_CALIBRATION_PROTOCOL.calibration_penalty) {
  if (!Array.isArray(rows) || !Number.isFinite(penalty) || penalty <= 0 ||
      rows.some(row => ![0, 1].includes(row.outcome) || !(row.midpoint > 0 && row.midpoint < 1))) {
    throw new RangeError('A valid binary calibration sample and positive penalty are required.');
  }
  if (rows.length < 20 || new Set(rows.map(row => row.outcome)).size < 2) return null;
  const data = rows.map(row => ({x: logit(row.midpoint), y: row.outcome}));
  let intercept = 0, slope = 1;
  for (let iteration = 0; iteration < 32; iteration++) {
    let g0 = -penalty * intercept, g1 = -penalty * (slope - 1);
    let h00 = penalty, h01 = 0, h11 = penalty;
    for (const row of data) {
      const p = sigmoid(intercept + slope * row.x), variance = p * (1 - p);
      g0 += row.y - p;
      g1 += (row.y - p) * row.x;
      h00 += variance;
      h01 += variance * row.x;
      h11 += variance * row.x ** 2;
    }
    const determinant = h00 * h11 - h01 ** 2;
    const step0 = (h11 * g0 - h01 * g1) / determinant;
    const step1 = (h00 * g1 - h01 * g0) / determinant;
    const scale = Math.max(1, Math.abs(step0), Math.abs(step1));
    intercept += step0 / scale;
    slope += step1 / scale;
    if (Math.max(Math.abs(step0), Math.abs(step1)) < 1e-8) break;
  }
  return {intercept, slope, penalty};
}

export function calibratedSettlementProbability(midpoint, coefficients) {
  if (!Number.isFinite(midpoint) || midpoint <= 0 || midpoint >= 1 ||
      !Number.isFinite(coefficients?.intercept) || !Number.isFinite(coefficients?.slope)) return null;
  return sigmoid(coefficients.intercept + coefficients.slope * logit(midpoint));
}

export function settlementCalibrationDiagnostic(midpoint, receipt, category) {
  const base = {classification: 'exchange_derived_settlement_calibration_research', eligible: false,
    independent_forecast: false, validation_url: '/research/settlement-calibration.json'};
  const probability = receipt?.available === true ? calibratedSettlementProbability(midpoint, receipt.coefficients) : null;
  if (probability === null) return {...base, available: false, reason: 'A valid two-sided midpoint and completed calibration replay are required.'};
  const observed = receipt.by_category && Object.hasOwn(receipt.by_category, category) ? receipt.by_category[category] : null;
  return {
    ...base,
    available: true,
    probability,
    midpoint,
    category_coverage: {training_n: observed?.training_n ?? 0, holdout_n: observed?.holdout_n ?? 0},
    validation: {overall: receipt.overall, brier_gain_interval_95: receipt.brier_gain_interval_95},
    note: 'Pooled transformation of the current exchange midpoint. The replay covered early-listing hourly quotes; other horizons extend beyond that sample. The held-out midpoint scored better overall.'
  };
}

function metrics(rows) {
  const crossEntropy = (p, y) => -(y ? Math.log(p) : Math.log1p(-p));
  return {
    n: rows.length,
    midpoint_brier: mean(rows.map(row => (row.midpoint - row.outcome) ** 2)),
    challenger_brier: mean(rows.map(row => (row.challenger - row.outcome) ** 2)),
    midpoint_log_loss: mean(rows.map(row => crossEntropy(row.midpoint, row.outcome))),
    challenger_log_loss: mean(rows.map(row => crossEntropy(row.challenger, row.outcome)))
  };
}

export function evaluateSettlementCalibration(rows, cutoff = SETTLEMENT_CALIBRATION_PROTOCOL.holdout_start) {
  const boundary = seconds(cutoff);
  if (!Number.isFinite(boundary) || !Array.isArray(rows) ||
      rows.some(row => !Number.isFinite(row.observed_ts) || !Number.isFinite(row.settled_ts) ||
        row.observed_ts >= row.settled_ts || ![0, 1].includes(row.outcome) ||
        !Number.isFinite(row.midpoint) || row.midpoint <= 0 || row.midpoint >= 1) ||
      new Set(rows.map(row => row.event_ticker)).size !== rows.length) {
    throw new RangeError('Distinct events with ordered quotes and binary settlements are required.');
  }
  const training = rows.filter(row => row.settled_ts < boundary);
  const holdout = rows.filter(row => row.observed_ts >= boundary);
  const coefficients = fitSettlementCalibration(training);
  const split = {cutoff, training_n: training.length, holdout_n: holdout.length,
    embargo_n: rows.length - training.length - holdout.length};
  const base = {classification: 'exchange_derived_settlement_calibration_research', eligible: false,
    independent_forecast: false, coefficients, split};
  if (!coefficients || !holdout.length) return {...base, available: false, reason: 'Insufficient earlier binary settlements or later observations.'};
  const scored = holdout.map(row => ({...row, challenger: calibratedSettlementProbability(row.midpoint, coefficients)}));
  const overall = metrics(scored);
  const groups = new Map();
  for (const row of scored) {
    const week = Math.floor((row.observed_ts - boundary) / WEEK);
    if (!groups.has(week)) groups.set(week, []);
    groups.get(week).push((row.midpoint - row.outcome) ** 2 - (row.challenger - row.outcome) ** 2);
  }
  const weeks = [...groups.values()].map(group => ({n: group.length, total: group.reduce((s, x) => s + x, 0)}));
  let seed = 147321;
  const bootstrap = weeks.length < 2 ? [] : Array.from({length: 2000}, () => {
    let n = 0, total = 0;
    for (let i = 0; i < weeks.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const sample = weeks[Math.floor(seed / 4294967296 * weeks.length)];
      n += sample.n;
      total += sample.total;
    }
    return total / n;
  }).sort((a, b) => a - b);
  return {
    ...base, available: true, overall, weekly_blocks: weeks.length,
    brier_gain: overall.midpoint_brier - overall.challenger_brier,
    brier_gain_interval_95: bootstrap.length ? [bootstrap[50], bootstrap[1949]] : null,
    by_category: Object.fromEntries(Object.keys(SETTLEMENT_CALIBRATION_PROTOCOL.series).map(category => {
      const samples = scored.filter(row => row.category === category);
      return [category, {
        training_n: training.filter(row => row.category === category).length,
        holdout_n: samples.length, metrics: samples.length ? metrics(samples) : null
      }];
    })),
    scored
  };
}
