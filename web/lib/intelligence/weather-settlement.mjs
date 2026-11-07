import {DAY, isoDay, localDay, sourceText} from './sources.mjs';
import {eventDate, gaussianProbability, marketBounds, quantile, wilson} from './math.mjs';

const HOUR = 3600000;
export const WEATHER_SETTLEMENT_SITES = Object.freeze({
  KXHIGHNY: {station: 'KNYC', report: 'CLINYC', zone: 'America/New_York'},
  KXHIGHCHI: {station: 'KMDW', report: 'CLIMDW', zone: 'America/Chicago'},
  KXHIGHMIA: {station: 'KMIA', report: 'CLIMIA', zone: 'America/New_York'},
});
export const MOS_URL = 'https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py';

export function weatherSettlementContract(market, series = market?.series) {
  if (!Object.hasOwn(WEATHER_SETTLEMENT_SITES, series)) return null;
  const site = WEATHER_SETTLEMENT_SITES[series];
  const parsed = /^If the maximum temperature recorded at [^()]+ \((CLI[A-Z]{3})\) for ([A-Za-z]+ \d{1,2}, \d{4}), is (greater than|less than|between) (-?\d+)(?:-(-?\d+))?° fahrenheit according to The Weather Company, then the market resolves to Yes\.$/i.exec(market.rules_primary || '');
  if (!parsed || parsed[1].toUpperCase() !== site.report || !market.event_ticker?.startsWith(series + '-') ||
      !market.ticker?.startsWith(market.event_ticker + '-')) return null;
  const [, , calendar, comparison, first, second] = parsed;
  const date = Date.parse(calendar + ' UTC'), close = Date.parse(market.close_time);
  const strikeType = {'greater than': 'greater', 'less than': 'less', between: 'between'}[comparison.toLowerCase()];
  if (market.strike_type !== strikeType || !Number.isFinite(date) || isoDay(date) !== eventDate(market) || !Number.isFinite(close) ||
      (strikeType === 'greater' && market.floor_strike !== Number(first)) ||
      (strikeType === 'less' && market.cap_strike !== Number(first)) ||
      (strikeType === 'between' && (!second || market.floor_strike !== Number(first) || market.cap_strike !== Number(second)))) return null;
  const bounds = marketBounds(market, 1);
  return bounds ? {series, station: site.station, day: isoDay(date), origin: date + 6 * HOUR, close, bounds} : null;
}

export function gfsDailyHighs(csv, station) {
  const [header, ...lines] = csv.trim().split(/\r?\n/), fields = header.split(',');
  const indices = ['runtime', 'ftime', 'model', 'n_x', 'station'].map(field => fields.indexOf(field));
  if (indices.some(index => index < 0)) throw new TypeError('MOS CSV lacks required fields');
  const forecasts = new Map();
  for (const line of lines) {
    const fields = line.split(',');
    const [run, forecast, model, high, rowStation] = indices.map(index => fields[index]);
    if (!run?.endsWith(' 00:00:00') || !forecast?.endsWith(' 00:00:00') || model !== 'GFS' || rowStation !== station || !high) continue;
    const day = run.slice(0, 10), time = Date.parse(day), valid = Date.parse(forecast.slice(0, 10)), value = Number(high);
    if (!Number.isFinite(time) || valid !== time + DAY || !Number.isInteger(value) || value < -80 || value > 145) continue;
    forecasts.set(day, value);
  }
  return forecasts;
}

export function weatherMosURL(station, start, end) {
  if (!Object.values(WEATHER_SETTLEMENT_SITES).some(site => site.station === station)) throw new RangeError('Unknown daily-high station');
  return MOS_URL + '?' + new URLSearchParams({station, model: 'GFS', sts: start, ets: end, format: 'csv'});
}

export async function weatherMosSource(series, {now = Date.now()} = {}) {
  const site = Object.hasOwn(WEATHER_SETTLEMENT_SITES, series) ? WEATHER_SETTLEMENT_SITES[series] : null;
  if (!site) throw new RangeError('Unknown daily-high series');
  const day = isoDay(now);
  if (now < Date.parse(day) + 6 * HOUR || localDay(now, site.zone) !== day) return null;
  const response = await sourceText(weatherMosURL(site.station, day + 'T00:00Z', day + 'T00:30Z'), HOUR,
    (url, options) => fetch(url, {...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(2400)])}));
  const high = gfsDailyHighs(response.text, site.station).get(day);
  if (!Number.isInteger(high)) return null;
  return {series, weather_mos: true, day, high, source_url: response.source_url,
    retrieved_at: response.retrieved_at, sha256: response.sha256, station: site.station};
}

function normalizedResiduals(rows, high, origin) {
  const available = rows.filter(row => row.settled_at < origin && row.origin < origin).slice(-110);
  if (available.length < 30) return null;
  const weighted = available.map(row => ({
    value: row.actual - row.high,
    raw: Math.exp(-Math.abs(row.high - high) / 10 - (origin - row.origin) / (90 * DAY)),
  }));
  const total = weighted.reduce((sum, row) => sum + row.raw, 0);
  const weights = weighted.map(row => ({value: row.value, weight: .65 * row.raw / total + .35 / weighted.length}));
  return {weights, effective: 1 / weights.reduce((sum, row) => sum + row.weight ** 2, 0)};
}

function discreteProbability(weights, high, bounds, useWeights) {
  const selected = weights.filter(row => high + row.value >= bounds.lower && high + row.value < bounds.upper);
  return useWeights ? selected.reduce((sum, row) => sum + row.weight, 0) : selected.length / weights.length;
}

export function weatherSettlementForecast(high, bounds, origin, rows) {
  const fit = normalizedResiduals(rows, high, origin);
  if (!fit) return null;
  const {weights, effective} = fit;
  const raw = gaussianProbability(high, 2.5, bounds);
  const pool = discreteProbability(weights, high, bounds, false);
  const conditional = discreteProbability(weights, high, bounds, true);
  const empirical = .9 * pool + .1 * raw;
  const probability = Math.min(1, Math.max(0, .9 * conditional + .1 * raw));
  const interval = wilson(probability * effective, effective);
  const residuals = weights.map(row => row.value).sort((a, b) => a - b);
  return {probability, interval, baseline: empirical, raw, n: weights.length, effective_n: effective,
    range_80: [high + quantile(residuals, .1), high + quantile(residuals, .9)]};
}

export function estimateWeatherSettlement(market, series, source, rows, receipt, now) {
  const contract = weatherSettlementContract(market, series);
  if (!contract || !source || source.day !== contract.day || source.station !== contract.station || now < contract.origin || now >= contract.close ||
      now - contract.origin > 18 * HOUR) return null;
  const result = weatherSettlementForecast(source.high, contract.bounds, contract.origin, rows);
  if (!result || result.baseline <= 0 || result.baseline >= 1) return null;
  return {probability: result.baseline, interval: wilson(result.baseline * result.n, result.n), n: result.n,
    range_80: result.range_80, validation: null, eligible: false, independent_forecast: true, target_date: contract.day,
    center: source.high, model_name: 'MOS forecast with pooled station errors',
    interval_kind: 'Station residual sampling range; it does not cover model or source changes',
    source_name: 'IEM archive of NWS GFS MOS', source_url: source.source_url,
    source_as_of: source.retrieved_at, source_sha256: source.sha256,
    inputs: {station: source.station, mos_high_f: source.high, origin: new Date(contract.origin).toISOString()},
    release_reason: receipt.release_reason, backtest: {url: '/research/weather-settlement.json', ...receipt},
    warnings: ['Research-only until a longer cross-season replay and same-time execution benchmark pass.']};
}
