import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {makePostgresStore} from '../lib/postgres-store.mjs';

test('remote PostgreSQL pool is capped and emits transient idle errors without throwing',()=>{
  let options,listener;
  const pool={on(event,fn){if(event==='error')listener=fn;},end:async()=>{},query:async()=>{},connect:async()=>({query:async()=>{},release(){}})};
  const original=pg.Pool;
  pg.Pool=class extends original {constructor(value){super({connectionString:'postgres://user:[REDACTED]@127.0.0.1/test'});options=value;return pool;}};
  try {
    const store=makePostgresStore({connectionString:'postgres://user:[REDACTED]@example.postgres.database.azure.com:5432/db'});
    assert.equal(options.max,4);
    assert.equal(options.idleTimeoutMillis,30000);
    assert.equal(options.connectionTimeoutMillis,10000);
    assert.equal(options.ssl.rejectUnauthorized,true);
    assert.equal(typeof listener,'function');
    assert.doesNotThrow(()=>listener(Object.assign(new Error('admin shutdown'),{code:'57P01'})));
    return store.close();
  } finally {pg.Pool=original;}
});
