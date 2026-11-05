import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const comparisonOrigin = 'https://predictir.dev';
const regionRejection = /^This service is unavailable in your region\.?$/i;
const usage = 'node terraform/azure/hosted/verify-live.mjs <https://azure-frontend> [--compare] [--backend <https://internal-backend>] [--allow-region-block]';

function httpsOrigin(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Use a bare HTTPS origin');
  return url.origin;
}

async function readLimited(response, maximum) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.byteLength;
    if (length > maximum) throw new Error('Response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function liquidMarkets(rows, now) {
  return (Array.isArray(rows) ? rows : []).filter(row =>
    typeof row?.ticker === 'string' && /^[a-z0-9_.-]{1,140}$/i.test(row.ticker) &&
    row.ticker !== '.' && !row.ticker.includes('..') && row.catalog_quote_valid === true &&
    Number.isFinite(row.volume_24h) && row.volume_24h > 0 && Date.parse(row.close_time) > now + 120_000
  ).sort((a, b) => b.volume_24h - a.volume_24h || a.ticker.localeCompare(b.ticker));
}

export async function verifyLive({origin, compare = false, backend, allowRegionBlock = false, fetcher = fetch, now = Date.now()} = {}) {
  const primary = httpsOrigin(origin);
  const internal = backend ? httpsOrigin(backend) : null;
  if (primary === comparisonOrigin || (internal && !/^[a-z0-9-]+\.internal\.[a-z0-9.-]+\.azurecontainerapps\.io$/.test(new URL(internal).hostname))) {
    throw new Error('Use an Azure frontend origin and an optional internal ACA backend origin');
  }
  const azure = {origin: primary, requests: [], ticker: null};
  const comparison = compare ? {origin: comparisonOrigin, requests: [], ticker: null} : null;

  async function request(target, step, path, {body, verify, maximum = 3 * 1024 * 1024, deadline = 55_000} = {}) {
    const started = performance.now();
    const result = {step, status: null, ms: null, outcome: 'transport_error'};
    target.requests.push(result);
    try {
      const response = await fetcher(new URL(path, target.origin), {
        method: body ? 'POST' : 'GET',
        headers: body ? {'Content-Type': 'application/json', Origin: target.origin, 'Sec-Fetch-Site': 'same-origin'} : undefined,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(deadline),
      });
      result.status = response.status;
      const type = response.headers.get('content-type') || '';
      const raw = await readLimited(response, maximum);
      const payload = /\bapplication\/json\b/i.test(type) ? JSON.parse(raw) : raw;
      if (response.status === 403 && regionRejection.test(payload?.error || '')) result.outcome = 'region_blocked';
      else if (!response.ok) result.outcome = 'http_error';
      else if (!verify(payload, response.headers)) result.outcome = 'unexpected_body';
      else { result.outcome = 'pass'; return payload; }
    } catch (error) {
      if (result.status !== null) result.outcome = 'unreadable_body';
      else if (error?.name === 'TimeoutError') result.outcome = 'timeout';
    } finally {
      result.ms = Math.round(performance.now() - started);
    }
    return null;
  }

  async function discover(target, azureLive) {
    await request(target, 'health', '/api/health', {maximum: 16 * 1024, verify: data =>
      data?.status === 'ok' && data.market_data_only === true && (!azureLive || data.runtime === 'Azure Container Apps')});
    const catalog = await request(target, 'catalog', '/api/workspace/catalog', {verify: data =>
      data?.categories?.some?.(category => category.id === 'crypto') === true});
    if (!catalog) return [];
    const marketList = await request(target, 'crypto_markets', '/api/workspace/markets?category=crypto', {verify: data =>
      data?.category === 'crypto' && Array.isArray(data.markets)});
    if (!marketList) return [];
    const rows = liquidMarkets(marketList.markets, now);
    if (!rows.length) target.requests.at(-1).outcome = 'no_liquid_ticker';
    return rows;
  }

  const azureMarkets = await discover(azure, true);
  const otherMarkets = comparison ? await discover(comparison, false) : [];
  const otherTickers = new Set(otherMarkets.map(row => row.ticker));
  const shared = azureMarkets.find(row => otherTickers.has(row.ticker))?.ticker;
  azure.ticker = shared || azureMarkets[0]?.ticker || null;
  if (comparison) comparison.ticker = shared || otherMarkets[0]?.ticker || null;

  for (const target of [azure, comparison].filter(Boolean)) {
    if (!target.ticker) continue;
    const params = new URLSearchParams({ticker: target.ticker, compact: '1'});
    await request(target, 'compact_research', '/api/workspace/research?' + params, {verify: data =>
      data?.market?.ticker === target.ticker && typeof data.as_of === 'string'});
  }
  if (azure.ticker) {
    await request(azure, 'source_coverage_chat', '/api/assistant', {
      maximum: 128 * 1024, deadline: 40_000,
      body: {ticker: azure.ticker, messages: [{role: 'user', content: 'What is the provider and warehouse coverage?'}]},
      verify: (data, headers) => typeof data === 'string' && /Warehouse coverage:/i.test(data) &&
        ['azure-deterministic', 'azure-foundry'].includes(headers.get('x-research-model')) &&
        headers.get('x-research-transport') === 'MCP Streamable HTTP',
    });
  }

  let backendAccess = null;
  if (internal) {
    const started = performance.now();
    backendAccess = {status: null, ms: null, outcome: 'inconclusive'};
    try {
      const response = await fetcher(new URL('/api/health', internal), {redirect: 'manual', signal: AbortSignal.timeout(8_000)});
      backendAccess.status = response.status;
      backendAccess.outcome = response.status === 404 ? 'blocked_404' : 'unexpected_status';
      await response.body?.cancel();
    } catch (error) {
      if (error?.cause?.code === 'ENOTFOUND') backendAccess.outcome = 'dns_not_public';
    } finally {
      backendAccess.ms = Math.round(performance.now() - started);
    }
  }

  const requests = [...azure.requests, ...(comparison?.requests || [])];
  const ok = requests.every(row => row.outcome === 'pass' || allowRegionBlock && row.outcome === 'region_blocked') &&
    (!backendAccess || ['blocked_404', 'dns_not_public'].includes(backendAccess.outcome));
  return {ok, azure, comparison, same_research_ticker: Boolean(shared), backend_access: backendAccess};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {values, positionals} = parseArgs({allowPositionals: true, options: {
      compare: {type: 'boolean'}, backend: {type: 'string'}, 'allow-region-block': {type: 'boolean'},
    }});
    if (positionals.length !== 1) throw new Error('Supply exactly one Azure frontend origin');
    const result = await verifyLive({origin: positionals[0], compare: values.compare,
      backend: values.backend, allowRegionBlock: values['allow-region-block']});
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.error(usage);
    process.exitCode = 2;
  }
}
