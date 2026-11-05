import {performance} from 'node:perf_hooks';
import {SharedEventRing} from '../lib/engineering/shared-ring.mjs';
import {PaperLimitOrderBook} from '../lib/engineering/paper-lob.mjs';

const count = 100000, payload = new Uint8Array(256), ring = new SharedEventRing({capacity: 1024, slotBytes: 256});
function measure(label, run) {
  for (let i = 0; i < 1000; i++) run(i);
  const start = performance.now(); for (let i = 0; i < count; i++) run(i);
  const elapsed = performance.now() - start; return {label, operations: count, elapsed_ms: elapsed, ns_per_operation: elapsed * 1e6 / count};
}
const baseline = new Array(1024); let head = 0, tail = 0;
const results = [measure('single-thread reference queue (no copy, no worker safety)', () => { baseline[head++ & 1023] = payload; baseline[tail++ & 1023] = undefined; }),
  measure('shared SPSC 256-byte offer + copied poll', () => { if (!ring.offer(payload) || !ring.poll()) throw new Error('Ring benchmark invariant'); })];
const book = new PaperLimitOrderBook();
results.push(measure('paper LOB submit + cross at one price', i => {
  book.submit({id: 'maker-' + i, owner: 'maker', side: 'sell', price: 40, quantity: 1});
  book.submit({id: 'taker-' + i, owner: 'taker', side: 'buy', price: 40, quantity: 1, timeInForce: 'IOC'});
}));
console.log(JSON.stringify({node: process.version, platform: process.platform, fixture: 'synthetic local microbenchmark; not end-to-end or exchange latency', results}, null, 2));
