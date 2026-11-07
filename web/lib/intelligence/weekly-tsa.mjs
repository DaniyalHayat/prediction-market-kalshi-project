import {marketBounds, mean, quantile, wilson} from './math.mjs';
import {DAY, isoDay, localDay} from './sources.mjs';
import history from './data/tsa-history.json' with {type: 'json'};

export const WEEKLY_TSA_SERIES = 'KXTSAW';
export const WEEKLY_TSA_MODEL = 'Prior-week TSA benchmark';
export const WEEKLY_TSA_CHALLENGER = 'Calendar and recent-week TSA ensemble';
export const TSA_PUBLICATION_LAG_DAYS = 2;
const WEEK = 7 * DAY;
const MIN_CALIBRATION_WEEKS = 16;
const CALIBRATION_WINDOW = 78;
const FIT_DAYS = 730;
const COMPONENTS = ['prior_week', 'recent_weeks', 'calendar'];
const MONTH_CODES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const weekDays = end => Array.from({length: 7}, (_, index) => end - (6 - index) * DAY);
const prepared = new WeakMap(), combinedRows = new WeakMap();
const historicalRows = history.observations.map(([date, value]) => ({date, value}));

export function weeklyTsaContract(market) {
  if (typeof market?.rules_primary !== 'string' || typeof market.ticker !== 'string') return null;
  const rule = market.rules_primary.match(/^If weekly average TSA airport screenings are above (\d+(?:\.\d+)?) million for the week ending ([A-Za-z]+ \d{1,2}, \d{4}), according to the TSA, then the market resolves to Yes\.$/i);
  const end = Date.parse(rule?.[2] ? rule[2] + ' UTC' : '');
  if (!rule || !Number.isFinite(end)) return null;
  const date = new Date(end), day = isoDay(end);
  const close = Date.parse(market?.close_time);
  const bounds = marketBounds(market || {});
  const event = WEEKLY_TSA_SERIES + '-' + day.slice(2, 4) + MONTH_CODES[date.getUTCMonth()] + day.slice(8);
  if (market.event_ticker !== event || !market.ticker.startsWith(event + '-') ||
      market.strike_type !== 'greater' || !Number.isFinite(bounds?.lower) ||
      Math.abs(Number(rule[1]) * 1e6 - bounds.lower) > .0001 || date.getUTCDay() !== 0 ||
      !Number.isFinite(close) || localDay(close, 'America/New_York') !== day) return null;
  return {event, end, close, strike: bounds.lower};
}

function seriesIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.value) || row.value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) continue;
    const day = Date.parse(row.date);
    if (Number.isFinite(day) && isoDay(day) === row.date) index.set(day, row.value);
  }
  return index;
}

function calendarFeatures(day, features) {
  if (features.has(day)) return features.get(day);
  const date = new Date(day), year = date.getUTCFullYear(), weekday = date.getUTCDay();
  const fixed = (month, value) => Date.UTC(year, month, value);
  const weekdayInMonth = (month, dow, ordinal) => {
    const first = fixed(month, 1);
    return first + ((dow - new Date(first).getUTCDay() + 7) % 7 + 7 * (ordinal - 1)) * DAY;
  };
  const memorial = fixed(4, 31) - ((new Date(fixed(4, 31)).getUTCDay() + 6) % 7) * DAY;
  const holidayDistances = [
    Math.abs(day - fixed(0, 1)) < Math.abs(day - Date.UTC(year + 1, 0, 1)) ? day - fixed(0, 1) : day - Date.UTC(year + 1, 0, 1),
    day - memorial, day - fixed(6, 4), day - weekdayInMonth(8, 1, 1),
    day - weekdayInMonth(10, 4, 4), day - fixed(11, 25),
  ].map(delta => delta / DAY);
  const annual = 2 * Math.PI * day / (365.2425 * DAY);
  const result = [1, ...Array.from({length: 6}, (_, index) => Number(weekday === index + 1)),
    Math.sin(annual), Math.cos(annual), Math.sin(2 * annual), Math.cos(2 * annual),
    ...holidayDistances.flatMap(distance => [Number(distance >= -3 && distance < 0),
      Number(distance === 0), Number(distance > 0 && distance <= 3)])];
  features.set(day, result);
  return result;
}

function solveRidge(matrix, response) {
  const size = response.length;
  for (let i = 0; i < size; i++) {
    matrix[i][i] += i === 0 ? .0001 : 2;
    for (let j = i + 1; j < size; j++) matrix[i][j] = matrix[j][i];
  }
  for (let i = 0; i < size; i++) {
    const diagonal = matrix[i][i];
    if (!Number.isFinite(diagonal) || diagonal <= 0) return null;
    for (let j = i + 1; j < size; j++) {
      const scale = matrix[j][i] / diagonal;
      response[j] -= scale * response[i];
      for (let k = i + 1; k < size; k++) matrix[j][k] -= scale * matrix[i][k];
    }
  }
  for (let i = size - 1; i >= 0; i--) {
    for (let j = i + 1; j < size; j++) response[i] -= matrix[i][j] * response[j];
    response[i] /= matrix[i][i];
  }
  return response;
}

function calendarEstimate({index, features}, cutoff) {
  const size = calendarFeatures(cutoff, features).length;
  const normal = Array.from({length: size}, () => new Float64Array(size)), response = new Float64Array(size);
  let count = 0;
  for (let day = cutoff - FIT_DAYS * DAY; day <= cutoff; day += DAY) {
    if (!index.has(day)) continue;
    count++;
    const x = calendarFeatures(day, features), y = Math.log(index.get(day));
    const weight = 2 ** ((day - cutoff) / (365 * DAY));
    for (let i = 0; i < size; i++) {
      const wx = weight * x[i];
      if (wx === 0) continue;
      response[i] += wx * y;
      for (let j = 0; j <= i; j++) normal[i][j] += wx * x[j];
    }
  }
  if (count < 365) return null;
  const coefficients = solveRidge(normal, response);
  if (!coefficients) return null;
  const fitted = day => calendarFeatures(day, features).reduce((sum, value, index) => sum + value * coefficients[index], 0);
  const recent = Array.from({length: 21}, (_, index) => cutoff - index * DAY)
    .filter(day => index.has(day)).map(day => Math.log(index.get(day)) - fitted(day));
  if (recent.length < 14) return null;
  const adjustment = Math.max(-.18, Math.min(.18, mean(recent)));
  return day => Math.exp(fitted(day) + adjustment);
}

function originForecast(state, end, horizon) {
  const key = end + ':' + horizon;
  if (state.origins.has(key)) return state.origins.get(key);
  const point = estimate(state, end, horizon);
  if (state.origins.size >= 2048) state.origins.delete(state.origins.keys().next().value);
  state.origins.set(key, point);
  return point;
}

function estimate(state, end, horizon) {
  const {index} = state;
  const cutoff = end - horizon * DAY;
  const days = weekDays(end);
  const seen = days.filter(day => day <= cutoff);
  if (seen.some(day => !index.has(day))) return null;
  const calendar = calendarEstimate(state, cutoff);
  if (!calendar) return null;
  const predictions = days.map(day => {
    if (day <= cutoff) return COMPONENTS.map(() => index.get(day));
    const lastAvailable = day - Math.ceil((day - cutoff) / WEEK) * WEEK;
    const observations = Array.from({length: 4}, (_, offset) => index.get(lastAvailable - offset * WEEK));
    if (!observations.every(Number.isFinite)) return null;
    const weights = [1, .75, .5625, .421875];
    const recent = observations.reduce((sum, value, i) => sum + weights[i] * value, 0) / weights.reduce((a, b) => a + b, 0);
    return [observations[0], recent, calendar(day)];
  });
  if (predictions.some(row => row === null)) return null;
  return {components: COMPONENTS.map((_, index) => mean(predictions.map(row => row[index]))), observed_days: seen.length};
}

function ensemble(components, earlierErrors) {
  const sample = earlierErrors.slice(-26);
  const scores = components.map((_, index) => sample.length < 12 ? 1 :
    1 / (20000 + mean(sample.map(errors => Math.abs(errors[index])))));
  const total = scores.reduce((a, b) => a + b, 0), weights = scores.map(score => score / total);
  return {center: components.reduce((sum, point, index) => sum + point * weights[index], 0), weights};
}

export function weeklyTsaForecast(rows, end, horizon) {
  if (!Array.isArray(rows) || !Number.isFinite(end) || new Date(end).getUTCDay() !== 0 ||
      !Number.isInteger(horizon) || horizon < TSA_PUBLICATION_LAG_DAYS || horizon > 8) return null;
  if (!prepared.has(rows)) prepared.set(rows, {index: seriesIndex(rows), features: new Map(), origins: new Map()});
  const state = prepared.get(rows), point = originForecast(state, end, horizon);
  if (!point) return null;
  const cutoff = end - horizon * DAY;
  const errors = [], componentErrors = [], residualHistory = [];
  for (let previous = end - (CALIBRATION_WINDOW + 26) * WEEK; previous <= cutoff; previous += WEEK) {
    const actual = weekDays(previous).map(day => state.index.get(day));
    if (!actual.every(Number.isFinite)) continue;
    const fit = originForecast(state, previous, horizon);
    if (!fit) continue;
    const observed = mean(actual), available = residualHistory.filter(row => row.end <= previous - horizon * DAY);
    const residuals = fit.components.map(value => observed - value);
    if (previous >= end - CALIBRATION_WINDOW * WEEK && available.length >= 12) {
      errors.push(observed - ensemble(fit.components, available.map(row => row.errors)).center);
      componentErrors.push(residuals);
    }
    residualHistory.push({end: previous, errors: residuals});
  }
  if (errors.length < MIN_CALIBRATION_WEEKS) return null;
  const {center, weights} = ensemble(point.components, residualHistory.map(row => row.errors));
  return {...point, center, weights, errors, componentErrors, range: [center + quantile(errors, .1), center + quantile(errors, .9)]};
}

export function weeklyTsaProbability(forecast, strike, baseline = false) {
  if (!forecast || !Number.isFinite(strike)) return null;
  const index = COMPONENTS.indexOf(baseline === true ? 'prior_week' : baseline);
  const center = index >= 0 ? forecast.components[index] : forecast.center;
  const residuals = index >= 0 ? forecast.componentErrors.map(row => row[index]) : forecast.errors;
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
  const latest = Date.parse(source.latest_observation);
  if (!Number.isFinite(latest) || local - latest > 5 * DAY) return {reason: 'TSA has not published a recent checkpoint count.'};
  const cutoff = Math.min(latest, local - TSA_PUBLICATION_LAG_DAYS * DAY);
  const horizon = (contract.end - cutoff) / DAY;
  if (!Array.isArray(source.rows) || !source.rows.length) return {reason: 'TSA checkpoint observations are unavailable.'};
  if (!combinedRows.has(source.rows)) combinedRows.set(source.rows, [
    ...historicalRows.filter(row => row.date < source.rows[0].date), ...source.rows,
  ]);
  const forecast = weeklyTsaForecast(combinedRows.get(source.rows), contract.end, horizon);
  if (!forecast) return {reason: 'The week is outside the modeled window, an expected day is missing, or fewer than 16 comparable historical weeks are available.'};
  const release_reason = receipt?.release_reason || 'The weekly model requires a passing point-in-time settlement replay before release.';
  const benchmark = forecast.components[0], residuals = forecast.componentErrors.map(row => row[0]);
  return {...weeklyTsaProbability(forecast, contract.strike, 'prior_week'), eligible: false, center: benchmark,
    range_80: [benchmark + quantile(residuals, .1), benchmark + quantile(residuals, .9)],
    target_date: isoDay(contract.end), source_name: source.name, source_url: source.source_url, source_as_of: source.retrieved_at,
    source_sha256: source.sha256, model_name: WEEKLY_TSA_MODEL, validation: null, independent_forecast: true, release_reason,
    backtest: receipt ? {url: '/research/weekly-tsa.json', ...receipt} : null,
    challenger: {model_name: WEEKLY_TSA_CHALLENGER, ...weeklyTsaProbability(forecast, contract.strike),
      center: forecast.center, range_80: forecast.range, eligible: false},
    inputs: {as_of_local_day: isoDay(local), publication_lag_days: TSA_PUBLICATION_LAG_DAYS,
      last_assumed_available_date: isoDay(cutoff), observed_days: forecast.observed_days,
      calibration_weeks: forecast.errors.length,
      component_weights: Object.fromEntries(COMPONENTS.map((name, index) => [name, forecast.weights[index]])),
      historical_tsa_sources: history.sources.map(({url, sha256}) => ({url, sha256}))},
    warnings: [source.revision_note, 'The replay uses current-vintage TSA counts with a conservative publication lag. It cannot verify when historical counts first appeared or were revised.',
      'The range is a historical-residual sensitivity check. The estimate is research-only until a point-in-time settlement holdout clears the release gate.']};
}
