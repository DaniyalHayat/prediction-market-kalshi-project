import {createServer} from 'node:http';
import {createHash, timingSafeEqual} from 'node:crypto';
import {sanitizeOperationalRecord} from './log-pipeline.mjs';

export function buildOperatorReport({telemetry = {}, logs = []} = {}) {
  const distributions = {}, proposals = [], evidence = [];
  for (const [key, value] of Object.entries(telemetry.distributions || {}).slice(0, 100)) {
    if (!/^(request|provider):[a-zA-Z0-9_./:-]{1,80}$/.test(key) || !value || typeof value !== 'object') continue;
    distributions[key] = Object.fromEntries(['count', 'window_count', 'p95_ms', 'p99_ms', 'errors'].filter(field => Number.isFinite(value[field]) && value[field] >= 0).map(field => [field, value[field]]));
    if (value.window_count >= 100 && value.p99_ms > 500) proposals.push({kind: 'latency', dimension: key, observed_p99_ms: value.p99_ms, hypothesis: 'Inspect correlated provider and database spans before changing caches, queries or concurrency.', approval_required: true});
  }
  for (const input of (Array.isArray(logs) ? logs : []).slice(-1000)) {
    try {
      const row = sanitizeOperationalRecord(input.event, input, input.level || 'info');
      if (row.level === 'error' || row.status >= 500 || row.pool_waiting > 0 || row.event_loop_p99_ms > 100) evidence.push(row);
    } catch {}
  }
  if (evidence.some(row => row.pool_waiting > 0)) proposals.push({kind: 'database_queue', hypothesis: 'Inspect slow queries and transaction duration against the existing four-connection pool; require a role-limit review before increasing connections.', approval_required: true});
  if (evidence.some(row => row.event_loop_p99_ms > 100)) proposals.push({kind: 'event_loop', hypothesis: 'Profile CPU and payload parsing; test worker isolation against measured end-to-end latency before enabling a ring buffer.', approval_required: true});
  return {generated_at: new Date().toISOString(), mode: 'operator-review-only', change_execution: 'disabled',
    percentiles: {scope: 'bounded local samples, not a fleet percentile', distributions},
    evidence: evidence.slice(-100), proposals,
    limitations: ['Hypotheses require runtime confirmation.', 'No production changes or deployments can be executed from this surface.']};
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Predictir operator review</title><style>body{font:16px system-ui;background:#11151b;color:#e6ecf3;max-width:1100px;margin:40px auto;padding:24px}input,button{font:inherit;padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #354252;padding:20px}label{display:block;margin-bottom:10px}</style><h1>Operator review</h1><p>Local inspection and proposed changes. Every production change requires a separate review.</p><form id="access"><label>Operator access token <input id="token" type="password" autocomplete="off" required></label><button>Inspect snapshot</button></form><pre id="report" aria-live="polite">No snapshot loaded.</pre><script src="/operator.js"></script></html>`;
const script = `document.getElementById('access').addEventListener('submit',async event=>{event.preventDefault();const token=document.getElementById('token'),report=document.getElementById('report');try{const response=await fetch('/api/report',{headers:{Authorization:'Bearer '+token.value}});token.value='';if(!response.ok)throw new Error('Access denied or snapshot unavailable');report.textContent=JSON.stringify(await response.json(),null,2);}catch{token.value='';report.textContent='Access denied or snapshot unavailable';}});`;

const workbench = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Predictir operations</title><link rel="stylesheet" href="/operator.css"><div id="operator-root"></div><noscript>Enable JavaScript to use the operator workbench.</noscript><script defer src="/operator.js"></script></html>`;

async function reviewBody(req) {
  const limit = 1024;
  const tooLarge = () => Object.assign(new Error('The review profile is too large.'), {status: 413});
  if (Number(req.headers['content-length']) > limit) throw tooLarge();
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({destroyOnReturn: false})) {
    length += chunk.length;
    if (length > limit) {
      req.resume();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(res, body, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(body));
}

export function createOperatorServer({token, readSnapshot, assets, runReview, evidence, now = Date.now}) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token) || typeof readSnapshot !== 'function') {
    throw new TypeError('A separate operator token and snapshot reader are required');
  }
  const digest = value => createHash('sha256').update(value).digest(), expected = digest(token);
  const hasReviews = typeof runReview === 'function' && evidence;
  let active = false, nextReviewAt = 0;
  return createServer({maxHeaderSize: 8192, headersTimeout: 6000, requestTimeout: 25000}, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = req.headers.host || '', origin = req.headers.origin;
    if (!/^(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(host) || origin && origin !== 'http://' + host) { res.writeHead(403); res.end(); return; }
    if (!req.url || req.url.length > 1024 || !req.url.startsWith('/') || /^\/[\/\\]/.test(req.url)) { res.writeHead(400); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const reviewWrite = hasReviews && path === '/api/reviews' && req.method === 'POST';
    if (req.method !== 'GET' && !reviewWrite) { res.writeHead(405, {Allow: 'GET'}); res.end(); return; }
    if (reviewWrite && origin !== 'http://' + host) { res.writeHead(403); res.end(); return; }
    if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(assets ? workbench : html); return; }
    if (path === '/operator.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(assets?.js ?? script); return; }
    if (path === '/operator.css' && assets) { res.setHeader('Content-Type', 'text/css; charset=utf-8'); res.end(assets.css); return; }
    const receipt = hasReviews && /^\/api\/reviews\/([a-f0-9]{64})$/.exec(path);
    const collection = hasReviews && path === '/api/reviews';
    if (path !== '/api/report' && !collection && !receipt) { res.writeHead(404); res.end(); return; }
    const authorization = req.headers.authorization || '';
    if (authorization.length > 512 || !authorization.startsWith('Bearer ') || !timingSafeEqual(digest(authorization.slice(7)), expected)) { res.writeHead(401); res.end(); return; }
    try {
      if (path === '/api/report') return json(res, buildOperatorReport(await readSnapshot()));
      if (receipt) {
        const result = await evidence.read(receipt[1]);
        return result ? json(res, result) : json(res, {error: 'Review not found.'}, 404);
      }
      if (!reviewWrite) return json(res, {items: await evidence.search({query: url.searchParams.get('q') ?? ''})});
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(res, {error: 'Send a JSON review profile.'}, 415);
      }
      if (active || now() < nextReviewAt) {
        res.setHeader('Retry-After', '10');
        return json(res, {error: 'A review is running or just finished. Try again in a few seconds.'}, 429);
      }
      active = true;
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.once('close', cancel);
      try {
        const input = await reviewBody(req);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(24000)]);
        const result = await runReview(input, {signal});
        signal.throwIfAborted();
        nextReviewAt = now() + 10000;
        return json(res, await evidence.save(result), 201);
      } finally {
        res.off('close', cancel);
        active = false;
      }
    } catch (error) {
      if (res.destroyed) return;
      if (error?.status === 413) return json(res, {error: 'The review profile is too large.'}, 413);
      if (reviewWrite && (error instanceof RangeError || error instanceof SyntaxError) ||
          collection && !reviewWrite && error instanceof TypeError) {
        return json(res, {error: 'Use a valid profile or evidence search.'}, 400);
      }
      if (error?.code === 'EVIDENCE_CAPACITY') return json(res, {error: 'The local evidence archive is full.'}, 507);
      return json(res, {error: 'The operator source or archive is unavailable.'}, 503);
    }
  });
}
