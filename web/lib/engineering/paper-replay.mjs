import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {startLoopbackGrpcIngest} from './grpc-ingest.mjs';
import {normalizePaperOrder} from './paper-lob.mjs';
import {SharedEventRing} from './shared-ring.mjs';

export const PAPER_REPLAY_LIMIT = 2048;
const RING_SHAPE = {capacity: 32, slotBytes: 2048};

function checkStream(streamId) {
  if (typeof streamId !== 'string' || !/^paper-replay:[a-zA-Z0-9_-]{1,120}$/.test(streamId)) throw new RangeError('Use an isolated paper-replay stream');
}

export function normalizePaperCommand(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.paper_only === false) throw new RangeError('Invalid paper command');
  if (type === 'PaperOrderPlaced') return {...normalizePaperOrder(payload), paper_only: true};
  const {id, owner} = payload;
  if (type !== 'PaperOrderCancelled' || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || typeof owner !== 'string' || !owner || owner.length > 80) throw new RangeError('Invalid paper command');
  return {id, owner, paper_only: true};
}

export function startPaperReplayIngest({store, streamId, token, port}) {
  checkStream(streamId);
  return startLoopbackGrpcIngest({token, port, onEvent: async (event, {signal}) => {
    const version = Number(event.sequence);
    if (event.streamId !== streamId || !Number.isInteger(version) || version < 1 || version > PAPER_REPLAY_LIMIT) return {accepted: false};
    let payload;
    try { payload = normalizePaperCommand(event.eventType, event.payload); }
    catch (error) { if (error instanceof RangeError) return {accepted: false}; throw error; }
    signal.throwIfAborted();
    try {
      const saved = await store.append({streamId, expectedVersion: version - 1, commandId: event.eventId, eventType: event.eventType, payload});
      return {accepted: Number(saved.version) === version};
    } catch (error) {
      if (['STREAM_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error.code)) return {accepted: false};
      throw error;
    }
  }});
}

export async function replayPaperBook({store, streamId}) {
  checkStream(streamId);
  const ring = new SharedEventRing(RING_SHAPE);
  const worker = new Worker(new URL('./paper-replay-worker.mjs', import.meta.url), {workerData: {...RING_SHAPE, buffer: ring.buffer}});
  const stopped = new AbortController();
  worker.on('error', error => stopped.abort(error));
  worker.once('exit', () => stopped.abort(new Error('Paper replay worker stopped')));
  async function exchange(action) {
    const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(10000)]);
    const response = once(worker, 'message', {signal});
    worker.postMessage(action);
    const [result] = await response;
    if (result.error) throw new Error(result.error);
    return result;
  }
  let version = 0;
  try {
    while (version < PAPER_REPLAY_LIMIT) {
      const limit = Math.min(ring.capacity, PAPER_REPLAY_LIMIT - version);
      const page = await store.replay(streamId, {afterVersion: version, limit});
      if (page.length > limit) throw new Error('Paper replay page exceeds capacity');
      if (!page.length) break;
      for (const row of page) {
        if (row.stream_id !== streamId || Number(row.version) !== version + 1) throw new Error('Paper replay sequence is not contiguous');
        const payload = normalizePaperCommand(row.event_type, row.payload);
        const packet = Buffer.from(JSON.stringify({type: row.event_type, payload}));
        if (!ring.offer(packet)) throw new Error('Paper replay ring is full');
        version++;
      }
      const progress = await exchange('drain');
      if (progress.version !== version) throw new Error('Paper replay worker did not consume the entire page');
      if (page.length < limit) break;
    }
    return await exchange('snapshot');
  } finally {
    await worker.terminate();
  }
}
