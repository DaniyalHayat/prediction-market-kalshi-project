import {workerData} from 'node:worker_threads';
import {SharedEventRing} from '../../lib/engineering/shared-ring.mjs';
const ring = new SharedEventRing({capacity: 64, slotBytes: 4, buffer: workerData.buffer}), payload = new Uint8Array(4), view = new DataView(payload.buffer);
for (let i = 0; i < workerData.count; i++) {
  view.setUint32(0, i, true);
  while (!ring.offer(payload)) await new Promise(resolve => setImmediate(resolve));
}
