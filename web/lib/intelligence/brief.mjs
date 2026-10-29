import { createHash } from 'node:crypto';
import { marketDetails, request, book, validateTicker } from '../live.mjs';
import { CATEGORIES } from './catalog.mjs';
import { researchReport, modelEvidence } from './index.mjs';
import { executionEstimate } from './math.mjs';

const NEWS_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const RSS_ENDPOINT = 'https://news.google.com/rss/search';
const NEWS_WINDOW = 7 * 86400000;
const newsState = { cache: new Map(), inflight: new Map(), retryAt: 0 };
const clean = (value, maximum = 6000) => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum) : '';
function publicURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function gdeltTime(value) {
  if (typeof value !== 'string') return null;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!compact && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const text = compact ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z` : value;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === text.slice(0, 19) ? date.toISOString() : null;
}

export function newsQuery(market, category) {
  const fixed = { travel: '"TSA" "passenger"', weather: '"weather" "temperature"',
    inflation: '"US" "inflation"', labor: '"US" "unemployment"',
    crypto: /ETH/.test(market.ticker || '') ? '"Ethereum"' : '"Bitcoin"' };
  if (fixed[category?.id]) return fixed[category.id] + ' sourcelang:english';
  const stop = new Set('will would could should the a an to in on by of for is are be at win wins yes no over under than before after'.split(' '));
  const terms = clean(market.title, 300).match(/[\p{L}\p{N}]+/gu) || [];
  const selected = [...new Set(terms.filter(term => term.length >= 3 && !/^\d+$/.test(term) && !stop.has(term.toLowerCase())))].slice(0, 7);
  return selected.length ? selected.map(term => `"${term}"`).join(' ') + ' sourcelang:english' : null;
}

export function parseHeadlines(payload, now = Date.now(), maximum = 8) {
  if (!payload || !Array.isArray(payload.articles)) throw new Error('GDELT article-list schema unavailable');
  const found = new Map();
  for (const article of payload.articles.slice(0, 30)) {
    const url = publicURL(article.url), seen = gdeltTime(article.seendate), title = clean(article.title, 240);
    const time = seen ? Date.parse(seen) : NaN;
    if (!url || !title || !Number.isFinite(time) || time > now + 300000 || time < now - NEWS_WINDOW) continue;
    const canonical = new URL(url); canonical.hash = '';
    if (found.has(canonical.href)) continue;
    found.set(canonical.href, { title, url: canonical.href, domain: new URL(url).hostname,
      seen_at: seen, published_at: null, language: clean(article.language, 40),
      source_country: clean(article.sourcecountry, 80) });
  }
  return [...found.values()].sort((a, b) => b.seen_at.localeCompare(a.seen_at)).slice(0, maximum);
}

function xmlText(value) {
  return clean(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'), 1000)
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const value = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : whole;
    });
}

export function parseGoogleNewsRss(xml, now = Date.now(), maximum = 8) {
  // No XML evaluator is used. Reject declarations instead of expanding any entities.
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss\b/i.test(xml) || !/<\/rss\s*>/i.test(xml)) throw new Error('Google News RSS schema unavailable');
  const found = new Map();
  for (const item of [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)].slice(0, 30)) {
    const read = name => item[1].match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '\\s*>', 'i'))?.[1] || '';
    const url = publicURL(xmlText(read('link'))), title = xmlText(read('title')).slice(0, 240);
    const rawDate = xmlText(read('pubDate')), time = Date.parse(rawDate);
    if (!url || !title || !Number.isFinite(time) || time > now + 300000 || time < now - NEWS_WINDOW) continue;
    const sourceTag = item[1].match(/<source\b([^>]*)>([\s\S]*?)<\/source\s*>/i);
    const publisher = sourceTag ? xmlText(sourceTag[2]).slice(0, 160) : '';
    const publisherURL = publicURL(sourceTag?.[1].match(/\burl\s*=\s*["']([^"']+)["']/i)?.[1] || '');
    const canonical = new URL(url); canonical.hash = '';
    if (found.has(canonical.href)) continue;
    found.set(canonical.href, { title, url: canonical.href,
      domain: publisherURL ? new URL(publisherURL).hostname : canonical.hostname,
      publisher: publisher || canonical.hostname, publisher_url: publisherURL,
      published_at: new Date(time).toISOString(), seen_at: null,
      language: null, source_country: null, provider: 'Google News RSS' });
  }
  return [...found.values()].sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, maximum);
}

async function boundedNewsBytes(response) {
  if (Number(response.headers.get('content-length') || 0) > 1000000) throw new Error('News response exceeded size bound');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1000000) { await reader.cancel(); throw new Error('News response exceeded size bound'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

async function fetchRssHeadlines(query, { fetcher, now, state, reason }) {
  state.rssCache ||= new Map(); state.rssInflight ||= new Map();
  const url = new URL(RSS_ENDPOINT);
  const rssQuery = query.replace(/\bsourcelang:[A-Za-z-]+\b/gi, '').trim().slice(0, 350);
  url.search = new URLSearchParams({ q: rssQuery, hl: 'en-US', gl: 'US', ceid: 'US:en' }).toString();
  const key = url.href, cached = state.rssCache.get(key);
  if (cached && now() - cached.at < cached.ttl) return { ...cached.value, fallback_reason: reason };
  if (state.rssRetryAt > now()) return { status: 'unavailable', articles: [], provider: 'Google News RSS', query: rssQuery,
    source_url: key, retrieved_at: null, error: 'Google News retrieval is paused after a provider rate limit', fallback_reason: reason };
  if (state.rssInflight.has(key)) return state.rssInflight.get(key);
  const task = (async () => {
    let value;
    try {
      const response = await fetcher(key, { method: 'GET', headers: { Accept: 'application/rss+xml, application/xml, text/xml',
        'User-Agent': 'KalshiMarketLab/3.0 headline-metadata-research' }, signal: AbortSignal.timeout(12000), redirect: 'error', cache: 'no-store' });
      if (response.status === 429) { state.rssRetryAt = now() + 600000; throw new Error('Google News returned HTTP 429; retries paused'); }
      if (!response.ok) throw new Error('Google News returned HTTP ' + response.status);
      const bytes = await boundedNewsBytes(response), articles = parseGoogleNewsRss(bytes.toString('utf8'), now());
      value = { status: articles.length ? 'live' : 'empty', articles, provider: 'Google News RSS', query: rssQuery,
        source_url: key, retrieved_at: new Date(now()).toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'),
        fallback_reason: reason, time_semantics: 'published_at is publication metadata reported by the RSS feed, not independently verified publication time',
        caveat: 'Publisher metadata and keyword matches can be incomplete or inaccurate. Article bodies are not fetched and headlines do not change probabilities.' };
    } catch (error) {
      value = { status: 'unavailable', articles: [], provider: 'Google News RSS', query: rssQuery,
        source_url: key, retrieved_at: null, fallback_reason: reason, error: clean(error.message, 250),
        caveat: 'Neither news provider supplied evidence; this does not mean that nothing happened.' };
    }
    if (state.rssCache.size >= 24) state.rssCache.delete(state.rssCache.keys().next().value);
    state.rssCache.set(key, { at: now(), ttl: value.status === 'unavailable' ? 60000 : 300000, value });
    return value;
  })();
  state.rssInflight.set(key, task);
  try { return await task; } finally { state.rssInflight.delete(key); }
}

export async function fetchHeadlines(query, { fetcher = fetch, now = Date.now, state = newsState } = {}) {
  if (!query) return { status: 'not_queried', articles: [], query: null, source_url: null, retrieved_at: null };
  const url = new URL(NEWS_ENDPOINT);
  url.search = new URLSearchParams({ query: query.slice(0, 350), mode: 'artlist', format: 'json',
    maxrecords: '15', timespan: '7d', sort: 'datedesc' }).toString();
  const key = url.href, cached = state.cache.get(key);
  if (cached && now() - cached.at < 300000) return cached.value;
  if (state.retryAt > now()) return fetchRssHeadlines(query, { fetcher, now, state, reason: 'GDELT retrieval is paused after a provider rate limit' });
  if (state.inflight.has(key)) return state.inflight.get(key);
  const task = (async () => {
    try {
      const response = await fetcher(key, { method: 'GET', headers: { Accept: 'application/json',
        'User-Agent': 'KalshiMarketLab/3.0 headline-metadata-research' }, signal: AbortSignal.timeout(12000), redirect: 'error', cache: 'no-store' });
      if (response.status === 429) { state.retryAt = now() + 600000; throw new Error('GDELT returned HTTP 429; retries paused'); }
      if (!response.ok) throw new Error('GDELT returned HTTP ' + response.status);
      const bytes = await boundedNewsBytes(response), articles = parseHeadlines(JSON.parse(bytes.toString('utf8')), now());
      const value = { status: articles.length ? 'live' : 'empty', articles, query, source_url: key,
        provider: 'GDELT DOC 2.0',
        retrieved_at: new Date(now()).toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'),
        time_semantics: 'seen_at is GDELT first-seen metadata, not a verified article publication time',
        caveat: 'Keyword matches can be irrelevant, incomplete, syndicated or inaccurate. Headlines do not change model probabilities.' };
      if (state.cache.size >= 24) state.cache.delete(state.cache.keys().next().value);
      state.cache.set(key, { at: now(), value });
      return value;
    } catch (error) {
      return fetchRssHeadlines(query, { fetcher, now, state, reason: clean(error.message, 250) });
    }
  })();
  state.inflight.set(key, task);
  try { return await task; } finally { state.inflight.delete(key); }
}

function driverChecklist(category, market, seriesProfile) {
  const text = `${seriesProfile?.category || ''} ${market.title || ''} ${market.rules_primary || ''}`;
  const id = category?.id || (/sport|basketball|football|baseball|hockey|tennis/i.test(text) ? 'sports'
    : /election|president|senate|governor|politic/i.test(text) ? 'politics'
    : /Federal Reserve|interest rate|GDP|econom/i.test(text) ? 'macro'
    : /movie|music|award|stream|entertainment/i.test(text) ? 'entertainment' : 'other');
  const specific = {
    travel: [['Passenger counts', 'Check the latest nationwide TSA observation and same-weekday seasonal pattern.'], ['Calendar effects', 'Check holidays, disruptions and the exact observation date; weekly contracts require a different model.']],
    weather: [['Station and local day', 'Match the settlement station, timezone and official daily climate report.'], ['Forecast and observed maximum', 'Check forecast updates, already observed highs and grid-to-station differences.']],
    inflation: [['Release definition', 'Confirm CPI month-over-month versus year-over-year and seasonal adjustment.'], ['Measurement and revisions', 'Check release timing, rounding conventions, first-release rules and changes in inflation regimes.']],
    labor: [['Labor release', 'Confirm the U-3 unemployment definition, observation month and first-release rules.'], ['Turning points', 'Check labor-force participation, revisions and whether recent changes differ from historical regimes.']],
    crypto: [['Settlement index and time', 'Match the exact index and averaging window; Coinbase is only an independent proxy.'], ['Volatility and tails', 'Check current volatility, jumps, liquidity and exchange basis; a terminal model cannot price a touch event.']],
    sports: [['Official event and lineup', 'Verify the competition, schedule, injuries, confirmed lineup and cancellation rules.'], ['Independent strength estimate', 'A separately validated matchup model is required; neither quoted odds nor a headline is an independent win probability.']],
    politics: [['Official rules and field', 'Check the eligible candidate field, deadlines, certification rules and settlement source.'], ['Polling and uncertainty', 'Check dated polls, sampling design and turnout; no electoral probability model is mapped here.']],
    macro: [['Release or policy decision', 'Confirm the exact decision/release, meeting date, units and settlement authority.'], ['Independent forecast inputs', 'Check recent official releases and model definition; no probability is inferred from related market prices.']],
    entertainment: [['Official measurement', 'Check the named chart, award body, reporting window and revision rules.'], ['Comparable evidence', 'Check directly comparable dated observations; no validated outcome model is mapped here.']],
    other: [['Resolution evidence', 'Find the named official authority and the exact observation, threshold and deadline.'], ['Independent data', 'A matched dataset and validated outcome model are needed before assigning an independent probability.']],
  };
  return [['Settlement terms', 'Read the full primary and secondary rules before comparing any estimate with the market.'], ...specific[id]]
    .map(([name, detail]) => ({ name, detail, kind: 'verification_check' }));
}

function validForecast(row) {
  return row && Number.isFinite(row.probability) && row.probability >= 0 && row.probability <= 1
    && Array.isArray(row.interval) && row.interval.length === 2 && row.interval.every(Number.isFinite)
    && row.interval[0] >= 0 && row.interval[1] <= 1 && row.interval[0] <= row.probability && row.probability <= row.interval[1];
}
const percent = value => `${(100 * value).toFixed(1)}%`;

export async function marketBrief(ticker, options = {}, dependencies = {}) {
  validateTicker(ticker);
  const { contracts = 100, slippage = 2, coefficient = .07, uncertainty_buffer = .02 } = options;
  executionEstimate({ orderbook_fp: {} }, 'yes', contracts, slippage, coefficient);
  if (!Number.isFinite(uncertainty_buffer) || uncertainty_buffer < 0 || uncertainty_buffer > .25) throw new RangeError('Invalid uncertainty buffer');
  const deps = { marketDetails, request, book, researchReport, headlines: fetchHeadlines, now: Date.now, ...dependencies };
  const detail = await deps.marketDetails(ticker);
  if (!detail.market || detail.market.ticker !== ticker) throw new Error('Official market response did not match selected ticker');
  const market = detail.market;
  const series = [market.series_ticker, market.series, market.event_ticker?.split('-')[0], ticker.split('-')[0]]
    .find(value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,140}$/.test(value) && !value.includes('..'));
  const category = CATEGORIES.find(item => item.series.includes(series)) || null;
  const errors = [];
  const attempt = async (label, task) => { try { return await task(); } catch (error) { errors.push({ source: label, error: clean(error.message, 250) }); return null; } };
  const [profileResult, eventResult, depth, report, news] = await Promise.all([
    series ? attempt('Official series', () => deps.request('/series/' + encodeURIComponent(series))) : null,
    market.event_ticker && /^[A-Za-z0-9_.-]{1,140}$/.test(market.event_ticker) && !market.event_ticker.includes('..')
      ? attempt('Official event', () => deps.request('/events/' + encodeURIComponent(market.event_ticker))) : null,
    attempt('Order book', () => deps.book(ticker, contracts)),
    category ? attempt('Independent model', () => deps.researchReport(category.id)) : null,
    attempt('Headlines', () => deps.headlines(newsQuery(market, category))),
  ]);
  const profile = profileResult?.data?.series, event = eventResult?.data?.event;
  const row = report?.markets?.find(value => value.ticker === ticker);
  const modeled = validForecast(row);
  const forecast = modeled ? { ...row, probability: row.probability, interval: [...row.interval], evidence: modelEvidence(row) }
    : { probability: null, interval: null, model_name: null, validation: null,
      evidence: { tier: 0, label: 'Probability withheld' }, reason: row?.reason || (!category
        ? 'No independent probability model is mapped to this exact series. Market quotes and headlines are evidence, not a substitute probability.'
        : report?.errors?.join('; ') || 'The exact contract has no supported independent forecast at this time.') };
  const reasons = [], now = deps.now();
  if (!modeled) reasons.push(forecast.reason);
  const validation = forecast.validation;
  const validated = modeled && forecast.evidence.tier === 2 && Number.isFinite(validation?.rmse_skill) && validation.rmse_skill > 0
    && Number.isFinite(validation?.interval_80_coverage) && validation.interval_80_coverage >= .7 && validation.n >= 30;
  if (modeled && !validated) reasons.push('The model lacks a passing underlying-value holdout; uncalibrated proxies and failed validation cannot produce a YES/NO screen.');
  if (!depth?.raw) reasons.push('Current executable depth is unavailable.');
  const bookAge = now - Date.parse(depth?.as_of || '');
  const freshBook = Number.isFinite(bookAge) && bookAge >= -60000 && bookAge <= 120000;
  if (depth?.raw && !freshBook) reasons.push('The order-book retrieval is missing, future-dated or more than two minutes old.');
  const sourceAge = now - Date.parse(forecast.source_as_of || '');
  const freshSource = Number.isFinite(sourceAge) && sourceAge >= -60000 && sourceAge <= 86400000;
  if (modeled && !freshSource) reasons.push('Independent model inputs were not retrieved within the last 24 hours.');
  const close = Date.parse(market.close_time || '');
  const open = ['active', 'open'].includes(market.status) && Number.isFinite(close) && close > now;
  if (!open) reasons.push('The contract is not confirmed open before its trading close.');
  const candidates = [];
  if (modeled && depth?.raw) {
    for (const side of ['yes', 'no']) {
      try {
        const execution = executionEstimate(depth.raw, side, contracts, slippage, coefficient);
        const probability = side === 'yes' ? forecast.probability : 1 - forecast.probability;
        const lower = side === 'yes' ? forecast.interval[0] : 1 - forecast.interval[1];
        const cost = execution.breakeven;
        candidates.push({ side, probability, lower_probability: lower, execution,
          expected_edge: cost === null ? null : probability - cost,
          conservative_edge: cost === null ? null : lower - cost - uncertainty_buffer,
          eligible: validated && freshBook && freshSource && open && execution.unfilled < 1e-8 && execution.filled > 0 });
      } catch (error) { errors.push({ source: 'Execution ' + side, error: clean(error.message, 250) }); }
    }
  }
  const best = candidates.filter(value => value.eligible && value.conservative_edge > 0)
    .sort((a, b) => b.conservative_edge - a.conservative_edge)[0];
  if (!best && modeled && !reasons.length) reasons.push(candidates.some(value => value.execution.unfilled > 0)
    ? 'The requested quantity cannot be fully modeled inside the slippage limit, or no fully filled side clears the conservative cost threshold.'
    : 'Neither side clears its all-in entry cost and uncertainty buffer at the model interval lower bound.');
  const decision = { side: best?.side || 'insufficient_edge',
    label: best ? `${best.side.toUpperCase()} · research hypothesis` : 'Insufficient supported edge',
    conservative_edge: best?.conservative_edge ?? null, expected_edge: best?.expected_edge ?? null,
    reasons, candidates, assumptions: { contracts, slippage_cents: slippage, fee_coefficient: coefficient, uncertainty_buffer,
      fee_note: 'The coefficient is an explicit taker-fee assumption, not a verified market-specific fee schedule.' },
    validation_note: 'Passing an underlying-value holdout does not establish calibrated contract probabilities or profitable net trading. A screen is not an order or a profit claim.' };
  const summary = !modeled ? `${clean(market.title, 240)}: evidence only. ${forecast.reason}`
    : `The independent model estimates ${percent(forecast.probability)} YES, with a ${percent(forecast.interval[0])}–${percent(forecast.interval[1])} uncertainty/sensitivity range. `
      + (best ? `${best.side.toUpperCase()} clears modeled filled-book cost, assumed fees and the ${(100 * uncertainty_buffer).toFixed(1)}¢ extra buffer by ${(100 * best.conservative_edge).toFixed(1)}¢ at the conservative bound. This remains an unproven research hypothesis.`
        : `${decision.label}. ${reasons[0] || 'No verified executable cost advantage was established.'}`);
  const sources = [{ kind: 'official_market', label: 'Kalshi market and settlement rules', url: publicURL(detail.source_url), retrieved_at: detail.as_of }];
  for (const [kind, result] of [['official_series', profileResult], ['official_event', eventResult]]) {
    if (result) sources.push({ kind, label: kind === 'official_series' ? 'Kalshi series metadata' : 'Kalshi event metadata', url: publicURL(result.source_url), retrieved_at: result.as_of, sha256: result.sha256 });
  }
  if (depth) sources.push({ kind: 'order_book', label: 'Kalshi public order book', url: publicURL(depth.source_url), retrieved_at: depth.as_of });
  if (modeled) sources.push({ kind: 'independent_model', label: clean(forecast.source_name || forecast.model_name, 200), url: publicURL(forecast.source_url), retrieved_at: forecast.source_as_of, sha256: forecast.source_sha256 });
  if (news?.retrieved_at) sources.push({ kind: 'headline_metadata', label: (news.provider || 'News') + ' headline metadata', url: publicURL(news.source_url), retrieved_at: news.retrieved_at, sha256: news.sha256 });
  return { ticker, title: clean(market.title, 240), as_of: new Date(now).toISOString(),
    status: modeled ? 'modeled' : 'evidence_only', category: category ? { id: category.id, name: category.name } : { id: 'unsupported', name: profile?.category || 'Evidence only' }, series,
    market, event: event ? { ticker: event.event_ticker, title: clean(event.title, 300), category: clean(event.category, 100), mutually_exclusive: event.mutually_exclusive } : null,
    rules: { primary: clean(market.rules_primary), secondary: clean(market.rules_secondary), close_time: market.close_time,
      settlement_sources: (profile?.settlement_sources || []).slice(0, 8).map(value => ({ name: clean(value.name, 160), url: publicURL(value.url) })) },
    forecast, decision, summary, drivers: driverChecklist(category, market, profile),
    news: news || { status: 'unavailable', articles: [], retrieved_at: null, error: 'Headline metadata unavailable' }, sources, errors,
    news_policy: 'Headlines are context for verification. They are not read as article bodies, scored as truth or used to alter probability, validation or side selection.' };
}
