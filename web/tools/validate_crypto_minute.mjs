import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';
import {readJSON} from '../lib/transport.mjs';
import {DAY, isoDay} from '../lib/intelligence/sources.mjs';
import {mean} from '../lib/intelligence/math.mjs';
import {CRYPTO_MINUTE_SERIES, cryptoMinuteSource, minuteCryptoContract, minuteCryptoForecast} from '../lib/intelligence/crypto-minute.mjs';

const ARCHIVE = new URL('../research-data/crypto-minute-archive.json.gz', import.meta.url);
const RECEIPT = new URL('../public/research/crypto-minute.json', import.meta.url);
const EXCHANGE = 'https://api.elections.kalshi.com/trade-api/v2';
const START = Date.parse('2026-11-03T00:00:00Z'), HOLDOUT = START + 2 * DAY, END = START + 4 * DAY;
const LEAD = 8 * 60000, PAGE = 299 * 60000;
const hash = content => createHash('sha256').update(content).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getMarkets(series) {
  const url = EXCHANGE + '/markets?' + new URLSearchParams({series_ticker: series, status: 'settled', limit: 1000,
    min_settled_ts: START / 1000, max_settled_ts: (END + 3600000) / 1000});
  const response = await fetch(url, {signal: AbortSignal.timeout(12000), redirect: 'error'});
  const {data, raw} = await readJSON(response, {source: 'Public Kalshi 15-minute settlements', maximumBytes: 8000000});
  if (!Array.isArray(data.markets) || data.cursor) throw new Error('Missing or truncated Kalshi settlement page: ' + series);
  const outcomes = [], seen = new Set();
  for (const row of data.markets) {
    const contract = minuteCryptoContract(row);
    if (!contract || contract.series !== series || contract.close < START || contract.close >= END ||
        !['yes', 'no'].includes(row.result) || !['settled', 'finalized'].includes(row.status) || row.market_type !== 'binary' ||
        row.settlement_value_dollars == null || row.settlement_value_dollars === '' ||
        Number(row.settlement_value_dollars) !== Number(row.result === 'yes') || seen.has(contract.event)) continue;
    const open = Math.max(Date.parse(row.created_time), Date.parse(row.open_time));
    const settle = Date.parse(row.settlement_ts);
    if (!Number.isFinite(open) || !Number.isFinite(settle) || open >= contract.close - LEAD || settle < contract.close) continue;
    outcomes.push({...contract, outcome: Number(row.result === 'yes')});
    seen.add(contract.event);
  }
  return {source: {url, rows: data.markets.length, sha256: hash(raw)}, outcomes: outcomes.sort((a, b) => a.close - b.close)};
}

async function capture() {
  const seriesData = {};
  for (const series of Object.keys(CRYPTO_MINUTE_SERIES)) {
    const {source, outcomes} = await getMarkets(series);
    const pages = [], bars = [];
    for (let from = START - PAGE; from < END; from += PAGE) {
      const page = await cryptoMinuteSource(series, {start: from, end: Math.min(from + PAGE, END)});
      pages.push({url: page.source_url, sha256: page.sha256, rows: page.bars.length});
      bars.push(...page.bars);
      await sleep(250);
    }
    seriesData[series] = {source, pages, bars, outcomes};
  }
  return {version: 'crypto-minute-archive-v1', start: START, holdout_start: HOLDOUT, end: END, lead_ms: LEAD, series: seriesData};
}

function metrics(rows) {
  const loss = (p, y) => -Math.log(y ? p : 1 - p);
  return {n: rows.length, brier: mean(rows.map(r => (r.probability - r.outcome) ** 2)),
    static_brier: mean(rows.map(r => (r.baseline - r.outcome) ** 2)), coinflip_brier: rows.length ? .25 : null,
    log_loss: mean(rows.map(r => loss(r.probability, r.outcome))),
    static_log_loss: mean(rows.map(r => loss(r.baseline, r.outcome))),
    wins: rows.filter(r => Number(r.probability >= .5) === r.outcome).length};
}

export function evaluateCryptoMinuteArchive(archive) {
  const by_series = {};
  for (const [series, {outcomes, bars}] of Object.entries(archive.series)) {
    const scores = [];
    for (const contract of outcomes) {
      const origin = contract.close - archive.lead_ms;
      const forecast = minuteCryptoForecast(contract, bars, origin);
      if (!forecast || forecast.observed_at !== origin) continue;
      scores.push({close: contract.close, outcome: contract.outcome, probability: forecast.probability, baseline: forecast.baseline});
    }
    const heldout = scores.filter(row => row.close >= archive.holdout_start);
    const days = [...new Set(heldout.map(row => isoDay(row.close)))];
    by_series[series] = {settled_events: outcomes.length, bars: bars.length, missing_origin_rows: outcomes.length - scores.length,
      earlier: metrics(scores.filter(row => row.close < archive.holdout_start)), holdout: metrics(heldout),
      by_holdout_day: Object.fromEntries(days.map(day => [day, metrics(heldout.filter(row => isoDay(row.close) === day))])),
      release_eligible: false};
  }
  return {version: 'crypto-minute-settlement-replay-v1', independent_forecast: true, release_eligible: false,
    archive_sha256: hash(JSON.stringify(archive)), start: new Date(archive.start).toISOString(),
    holdout_start: new Date(archive.holdout_start).toISOString(), end: new Date(archive.end).toISOString(),
    minutes_before_close: archive.lead_ms / 60000, by_series, protocol: [
      'A fixed eight-minute lead uses only completed Coinbase minutes. Gap or mismatched contract rules withhold the prediction.',
      'Exact binary outcomes come from finalized Kalshi settlement. Contract terms provide the named CF index and known starting strike.',
      'Coinbase OHLC approximates each minute average. The settlement index is separately calculated by CF Benchmarks.',
      'A constant 50% baseline and the same empirical returns without short-term volatility adjustment are scored on identical rows.',
      'The short holdout has serially related observations and no comparable cost or trade simulation. It does not establish repeatable edge.'
    ]};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fresh = process.argv.includes('--fetch');
  const archive = fresh ? await capture() : JSON.parse(gunzipSync(await readFile(ARCHIVE)));
  const result = evaluateCryptoMinuteArchive(archive);
  if (fresh) {
    await writeFile(ARCHIVE, gzipSync(JSON.stringify(archive)));
    await writeFile(RECEIPT, JSON.stringify(result, null, 2) + '\n');
  } else {
    const receipt = JSON.parse(await readFile(RECEIPT, 'utf8'));
    if (JSON.stringify(receipt) !== JSON.stringify(result)) throw new Error('Crypto replay differs from its published receipt');
  }
  console.log(JSON.stringify(result, null, 2));
}
