import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createEventStore} from '../lib/engineering/event-store.mjs';
import {publishLoopbackEvent} from '../lib/engineering/grpc-ingest.mjs';
import {replayPaperBook, startPaperReplayIngest} from '../lib/engineering/paper-replay.mjs';

const url = new URL(process.env.MARKET_TEST_DATABASE_URL || 'postgresql://localhost/');
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/[a-z0-9_]+_test$/.test(url.pathname) || url.search) throw new Error('Set MARKET_TEST_DATABASE_URL to a disposable loopback PostgreSQL database ending in _test, without connection options');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--replay')) throw new Error('Usage: node tools/paper_replay.mjs [--replay stream-id]');
const [mode, requestedStream] = args;
const streamId = requestedStream ?? 'paper-replay:' + randomUUID();
const pool = new pg.Pool({connectionString: url.href, max: 2, connectionTimeoutMillis: 3000});
const store = createEventStore({pool});

try {
  if (!(await pool.query('SELECT current_database() AS name')).rows[0].name.endsWith('_test')) throw new Error('Use a disposable _test database');
  if (!mode) {
    await pool.query('CREATE SCHEMA IF NOT EXISTS market_lab');
    await pool.query(await readFile(new URL('../database/005_engineering_events.sql', import.meta.url), 'utf8'));
    const token = randomUUID() + randomUUID();
    const ingest = await startPaperReplayIngest({store, streamId, token});
    const orders = [
      {id: 'maker-a', owner: 'seller-a', side: 'sell', price: 40, quantity: 3},
      {id: 'maker-b', owner: 'seller-b', side: 'sell', price: 40, quantity: 4},
      {id: 'taker', owner: 'buyer', side: 'buy', price: 45, quantity: 5, timeInForce: 'IOC'},
    ];
    try {
      for (const [index, payload] of orders.entries()) {
        const event = {streamId, sequence: String(index + 1), eventId: payload.id, eventType: 'PaperOrderPlaced', payload};
        const ack = await publishLoopbackEvent({port: ingest.port, token, event});
        if (!ack.accepted) throw new Error('Fixture command did not reach the event store');
      }
    } finally {
      await ingest.close();
    }
  }
  const snapshot = await replayPaperBook({store, streamId});
  if (!snapshot.version) throw new Error('No durable paper commands found in this stream');
  console.log(JSON.stringify({stream_id: streamId, ...snapshot}, null, 2));
} finally {
  await pool.end();
}
