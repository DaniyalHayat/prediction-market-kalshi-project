import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {createLogPipeline} from '../lib/runtime/log-pipeline.mjs';
import {createLogDrainHandler} from '../lib/runtime/log-drain.mjs';

test('drain verifies raw-body HMAC, filters private content, deduplicates delivery and caps record batches', async t => {
  const signatureSecret = 'local-drain-test-'.repeat(3), lines = [], pipeline = createLogPipeline({write: row => lines.push(row), successSampleRate: 1});
  const server = createServer(createLogDrainHandler({signatureSecret, pipeline}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port + '/drain';
  const body = JSON.stringify([{level: 'error', message: JSON.stringify({event: 'request.finished', status: 500, body: 'PRIVATE', url: '/?secret=PRIVATE', trace_id: 'a'.repeat(32)}), ip: 'PRIVATE'}]);
  const send = (raw, signature = createHmac('sha1', signatureSecret).update(raw).digest('hex')) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json', 'x-vercel-signature': signature}, body: raw});
  assert.equal((await send(body, 'a'.repeat(40))).status, 403); assert.equal(lines.length, 0);
  assert.equal((await send(body)).status, 204); assert.equal((await send(body)).status, 204); assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('PRIVATE')); assert.match(lines[0], /"status":500/);
  assert.equal((await send(JSON.stringify(Array(201).fill({})))).status, 413);
  assert.equal((await fetch(url, {method: 'GET'})).status, 405);
});
