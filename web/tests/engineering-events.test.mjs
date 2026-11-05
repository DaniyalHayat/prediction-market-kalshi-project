import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createEventStore} from '../lib/engineering/event-store.mjs';

const connectionString = process.env.MARKET_TEST_DATABASE_URL;
test('event store reuses the configured pool and validates input before connecting', async () => {
  assert.throws(() => createEventStore({}), TypeError);
  let connections = 0; const store = createEventStore({pool: {connect: async () => { connections++; throw new Error('Unexpected connection'); }}});
  await assert.rejects(store.append({streamId: 'bad\nstream', expectedVersion: 0, commandId: 'a', eventType: 'OrderPlaced', payload: {}}), RangeError);
  await assert.rejects(store.replay('paper:fixture', {limit: 1001}), RangeError); assert.equal(connections, 0);
});

test('PostgreSQL event sourcing enforces versions, durable idempotency, append-only history and atomic projections', {skip: !connectionString}, async t => {
  const pool = new pg.Pool({connectionString, max: 4}), store = createEventStore({pool});
  t.after(() => pool.end());
  await pool.query('CREATE SCHEMA IF NOT EXISTS market_lab');
  await pool.query(await readFile(new URL('../database/005_engineering_events.sql', import.meta.url), 'utf8'));
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
