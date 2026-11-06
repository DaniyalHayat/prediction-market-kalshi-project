import {execFile} from 'node:child_process';
import {open, readFile, stat} from 'node:fs/promises';
import {promisify} from 'node:util';
import {sanitizeOperationalRecord} from '../lib/runtime/log-pipeline.mjs';
import {OPERATOR_SEARCH_SCOPE} from '../lib/runtime/operator-search.mjs';

const runFile = promisify(execFile);
const maximumBytes = 2 * 1024 * 1024;
const scopeName = /^[a-z0-9][a-z0-9-]{1,89}$/;
const searchArgs = ['account', 'get-access-token', '--scope', OPERATOR_SEARCH_SCOPE, '--only-show-errors', '-o', 'json'];

async function runAzure(args, signal) {
  const options = {timeout: 9000, maxBuffer: maximumBytes, windowsHide: true, signal};
  return process.platform === 'win32'
    ? await runFile('cmd.exe', ['/d', '/s', '/c', 'az ' + args.join(' ')], options)
    : await runFile('az', args, options);
}

export function azureSearchToken({cli = runAzure, now = Date.now} = {}) {
  let credential;
  return async ({scope, signal}) => {
    if (scope !== OPERATOR_SEARCH_SCOPE) throw new Error('Unexpected Azure Search token scope.');
    if (credential && credential.until - now() > 90_000) return credential.value;
    try {
      const {stdout} = await cli(searchArgs, signal);
      const {accessToken, expires_on} = JSON.parse(stdout);
      if (typeof accessToken !== 'string' || !accessToken) throw new Error('Invalid access token');
      credential = {value: accessToken, until: Number(expires_on) * 1000 || 0};
      return accessToken;
    } catch {
      throw new Error('Azure Search sign-in is unavailable.');
    }
  };
}

export async function readOperatorFile(path, limit = maximumBytes) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Operator input exceeds the local inspection limit.');
  return readFile(path, 'utf8');
}

function decodeRows(text) {
  try {
    const packet = JSON.parse(text);
    return Array.isArray(packet) ? packet.slice(-1000) : Array.isArray(packet?.logs) ? packet.logs.slice(-1000) : [packet];
  } catch {
    return text.split(/\r?\n/).filter(Boolean).slice(-1000).flatMap(line => {
      try { return line.length <= 16384 ? [JSON.parse(line)] : []; }
      catch { return []; }
    });
  }
}

function logEnvelopes(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maximumBytes) return [];
  return decodeRows(text).flatMap(envelope => {
    try {
      const inner = typeof envelope?.Log === 'string' ? JSON.parse(envelope.Log.replace(/^F (?=\{)/, '')) : envelope;
      return [{inner, stamp: envelope?.TimeStamp}];
    } catch { return []; }
  });
}

export function parseOperatorLogExport(text) {
  return logEnvelopes(text).flatMap(({inner, stamp}) => {
    const time = Date.parse(inner?.time ?? stamp);
    if (inner?.event !== 'request.finished' || !Number.isFinite(time) || !Number.isInteger(inner.status) ||
        inner.status < 400 || inner.status > 599) return [];
    return [{...sanitizeOperationalRecord(inner.event, inner, inner.status >= 500 ? 'error' : 'warn'),
      time: new Date(time).toISOString()}];
  });
}

export function parseOperatorAllowanceExport(text) {
  let newest;
  for (const {inner} of logEnvelopes(text)) {
    const time = Date.parse(inner?.as_of);
    if (inner?.event !== 'operator.allowances' || !Number.isFinite(time) || !Array.isArray(inner.allowances) ||
        inner.allowances.length > 16 || newest && time <= Date.parse(newest.as_of)) continue;
    const allowances = inner.allowances.flatMap(row =>
      /^[a-z_]{3,48}$/.test(row?.resource ?? '') && [row.used, row.limit].every(n => Number.isSafeInteger(n) && n >= 0) ?
        [{resource: row.resource, used: row.used, limit: row.limit}] : []);
    if (allowances.length) newest = {as_of: new Date(time).toISOString(), allowances};
  }
  return newest;
}

async function readDrainTail(path) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) return '';
    const length = Math.min(info.size, 512 * 1024);
    const start = info.size - length;
    const buffer = Buffer.alloc(length);
    const {bytesRead} = await file.read(buffer, 0, length, start);
    const text = buffer.toString('utf8', 0, bytesRead);
    if (!start) return text;
    const first = text.indexOf('\n');
    return first < 0 ? '' : text.slice(first + 1);
  } finally { await file.close(); }
}

export function createOperatorLogReader({group, app, drainPath, cli = runAzure, now = Date.now} = {}) {
  if ((group || app) && (!scopeName.test(group || '') || !scopeName.test(app || '') || !app.endsWith('-backend'))) {
    throw new TypeError('Use the configured Azure resource group and backend app for live logs.');
  }
  const args = group ? ['containerapp', 'logs', 'show', '-g', group, '-n', app, '--type', 'console',
    '--tail', '150', '--only-show-errors', '-o', 'json'] : null;
  let recent, inflight;
  return async function readLogs({signal} = {}) {
    if (recent && recent.until > now()) return recent.value;
    if (inflight) return inflight;
    inflight = (async () => {
      const sources = await Promise.allSettled([
        args ? cli(args, signal).then(result => result.stdout) : '',
        drainPath ? readDrainTail(drainPath) : '',
      ]);
      const logs = sources.flatMap(item => item.status === 'fulfilled' ? parseOperatorLogExport(item.value) : []);
      const seen = new Set();
      const records = logs.filter(row => {
        if (!row.trace_id) return true;
        const key = [row.trace_id, row.span_id, row.route, row.status, row.error_code, row.time].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(-1000);
      const allowances = sources.map(item => item.status === 'fulfilled' ? parseOperatorAllowanceExport(item.value) : undefined)
        .filter(Boolean).sort((a, b) => b.as_of.localeCompare(a.as_of))[0];
      const value = {logs: records, allowances};
      if (!signal?.aborted) recent = {value, until: now() + 20000};
      return value;
    })();
    try { return await inflight; }
    finally { inflight = null; }
  };
}

export function createOperatorArchiveSearch({evidence, search}) {
  let pending = 0;
  return {
    async find({query}) {
      const items = await evidence.search({query});
      if (!search) return {items, source: 'local'};
      try {
        const cloud = await search.search({query});
        if (cloud === null) return {items, source: 'local'};
        const found = new Map(items.map(item => [item.id, item]));
        await Promise.all(cloud.filter(item => !found.has(item.id)).map(async item => {
          const receipt = await evidence.read(item.id);
          if (receipt) {
            const {checks, ...metadata} = receipt;
            found.set(item.id, metadata);
          }
        }));
        return {items: [...found.values()].sort((a, b) => b.captured_at.localeCompare(a.captured_at) ||
          a.id.localeCompare(b.id)).slice(0, 20), source: 'azure-search'};
      } catch {
        return {items, source: 'local-fallback'};
      }
    },
    index(receipt) {
      if (!search || pending >= 2) return;
      pending += 1;
      void search.upsert(receipt).catch(() => {}).finally(() => { pending -= 1; });
    },
  };
}
