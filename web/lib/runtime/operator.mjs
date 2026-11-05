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
  for (const input of logs.slice(-1000)) {
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

export function createOperatorServer({token, readSnapshot}) {
  if (typeof token !== 'string' || token.length < 32 || typeof readSnapshot !== 'function') throw new TypeError('A separate operator token and snapshot reader are required');
  const digest = value => createHash('sha256').update(value).digest(), expected = digest(token);
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = req.headers.host || '', origin = req.headers.origin;
    if (!/^(127\.0\.0\.1|localhost)(:[0-9]{1,5})?$/.test(host) || origin && origin !== 'http://' + host) { res.writeHead(403); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, {Allow: 'GET'}); res.end(); return; }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (req.url === '/operator.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(script); return; }
    if (req.url !== '/api/report') { res.writeHead(404); res.end(); return; }
    const authorization = req.headers.authorization || '';
    if (authorization.length > 512 || !authorization.startsWith('Bearer ') || !timingSafeEqual(digest(authorization.slice(7)), expected)) { res.writeHead(401); res.end(); return; }
    try { const report = buildOperatorReport(await readSnapshot()); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(report)); }
    catch { res.writeHead(503); res.end(); }
  });
}
