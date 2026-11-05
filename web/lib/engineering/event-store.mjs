import {randomUUID} from 'node:crypto';

const identifier = (value, maximum = 160) => typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[a-zA-Z0-9_:./-]+$/.test(value);
const conflict = () => Object.assign(new Error('Stream version conflict'), {code: 'STREAM_CONFLICT', status: 409});

export function createEventStore({pool}) {
  if (typeof pool?.connect !== 'function') throw new TypeError('Reuse the existing bounded PostgreSQL pool');
  async function transaction(run) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'"); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  function validateStream(streamId) { if (!identifier(streamId)) throw new RangeError('Invalid event stream'); }
  async function read(client, streamId, afterVersion, limit) {
    return (await client.query('SELECT stream_id,version,command_id,event_id,event_type,payload,created_at FROM market_lab.domain_events WHERE stream_id=$1 AND version>$2 ORDER BY version LIMIT $3', [streamId, afterVersion, limit])).rows;
  }
  return {
    async append({streamId, expectedVersion, commandId, eventType, payload}) {
      validateStream(streamId);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !identifier(commandId) || !identifier(eventType, 80) || !payload || Array.isArray(payload) || typeof payload !== 'object' || Buffer.byteLength(JSON.stringify(payload)) > 65536) throw new RangeError('Invalid domain event');
      return transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['events:' + streamId]);
        const previous = (await client.query('SELECT * FROM market_lab.domain_events WHERE stream_id=$1 AND command_id=$2', [streamId, commandId])).rows[0];
        if (previous) {
          const same = (await client.query('SELECT event_type=$3 AND payload=$4::jsonb AS same FROM market_lab.domain_events WHERE stream_id=$1 AND command_id=$2', [streamId, commandId, eventType, JSON.stringify(payload)])).rows[0]?.same;
          if (!same) throw Object.assign(new Error('Command id reused with a different event'), {code: 'IDEMPOTENCY_CONFLICT', status: 409});
          return {...previous, duplicate: true};
        }
        const current = Number((await client.query('SELECT coalesce(max(version),0) AS version FROM market_lab.domain_events WHERE stream_id=$1', [streamId])).rows[0].version);
        if (current !== expectedVersion || !Number.isSafeInteger(current + 1)) throw conflict();
        return (await client.query('INSERT INTO market_lab.domain_events(stream_id,version,command_id,event_id,event_type,payload) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [streamId, current + 1, commandId, randomUUID(), eventType, JSON.stringify(payload)])).rows[0];
      });
    },
    async replay(streamId, {afterVersion = 0, limit = 1000} = {}) {
      validateStream(streamId); if (!Number.isSafeInteger(afterVersion) || afterVersion < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid replay bounds');
      return read(pool, streamId, afterVersion, limit);
    },
    async project({projection, streamId, apply, limit = 100}) {
      validateStream(streamId); if (!identifier(projection, 80) || typeof apply !== 'function' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid projection');
      return transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['projection:' + projection + ':' + streamId]);
        const cursor = Number((await client.query('SELECT version FROM market_lab.projection_cursors WHERE projection=$1 AND stream_id=$2', [projection, streamId])).rows[0]?.version || 0), events = await read(client, streamId, cursor, limit);
        for (const event of events) await apply(client, event);
        const version = events.at(-1)?.version || cursor;
        await client.query('INSERT INTO market_lab.projection_cursors(projection,stream_id,version) VALUES($1,$2,$3) ON CONFLICT(projection,stream_id) DO UPDATE SET version=excluded.version', [projection, streamId, version]);
        return {applied: events.length, version};
      });
    },
    async publishStream({destination, streamId, publish, limit = 100}) {
      validateStream(streamId); if (!identifier(destination, 80) || typeof publish !== 'function' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Invalid event destination');
      return transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['outbox:' + destination + ':' + streamId]);
        const events = (await client.query('SELECT e.* FROM market_lab.domain_events e WHERE e.stream_id=$1 AND NOT EXISTS(SELECT 1 FROM market_lab.event_deliveries d WHERE d.destination=$2 AND d.event_id=e.event_id) ORDER BY e.version LIMIT $3', [streamId, destination, limit])).rows;
        for (const event of events) {
          await publish({key: streamId, id: event.event_id, version: event.version, type: event.event_type, payload: event.payload});
          await client.query('INSERT INTO market_lab.event_deliveries(destination,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [destination, event.event_id]);
        }
        return {published: events.length, semantics: 'at-least-once; consumers deduplicate event id'};
      });
    }
  };
}
