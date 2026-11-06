import {readJSON} from '../transport.mjs';

export const OPERATOR_SEARCH_SCOPE = 'https://search.azure.com/.default';
export const OPERATOR_SEARCH_API_VERSION = '2026-04-01';
export const OPERATOR_SEARCH_DEFAULT_INDEX = 'predictir-operator-v1';

const idPattern = /^[a-f0-9]{64}$/;
const indexPattern = /^predictir-operator-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const connectorNames = ['api', 'azure', 'mcp', 'runtime'];
const statusNames = ['pass', 'fail', 'unavailable'];
const countNames = ['check_count', 'passed_count', 'failed_count', 'unavailable_count'];
const checkTerms = {
  catalog: 'catalog market markets',
  connector_read: 'connector read',
  cpu_average: 'cpu average utilization',
  expected_ingress: 'ingress network',
  health: 'health readiness',
  memory_average: 'memory average utilization',
  metrics_snapshot: 'metrics snapshot',
  open_contract: 'open contract',
  p95: 'p95 latency',
  p99: 'p99 latency',
  replicas_average: 'replicas average capacity',
  requests: 'requests traffic',
  requests_429: 'requests 429 rate limit',
  requests_429_peak: 'requests 429 peak rate limit',
  requests_5xx: 'requests 5xx errors',
  retained_throttles: 'retained throttles',
  revision_ready: 'revision ready readiness',
  runtime_snapshot: 'runtime snapshot',
  sample_count: 'sample count',
  snapshot_age: 'snapshot age freshness',
  source_status: 'source status warehouse',
};
const throttleChecks = new Set(['requests_429', 'requests_429_peak', 'retained_throttles']);
const allowedTerms = new Set([...connectorNames, ...statusNames,
  ...Object.values(checkTerms).flatMap(value => value.split(' ')), 'throttle', 'throttled', 'quota']);

function field(name, type, flags = {}) {
  return {name, type, key: false, searchable: false, filterable: false, retrievable: true, sortable: false,
    facetable: false, ...flags};
}

const fields = [
  field('id', 'Edm.String', {key: true, sortable: true}),
  field('captured_at', 'Edm.DateTimeOffset', {sortable: true}),
  field('status', 'Edm.String', {filterable: true}),
  field('connectors', 'Collection(Edm.String)', {filterable: true}),
  ...countNames.map(name => field(name, 'Edm.Int32')),
  field('terms', 'Edm.String', {searchable: true, retrievable: false}),
];
const selected = fields.filter(item => item.retrievable).map(item => item.name).join(',');

function fail(message, code = 'OPERATOR_SEARCH_RESPONSE', status) {
  return Object.assign(new Error(message), {code, status});
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|\+00:00)$/.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  const normalized = parsed.toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}

function indexedReceipt(receipt) {
  const captured_at = timestamp(receipt?.captured_at);
  if (typeof receipt?.id !== 'string' || !idPattern.test(receipt.id) || !captured_at || !Array.isArray(receipt.checks) ||
      receipt.checks.length < 1 || receipt.checks.length > 60) {
    throw new TypeError('Expected a complete, bounded local maintenance receipt.');
  }
  const terms = new Set(), connectors = new Set();
  const counts = {pass: 0, fail: 0, unavailable: 0};
  for (const row of receipt.checks) {
    if (!connectorNames.includes(row?.connector) || !statusNames.includes(row.status)) {
      throw new TypeError('Expected maintenance connector and outcome fields.');
    }
    connectors.add(row.connector);
    terms.add(row.connector).add(row.status);
    if (Object.hasOwn(checkTerms, row.check)) {
      for (const term of checkTerms[row.check].split(' ')) terms.add(term);
    }
    if (row.status_code === 429 || (throttleChecks.has(row.check) && Number.isFinite(row.value) && row.value > 0)) {
      terms.add('429').add('throttle').add('throttled').add('quota');
    }
    counts[row.status] += 1;
  }
  return {
    id: receipt.id, captured_at, status: counts.fail ? 'fail' : counts.unavailable ? 'unavailable' : 'pass',
    connectors: [...connectors].sort(), check_count: receipt.checks.length,
    passed_count: counts.pass, failed_count: counts.fail, unavailable_count: counts.unavailable,
    terms: [...terms].sort().join(' '),
  };
}

function resultMetadata(result) {
  const captured_at = timestamp(result?.captured_at);
  if (typeof result?.id !== 'string' || !idPattern.test(result.id) || !captured_at || !statusNames.includes(result.status) ||
      !Array.isArray(result.connectors) || result.connectors.length < 1 || result.connectors.length > connectorNames.length ||
      new Set(result.connectors).size !== result.connectors.length ||
      result.connectors.some(name => !connectorNames.includes(name)) ||
      countNames.some(name => !Number.isSafeInteger(result[name]) || result[name] < 0 || result[name] > 60) ||
      !result.check_count || result.passed_count + result.failed_count + result.unavailable_count !== result.check_count ||
      result.status !== (result.failed_count ? 'fail' : result.unavailable_count ? 'unavailable' : 'pass')) {
    throw fail('Azure AI Search returned invalid maintenance metadata.');
  }
  return {
    id: result.id, captured_at, status: result.status, connectors: result.connectors,
    check_count: result.check_count, passed_count: result.passed_count, failed_count: result.failed_count,
    unavailable_count: result.unavailable_count,
  };
}

function searchInput(query, limit) {
  if (typeof query !== 'string' || query.length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Invalid maintenance search.');
  }
  if (!query.trim()) return '*';
  if (!/^[a-zA-Z0-9 _-]+$/.test(query)) return null;
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (!tokens.length || tokens.length > 8 || tokens.some(term => !allowedTerms.has(term))) return null;
  return [...new Set(tokens)].join(' ');
}

export function createOperatorSearch({endpoint, index = OPERATOR_SEARCH_DEFAULT_INDEX, getToken, fetcher = fetch} = {}) {
  if (typeof endpoint !== 'string' || !/^https:\/\/[a-z0-9][a-z0-9-]{0,58}[a-z0-9]\.search\.windows\.net\/?$/.test(endpoint) ||
      typeof index !== 'string' || index.length > 128 || !indexPattern.test(index) || typeof getToken !== 'function') {
    throw new TypeError('Expected an Azure AI Search endpoint, dedicated operator index, and Entra token provider.');
  }
  const target = new URL(endpoint).origin;
  const path = "/indexes('" + index + "')";

  async function request(route, {method = 'GET', body, headers, accept = [], signal} = {}) {
    const timeout = AbortSignal.timeout(5000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    deadline.throwIfAborted();
    let token;
    try { token = await getToken({scope: OPERATOR_SEARCH_SCOPE, signal: deadline}); }
    catch { throw fail('Azure AI Search credential acquisition failed.', 'OPERATOR_SEARCH_AUTH'); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.~+\/-]{16,16384}={0,2}$/.test(token)) {
      throw fail('Azure AI Search did not receive a usable Entra token.', 'OPERATOR_SEARCH_AUTH');
    }
    let response;
    try {
      deadline.throwIfAborted();
      response = await fetcher(new URL(route + '?api-version=' + OPERATOR_SEARCH_API_VERSION, target), {
        method, signal: deadline, redirect: 'error', cache: 'no-store',
        headers: {Accept: 'application/json', Authorization: 'Bearer ' + token,
          ...(body ? {'Content-Type': 'application/json'} : {}), ...headers},
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
    } catch { throw fail('Azure AI Search request did not complete.', 'OPERATOR_SEARCH_UNAVAILABLE'); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      if (accept.includes(response.status)) return {status: response.status};
      throw fail('Azure AI Search rejected the request.', 'OPERATOR_SEARCH_HTTP', response.status);
    }
    try {
      const {data} = await readJSON(response, {maximumBytes: 128 * 1024});
      return {data, status: response.status};
    } catch {
      throw fail('Azure AI Search returned an unreadable response.', 'OPERATOR_SEARCH_RESPONSE', response.status);
    }
  }

  function verifySchema(data) {
    const valid = data?.name === index && Array.isArray(data.fields) && data.fields.length === fields.length &&
      fields.every(expected => {
        const actual = data.fields.find(item => item?.name === expected.name);
        return actual?.type === expected.type && ['key', 'searchable', 'filterable', 'retrievable', 'sortable', 'facetable']
          .every(flag => (actual[flag] ?? false) === expected[flag]);
      });
    if (!valid) throw fail('Azure AI Search index schema differs from the maintenance schema.', 'OPERATOR_SEARCH_SCHEMA');
  }

  return {
    async ensureIndex({signal} = {}) {
      const current = await request(path, {signal, accept: [404]});
      if (current.status === 200) {
        verifySchema(current.data);
        return {index, created: false};
      }
      const created = await request(path, {
        method: 'PUT', body: {name: index, fields}, signal,
        headers: {'If-None-Match': '*', Prefer: 'return=representation'}, accept: [409, 412],
      });
      if (created.status === 409 || created.status === 412) {
        verifySchema((await request(path, {signal})).data);
        return {index, created: false};
      }
      verifySchema(created.data);
      return {index, created: true};
    },

    async upsert(receiptOrReceipts, {signal} = {}) {
      const receipts = Array.isArray(receiptOrReceipts) ? receiptOrReceipts : [receiptOrReceipts];
      if (receipts.length > 256) throw new TypeError('Azure AI Search upload exceeds the archive bound.');
      const documents = [...new Map(receipts.map(receipt => {
        const document = indexedReceipt(receipt);
        return [document.id, document];
      })).values()];
      for (let offset = 0; offset < documents.length; offset += 50) {
        const batch = documents.slice(offset, offset + 50);
        const {data} = await request(path + '/docs/search.index', {
          method: 'POST', body: {value: batch.map(document => ({'@search.action': 'mergeOrUpload', ...document}))}, signal,
        });
        const results = data?.value;
        if (!Array.isArray(results) || results.length !== batch.length || new Set(results.map(row => row?.key)).size !== batch.length ||
            batch.some(document => !results.some(row => row?.key === document.id && row.status === true))) {
          throw fail('Azure AI Search did not confirm every maintenance document.', 'OPERATOR_SEARCH_WRITE');
        }
      }
      return documents.length;
    },

    async search({query = '', limit = 20, signal} = {}) {
      const search = searchInput(query, limit);
      if (search === null) return null;
      const {data, status} = await request(path + '/docs/search.post.search', {
        method: 'POST', signal, body: {search, queryType: 'simple', searchMode: 'all', searchFields: 'terms',
          select: selected, orderby: 'captured_at desc,id asc', top: limit},
      });
      if (status !== 200 || !Array.isArray(data?.value) || data.value.length > limit ||
          data['@search.coverage'] !== undefined && data['@search.coverage'] !== 100) {
        throw fail('Azure AI Search returned an invalid maintenance result set.');
      }
      const result = data.value.map(resultMetadata);
      if (new Set(result.map(row => row.id)).size !== result.length) {
        throw fail('Azure AI Search returned duplicate maintenance results.');
      }
      return result;
    },
  };
}
