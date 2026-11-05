import {parentPort, workerData} from 'node:worker_threads';
import {PaperLimitOrderBook} from './paper-lob.mjs';
import {SharedEventRing} from './shared-ring.mjs';

const ring = new SharedEventRing(workerData), book = new PaperLimitOrderBook();
const recentFills = [];
let version = 0, fillCount = 0, filledContracts = 0, rejected = 0;

function apply({type, payload}) {
  if (type === 'PaperOrderCancelled') {
    if (!book.cancel(payload.id, payload.owner)) rejected++;
    return;
  }
  let order;
  try { order = book.submit(payload); }
  catch (error) {
    if (!['DUPLICATE_ACTIVE_ORDER', 'PAPER_ORDER_CAPACITY'].includes(error.code)) throw error;
    rejected++;
    return;
  }
  for (const fill of order.fills) {
    fillCount++;
    filledContracts += fill.quantity;
    recentFills.push(fill);
    if (recentFills.length > 20) recentFills.shift();
  }
}

parentPort.on('message', action => {
  try {
    if (action === 'drain') {
      let bytes;
      while ((bytes = ring.poll()) !== null) {
        apply(JSON.parse(Buffer.from(bytes).toString('utf8')));
        version++;
      }
      parentPort.postMessage({version});
      return;
    }
    parentPort.postMessage({version, fill_count: fillCount, filled_contracts: filledContracts, rejected_commands: rejected, recent_fills: recentFills, book: book.snapshot(), paper_only: true});
  } catch {
    parentPort.postMessage({error: 'Paper replay worker could not apply the event page'});
  }
});
