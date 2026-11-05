import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

export function createLogDrainHandler({signatureSecret, pipeline, clock = Date.now}) {
  if (typeof signatureSecret !== 'string' || signatureSecret.length < 32 || typeof pipeline?.log !== 'function') throw new TypeError('Separate drain signing secret and filtered log pipeline are required');
  const recent = new Map();
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url !== '/drain') { res.writeHead(404); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, {Allow: 'POST'}); res.end(); return; }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') { res.writeHead(415); res.end(); return; }
    if (!String(req.headers['content-type']).toLowerCase().startsWith('application/json')) { res.writeHead(415); res.end(); return; }
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length; if (bytes > 1024 * 1024) { res.writeHead(413); res.end(); req.resume(); return; } chunks.push(chunk);
      }
      const body = Buffer.concat(chunks), signature = req.headers['x-vercel-signature'];
      if (typeof signature !== 'string' || !/^[a-f0-9]{40}$/.test(signature) || !timingSafeEqual(createHmac('sha1', signatureSecret).update(body).digest(), Buffer.from(signature, 'hex'))) { res.writeHead(403); res.end(); return; }
      const now = clock(), digest = createHash('sha256').update(body).digest('hex');
      for (const [key, until] of recent) if (until <= now) recent.delete(key);
      if (recent.has(digest)) { res.writeHead(204); res.end(); return; }
      const records = JSON.parse(body.toString('utf8'));
      if (!Array.isArray(records) || records.length > 200) { res.writeHead(413); res.end(); return; }
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        let fields = {};
        if (typeof record.message === 'string' && Buffer.byteLength(record.message) <= 16384) {
          try { const parsed = JSON.parse(record.message); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed; } catch {}
        }
        const level = ['debug', 'info', 'warn', 'error'].includes(record.level) ? record.level : 'info';
        const event = /^[a-z][a-z0-9_.-]{0,63}$/.test(fields.event || '') ? fields.event : 'platform.event';
        pipeline.log(event, fields, level);
      }
      if (recent.size >= 256) recent.delete(recent.keys().next().value);
      recent.set(digest, now + 300000); res.writeHead(204); res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(error instanceof SyntaxError ? 400 : 503); res.end(); }
  };
}
