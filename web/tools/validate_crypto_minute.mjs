import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';
import {readJSON} from '../lib/transport.mjs';
import {DAY, isoDay} from '../lib/intelligence/sources.mjs';
import {mean} from '../lib/intelligence/math.mjs';
import {CRYPTO_MINUTE_SERIES, cryptoMinuteSource, minuteCryptoContract, minuteCryptoFeatures, minuteCryptoPrediction} from '../lib/intelligence/crypto-minute.mjs';

const ARCHIVE = new URL('../research-data/crypto-minute-archive.json.gz', import.meta.url);
const RECEIPT = new URL('../public/research/crypto-minute.json', import.meta.url);
const EXCHANGE = 'https://api.elections.kalshi.com/trade-api/v2';
const START = Date.parse('2026-09-25T00:00:00Z'), HOLDOUT = Date.parse('2026-10-13T00:00:00Z'), END = Date.parse('2026-11-03T00:00:00Z');
const LEAD = 8 * 60000, PAGE = 299 * 60000;
const hash = content => createHash('sha256').update(content).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getMarkets(series) {
  const query = new URLSearchParams({series_ticker: series, status: 'settled', limit: 1000,
    min_settled_ts: START / 1000, max_settled_ts: (END + 3600000) / 1000});
  const outcomes = [], seen = new Set(), source = [];
  let cursor = '';
  do {
    if (source.length >= 20) throw new Error('Kalshi settlement cursor exceeded the capture bound');
    if (cursor) query.set('cursor', cursor);
    const url = EXCHANGE + '/markets?' + query;
    const response = await fetch(url, {signal: AbortSignal.timeout(12000), redirect: 'error'});
    const {data, raw} = await readJSON(response, {source: 'Public Kalshi 15-minute settlements', maximumBytes: 8000000});
    if (!Array.isArray(data.markets) || typeof data.cursor !== 'string' || cursor && cursor === data.cursor) {
      throw new Error('Missing or invalid Kalshi settlement page: ' + series);
    }
    source.push({url, rows: data.markets.length, sha256: hash(raw)});
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
    cursor = data.cursor;
    if (cursor) await sleep(450);
  } while (cursor);
  return {source, outcomes: outcomes.sort((a, b) => a.close - b.close)};
}

function quoteAt(candles, timestamp) {
  const row = candles.find(value => value.end_period_ts * 1000 === timestamp);
  const price = value => typeof value === 'string' && /^\d\.\d{1,6}$/.test(value) ? Number(value) : NaN;
  const bid = price(row?.yes_bid?.close_dollars), ask = price(row?.yes_ask?.close_dollars);
  return bid > 0 && ask < 1 && bid <= ask ? [bid, ask] : null;
}

async function getQuoteCaptures(outcomes) {
  const blocks = new Map(), source = [], quotes = {};
  for (const row of outcomes) {
    if (row.close < HOLDOUT) continue;
    const block = Math.floor((row.close - 1) / (6 * 3600000));
    if (!blocks.has(block)) blocks.set(block, []);
    blocks.get(block).push(row);
  }
  for (const block of blocks.values()) {
    const query = new URLSearchParams({market_tickers: block.map(row => row.ticker).join(','),
      start_ts: (block[0].close - LEAD) / 1000 - 60, end_ts: (block.at(-1).close - LEAD) / 1000 + 60,
      period_interval: '1', include_latest_before_start: 'false'});
    const url = EXCHANGE + '/markets/candlesticks?' + query;
    const response = await fetch(url, {signal: AbortSignal.timeout(15000), redirect: 'error'});
    const {data, raw} = await readJSON(response, {source: 'Public Kalshi one-minute quote candles', maximumBytes: 8000000});
    if (!Array.isArray(data.markets)) throw new Error('Invalid Kalshi quote capture');
    const contracts = new Map(block.map(row => [row.ticker, row]));
    source.push({url, market_count: data.markets.length, sha256: hash(raw)});
    for (const row of data.markets) {
      const contract = contracts.get(row.market_ticker);
      if (!contract || !Array.isArray(row.candlesticks)) continue;
      const origin = contract.close - LEAD;
      quotes[row.market_ticker] = [quoteAt(row.candlesticks, origin), quoteAt(row.candlesticks, origin + 60000)];
    }
    await sleep(550);
  }
  return {source, quotes};
}

async function capture() {
  const seriesData = Object.fromEntries(await Promise.all(Object.keys(CRYPTO_MINUTE_SERIES).map(async series => {
    const {source, outcomes} = await getMarkets(series);
    const pages = [], bars = [];
    for (let from = START - PAGE; from < END; from += PAGE) {
      const page = await cryptoMinuteSource(series, {start: from, end: Math.min(from + PAGE, END)});
      pages.push({url: page.source_url, sha256: page.sha256, rows: page.bars.length});
      bars.push(...page.bars);
      await sleep(400);
    }
    return [series, {source, pages, bars, outcomes, quote_capture: await getQuoteCaptures(outcomes)}];
  })));
  return {version: 'crypto-minute-archive-v2', start: START, holdout_start: HOLDOUT, end: END, lead_ms: LEAD, series: seriesData};
}

const brier = (probability, outcome) => (probability - outcome) ** 2;
const logLoss = (probability, outcome) => -Math.log(outcome ? probability : 1 - probability);
const average = values => values.length ? mean(values) : null;
const GRID = [0, .25, .5, .75, 1];

function fitProfile(earlier, lead_minutes) {
  if (earlier.length < 500) throw new Error('Insufficient completed development forecasts');
  let best;
  for (const basis_weight of GRID) for (const gaussian_weight of GRID) {
    const profile = {lead_minutes, basis_weight, gaussian_weight};
    const score = mean(earlier.map(row => brier(minuteCryptoPrediction(row.features, profile).probability, row.outcome)));
    if (!best || score < best.score) best = {profile, score};
  }
  return best.profile;
}

function groupedByDay(rows) {
  const groups = new Map();
  for (const row of rows) {
    const day = isoDay(row.close);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(row);
  }
  return groups;
}

function twoDayBlockInterval(rows, measure) {
  const daily = [...groupedByDay(rows).values()].map(group => mean(group.map(measure)));
  if (daily.length < 2) return null;
  let seed = 9481;
  const draw = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return Math.floor(seed / 2 ** 32 * daily.length);
  };
  const estimates = Array.from({length: 2000}, () => {
    let sum = 0;
    for (let i = 0; i < daily.length; i += 2) {
      const index = draw();
      sum += daily[index];
      if (i + 1 < daily.length) sum += daily[(index + 1) % daily.length];
    }
    return sum / daily.length;
  }).sort((a, b) => a - b);
  return [estimates[49], estimates[1949]];
}

function metrics(rows, benchmark) {
  return {n: rows.length,
    brier: average(rows.map(r => brier(r.probability, r.outcome))),
    baseline_brier: average(rows.map(r => brier(r[benchmark], r.outcome))),
    log_loss: average(rows.map(r => logLoss(r.probability, r.outcome))),
    baseline_log_loss: average(rows.map(r => logLoss(r[benchmark], r.outcome))),
    paired_brier_gain_95: twoDayBlockInterval(rows, r => brier(r[benchmark], r.outcome) - brier(r.probability, r.outcome))};
}

function calibration(rows) {
  return Array.from({length: 10}, (_, i) => {
    const bin = rows.filter(r => Math.min(9, Math.floor(r.probability * 10)) === i);
    return {lower: i / 10, upper: (i + 1) / 10, n: bin.length,
      forecast_mean: average(bin.map(row => row.probability)), realized_rate: average(bin.map(row => row.outcome))};
  });
}

function delayedQuoteReplay(rows) {
  const cost = price => price + Math.ceil(7 * price * (1 - price) - 1e-12) / 100;
  const evaluated = rows.map(row => {
    const [bid, ask] = row.quote, candidates = [
      {side: 1, entry: ask, margin: row.interval[0] - cost(ask)},
      {side: 0, entry: 1 - bid, margin: 1 - row.interval[1] - cost(1 - bid)},
    ].sort((a, b) => b.margin - a.margin);
    const [signal] = candidates;
    if (signal.margin < .01) return {...row, attempted: false, fill: false, pnl: 0};
    const next = row.delayed_quote && (signal.side ? row.delayed_quote[1] : 1 - row.delayed_quote[0]);
    if (!next || cost(next) > cost(signal.entry) + 1e-9) return {...row, attempted: true, fill: false, pnl: 0};
    return {...row, attempted: true, fill: true, pnl: Number(row.outcome === signal.side) - cost(next)};
  });
  return {eligible_quote_rows: evaluated.length, attempts: evaluated.filter(r => r.attempted).length,
    delayed_quote_rows: evaluated.filter(r => r.delayed_quote).length, indicative_fills: evaluated.filter(r => r.fill).length,
    net_pnl_dollars: evaluated.reduce((sum, row) => sum + row.pnl, 0),
    daily_block_pnl_per_quoted_origin_95: twoDayBlockInterval(evaluated, r => r.pnl)};
}

export function evaluateCryptoMinuteArchive(archive) {
  const by_series = {};
  for (const [series, {outcomes, bars, quote_capture}] of Object.entries(archive.series)) {
    const observations = [];
    for (const contract of outcomes) {
      const origin = contract.close - archive.lead_ms;
      const features = minuteCryptoFeatures(contract, bars, origin);
      if (!features || features.observed_at !== origin) continue;
      const [quote, delayed_quote] = quote_capture?.quotes[contract.ticker] || [];
      observations.push({close: contract.close, outcome: contract.outcome, features, quote, delayed_quote});
    }
    const development = observations.filter(row => row.close < archive.holdout_start);
    const selected_profile = fitProfile(development, archive.lead_ms / 60000);
    const scores = observations.map(row => ({
      ...row, ...minuteCryptoPrediction(row.features, selected_profile), coinflip: .5,
      static: minuteCryptoPrediction({...row.features, historical: row.features.baseline}).probability,
      incumbent: minuteCryptoPrediction(row.features).probability,
      gaussian: minuteCryptoPrediction(row.features, {gaussian_weight: 1}).probability,
      market_mid: row.quote ? (row.quote[0] + row.quote[1]) / 2 : null,
    }));
    const heldout = scores.filter(row => row.close >= archive.holdout_start);
    const quoted = heldout.filter(row => row.quote);
    const days = groupedByDay(heldout);
    const holdout = metrics(heldout, 'static');
    const incumbent = metrics(heldout, 'incumbent');
    const gauss = metrics(heldout, 'gaussian');
    const market = metrics(quoted, 'market_mid');
    const costs = delayedQuoteReplay(quoted);
    const gates = {
      at_least_fourteen_held_out_days: days.size >= 14,
      at_least_ninety_five_percent_completed_origins: heldout.length >= .95 * outcomes.filter(row => row.close >= archive.holdout_start).length,
      at_least_ninety_percent_matched_quotes: heldout.length > 0 && quoted.length / heldout.length >= .90,
      paired_gain_over_static: (holdout.paired_brier_gain_95?.[0] ?? -1) > 0,
      paired_gain_over_incumbent: (incumbent.paired_brier_gain_95?.[0] ?? -1) > 0,
      paired_gain_over_gaussian: (gauss.paired_brier_gain_95?.[0] ?? -1) > 0,
      paired_gain_over_market_midpoint: (market.paired_brier_gain_95?.[0] ?? -1) > 0,
      positive_delayed_paper_returns: costs.indicative_fills >= 30 && (costs.daily_block_pnl_per_quoted_origin_95?.[0] ?? -1) > 0,
      verified_historical_depth: false,
    };
    const release_eligible = Object.values(gates).every(Boolean);
    by_series[series] = {settled_events: outcomes.length, bars: bars.length, missing_origin_rows: outcomes.length - scores.length,
      selected_profile, development: metrics(scores.filter(row => row.close < archive.holdout_start), 'static'),
      holdout, held_out_days: days.size, incumbent_benchmark: incumbent, gaussian_benchmark: gauss,
      coinflip_benchmark: metrics(heldout, 'coinflip'),
      midpoint_benchmark: market, calibration: calibration(heldout), paper_replay: costs, release_gates: gates, release_eligible,
      release_reason: !gates.paired_gain_over_market_midpoint ? 'The held-out forecasts did not establish a positive paired Brier gain over Kalshi’s quoted midpoint.' :
        !gates.positive_delayed_paper_returns ? 'The delayed, fee-adjusted quote replay did not establish positive paper returns.' :
        'The available quote history contains no executable depth, so an entry remains a research scenario.'};
  }
  return {version: 'crypto-minute-settlement-replay-v2', independent_forecast: true, release_eligible: Object.values(by_series).every(r => r.release_eligible),
    archive_sha256: hash(JSON.stringify(archive)), start: new Date(archive.start).toISOString(),
    holdout_start: new Date(archive.holdout_start).toISOString(), end: new Date(archive.end).toISOString(),
    minutes_before_close: archive.lead_ms / 60000, by_series, protocol: [
      'A fixed eight-minute lead uses only completed Coinbase minutes. Gap or mismatched contract rules withhold the prediction.',
      'Exact binary outcomes come from finalized Kalshi settlement. Contract terms provide the named CF index and known starting strike.',
      'Coinbase OHLC approximates each minute average. The settlement index is separately calculated by CF Benchmarks.',
      'Opening Coinbase-to-CF basis weight and Gaussian mixture weight are selected on the chronological development prefix only. Test-period exchange quotes are never forecast inputs.',
      'Benchmarks are coin flip, static empirical returns, the prior volatility-adjusted empirical model, Gaussian EWMA and the exact-minute Kalshi bid/ask midpoint on matched rows.',
      'Two-day moving blocks preserve local serial dependence and weight each UTC day equally for paired Brier gain and paper P&L intervals.',
      'Paper entries require a one-cent conservative margin above rounded standard taker fees. A one-minute delayed quote must still clear the predeclared entry cap.',
      'Quote candles lack displayed size and do not guarantee fills or profits. Releases require independently verified historical depth.'
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
