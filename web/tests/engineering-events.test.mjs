import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createEventStore} from '../lib/engineering/event-store.mjs';
import {publishLoopbackEvent} from '../lib/engineering/grpc-ingest.mjs';
import {replayPaperBook, startPaperReplayIngest} from '../lib/engineering/paper-replay.mjs';
import {applyTestSchema} from './database-fixture.mjs';

const connectionString = process.env.MARKET_TEST_DATABASE_URL;
async function eventFixture(t) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test') || url.search) throw new Error('Use a disposable loopback _test database');
  const pool = new pg.Pool({connectionString, max: 4});
  t.after(() => pool.end());
  await applyTestSchema(pool);
  await pool.query(await readFile(new URL('../database/005_engineering_events.sql', import.meta.url), 'utf8'));
  return {pool, store: createEventStore({pool})};
}

test('event store reuses the configured pool and validates input before connecting', async () => {
  assert.throws(() => createEventStore({}), TypeError);
  let connections = 0; const store = createEventStore({pool: {connect: async () => { connections++; throw new Error('Unexpected connection'); }}});
  await assert.rejects(store.append({streamId: 'bad\nstream', expectedVersion: 0, commandId: 'a', eventType: 'OrderPlaced', payload: {}}), RangeError);
  await assert.rejects(store.replay('paper:fixture', {limit: 1001}), RangeError); assert.equal(connections, 0);
});

test('PostgreSQL event sourcing enforces versions, durable idempotency, append-only history and atomic projections', {skip: !connectionString}, async t => {
  const {pool, store} = await eventFixture(t);
  await pool.query('CREATE TABLE IF NOT EXISTS market_lab.event_projection_fixture(stream_id text NOT NULL, version bigint NOT NULL, PRIMARY KEY(stream_id,version))');
  await pool.query('ALTER TABLE market_lab.event_projection_fixture ENABLE ROW LEVEL SECURITY');
  const streamId = 'paper:test:' + crypto.randomUUID(), event = {streamId, expectedVersion: 0, commandId: 'first', eventType: 'PaperOrderPlaced', payload: {quantity: 3, paper_only: true}};
  const first = await store.append(event); assert.equal(Number(first.version), 1);
  const duplicate = await store.append(event); assert.equal(duplicate.event_id, first.event_id); assert.equal(duplicate.duplicate, true);
  await assert.rejects(store.append({...event, payload: {quantity: 8}}), {code: 'IDEMPOTENCY_CONFLICT'});
  const outcomes = await Promise.allSettled(['second', 'third'].map(commandId => store.append({...event, expectedVersion: 1, commandId})));
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(row => row.status === 'rejected').reason.code, 'STREAM_CONFLICT');
  const history = await store.replay(streamId); assert.deepEqual(history.map(row => Number(row.version)), [1, 2]);
  await assert.rejects(pool.query('DELETE FROM market_lab.domain_events WHERE stream_id=$1', [streamId]), {code: '42501'});
  await assert.rejects(pool.query('UPDATE market_lab.domain_events SET payload=$2 WHERE stream_id=$1', [streamId, {}]), {code: '42501'});
  await assert.rejects(store.project({projection: 'fixture', streamId, apply: async (client, row) => {
    await client.query('INSERT INTO market_lab.event_projection_fixture(stream_id,version) VALUES($1,$2)', [streamId, row.version]);
    throw new Error('Projection fixture failure');
  }}), /fixture failure/);
  assert.equal((await pool.query('SELECT * FROM market_lab.projection_cursors WHERE stream_id=$1', [streamId])).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM market_lab.event_projection_fixture WHERE stream_id=$1', [streamId])).rowCount, 0);
  const versions = []; assert.equal((await store.project({projection: 'fixture', streamId, apply: async (client, row) => {
    await client.query('INSERT INTO market_lab.event_projection_fixture(stream_id,version) VALUES($1,$2)', [streamId, row.version]); versions.push(Number(row.version));
  }})).applied, 2);
  assert.deepEqual(versions, [1, 2]); assert.equal((await store.project({projection: 'fixture', streamId, apply: async () => assert.fail('already projected')})).applied, 0);
  const published = []; assert.equal((await store.publishStream({destination: 'fixture-kafka', streamId, publish: async row => published.push(row)})).published, 2);
  assert.equal((await store.publishStream({destination: 'fixture-kafka', streamId, publish: async () => assert.fail('already delivered')})).published, 0);
  assert.deepEqual(published.map(row => Number(row.version)), [1, 2]);
  const deliveredBeforeFailure = [];
  await assert.rejects(store.publishStream({destination: 'failure', streamId, publish: async row => { deliveredBeforeFailure.push(row.id); if (deliveredBeforeFailure.length === 2) throw new Error('broker unavailable'); }}), /broker unavailable/);
  assert.equal((await pool.query("SELECT d.* FROM market_lab.event_deliveries d JOIN market_lab.domain_events e USING(event_id) WHERE d.destination='failure' AND e.stream_id=$1",[streamId])).rowCount, 0);
  const replayed = []; await store.publishStream({destination: 'failure', streamId, publish: async row => replayed.push(row.id)});
  assert.equal(replayed[0], deliveredBeforeFailure[0]); assert.equal(replayed.length, 2);
});

test('loopback gRPC durably admits paper commands and a new SPSC worker replays the book', {skip: !connectionString, timeout: 30000}, async t => {
  const {pool, store} = await eventFixture(t), streamId = 'paper-replay:' + crypto.randomUUID();
  const token = 'local-paper-replay-test-'.repeat(2);
  const ingest = await startPaperReplayIngest({store, streamId, token});
  const place = (sequence, eventId, payload) => ({streamId, sequence: String(sequence), eventId, eventType: 'PaperOrderPlaced', payload});
  const cancel = (sequence, id, owner) => ({streamId, sequence: String(sequence), eventId: 'cancel-' + sequence, eventType: 'PaperOrderCancelled', payload: {id, owner}});
  const send = event => publishLoopbackEvent({port: ingest.port, token, event});
  const maker = place(1, 'maker-a', {id: 'a', owner: 'seller-a', side: 'sell', price: 40, quantity: 3});
  const second = place(2, 'maker-b', {id: 'b', owner: 'seller-b', side: 'sell', price: 40, quantity: 4});
  const taker = place(3, 'taker', {id: 't', owner: 'buyer', side: 'buy', price: 45, quantity: 5, timeInForce: 'IOC'});
  try {
    assert.equal((await send({...maker, streamId: streamId + '-other'})).accepted, false);
    assert.equal((await send({...maker, payload: {...maker.payload, paper_only: false}})).accepted, false);
    assert.equal((await send(second)).accepted, false);
    assert.equal((await send(maker)).accepted, true);
    assert.equal((await send(maker)).accepted, true);
    assert.equal((await send({...maker, sequence: '2'})).accepted, false);
    assert.equal((await send({...maker, payload: {...maker.payload, quantity: 8}})).accepted, false);
    assert.equal((await send(second)).accepted, true);
    assert.equal((await send(taker)).accepted, true);
    assert.equal((await send(cancel(4, 'b', 'buyer'))).accepted, true);
    assert.equal((await send(cancel(5, 'b', 'seller-b'))).accepted, true);
  } finally {
    await ingest.close();
  }
  assert.deepEqual((await store.replay(streamId)).map(row => row.command_id), ['maker-a', 'maker-b', 'taker', 'cancel-4', 'cancel-5']);
  const restartedStore = createEventStore({pool});
  const result = await replayPaperBook({store: restartedStore, streamId});
  assert.equal(result.version, 5);
  assert.equal(result.fill_count, 2);
  assert.equal(result.filled_contracts, 5);
  assert.equal(result.rejected_commands, 1);
  assert.deepEqual(result.recent_fills.map(row => [row.maker_id, row.price, row.quantity]), [['a', 40, 3], ['b', 40, 2]]);
  assert.deepEqual(result.book.asks, []);
  assert.equal(result.book.active_orders, 0);
  assert.deepEqual(await replayPaperBook({store: restartedStore, streamId}), result);
});

test('SPSC paper replay drains all pages, rejects sequence gaps, and returns a bounded fill suffix', async () => {
  const streamId = 'paper-replay:paged-fixture', events = [];
  for (let i = 0; i < 21; i++) {
    for (const [side, price] of [['sell', 40], ['buy', 41]]) {
      events.push({stream_id: streamId, version: events.length + 1, event_type: 'PaperOrderPlaced',
        payload: {id: side + '-' + i, owner: side, side, price, quantity: 2}});
    }
  }
  const store = {replay: async (_, {afterVersion, limit}) => events.slice(afterVersion, afterVersion + limit)};
  const result = await replayPaperBook({store, streamId});
  assert.equal(result.version, 42);
  assert.equal(result.fill_count, 21);
  assert.equal(result.filled_contracts, 42);
  assert.equal(result.recent_fills.length, 20);
  assert.equal(result.recent_fills[0].maker_id, 'sell-1');
  assert.equal(result.recent_fills.at(-1).maker_id, 'sell-20');
  events[32].version = 34;
  await assert.rejects(replayPaperBook({store, streamId}), /sequence is not contiguous/);
});
