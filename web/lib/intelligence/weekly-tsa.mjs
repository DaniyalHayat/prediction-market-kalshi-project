import {marketBounds, mean, median, quantile, wilson} from './math.mjs';
import {DAY, isoDay, localDay} from './sources.mjs';

export const WEEKLY_TSA_SERIES = 'KXTSAW';
export const WEEKLY_TSA_MODEL = 'Weekly TSA seasonal nowcast';
export const TSA_PUBLICATION_LAG_DAYS = 2;
const WEEK = 7 * DAY;
const MIN_CALIBRATION_WEEKS = 16;
const weekDays = end => Array.from({length: 7}, (_, index) => end - (6 - index) * DAY);

export function weeklyTsaContract(market) {
  const rules = market?.rules_primary || '';
  const rule = rules.match(/^If weekly average TSA airport screenings are above (\d+(?:\.\d+)?) million for the week ending ([A-Za-z]+ \d{1,2}, \d{4}), according to the TSA, then the market resolves to Yes\.$/i);
  const end = Date.parse(rule?.[2] ? rule[2] + ' UTC' : '');
  const close = Date.parse(market?.close_time);
  const bounds = marketBounds(market || {});
  const event = market?.event_ticker;
  if (!rule || !event?.startsWith(WEEKLY_TSA_SERIES + '-') || !market?.ticker?.startsWith(event + '-') ||
      market.strike_type !== 'greater' || !Number.isFinite(bounds?.lower) ||
      Math.abs(Number(rule[1]) * 1e6 - bounds.lower) > .0001 || !Number.isFinite(end) ||
      new Date(end).getUTCDay() !== 0 || !Number.isFinite(close) ||
      localDay(close, 'America/New_York') !== isoDay(end)) return null;
  return {event, end, close, strike: bounds.lower};
}

function seriesIndex(rows) {
  return new Map(rows.flatMap(row => Number.isSafeInteger(row?.value) && row.value > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.date || '') && Number.isFinite(Date.parse(row.date))
    ? [[Date.parse(row.date), row.value]] : []));
}

function estimate(index, end, horizon) {
  const cutoff = end - horizon * DAY;
  const days = weekDays(end);
  const seen = days.filter(day => day <= cutoff);
  if (seen.some(day => !index.has(day))) return null;
  const seasonal = days.map(day => {
    const lagged = Array.from({length: 8}, (_, i) => day - (i + 1) * WEEK)
      .filter(lag => lag <= cutoff && index.has(lag)).map(lag => index.get(lag));
    return lagged.length >= 4 ? median(lagged) : null;
  });
  if (seasonal.some(value => value === null)) return null;
  const known = seen.map(day => index.get(day));
  const relative = seen.map((_, i) => known[i] / seasonal[i]);
  const adjustment = relative.length ? Math.max(.85, Math.min(1.15, 1 + (median(relative) - 1) * relative.length / (relative.length + 4))) : 1;
  const center = mean(days.map((day, index) => day <= cutoff ? known[index] : seasonal[index] * adjustment));
  const baselineLag = Math.ceil(horizon / 7) * WEEK;
  const baseline = days.map((day, i) => day <= cutoff ? known[i] : index.get(day - baselineLag));
  if (!baseline.every(Number.isFinite)) return null;
  return {center, baseline: mean(baseline), observed_days: seen.length, adjustment};
}

export function weeklyTsaForecast(rows, end, horizon) {
  if (!Array.isArray(rows) || !Number.isFinite(end) || new Date(end).getUTCDay() !== 0 ||
      !Number.isInteger(horizon) || horizon < TSA_PUBLICATION_LAG_DAYS || horizon > 8) return null;
  const index = seriesIndex(rows), point = estimate(index, end, horizon);
  if (!point) return null;
  const cutoff = end - horizon * DAY;
  const errors = [], baselineErrors = [];
  for (let previous = end - WEEK; previous <= cutoff && previous >= end - 78 * WEEK; previous -= WEEK) {
    const actual = weekDays(previous).map(day => index.get(day));
    if (!actual.every(Number.isFinite)) continue;
    const fit = estimate(index, previous, horizon);
    if (!fit) continue;
    errors.push(mean(actual) - fit.center);
    baselineErrors.push(mean(actual) - fit.baseline);
  }
  if (errors.length < MIN_CALIBRATION_WEEKS) return null;
  return {...point, errors, baselineErrors, range: [point.center + quantile(errors, .1), point.center + quantile(errors, .9)]};
}

export function weeklyTsaProbability(forecast, strike, baseline = false) {
  if (!forecast || !Number.isFinite(strike)) return null;
  const center = baseline ? forecast.baseline : forecast.center;
  const residuals = baseline ? forecast.baselineErrors : forecast.errors;
  const n = residuals.length, wins = residuals.filter(error => center + error > strike).length;
  const probability = (wins + .5) / (n + 1);
  return {probability, interval: wilson(probability * n, n), n, effective_n: n,
    interval_kind: 'Historical week sampling interval. Publication and revision risk are separate.'};
}

export function estimateWeeklyTsa(market, source, now = Date.now(), receipt) {
  const contract = weeklyTsaContract(market);
  if (!contract) return {reason: 'The exact Sunday, TSA weekly-average settlement rule and strict strike could not be matched.'};
  if (contract.close <= now) return {reason: 'Trading close has passed.'};
  if (!source) return {reason: 'TSA checkpoint observations are unavailable.'};
  const age = now - Date.parse(source.retrieved_at);
  if (!Number.isFinite(age) || age < -5000 || age > 3600000) return {reason: 'TSA retrieval is missing or stale.'};
  const local = Date.parse(localDay(now, 'America/New_York'));
  const horizon = (contract.end - local) / DAY + TSA_PUBLICATION_LAG_DAYS;
  const latest = Date.parse(source.latest_observation);
  if (!Number.isFinite(latest) || local - latest > 5 * DAY) return {reason: 'TSA has not published a recent checkpoint count.'};
  const forecast = weeklyTsaForecast(source.rows, contract.end, horizon);
  if (!forecast) return {reason: 'The week is outside the modeled window, an expected day is missing, or fewer than 16 comparable historical weeks are available.'};
  const holdout = receipt?.holdout;
  const release_reason = holdout?.brier >= holdout?.baseline_brier
    ? 'The weekly model did not improve on the prior-week baseline in the held-out settlements.'
    : 'The weekly model requires point-in-time publication evidence before release.';
  return {...weeklyTsaProbability(forecast, contract.strike), eligible: false, center: forecast.center, range_80: forecast.range,
    target_date: isoDay(contract.end), source_name: source.name, source_url: source.source_url, source_as_of: source.retrieved_at,
    source_sha256: source.sha256, model_name: WEEKLY_TSA_MODEL, validation: null, independent_forecast: true, release_reason,
    backtest: receipt ? {url: '/research/weekly-tsa.json', ...receipt} : null,
    inputs: {as_of_local_day: isoDay(local), publication_lag_days: TSA_PUBLICATION_LAG_DAYS,
      last_assumed_available_date: isoDay(contract.end - horizon * DAY), observed_days: forecast.observed_days,
      calibration_weeks: forecast.errors.length, seasonal_adjustment: forecast.adjustment},
    warnings: [source.revision_note, 'The replay uses current-vintage TSA counts with a conservative publication lag. It cannot verify when historical counts first appeared or were revised.',
      'The range is a historical-residual sensitivity check. The estimate is research-only until a point-in-time settlement holdout clears the release gate.']};
}
