import test from 'node:test';
import assert from 'node:assert/strict';
import { marketBrief, parseHeadlines, parseGoogleNewsRss, fetchHeadlines, newsQuery } from '../lib/intelligence/brief.mjs';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const ticker = 'KXCPI-26NOV-T0.2';
const market = { ticker, event_ticker: 'KXCPI-26NOV', title: 'Will CPI inflation exceed 0.2%?', status: 'active',
  close_time: '2026-12-10T12:00:00Z', rules_primary: 'BLS seasonally adjusted month-over-month CPI.', yes_bid_dollars: '.39', yes_ask_dollars: '.4' };
const raw = { orderbook_fp: { yes_dollars: [['.39', '1000']], no_dollars: [['.6', '1000']] } };
function dependencies(overrides = {}) {
  return { now: () => NOW, marketDetails: async selected => ({ market: { ...market, ticker: selected }, as_of: new Date(NOW).toISOString(), source_url: 'https://external-api.kalshi.com/trade-api/v2/markets/' + selected }),
    request: async path => ({ data: path.startsWith('/series/') ? { series: { category: 'Economics', settlement_sources: [{ name: 'BLS', url: 'https://www.bls.gov/cpi/' }] } } : { event: { event_ticker: market.event_ticker, title: 'November CPI' } }, as_of: new Date(NOW).toISOString(), source_url: 'https://external-api.kalshi.com/trade-api/v2' + path }),
    book: async () => ({ raw, as_of: new Date(NOW).toISOString(), source_url: 'https://external-api.kalshi.com/trade-api/v2/markets/' + ticker + '/orderbook' }),
    researchReport: async () => ({ markets: [{ ticker, probability: .8, interval: [.7, .9], source_as_of: new Date(NOW).toISOString(), source_url: 'https://fred.stlouisfed.org/series/CPIAUCSL', source_name: 'FRED CPI',
      validation: { n: 60, rmse_skill: .1, interval_80_coverage: .8 }, model_name: 'Independent CPI ensemble' }] }),
    headlines: async () => ({ status: 'empty', articles: [], retrieved_at: null }), ...overrides };
}
test('exact supported series uses independent forecast and filled-book costs for YES screen', async () => {
  const result = await marketBrief(ticker, {}, dependencies());
  assert.equal(result.status, 'modeled'); assert.equal(result.forecast.probability, .8);
  assert.equal(result.decision.side, 'yes');
  const candidate = result.decision.candidates.find(value => value.side === 'yes');
  assert.ok(Math.abs(candidate.conservative_edge - (.7 - candidate.execution.breakeven - .02)) < 1e-12);
  assert.match(result.summary, /independent model/i);
});
test('NO uses one minus upper YES bound, not one minus lower bound', async () => {
  const deps = dependencies({ researchReport: async () => ({ markets: [{ ticker, probability: .1, interval: [.05, .2], source_as_of: new Date(NOW).toISOString(), validation: { n: 60, rmse_skill: .2, interval_80_coverage: .8 } }] }) });
  const result = await marketBrief(ticker, {}, deps);
  assert.equal(result.decision.side, 'no');
  assert.equal(result.decision.candidates.find(value => value.side === 'no').lower_probability, .8);
});
test('unsupported exact series remains evidence-only despite a name resembling a supported category', async () => {
  let modelCalled = false;
  const deps = dependencies({ marketDetails: async () => ({ market: { ...market, ticker: 'KXBTC15M-26OCT28-T100', event_ticker: 'KXBTC15M-26OCT28', title: 'Bitcoin short-term outcome' }, as_of: new Date(NOW).toISOString() }),
    researchReport: async () => { modelCalled = true; throw new Error('must not model'); } });
  const result = await marketBrief('KXBTC15M-26OCT28-T100', {}, deps);
  assert.equal(modelCalled, false); assert.equal(result.status, 'evidence_only');
  assert.equal(result.forecast.probability, null); assert.equal(result.decision.side, 'insufficient_edge');
  assert.ok(result.drivers.length >= 3);
});
test('bad validation, incomplete depth, stale book and expired market fail closed', async () => {
  for (const override of [
    { researchReport: async () => ({ markets: [{ ticker, probability: .99, interval: [.98, 1], source_as_of: new Date(NOW).toISOString(), validation: { n: 60, rmse_skill: -.1, interval_80_coverage: .9 } }] }) },
    { book: async () => ({ raw: { orderbook_fp: { yes_dollars: [['.39', '2']], no_dollars: [['.6', '2']] } }, as_of: new Date(NOW).toISOString() }) },
    { book: async () => ({ raw, as_of: '2026-10-27T00:00:00Z' }) },
    { marketDetails: async () => ({ market: { ...market, status: 'closed' } }) },
  ]) assert.equal((await marketBrief(ticker, {}, dependencies(override))).decision.side, 'insufficient_edge');
});
test('uncalibrated proxy can be inspected but cannot become a YES/NO screen', async () => {
  const result = await marketBrief(ticker, {}, dependencies({ researchReport: async () => ({ markets: [{ ticker, probability: .99, interval: [.98, 1], source_as_of: new Date(NOW).toISOString(), validation: null }] }) }));
  assert.equal(result.forecast.probability, .99);
  assert.equal(result.decision.side, 'insufficient_edge');
});
test('headlines never alter probability or side; no article bodies are returned', async () => {
  const a = await marketBrief(ticker, {}, dependencies());
  const b = await marketBrief(ticker, {}, dependencies({ headlines: async () => ({ status: 'live', articles: [{ title: 'Unexpected inflation change', url: 'https://example.org/news', seen_at: '2026-10-28T11:00:00Z' }] }) }));
  assert.equal(a.forecast.probability, b.forecast.probability);
  assert.equal(a.decision.side, b.decision.side);
  assert.equal(a.decision.conservative_edge, b.decision.conservative_edge);
  assert.equal(b.news.articles[0].body, undefined);
});
test('GDELT metadata has real bounded first-seen dates, safe URLs, deduplication and no invented publication time', () => {
  const result = parseHeadlines({ articles: [
    { title: 'Recent headline', url: 'https://example.org/recent', seendate: '20261028T110000Z', body: 'do not retain' },
    { title: 'Duplicate', url: 'https://example.org/recent#fragment', seendate: '20261028T110000Z' },
    { title: 'Unsafe', url: 'javascript:alert(1)', seendate: '20261028T110000Z' },
    { title: 'Old', url: 'https://example.org/old', seendate: '20260101T110000Z' },
    { title: 'Missing date', url: 'https://example.org/missing' },
    { title: 'Future', url: 'https://example.org/future', seendate: '20261029T110000Z' },
    { title: 'Invalid calendar date', url: 'https://example.org/invalid', seendate: '20260230T110000Z' },
  ] }, NOW);
  assert.equal(result.length, 1); assert.equal(result[0].seen_at, '2026-10-28T11:00:00.000Z');
  assert.equal(result[0].published_at, null); assert.equal(result[0].body, undefined);
});
test('news failures are unavailable, not false empty evidence; 429 pauses later calls', async () => {
  let called = 0;
  const state = { cache: new Map(), inflight: new Map(), retryAt: 0 };
  const opts = { state, now: () => NOW, fetcher: async () => { called++; return new Response('{}', { status: 429 }); } };
  const a = await fetchHeadlines('"inflation"', opts), b = await fetchHeadlines('"labor"', opts);
  assert.equal(a.status, 'unavailable'); assert.equal(b.status, 'unavailable'); assert.equal(called, 2);
});
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Inflation &amp; prices &#8212; update</title><link>https://news.google.com/rss/articles/example?x=1&amp;y=2</link><pubDate>Wed, 28 Oct 2026 11:00:00 GMT</pubDate><source url="https://publisher.example">Example Publisher</source><description>Article body must never be retained</description></item></channel></rss>`;
test('RSS parses safe static metadata, preserves actual publication date and excludes article descriptions', () => {
  const articles = parseGoogleNewsRss(RSS, NOW);
  assert.equal(articles.length, 1); assert.equal(articles[0].title, 'Inflation & prices — update');
  assert.equal(articles[0].published_at, '2026-10-28T11:00:00.000Z');
  assert.equal(articles[0].seen_at, null); assert.equal(articles[0].publisher, 'Example Publisher');
  assert.equal(articles[0].description, undefined); assert.equal(articles[0].body, undefined);
  assert.throws(() => parseGoogleNewsRss('<!DOCTYPE rss [<!ENTITY leak SYSTEM="file:///secret">]>' + RSS, NOW));
});
test('GDELT 429 falls back to a separate fixed RSS host without repeating the limited provider', async () => {
  const calls = [], state = { cache: new Map(), inflight: new Map(), retryAt: 0 };
  const options = { state, now: () => NOW, fetcher: async input => {
    const url = new URL(input); calls.push(url.hostname);
    if (url.hostname === 'api.gdeltproject.org') return new Response('{}', { status: 429 });
    assert.equal(url.hostname, 'news.google.com'); assert.equal(url.pathname, '/rss/search');
    assert.equal(url.searchParams.get('ceid'), 'US:en'); assert.ok(!url.searchParams.get('q').includes('sourcelang:'));
    return new Response(RSS, { headers: { 'content-type': 'application/rss+xml' } });
  } };
  const first = await fetchHeadlines('"inflation" sourcelang:english', options);
  const again = await fetchHeadlines('"inflation" sourcelang:english', options);
  assert.equal(first.status, 'live'); assert.equal(first.provider, 'Google News RSS');
  assert.match(first.fallback_reason, /429/); assert.equal(first.articles.length, 1);
  assert.equal(first.retrieved_at, again.retrieved_at);
  assert.deepEqual(calls, ['api.gdeltproject.org', 'news.google.com']);
});
test('both news providers unavailable stays explicit and respects the RSS response size bound', async () => {
  const state = { cache: new Map(), inflight: new Map(), retryAt: 0 };
  const result = await fetchHeadlines('"inflation"', { state, now: () => NOW,
    fetcher: async input => new URL(input).hostname === 'api.gdeltproject.org'
      ? new Response('{}', { status: 503 }) : new Response(RSS, { headers: { 'content-length': '1000001' } }) });
  assert.equal(result.status, 'unavailable'); assert.equal(result.retrieved_at, null);
  assert.equal(result.articles.length, 0); assert.match(result.error, /size bound/);
  assert.match(result.fallback_reason, /503/);
});
test('news requests use one fixed host and bounded metadata mode, cached without a fake new date', async () => {
  let called = 0, time = NOW;
  const state = { cache: new Map(), inflight: new Map(), retryAt: 0 };
  const options = { state, now: () => time, fetcher: async url => { called++; const parsed = new URL(url); assert.equal(parsed.hostname, 'api.gdeltproject.org'); assert.equal(parsed.searchParams.get('maxrecords'), '15'); assert.equal(parsed.searchParams.get('mode'), 'artlist'); return new Response(JSON.stringify({ articles: [] })); } };
  const a = await fetchHeadlines('"CPI"', options); time += 1000;
  const b = await fetchHeadlines('"CPI"', options);
  assert.equal(called, 1); assert.equal(a.retrieved_at, b.retrieved_at);
  assert.ok(!newsQuery({ title: 'Will X happen? url:https://evil.example' }).includes('url:'));
});
test('invalid brief inputs are rejected before any provider requests', async () => {
  const deps = dependencies({ marketDetails: async () => assert.fail('network called') });
  await assert.rejects(marketBrief('../portfolio/balance', {}, deps));
  await assert.rejects(marketBrief(ticker, { contracts: 0 }, deps));
});
