import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {readJSON} from '../lib/transport.mjs';
import {DAY, isoDay, tsaSource} from '../lib/intelligence/sources.mjs';
import {mean, quantile} from '../lib/intelligence/math.mjs';
import {weeklyTsaContract, weeklyTsaForecast, weeklyTsaProbability} from '../lib/intelligence/weekly-tsa.mjs';

const ARCHIVE = new URL('../research-data/weekly-tsa-archive.json', import.meta.url);
const RECEIPT = new URL('../public/research/weekly-tsa.json', import.meta.url);
const API = 'https://api.elections.kalshi.com/trade-api/v2';
const HOLDOUT = '2026-08-01', END = '2026-11-06', HORIZON = 4;
const hash = content => createHash('sha256').update(content).digest('hex');

async function getSettled(path) {
  const url = API + path + '?' + new URLSearchParams({series_ticker: 'KXTSAW', limit: 1000,
    ...(path === '/markets' ? {status: 'settled'} : {})});
  const response = await fetch(url, {signal: AbortSignal.timeout(12000), redirect: 'error'});
  const {data, raw} = await readJSON(response, {source: 'Public Kalshi weekly TSA settlements', maximumBytes: 8000000});
  if (!Array.isArray(data.markets)) throw new Error('Kalshi weekly TSA settlement list is unavailable');
  return {markets: data.markets, lineage: {url, sha256: hash(raw), rows: data.markets.length, truncated: Boolean(data.cursor)}};
}

async function capture() {
  const [source, live, historical] = await Promise.all([tsaSource(), getSettled('/markets'), getSettled('/historical/markets')]);
  const rows = source.rows.filter(row => row.date < END);
  const historicalStart = historical.markets.map(row => row.close_time).filter(Boolean).sort()[0]?.slice(0, 10);
  if (historical.lineage.truncated && (!historicalStart || historicalStart > rows[0].date) || live.lineage.truncated)
    throw new Error('A truncated Kalshi page falls inside the TSA observation window');
  const events = new Map(), seen = new Set();
  for (const market of [...live.markets, ...historical.markets]) {
    const contract = weeklyTsaContract(market);
    if (!contract || !['yes', 'no'].includes(market.result) || !['settled', 'finalized'].includes(market.status) ||
        market.market_type !== 'binary' || market.settlement_value_dollars == null || market.settlement_value_dollars === '' ||
        Number(market.settlement_value_dollars) !== Number(market.result === 'yes') ||
        seen.has(market.ticker) || isoDay(contract.end) < rows[0].date || isoDay(contract.end) >= END) continue;
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
  return {version: 'weekly-tsa-archive-v1', window_end: END, sources: [
    {url: source.source_url, sha256: source.sha256, rows: rows.length, retrieved_at: source.retrieved_at},
    live.lineage, historical.lineage
  ], observations: rows.map(row => [row.date, row.value]), events: replayEvents};
}

function scores(events) {
  return {events: events.length, contracts: events.reduce((total, event) => total + event.n, 0),
    brier: mean(events.map(event => event.brier)), baseline_brier: mean(events.map(event => event.baseline_brier)),
    log_loss: mean(events.map(event => event.log_loss)), baseline_log_loss: mean(events.map(event => event.baseline_log_loss))};
}

export function evaluateWeeklyTsaArchive(archive) {
  const observations = archive.observations.map(([date, value]) => ({date, value}));
  const results = [], noForecast = [];
  for (const event of archive.events) {
    const forecast = weeklyTsaForecast(observations, Date.parse(event.end), HORIZON);
    if (!forecast) { noForecast.push(event.event); continue; }
    const predictions = event.outcomes.map(([ticker, strike, outcome]) => ({
      ticker, outcome, probability: weeklyTsaProbability(forecast, strike).probability,
      baseline: weeklyTsaProbability(forecast, strike, true).probability
    }));
    const loss = (p, y) => -Math.log(y ? p : 1 - p);
    results.push({event: event.event, end: event.end, origin: event.origin, n: predictions.length,
      brier: mean(predictions.map(row => (row.probability - row.outcome) ** 2)),
      baseline_brier: mean(predictions.map(row => (row.baseline - row.outcome) ** 2)),
      log_loss: mean(predictions.map(row => loss(row.probability, row.outcome))),
      baseline_log_loss: mean(predictions.map(row => loss(row.baseline, row.outcome)))});
  }
  const heldout = results.filter(row => row.end >= HOLDOUT);
  const holdout = scores(heldout), earlier = scores(results.filter(row => row.end < HOLDOUT));
  let seed = 742413;
  const gains = heldout.length < 10 ? [] : Array.from({length: 2000}, () =>
    mean(heldout.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const row = heldout[Math.floor(seed / 4294967296 * heldout.length)];
      return row.baseline_brier - row.brier;
    })));
  return {version: 'weekly-tsa-settlement-replay-v1', independent_forecast: true, release_eligible: false,
    holdout_start: HOLDOUT, window_end: archive.window_end, archive_sha256: hash(JSON.stringify(archive)),
    observation_rows: observations.length, settled_events: archive.events.length, insufficient_history_events: noForecast.length,
    earlier, holdout, holdout_brier_gain_95: gains.length ? [quantile(gains, .025), quantile(gains, .975)] : null,
    protocol: [
      'The Friday forecast uses TSA observations through Wednesday under a two-calendar-day publication lag.',
      'The model uses only earlier resolved weeks to estimate horizon-matched residuals. The prior completed week is the baseline.',
      'Kalshi contributes exact contract definitions and finalized $0/$1 outcomes. Exchange prices are excluded.',
      'Scores average within each week before averaging weeks. The paired bootstrap resamples whole weeks.',
      'TSA daily values use the currently published vintage. First-publication times and subsequent revisions are unverified.'
    ], events: results};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fresh = process.argv.includes('--fetch');
  const archive = fresh ? await capture() : JSON.parse(await readFile(ARCHIVE, 'utf8'));
  const result = evaluateWeeklyTsaArchive(archive);
  if (fresh) {
    await writeFile(ARCHIVE, JSON.stringify(archive) + '\n');
    await writeFile(RECEIPT, JSON.stringify(result, null, 2) + '\n');
  } else {
    const receipt = JSON.parse(await readFile(RECEIPT, 'utf8'));
    if (JSON.stringify(receipt) !== JSON.stringify(result)) throw new Error('Weekly TSA replay differs from its published receipt');
  }
  const {events, ...summary} = result;
  console.log(JSON.stringify(summary, null, 2));
}
