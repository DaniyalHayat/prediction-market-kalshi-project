import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {SharedEventRing} from '../lib/engineering/shared-ring.mjs';
import {PaperLimitOrderBook} from '../lib/engineering/paper-lob.mjs';
import {createRuntimeTelemetry} from '../lib/runtime/telemetry.mjs';
import {createLogPipeline} from '../lib/runtime/log-pipeline.mjs';
import {encodeEnvelope, decodeEnvelope, startLoopbackGrpcIngest, publishLoopbackEvent, frameGrpcMessage} from '../lib/engineering/grpc-ingest.mjs';

test('SPSC ring bounds bytes, signals overflow, wraps uint32 indices and preserves a copy', () => {
  const ring = new SharedEventRing({capacity: 2, slotBytes: 4});
  Atomics.store(ring.indices, 0, 0xfffffffe); Atomics.store(ring.indices, 16, 0xfffffffe);
  assert.equal(ring.offer(Uint8Array.of(1)), true); assert.equal(ring.offer(Uint8Array.of(2)), true);
  assert.equal(ring.offer(Uint8Array.of(3)), false); assert.equal(ring.size, 2);
  const first = ring.poll(); assert.deepEqual([...first], [1]); assert.deepEqual([...ring.poll()], [2]);
  assert.equal(ring.poll(), null); ring.offer(Uint8Array.of(9)); assert.deepEqual([...first], [1]);
  assert.throws(() => ring.offer(new Uint8Array(5)), RangeError);
});

test('SPSC ring transfers ordered payloads between a worker producer and main consumer', {timeout: 15000}, async () => {
  const ring = new SharedEventRing({capacity: 64, slotBytes: 4}), count = 10000;
  const worker = new Worker(new URL('./fixtures/ring-producer.mjs', import.meta.url), {workerData: {buffer: ring.buffer, count}});
  let workerFailure, workerExited = false;
  const done = new Promise(resolve => { worker.once('error', error => { workerFailure = error; }); worker.once('exit', code => { workerExited = true; if (code) workerFailure ||= new Error('Worker exited ' + code); resolve(); }); });
  let next = 0; const deadline = Date.now() + 10000;
  try {
    while (next < count) {
      if (workerFailure) throw workerFailure;
      if (Date.now() > deadline || workerExited && ring.size === 0) throw new Error('Worker stopped before all ring payloads arrived');
      let payload;
      while ((payload = ring.poll()) !== null) { assert.equal(new DataView(payload.buffer).getUint32(0, true), next++); }
      if (next < count) await new Promise(resolve => setImmediate(resolve));
    }
    await done; assert.equal(ring.size, 0);
  } finally { await worker.terminate(); }
});

test('paper LOB matches maker price, FIFO, partial fills and owner-authorized cancellation', () => {
  const book = new PaperLimitOrderBook();
  book.submit({id: 'a', owner: 'alice', side: 'sell', price: 40, quantity: 3});
  book.submit({id: 'b', owner: 'bob', side: 'sell', price: 40, quantity: 4});
  const result = book.submit({id: 'c', owner: 'carol', side: 'buy', price: 45, quantity: 5});
  assert.deepEqual(result.fills.map(row => [row.maker_id, row.quantity, row.price]), [['a', 3, 40], ['b', 2, 40]]);
  assert.equal(book.cancel('b', 'carol'), false); assert.equal(book.cancel('b', 'bob'), true); assert.equal(book.snapshot().active_orders, 0);
});

test('paper FOK preflight is atomic, IOC does not rest and self-trade cancels own maker', () => {
  const book = new PaperLimitOrderBook();
  book.submit({id: 'a', owner: 'alice', side: 'sell', price: 40, quantity: 3});
  assert.equal(book.submit({id: 'fok', owner: 'bob', side: 'buy', price: 45, quantity: 4, timeInForce: 'FOK'}).fills.length, 0);
  assert.equal(book.snapshot().asks[0].quantity, 3);
  const own = book.submit({id: 'self', owner: 'alice', side: 'buy', price: 45, quantity: 1, timeInForce: 'IOC'});
  assert.equal(own.fills.length, 0); assert.equal(book.snapshot().active_orders, 0);
  assert.equal(book.submit({id: 'ioc', owner: 'bob', side: 'buy', price: 45, quantity: 4, timeInForce: 'IOC'}).status, 'cancelled');
});

test('telemetry reports p95/p99 and cumulative buckets without unbounded route cardinality', () => {
  const telemetry = createRuntimeTelemetry({routes: ['/api/book'], providers: ['kalshi'], sampleSize: 100});
  for (let i = 1; i <= 100; i++) telemetry.observeRequest({route: '/api/book', durationMs: i, status: i === 100 ? 500 : 200});
  for (let i = 0; i < 1000; i++) telemetry.observeProvider({provider: 'arbitrary-' + i, durationMs: 2});
  assert.equal(telemetry.snapshot().distributions['request:/api/book'].p95_ms, 95);
  assert.equal(telemetry.snapshot().distributions['request:/api/book'].p99_ms, 99);
  assert.equal(telemetry.snapshot().distributions['request:/api/book'].errors, 1);
  assert.equal(Object.keys(telemetry.snapshot().distributions).length, 2);
  assert.match(telemetry.prometheus(), /le="100"\} 100/);
  assert.equal(telemetry.observeRequest({route: '/api/book', durationMs: NaN}), false);
});

test('log filtering strips sensitive data, samples successes and reserves a bounded error budget', () => {
  const lines = [], pipeline = createLogPipeline({write: row => lines.push(row), successSampleRate: 0, normalPerMinute: 1, errorsPerMinute: 2, clock: () => 0});
  assert.equal(pipeline.log('request.finished', {status: 200, token: 'PRIVATE'}), false);
  for (let i = 0; i < 3; i++) pipeline.log('request.failed', {status: 500, route: '/api/book?token=PRIVATE', error_code: 'UPSTREAM_TIMEOUT', body: 'PRIVATE', trace_id: 'a'.repeat(32)}, 'error');
  assert.equal(lines.length, 2); assert.ok(!lines.join('').includes('PRIVATE'));
  assert.deepEqual(pipeline.snapshot(), {written: 2, sampled_out: 1, throttled: 1, normal_per_minute: 1, errors_per_minute: 2});
});

test('protobuf envelope preserves full uint64 sequences and rejects malformed payloads', () => {
  const event = {streamId: 'paper:test', sequence: '18446744073709551615', eventId: 'fixture-1', eventType: 'PaperOrderPlaced', payload: {paper_only: true}};
  assert.deepEqual(decodeEnvelope(encodeEnvelope(event)), event);
  assert.throws(() => decodeEnvelope(Buffer.from([0x12, 0x80])));
  assert.throws(() => frameGrpcMessage(Buffer.alloc(65537)), RangeError);
});

test('real HTTP/2 gRPC unary ingest is loopback only, token protected and sends status trailers', async t => {
  const token = 'internal-ingest-fixture-'.repeat(3), received = [], server = await startLoopbackGrpcIngest({token, onEvent: async event => { received.push(event); return {accepted: true}; }});
  t.after(() => server.close());
  const event = {streamId: 'paper:test', sequence: '7', eventId: 'fixture-7', eventType: 'PaperOrderPlaced', payload: {paper_only: true}};
  assert.deepEqual(await publishLoopbackEvent({port: server.port, token, event}), {accepted: true, sequence: '7', reason: ''});
  assert.deepEqual(received, [event]);
  await assert.rejects(publishLoopbackEvent({port: server.port, token: 'invalid-token-'.repeat(4), event}), {grpcStatus: '16'});
});
