import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {readJSON} from '../lib/transport.mjs';
import {DAY, isoDay, parseTsa, sourceText, tsaSource} from '../lib/intelligence/sources.mjs';
import {mean, quantile} from '../lib/intelligence/math.mjs';
import {WEEKLY_TSA_CHALLENGER, WEEKLY_TSA_MODEL, weeklyTsaContract, weeklyTsaForecast, weeklyTsaProbability} from '../lib/intelligence/weekly-tsa.mjs';

const ARCHIVE = new URL('../research-data/weekly-tsa-archive.json', import.meta.url);
const HISTORY = new URL('../lib/intelligence/data/tsa-history.json', import.meta.url);
const RECEIPT = new URL('../public/research/weekly-tsa.json', import.meta.url);
const API = 'https://api.elections.kalshi.com/trade-api/v2';
const HOLDOUT = '2026-08-01', END = '2026-11-06', HORIZON = 4;
const hash = content => createHash('sha256').update(content).digest('hex');

async function captureTsaHistory() {
  const annual = await Promise.all([2023, 2024, 2025].map(async year => {
    const source = await sourceText('https://www.tsa.gov/travel/passenger-volumes/' + year);
    const rows = parseTsa(source.text);
    const first = Date.UTC(year, 0, 1), count = (Date.UTC(year + 1, 0, 1) - first) / DAY;
    if (rows.length !== count || rows.some((row, index) => row.date !== isoDay(first + index * DAY)))
      throw new Error('Incomplete TSA daily archive for ' + year);
    return {lineage: {url: source.source_url, sha256: source.sha256, retrieved_at: source.retrieved_at, rows: count},
      observations: rows.map(row => [row.date, row.value])};
  }));
  return {version: 'tsa-checkpoints-2023-2025-v1', sources: annual.map(row => row.lineage),
    observations: annual.flatMap(row => row.observations)};
}

async function getSettled(path) {
  const query = new URLSearchParams({series_ticker: 'KXTSAW', limit: 1000, ...(path === '/markets' ? {status: 'settled'} : {})});
  const markets = [], pages = [], seen = new Set();
  do {
    const url = API + path + '?' + query;
    const response = await fetch(url, {signal: AbortSignal.timeout(12000), redirect: 'error'});
    const {data, raw} = await readJSON(response, {source: 'Public Kalshi weekly TSA settlements', maximumBytes: 8000000});
    if (!Array.isArray(data.markets)) throw new Error('Kalshi weekly TSA settlement list is unavailable');
    markets.push(...data.markets);
    pages.push({url, sha256: hash(raw), rows: data.markets.length});
    if (!data.cursor) break;
    if (typeof data.cursor !== 'string' || seen.has(data.cursor) || pages.length >= 5)
      throw new Error('Could not finish the bounded Kalshi weekly TSA settlement archive');
    seen.add(data.cursor);
    query.set('cursor', data.cursor);
  } while (true);
  return {markets, pages};
}

async function capture(history) {
  const [source, live, historical] = await Promise.all([tsaSource(), getSettled('/markets'), getSettled('/historical/markets')]);
  const rows = source.rows.filter(row => row.date < END);
  const events = new Map(), seen = new Set();
  for (const market of [...live.markets, ...historical.markets]) {
    const contract = weeklyTsaContract(market);
    if (!contract || !['yes', 'no'].includes(market.result) || !['settled', 'finalized'].includes(market.status) ||
        market.market_type !== 'binary' || market.settlement_value_dollars == null || market.settlement_value_dollars === '' ||
        Number(market.settlement_value_dollars) !== Number(market.result === 'yes') ||
        seen.has(market.ticker) || isoDay(contract.end) < history.observations[0][0] || isoDay(contract.end) >= END) continue;
    const origin = contract.end - 2 * DAY + 16 * 3600000;
    const opening = Date.parse(market.open_time), created = Date.parse(market.created_time);
    const settlement = Date.parse(market.settlement_ts);
    if (![opening, created, settlement].every(Number.isFinite) || Math.max(opening, created) >= origin ||
        contract.close <= origin || settlement <= origin || settlement >= Date.parse(END)) continue;
    const event = events.get(contract.event) || {event: contract.event, end: isoDay(contract.end),
      origin: new Date(origin).toISOString(), outcomes: []};
    event.outcomes.push([market.ticker, contract.strike, Number(market.result === 'yes')]);
    events.set(contract.event, event);
    seen.add(market.ticker);
  }
  const replayEvents = [...events.values()].sort((a, b) => a.end.localeCompare(b.end));
  for (const event of replayEvents) event.outcomes.sort((a, b) => a[0].localeCompare(b[0]));
  return {version: 'weekly-tsa-archive-v2', window_end: END, sources: [
    ...history.sources,
    {url: source.source_url, sha256: source.sha256, rows: rows.length, retrieved_at: source.retrieved_at},
    ...live.pages, ...historical.pages
  ], observations: [...history.observations, ...rows.map(row => [row.date, row.value])], events: replayEvents};
}

function scores(events) {
  return {events: events.length, contracts: events.reduce((total, event) => total + event.n, 0),
    brier: mean(events.map(event => event.brier)), baseline_brier: mean(events.map(event => event.baseline_brier)),
    recent_weeks_brier: mean(events.map(event => event.recent_weeks_brier)),
    calendar_brier: mean(events.map(event => event.calendar_brier)),
    log_loss: mean(events.map(event => event.log_loss)), baseline_log_loss: mean(events.map(event => event.baseline_log_loss)),
    recent_weeks_log_loss: mean(events.map(event => event.recent_weeks_log_loss)),
    calendar_log_loss: mean(events.map(event => event.calendar_log_loss)),
    interval_80_coverage: mean(events.map(event => event.interval_80_covers ? 1 : 0)),
    volume_mae: mean(events.map(event => event.volume_absolute_error))};
}

function pairedGainInterval(events) {
  if (events.length < 10) return null;
  let seed = 742413;
  const gains = Array.from({length: 2000}, () => {
    const sample = [];
    while (sample.length < events.length) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const start = Math.floor(seed / 4294967296 * events.length);
      for (let offset = 0; offset < 3 && sample.length < events.length; offset++) sample.push(events[(start + offset) % events.length]);
    }
    return Math.min(...['baseline_brier', 'recent_weeks_brier'].map(key => mean(sample.map(row => row[key] - row.brier))));
  });
  return [quantile(gains, .025), quantile(gains, .975)];
}

export function evaluateWeeklyTsaArchive(archive) {
  const observations = archive.observations.map(([date, value]) => ({date, value}));
  const values = new Map(archive.observations);
  const results = [], noForecast = [];
  for (const event of archive.events) {
    const end = Date.parse(event.end);
    const forecast = weeklyTsaForecast(observations, end, HORIZON);
    const actual = Array.from({length: 7}, (_, index) => values.get(isoDay(end - index * DAY)));
    if (!actual.every(Number.isFinite)) { noForecast.push(event.event); continue; }
    if (!forecast) { noForecast.push(event.event); continue; }
    const predictions = event.outcomes.map(([, strike, outcome]) => ({outcome,
      model: weeklyTsaProbability(forecast, strike).probability,
      baseline: weeklyTsaProbability(forecast, strike, 'prior_week').probability,
      recent_weeks: weeklyTsaProbability(forecast, strike, 'recent_weeks').probability,
      calendar: weeklyTsaProbability(forecast, strike, 'calendar').probability}));
    const loss = (p, y) => -Math.log(y ? p : 1 - p);
    const volume = mean(actual);
    const brier = model => mean(predictions.map(row => (row[model] - row.outcome) ** 2));
    const logLoss = model => Number(mean(predictions.map(row => loss(row[model], row.outcome))).toFixed(12));
    results.push({event: event.event, end: event.end, origin: event.origin, n: predictions.length,
      brier: brier('model'), baseline_brier: brier('baseline'), recent_weeks_brier: brier('recent_weeks'), calendar_brier: brier('calendar'),
      log_loss: logLoss('model'), baseline_log_loss: logLoss('baseline'), recent_weeks_log_loss: logLoss('recent_weeks'), calendar_log_loss: logLoss('calendar'),
      interval_80_covers: forecast.range[0] <= volume && volume <= forecast.range[1],
      volume_absolute_error: Number(Math.abs(forecast.center - volume).toFixed(3)),
      weights: forecast.weights.map(weight => Number(weight.toFixed(9)))});
  }
  const heldout = results.filter(row => row.end >= HOLDOUT);
  const holdout = scores(heldout), earlier = scores(results.filter(row => row.end < HOLDOUT));
  const gain = pairedGainInterval(heldout);
  const checks = {at_least_30_held_out_weeks: holdout.events >= 30,
    improves_brier_and_log_loss_over_both_recent_baselines:
      holdout.events > 0 && holdout.brier < Math.min(holdout.baseline_brier, holdout.recent_weeks_brier) &&
      holdout.log_loss < Math.min(holdout.baseline_log_loss, holdout.recent_weeks_log_loss),
    positive_lower_paired_brier_gain: Boolean(gain && gain[0] > 0),
    sufficient_volume_interval_coverage: holdout.interval_80_coverage >= .7,
    first_publication_vintages_verified: false};
  const release_eligible = Object.values(checks).every(Boolean);
  const findings = [];
  if (!checks.improves_brier_and_log_loss_over_both_recent_baselines) findings.push('The calendar challenger did not improve on both seasonal benchmarks.');
  if (!checks.at_least_30_held_out_weeks) findings.push('The holdout contains fewer than 30 weeks.');
  if (!checks.positive_lower_paired_brier_gain) findings.push('The lower bound on paired Brier improvement did not clear zero.');
  if (!checks.sufficient_volume_interval_coverage) findings.push('The TSA volume range fell below its coverage gate.');
  if (!checks.first_publication_vintages_verified) findings.push('First-publication TSA vintages remain unverified.');
  return {version: 'weekly-tsa-settlement-replay-v2', independent_forecast: true, release_eligible,
    primary_model: WEEKLY_TSA_MODEL, challenger_model: WEEKLY_TSA_CHALLENGER,
    release_reason: findings.join(' '),
    release_checks: checks,
    holdout_start: HOLDOUT, window_end: archive.window_end, archive_sha256: hash(JSON.stringify(archive)),
    observation_rows: observations.length, settled_events: archive.events.length, insufficient_history_events: noForecast.length,
    earlier, holdout, holdout_brier_gain_vs_both_95: gain,
    protocol: [
      'The Friday forecast uses TSA observations through Wednesday under a two-calendar-day publication lag.',
      'Log-volume ridge regression uses weekday, annual Fourier and moving or fixed holiday effects. A recent residual adjustment adapts the current level.',
      'The ensemble weights three point forecasts by rolling prior-week error. Each residual uses the weights available at its own origin.',
      'Both recent baselines use observed days and same weekdays from prior available weeks. The first uses one week and the second weights four.',
      'Kalshi contributes exact contract definitions and finalized $0/$1 outcomes. Exchange prices are excluded.',
      'Scores average within each week before averaging weeks. The paired circular block bootstrap resamples three adjacent weeks per block.',
      'The existing August holdout cutoff is retained. This is a repeated research comparison on that window.',
      'TSA daily values use the currently published vintage. First-publication times and subsequent revisions are unverified.'
    ],
    methodology: ['https://otexts.com/fpp3/tscv.html', 'https://otexts.com/fpp3/dhr.html', 'https://doi.org/10.1198/016214506000001437'],
    events: results};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fresh = process.argv.includes('--fetch');
  const history = fresh ? await captureTsaHistory() : null;
  const archive = fresh ? await capture(history) : JSON.parse(await readFile(ARCHIVE, 'utf8'));
  const result = evaluateWeeklyTsaArchive(archive);
  if (fresh) {
    await writeFile(HISTORY, JSON.stringify(history) + '\n');
    await writeFile(ARCHIVE, JSON.stringify(archive) + '\n');
    await writeFile(RECEIPT, JSON.stringify(result, null, 2) + '\n');
  } else {
    const receipt = JSON.parse(await readFile(RECEIPT, 'utf8'));
    if (JSON.stringify(receipt) !== JSON.stringify(result)) throw new Error('Weekly TSA replay differs from its published receipt');
  }
  const {events, ...summary} = result;
  console.log(JSON.stringify(summary, null, 2));
}
