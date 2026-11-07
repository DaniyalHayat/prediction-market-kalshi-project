import {normalCdf, wilson} from './math.mjs';
import {sourceText} from './sources.mjs';

const MINUTE = 60_000, WINDOW = 15 * MINUTE;
export const CRYPTO_MINUTE_SERIES = Object.freeze({KXBTC15M: {asset: 'BTC', index: 'BRTI'}, KXETH15M: {asset: 'ETH', index: 'ETHUSDRTI'}});
const measurement = /^(\d{1,2}:\d{2} [AP]M) (E[DS]T) on ([A-Za-z]+ \d{1,2}, \d{4})$/;
const rule = /^If the simple average of the sixty seconds of CF Benchmarks' (BRTI|ETHUSDRTI) before (.+?) is at least the simple average of the sixty seconds of CF Benchmarks' \1 before (.+?), then the market resolves to Yes\.$/;

function time(value) {
  const parts = value.match(measurement);
  return parts ? Date.parse(parts[3] + ' ' + parts[1] + ' ' + parts[2]) : NaN;
}

export function minuteCryptoContract(market) {
  const event = market?.event_ticker;
  if (typeof event !== 'string' || typeof market?.rules_primary !== 'string' || typeof market?.ticker !== 'string') return null;
  const series = event.split('-')[0], entry = CRYPTO_MINUTE_SERIES[series], matched = market.rules_primary.match(rule);
  if (!Object.hasOwn(CRYPTO_MINUTE_SERIES, series) || !matched || entry.index !== matched[1] || !market.ticker.startsWith(event + '-') ||
      market.strike_type !== 'greater_or_equal' || typeof market.floor_strike !== 'number' ||
      !Number.isFinite(market.floor_strike) || market.floor_strike < .01) return null;
  const close = time(matched[2]), open = time(matched[3]);
  if (!Number.isFinite(close) || close - open !== WINDOW || close !== Date.parse(market.close_time)) return null;
  return {ticker: market.ticker, event, series, open, close, strike: market.floor_strike};
}

export function parseClosedMinuteBars(rows, cutoff) {
  if (!Array.isArray(rows)) throw new TypeError('Coinbase minute candle response is not a list');
  const bars = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [start, low, high, open, close] = row;
    const end = (start + 60) * 1000;
    if (!Number.isSafeInteger(start) || start % 60 !== 0 || end > cutoff ||
        ![low, high, open, close].every(price => Number.isFinite(price) && price > 0) ||
        low > Math.min(open, close) || high < Math.max(open, close)) continue;
    bars.set(end, [end, close, (low + high + open + close) / 4]);
  }
  return [...bars.values()].sort((a, b) => a[0] - b[0]);
}

export async function cryptoMinuteSource(series, {start, end, now = Date.now()} = {}) {
  if (!Object.hasOwn(CRYPTO_MINUTE_SERIES, series)) throw new RangeError('Unknown 15-minute contract series');
  const entry = CRYPTO_MINUTE_SERIES[series];
  end ??= Math.floor(now / MINUTE) * MINUTE;
  start ??= end - 299 * MINUTE;
  const query = new URLSearchParams({granularity: '60', start: new Date(start).toISOString(), end: new Date(end).toISOString()});
  const url = 'https://api.exchange.coinbase.com/products/' + entry.asset + '-USD/candles?' + query;
  const result = await sourceText(url, 12000);
  const bars = parseClosedMinuteBars(JSON.parse(result.text), Math.min(now, end)).filter(([ts]) => ts > start);
  return {source_url: result.source_url, retrieved_at: result.retrieved_at, sha256: result.sha256,
    series, name: 'Coinbase ' + entry.asset + '-USD completed minute candles', bars};
}

function returnsAndVolatility(bars) {
  const volatility = [];
  let variance = 0, n = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i][0] - bars[i - 1][0] !== MINUTE) continue;
    const change = Math.log(bars[i][1] / bars[i - 1][1]);
    n++;
    variance = n <= 24 ? variance + (change ** 2 - variance) / n : .94 * variance + .06 * change ** 2;
    if (n >= 24) volatility[i] = Math.max(1e-7, Math.sqrt(variance));
  }
  return volatility;
}

function distribution(values, relative, threshold, basis) {
  const probabilityAt = shift => (values.filter(value => relative + value + shift >= threshold).length + .5) / (values.length + 1);
  const probability = probabilityAt(0);
  const interval = [wilson(probabilityAt(-basis) * values.length, values.length)[0],
    wilson(probabilityAt(basis) * values.length, values.length)[1]];
  return {probability, interval};
}

export function minuteCryptoFeatures(contract, sourceBars, now = Date.now()) {
  if (!contract || !Array.isArray(sourceBars) || now >= contract.close) return null;
  let left = 0, right = sourceBars.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (sourceBars[middle][0] <= now) left = middle + 1;
    else right = middle;
  }
  const bars = sourceBars.slice(Math.max(0, left - 300), left);
  const current = bars.at(-1), ref = bars.findIndex(([end]) => end === contract.open);
  if (!current || ref < 0 || bars.length < 180 || now - current[0] > 125000 ||
      current[0] - contract.open !== (bars.length - 1 - ref) * MINUTE) return null;
  const horizon = (contract.close - current[0]) / MINUTE;
  if (!Number.isInteger(horizon) || horizon < 2 || horizon > 14 || contract.close - now < MINUTE) return null;
  const volatility = returnsAndVolatility(bars);
  const currentSigma = volatility.at(-1);
  if (!Number.isFinite(currentSigma) || currentSigma <= 1e-7) return null;
  const historical = [], baseline = [];
  for (let i = bars.length - horizon - 1; i >= 24; i -= horizon) {
    const start = bars[i], end = bars[i + horizon];
    if (!volatility[i] || end[0] - start[0] !== horizon * MINUTE) continue;
    const move = Math.log(end[2] / start[1]);
    baseline.push(move);
    historical.push(move * Math.max(.4, Math.min(2.5, currentSigma / volatility[i])));
  }
  if (historical.length < 16) return null;
  const startProxy = bars[ref][2];
  return {historical, baseline, relative: Math.log(current[1] / startProxy),
    threshold: Math.log((contract.strike - .005) / contract.strike),
    opening_basis: Math.log(startProxy / contract.strike), basis: .0005,
    reference_price: startProxy, underlying_price: current[1], observed_at: current[0], horizon_minutes: horizon,
    volatility_per_minute: currentSigma, residual_windows: historical.length};
}

export function minuteCryptoPrediction(features, profile = {}) {
  const {historical, relative, threshold, opening_basis, basis, horizon_minutes, volatility_per_minute} = features;
  const {basis_weight = 0, gaussian_weight = 0} = profile;
  const location = relative + basis_weight * opening_basis;
  const empirical = distribution(historical, location, threshold, basis);
  const sd = volatility_per_minute * Math.sqrt(horizon_minutes);
  const floor = .5 / (historical.length + 1);
  const gaussian = shift => Math.max(floor, Math.min(1 - floor, normalCdf((location + shift - threshold) / sd)));
  const blend = (empiricalValue, gaussianValue) => (1 - gaussian_weight) * empiricalValue + gaussian_weight * gaussianValue;
  return {probability: blend(empirical.probability, gaussian(0)),
    interval: [blend(empirical.interval[0], gaussian(-basis)), blend(empirical.interval[1], gaussian(basis))]};
}

export function minuteCryptoForecast(contract, sourceBars, now = Date.now(), profile) {
  const features = minuteCryptoFeatures(contract, sourceBars, now);
  if (!features) return null;
  const {historical, baseline, relative, threshold, opening_basis, basis, ...inputs} = features;
  const useFit = profile && profile.lead_minutes === inputs.horizon_minutes &&
    [profile.basis_weight, profile.gaussian_weight].every(weight => Number.isFinite(weight) && weight >= 0 && weight <= 1);
  return {...minuteCryptoPrediction(features, useFit ? profile : undefined), ...inputs,
    baseline: distribution(baseline, relative, threshold, basis).probability,
    gaussian_baseline: minuteCryptoPrediction(features, {gaussian_weight: 1}).probability,
    basis_sensitivity_bps: basis * 10000, opening_basis_bps: opening_basis * 10000,
    calibrated_profile: useFit ? profile : null};
}

export function estimateMinuteCrypto(market, source, now = Date.now(), receipt) {
  const contract = minuteCryptoContract(market);
  if (!contract) return {reason: 'The exact 15-minute CF index, strike or averaging-window rule could not be matched.'};
  if (source?.series !== contract.series) return {reason: 'Matching completed Coinbase minute candles are unavailable.'};
  const forecast = minuteCryptoForecast(contract, source.bars, now, receipt?.selected_profile);
  if (!forecast) return {reason: 'Awaiting a completed matching Coinbase minute, or the source window is stale, incomplete or too close to settlement.'};
  const {probability, interval, baseline, gaussian_baseline, observed_at, calibrated_profile, ...inputs} = forecast;
  const pureGaussian = calibrated_profile?.gaussian_weight === 1;
  return {probability, interval, eligible: false, independent_forecast: true, validation: null,
    interval_kind: pureGaussian ? 'Five-basis-point index sensitivity range' : 'Empirical sampling and five-basis-point index sensitivity range',
    model_name: pureGaussian ? 'Basis-adjusted Coinbase Gaussian forecast' :
      calibrated_profile ? 'Basis-adjusted Coinbase return blend' : 'Volatility-adjusted Coinbase minute return model',
    target_date: new Date(contract.close).toISOString(),
    source_name: source.name, source_url: source.source_url, source_as_of: new Date(observed_at).toISOString(), source_sha256: source.sha256,
    max_source_age_seconds: 125, inplay: true,
    release_reason: calibrated_profile ? receipt.release_reason : 'This remaining-time horizon is outside the fixed eight-minute settlement holdout.',
    backtest: receipt ? {url: '/research/crypto-minute.json', ...receipt} : null,
    inputs: {...inputs, calibrated_profile, official_starting_strike: contract.strike,
      independent_static_volatility_baseline: baseline, independent_gaussian_baseline: gaussian_baseline},
    warnings: ['Coinbase OHLC approximates the independently observed price move. Kalshi settles against the named CF Benchmarks 60-second average.',
      'The starting strike is a contract term. Exchange odds do not enter the estimate. The replay is research-only and has no execution or profitability result.']};
}
