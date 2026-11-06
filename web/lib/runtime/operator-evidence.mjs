import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, mkdir, open, opendir, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const receiptId = /^[a-f0-9]{64}$/;
const profileName = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,46}[A-Za-z0-9]$/;
const checkName = /^[a-z][a-z0-9_-]{0,63}$/;
const dimensionName = /^[a-zA-Z0-9_./:-]{1,90}$/;
const connectors = new Set(['api', 'azure', 'mcp', 'runtime']);
const statuses = new Set(['pass', 'fail', 'unavailable']);
const units = new Set(['count', 'ms', 'bytes', 'nanocores', 'percent', 'replicas', 'minutes']);
const byteLimit = 24 * 1024;
const maxChecks = 60;
const json = value => JSON.stringify(value);

function archiveError(message, code) {
  return Object.assign(new Error(message), {code});
}

function boundedNumber(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isFinite(value) && value >= 0 && value <= max;
}

function checkedResult(input) {
  if (!input || !connectors.has(input.connector) || !statuses.has(input.status) ||
      typeof input.check !== 'string' || !checkName.test(input.check)) {
    throw new TypeError('Invalid maintenance check');
  }
  const {connector, check, status, dimension, latency_ms, status_code, sample_count, value, unit} = input;
  return {
    connector, check, status,
    ...(typeof dimension === 'string' && dimensionName.test(dimension) ? {dimension} : {}),
    ...(boundedNumber(latency_ms) ? {latency_ms} : {}),
    ...(Number.isInteger(status_code) && status_code >= 100 && status_code <= 599 ? {status_code} : {}),
    ...(Number.isSafeInteger(sample_count) && sample_count >= 0 ? {sample_count} : {}),
    ...(boundedNumber(value) ? {value, ...(units.has(unit) ? {unit} : {})} : {}),
  };
}

function makeReceipt(input) {
  if (!input || typeof input.profile !== 'string' || !profileName.test(input.profile) ||
      typeof input.captured_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.captured_at) ||
      !Array.isArray(input.checks) || input.checks.length < 1 || input.checks.length > maxChecks) {
    throw new TypeError('Invalid maintenance receipt');
  }
  const captured = new Date(input.captured_at);
  if (!Number.isFinite(captured.getTime()) || captured.toISOString() !== input.captured_at) {
    throw new TypeError('Invalid maintenance timestamp');
  }
  const key = row => [row.connector, row.check, row.dimension || ''].join('\0');
  const checks = input.checks.map(checkedResult).sort((a, b) => key(a) < key(b) ? -1 : Number(key(a) > key(b)));
  if (new Set(checks.map(key)).size !== checks.length) throw new TypeError('Duplicate maintenance check');
  const payload = {version: 1, captured_at: input.captured_at, profile: input.profile, checks};
  const id = createHash('sha256').update(json(payload)).digest('hex');
  const failed_count = checks.filter(row => row.status === 'fail').length;
  const unavailable_count = checks.filter(row => row.status === 'unavailable').length;
  return {
    id, ...payload,
    title: input.profile.replaceAll('-', ' ') + ' maintenance review',
    status: failed_count ? 'fail' : unavailable_count ? 'unavailable' : 'pass',
    connectors: [...new Set(checks.map(row => row.connector))],
    check_count: checks.length,
    passed_count: checks.length - failed_count - unavailable_count,
    failed_count, unavailable_count,
  };
}

function searchInput(query, limit) {
  if (typeof query !== 'string' || query.length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Invalid evidence search');
  }
  const terms = query.toLowerCase().match(/[a-z0-9_.:/-]+/g) || [];
  if (terms.length > 8) throw new TypeError('Use at most eight evidence search terms');
  return terms;
}

export function createOperatorEvidenceStore(directory, {maxReceipts = 256} = {}) {
  if (typeof directory !== 'string' || !directory.trim() || !Number.isInteger(maxReceipts) ||
      maxReceipts < 1 || maxReceipts > 256) {
    throw new TypeError('A local evidence directory and valid capacity are required');
  }
  const root = resolve(directory);
  const fileFor = id => join(root, id + '.json');
  let pending = Promise.resolve();
  let queued = 0;

  async function prepare() {
    await mkdir(root, {recursive: true, mode: 0o700});
    if (!(await lstat(root)).isDirectory()) throw archiveError('Invalid evidence directory', 'EVIDENCE_DIRECTORY');
  }

  async function readReceipt(id) {
    const file = fileFor(id);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size < 1 || info.size > byteLimit) return null;
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
      const handle = await open(file, flags);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) return null;
        const bytes = Buffer.alloc(info.size + 1);
        let count = 0;
        while (count < bytes.length) {
          const {bytesRead} = await handle.read(bytes, count, bytes.length - count, count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        if (count !== info.size) return null;
        const stored = JSON.parse(bytes.toString('utf8', 0, count));
        const receipt = makeReceipt(stored);
        return receipt.id === id && json(receipt) === json(stored) ? receipt : null;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError || ['ENOENT', 'ELOOP'].includes(error.code)) return null;
      throw error;
    }
  }

  async function receiptIds() {
    const ids = [];
    const folder = await opendir(root);
    let scanned = 0;
    for await (const entry of folder) {
      scanned += 1;
      if (scanned > 1_024) throw archiveError('Evidence directory exceeds the scan budget', 'EVIDENCE_CAPACITY');
      if (entry.name.endsWith('.json') && receiptId.test(entry.name.slice(0, -5))) ids.push(entry.name.slice(0, -5));
      if (ids.length > maxReceipts) throw archiveError('Evidence archive exceeds capacity', 'EVIDENCE_CAPACITY');
    }
    return ids;
  }

  async function writeReceipt(receipt) {
    await prepare();
    if (await readReceipt(receipt.id)) return receipt;
    if ((await receiptIds()).length >= maxReceipts) {
      throw archiveError('Evidence archive is full. Move older receipts to a private archive before saving more.', 'EVIDENCE_CAPACITY');
    }
    const file = fileFor(receipt.id);
    const temp = join(root, '.' + receipt.id + '.' + randomUUID() + '.tmp');
    const data = json(receipt) + '\n';
    if (Buffer.byteLength(data) > byteLimit) throw archiveError('Evidence receipt exceeds the byte limit', 'EVIDENCE_CAPACITY');
    const handle = await open(temp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temp, file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await readReceipt(receipt.id))) {
          throw archiveError('Existing evidence receipt failed integrity validation', 'EVIDENCE_INTEGRITY');
        }
      }
      return receipt;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  return {
    async save(input) {
      const receipt = makeReceipt(input);
      if (queued >= 16) throw archiveError('Evidence archive is busy', 'EVIDENCE_BUSY');
      queued += 1;
      const operation = pending.then(() => writeReceipt(receipt));
      pending = operation.catch(() => {});
      try { return await operation; }
      finally { queued -= 1; }
    },
    async read(id) {
      if (typeof id !== 'string' || !receiptId.test(id)) return null;
      await prepare();
      return readReceipt(id);
    },
    async search({query = '', limit = 20} = {}) {
      const terms = searchInput(query, limit);
      await prepare();
      const ids = await receiptIds();
      const matches = [];
      for (let offset = 0; offset < ids.length; offset += 8) {
        for (const receipt of await Promise.all(ids.slice(offset, offset + 8).map(readReceipt))) {
          if (!receipt) continue;
          const {checks, ...metadata} = receipt;
          const tokens = [receipt.id, receipt.title, receipt.profile, receipt.captured_at, receipt.status,
            ...checks.flatMap(row => [row.connector, row.check, row.dimension, row.status])].join(' ').toLowerCase();
          if (terms.every(term => tokens.includes(term))) matches.push(metadata);
        }
      }
      return matches.sort((a, b) => b.captured_at.localeCompare(a.captured_at) || a.id.localeCompare(b.id)).slice(0, limit);
    },
  };
}
