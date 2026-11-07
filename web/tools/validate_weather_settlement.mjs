import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mean, quantile} from '../lib/intelligence/math.mjs';
import {gfsDailyHighs, weatherMosURL, weatherSettlementContract, weatherSettlementForecast, WEATHER_SETTLEMENT_SITES} from '../lib/intelligence/weather-settlement.mjs';

const ARCHIVE = new URL('../research-data/weather-settlement-archive.json', import.meta.url);
const RECEIPT = new URL('../public/research/weather-settlement.json', import.meta.url);
const START = '2026-06-01', HOLDOUT = '2026-09-01', END = '2026-11-07';
const hash = value => createHash('sha256').update(value).digest('hex');

async function capture(directory) {
  const by_series = {};
  for (const [series, {station}] of Object.entries(WEATHER_SETTLEMENT_SITES)) {
    const [csv, settlements] = await Promise.all([
      readFile(join(directory, station.toLowerCase() + '-gfs-replay.csv'), 'utf8'),
      readFile(join(directory, station + '-settlements.json'), 'utf8'),
    ]);
    const highs = gfsDailyHighs(csv, station), events = new Map(), tickers = new Set();
    let missing_forecast_contracts = 0;
    for (const market of JSON.parse(settlements)) {
      const contract = weatherSettlementContract(market, series);
      const actual = Number(market.expiration_value), settled_at = Date.parse(market.settlement_ts);
      const opened = Date.parse(market.open_time), created = Date.parse(market.created_time);
      if (!contract || !['yes', 'no'].includes(market.result) || !['settled', 'finalized'].includes(market.status) ||
          market.market_type !== 'binary' || !/^-?\d+(?:\.0+)?$/.test(market.expiration_value || '') ||
          !Number.isInteger(actual) || !Number.isFinite(settled_at) || !Number.isFinite(opened) || !Number.isFinite(created) ||
          market.settlement_value_dollars == null || market.settlement_value_dollars === '' ||
          Number(market.settlement_value_dollars) !== Number(market.result === 'yes') ||
          contract.day < START || contract.day >= END || Math.max(opened, created) >= contract.origin ||
          contract.close <= contract.origin || settled_at <= contract.origin || tickers.has(market.ticker)) continue;
      const high = highs.get(contract.day);
      if (!Number.isInteger(high)) { missing_forecast_contracts++; continue; }
      const {lower, upper} = contract.bounds;
      const outcome = Number(market.result === 'yes');
      if (outcome !== Number(actual >= lower && actual < upper)) throw new Error('Settlement disagrees with the published strike for ' + market.ticker);
      const event = events.get(contract.day) || {day: contract.day, origin: contract.origin, settled_at, actual, high, outcomes: []};
      if (event.actual !== actual) throw new Error('Conflicting measurements for ' + contract.day);
      event.settled_at = Math.max(event.settled_at, settled_at);
      event.outcomes.push([market.ticker, Number.isFinite(lower) ? lower : null, Number.isFinite(upper) ? upper : null, outcome]);
      events.set(contract.day, event);
      tickers.add(market.ticker);
    }
    const rows = [...events.values()].sort((a, b) => a.day.localeCompare(b.day));
    for (const row of rows) row.outcomes.sort(([a], [b]) => a.localeCompare(b));
    if (rows.length < 50) throw new Error('Insufficient matched daily settlements for ' + series + ': ' + rows.length);
    by_series[series] = {station, missing_forecast_contracts, events: rows,
      sources: {forecast: {url: weatherMosURL(station, START + 'T00:00Z', END + 'T00:00Z'), sha256: hash(csv)},
        outcomes: {urls: ['/markets?status=settled&series_ticker=', '/historical/markets?series_ticker=']
          .map(path => 'https://external-api.kalshi.com/trade-api/v2' + path + series), sha256: hash(settlements)}}};
  }
  return {version: 'weather-settlement-archive-v1', by_series};
}

const score = (p, outcome) => (p - outcome) ** 2;
const logLoss = (p, outcome) => -Math.log(Math.max(1e-8, outcome ? p : 1 - p));
function summary(rows) {
  return {events: rows.length, contracts: rows.reduce((sum, row) => sum + row.contracts, 0),
    brier: mean(rows.map(row => row.brier)), baseline_brier: mean(rows.map(row => row.baseline)),
    raw_mos_brier: mean(rows.map(row => row.raw)), log_loss: mean(rows.map(row => row.log_loss)),
    baseline_log_loss: mean(rows.map(row => row.baseline_log_loss))};
}

function blockInterval(gains) {
  if (gains.length < 21) return null;
  let seed = 3948573;
  const samples = Array.from({length: 2000}, () => {
    const draw = [];
    while (draw.length < gains.length) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const start = Math.floor(seed / 4294967296 * gains.length);
      for (let i = 0; i < 7 && draw.length < gains.length; i++) draw.push(gains[(start + i) % gains.length]);
    }
    return mean(draw);
  });
  return [quantile(samples, .025), quantile(samples, .975)];
}

export function evaluateWeatherArchive(archive) {
  const by_series = {};
  for (const [series, data] of Object.entries(archive.by_series)) {
    const predictions = [];
    for (const row of data.events) {
      const values = row.outcomes.map(([, lower, upper, outcome]) => {
        const forecast = weatherSettlementForecast(row.high, {lower: lower ?? -Infinity, upper: upper ?? Infinity}, row.origin, data.events);
        return forecast && {...forecast, outcome};
      });
      if (!values.length || values.some(value => !value)) continue;
      predictions.push({day: row.day, contracts: values.length,
        brier: mean(values.map(value => score(value.probability, value.outcome))),
        baseline: mean(values.map(value => score(value.baseline, value.outcome))),
        raw: mean(values.map(value => score(value.raw, value.outcome))),
        log_loss: mean(values.map(value => logLoss(value.probability, value.outcome))),
        baseline_log_loss: mean(values.map(value => logLoss(value.baseline, value.outcome)))});
    }
    const holdoutRows = predictions.filter(row => row.day >= HOLDOUT);
    by_series[series] = {station: data.station, matched_events: data.events.length,
      missing_forecast_contracts: data.missing_forecast_contracts,
      prior_history_missing_events: data.events.length - predictions.length,
      earlier: summary(predictions.filter(row => row.day < HOLDOUT)), holdout: summary(holdoutRows),
      weighted_vs_pooled_brier_gain_95: blockInterval(holdoutRows.map(row => row.baseline - row.brier)),
      pooled_vs_raw_brier_gain_95: blockInterval(holdoutRows.map(row => row.raw - row.baseline)),
      release_eligible: false,
      release_reason: 'The station replay has no cross-season or contemporaneous market-price and execution validation.'};
  }
  return {version: 'weather-settlement-replay-v1', independent_forecast: true, archive_sha256: hash(JSON.stringify(archive)),
    origin_utc: '06:00', holdout_start: HOLDOUT, window_end: END, by_series,
    protocol: [
      'Select the archived 00Z NWS GFS MOS daily maximum and wait until 06Z to allow publication.',
      'Use only exact exchange contracts open at the origin and official finalized binary outcomes. The forecast receives no exchange price.',
      'Fit residuals only with earlier settlements available before the origin. Compare warmth and recency weighting to an unweighted residual pool and a fixed 2.5 F Gaussian.',
      'Average scores within each day, then across dates. Resample seven-day circular blocks for paired Brier gain uncertainty.',
      'Archive issue time and settlement reporting delay are conservative assumptions. There is no venue-price or fill benchmark for this replay.'
    ]};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  const archive = directory ? await capture(directory) : JSON.parse(await readFile(ARCHIVE, 'utf8'));
  const result = evaluateWeatherArchive(archive);
  if (directory) {
    await writeFile(ARCHIVE, JSON.stringify(archive) + '\n');
    await writeFile(RECEIPT, JSON.stringify(result, null, 2) + '\n');
  } else {
    const receipt = JSON.parse(await readFile(RECEIPT, 'utf8'));
    if (JSON.stringify(result) !== JSON.stringify(receipt)) throw new Error('Weather replay differs from its published receipt');
  }
  console.log(JSON.stringify(result, null, 2));
}
