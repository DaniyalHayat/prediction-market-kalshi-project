import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {readJSON} from '../lib/transport.mjs';
import {
  SETTLEMENT_CALIBRATION_PROTOCOL as protocol,
  evaluateSettlementCalibration,
  settlementCandidate,
  settlementObservation
} from '../lib/workspace/settlement-calibration.mjs';

const API = 'https://api.elections.kalshi.com/trade-api/v2';
const archiveURL = new URL('../research-data/settlement-calibration-archive.json', import.meta.url);
const receiptURL = new URL('../public/research/settlement-calibration.json', import.meta.url);
const START = Date.parse(protocol.window_start) / 1000;
const END = Date.parse(protocol.window_end) / 1000;
const WEEK = 7 * 86400;
const MAX_CALLS = 35;
const hash = value => createHash('sha256').update(value).digest('hex');
const weekOf = timestamp => Math.floor((timestamp - START) / WEEK);
const rank = value => hash('predictir-settlement-calibration-v1:' + value);
let requests = 0;
let lastRequest = 0;
const sources = [];

async function publicRead(path, params, scope) {
  if (requests >= MAX_CALLS) throw new Error('Public read allowance exhausted');
  const delay = 200 - (Date.now() - lastRequest);
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  requests++;
  lastRequest = Date.now();
  const url = API + path + '?' + new URLSearchParams(params);
  const started = new Date().toISOString();
  const record = {scope, url, requested_at: started};
  sources.push(record);
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(10000), redirect: 'error'});
    record.status = response.status;
    if (response.status === 429) throw new Error('Public source rate limit');
    const {data, raw} = await readJSON(response, {source: 'Public Kalshi research', maximumBytes: 14000000});
    record.sha256 = hash(raw);
    record.retrieved_at = new Date().toISOString();
    return data;
  } catch (error) {
    record.error = record.status ? 'HTTP ' + record.status + ' or unreadable response' : 'Source request failed';
    if (record.status === 429) throw error;
    return null;
  }
}

async function capture() {
  const categories = Object.keys(protocol.series);
  const coverage = Object.fromEntries(categories.map(category => [category, {
    series: {}, listed_markets: 0, candidate_markets: 0, unique_candidate_events: 0, sampled_events: 0, observed_events: 0
  }]));
  const events = new Map();
  for (const [category, series] of Object.entries(protocol.series)) {
    for (const ticker of series) {
      const data = await publicRead('/markets', {
        status: 'settled', series_ticker: ticker, min_settled_ts: START, max_settled_ts: END,
        mve_filter: 'exclude', limit: 1000
      }, 'settled series ' + ticker);
      const markets = Array.isArray(data?.markets) ? data.markets : [];
      const tally = {returned: markets.length, eligible: 0, truncated: Boolean(data?.cursor), available: Array.isArray(data?.markets)};
      coverage[category].series[ticker] = tally;
      coverage[category].listed_markets += markets.length;
      for (const market of markets) {
        const candidate = settlementCandidate(market, category, ticker);
        if (!candidate) continue;
        tally.eligible++;
        coverage[category].candidate_markets++;
        const prior = events.get(candidate.event_ticker);
        if (!prior || rank(candidate.ticker) < rank(prior.ticker)) events.set(candidate.event_ticker, candidate);
      }
    }
  }
  const strata = new Map();
  for (const candidate of events.values()) {
    const key = candidate.category + ':' + weekOf(candidate.open_ts);
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(candidate);
    coverage[candidate.category].unique_candidate_events++;
  }
  const batches = new Map();
  for (const group of strata.values()) {
    const selected = group.sort((a, b) => rank(a.event_ticker).localeCompare(rank(b.event_ticker)))
      .slice(0, protocol.per_category_per_week);
    for (const candidate of selected) {
      const week = weekOf(candidate.open_ts);
      if (!batches.has(week)) batches.set(week, []);
      batches.get(week).push(candidate);
      coverage[candidate.category].sampled_events++;
    }
  }
  const observations = [];
  for (const [week, candidates] of [...batches.entries()].sort(([a], [b]) => a - b)) {
    const first = Math.floor(Math.min(...candidates.map(row => row.open_ts)));
    const last = Math.ceil(Math.max(...candidates.map(row => row.latest_observation_ts)));
    const data = await publicRead('/markets/candlesticks', {
      market_tickers: candidates.map(row => row.ticker).join(','),
      start_ts: first, end_ts: last, period_interval: protocol.candle_period_minutes,
      include_latest_before_start: false
    }, 'hourly candle batch ' + week);
    const lookup = new Map((Array.isArray(data?.markets) ? data.markets : [])
      .map(row => [row.market_ticker, row.candlesticks]));
    for (const candidate of candidates) {
      const row = settlementObservation(candidate, lookup.get(candidate.ticker));
      if (!row) continue;
      observations.push(row);
      coverage[candidate.category].observed_events++;
    }
  }
  return {protocol, requests, sources, coverage, observations: observations.sort((a, b) =>
    a.observed_ts - b.observed_ts || a.ticker.localeCompare(b.ticker))};
}

const fresh = process.argv.includes('--fetch');
const archive = fresh ? await capture() : JSON.parse(await readFile(archiveURL, 'utf8'));
if (fresh) {
  await mkdir(new URL('../research-data/', import.meta.url), {recursive: true});
  await writeFile(archiveURL, JSON.stringify(archive, null, 2) + '\n');
}
const {scored, ...evaluation} = evaluateSettlementCalibration(archive.observations);
const result = {
  version: 'settlement-calibration-v1',
  protocol,
  archive_sha256: hash(JSON.stringify(archive)),
  scored_rows_sha256: scored ? hash(JSON.stringify(scored)) : null,
  network_requests: archive.requests,
  sample_coverage: archive.coverage,
  ...evaluation,
  limitations: [
    'The selected series and capped pages define this sample. Categories and contract families outside those pages lack coverage.',
    'Each event contributes at most one ticker, selected by a fixed hash before reading its candle.',
    'Hourly bid and ask closes with observed volume are price observations. Market availability, fill probability and execution costs are separate questions.',
    'The six-hour buffer precedes recorded close, expiry and settlement. The archive lacks authoritative point-in-time publication times for the underlying outcomes.',
    'Training labels settle before the holdout cutoff. Observations from overlapping events are withheld from both partitions.',
    'The diagnostic calibrates the exchange midpoint. Its estimates rely on the same market price as the baseline.',
    'Small weekly samples, unequal category coverage and shared underlying events limit generalization.'
  ]
};
await mkdir(new URL('../public/research/', import.meta.url), {recursive: true});
await writeFile(receiptURL, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({
  requests: archive.requests,
  observations: archive.observations.length,
  available: result.available,
  split: result.split,
  overall: result.overall,
  brier_gain_interval_95: result.brier_gain_interval_95,
  by_category: result.by_category,
  source_failures: archive.sources.filter(source => source.error).map(({scope, status}) => ({scope, status})),
  coverage: Object.fromEntries(Object.entries(archive.coverage).map(([key, value]) => [
    key, {listed: value.listed_markets, candidates: value.unique_candidate_events, sampled: value.sampled_events, observed: value.observed_events}
  ]))
}, null, 2));
