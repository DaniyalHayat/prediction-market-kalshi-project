import pg from 'pg';
import {createHash, randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {gzipSync,gunzipSync} from 'node:zlib';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const conflict = message => Object.assign(new Error(message), {name:'ConditionalCheckFailedException', status:409});

export function makePostgresStore({connectionString=process.env.DATABASE_URL, pool,
  storageURL=process.env.SUPABASE_URL, storageKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
  bucket=process.env.MARKET_STORAGE_BUCKET || 'market-lab-evidence'} = {}) {
  const remote=connectionString && !['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname);
  const db = pool || new pg.Pool({connectionString,max:4,idleTimeoutMillis:30000,connectionTimeoutMillis:10000,
    ...(remote ? {ssl:{rejectUnauthorized:true,...(process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT}:{})}} : {})});
  const storage = storageURL && storageKey ? createClient(storageURL,storageKey,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from(bucket) : null;
  const denied = new Map();
  async function transaction(fn) {
    const client=await db.connect();
    try { await client.query('BEGIN'); const value=await fn(client); await client.query('COMMIT'); return value; }
    catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function get(pk,sk='value') {
    const r=await db.query('SELECT payload FROM market_lab.records WHERE pk=$1 AND sk=$2 AND (expires_at IS NULL OR expires_at>now())',[pk,sk]);
    return r.rows[0]?.payload;
  }
  async function save(item,overwrite=false) {
    const expiry=Number.isFinite(item.expires_epoch) ? new Date(item.expires_epoch*1000) : null;
    try { await db.query('INSERT INTO market_lab.records(pk,sk,payload,expires_at) VALUES($1,$2,$3,$4)'+
      (overwrite?' ON CONFLICT(pk,sk) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at':''),[item.pk,item.sk,JSON.stringify(item),expiry]); }
    catch(error) { if(error.code==='23505')throw conflict('This record is already registered'); throw error; }
  }
  async function consume(key,limit,amount=1,ttl=172800) {
    if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(amount)||amount<1||amount>limit||!Number.isFinite(ttl)||ttl<1)throw new RangeError('Invalid quota');
    if((denied.get(key)||0)>Date.now())return false;
    const r=await db.query(`INSERT INTO market_lab.quotas(key,used,expires_at) VALUES($1,$2,now()+$3*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET used=CASE WHEN market_lab.quotas.expires_at<=now() THEN excluded.used ELSE market_lab.quotas.used+excluded.used END,
      expires_at=excluded.expires_at WHERE market_lab.quotas.expires_at<=now() OR market_lab.quotas.used<=$4 RETURNING used`,[key,amount,ttl,limit-amount]);
    if(!r.rowCount)denied.set(key,Date.now()+60000);
    return Boolean(r.rowCount);
  }
  async function lease(key,seconds=30) {
    const owner=randomUUID();
    const r=await db.query(`INSERT INTO market_lab.leases(key,owner,expires_at) VALUES($1,$2,now()+$3*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE market_lab.leases.expires_at<=now() RETURNING owner`,[key,owner,seconds]);
    if(!r.rowCount)return null;
    return async()=>{await db.query('DELETE FROM market_lab.leases WHERE key=$1 AND owner=$2',[key,owner]);};
  }
  async function archive(key,value) {
    const body=canonical(value),hash=sha(body),existing=await db.query('SELECT sha256 FROM market_lab.archives WHERE key=$1',[key]);
    if(existing.rowCount) { if(existing.rows[0].sha256!==hash)throw conflict('Archive key has different content'); return {key,sha256:hash}; }
    if(storage) {
      const compressed=gzipSync(Buffer.from(body)),limit=Number(process.env.ARCHIVE_MONTHLY_BYTE_LIMIT||1000000000);
      if(!await consume('archive-bytes#'+new Date().toISOString().slice(0,7),limit,compressed.length,45*86400))throw new Error('Monthly evidence storage allowance reached');
      const {error}=await storage.upload(key+'.gz',compressed,{contentType:'application/gzip',upsert:false});
      if(error && !['409','Duplicate'].includes(String(error.statusCode||error.error)))throw new Error('Evidence storage is unavailable');
    }
    await db.query('INSERT INTO market_lab.archives(key,sha256,payload,object_path) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO NOTHING',
      [key,hash,storage?null:body,storage?key+'.gz':null]);
    const stored=await db.query('SELECT sha256 FROM market_lab.archives WHERE key=$1',[key]);
    if(stored.rows[0]?.sha256!==hash)throw conflict('Archive key has different content');
    return {key,sha256:hash};
  }
  async function readArchive(key) {
    const r=await db.query('SELECT * FROM market_lab.archives WHERE key=$1',[key]);
    const item=r.rows[0]; if(!item)throw new Error('Evidence archive is missing');
    let body;
    if(item.payload!==null)body=JSON.stringify(item.payload);
    else {
      if(!storage)throw new Error('Evidence storage is not configured');
      const {data,error}=await storage.download(item.object_path); if(error)throw new Error('Evidence archive is unavailable');
      body=item.object_path.endsWith('.gz')?gunzipSync(Buffer.from(await data.arrayBuffer())).toString('utf8'):await data.text();
    }
    const value=JSON.parse(body);
    if(sha(canonical(value))!==item.sha256)throw new Error('Evidence archive integrity failure');
    return value;
  }
  async function cached(key,seconds,producer) {
    const pk='cache#'+sha(key),existing=await get(pk); if(existing)return existing.value;
    const release=await lease(pk,25);
    if(!release) {
      for(let i=0;i<10;i++) { await new Promise(r=>setTimeout(r,150)); const hit=await get(pk); if(hit)return hit.value; }
      throw Object.assign(new Error('This source is refreshing; try again shortly'),{status:429});
    }
    try {
      if(!await consume('upstream#'+new Date().toISOString().slice(0,10),12000))throw Object.assign(new Error('Daily source-read allowance reached'),{status:429});
      const value=await producer(); await save({pk,sk:'value',value,expires_epoch:Math.floor(Date.now()/1000)+seconds},true); return value;
    } finally { await release(); }
  }
  async function appendAudit(id,entry) {
    const key=`forward/${id}/${entry.type}-${entry.hash}.json`; await archive(key,entry);
    await transaction(async c=>{
      if(!entry.previous) {
        try { await c.query('INSERT INTO market_lab.audit_heads(id,last_hash) VALUES($1,$2)',[id,entry.hash]); }
        catch(error) { if(error.code==='23505')throw conflict('This cohort already exists'); throw error; }
      } else {
        const changed=await c.query('UPDATE market_lab.audit_heads SET last_hash=$1 WHERE id=$2 AND last_hash=$3 RETURNING id',[entry.hash,id,entry.previous]);
        if(!changed.rowCount)throw conflict('The audit chain changed before this append');
      }
      await c.query('INSERT INTO market_lab.audit_events(id,type,hash,previous_hash,archive_key,recorded_at) VALUES($1,$2,$3,$4,$5,$6)',
        [id,entry.type,entry.hash,entry.previous,key,entry.recorded_at]);
    });
  }
  async function readAudit(id) {
    const r=await db.query("SELECT archive_key FROM market_lab.audit_events WHERE id=$1 ORDER BY CASE type WHEN 'freeze' THEN 0 ELSE 1 END",[id]);
    return Promise.all(r.rows.map(row=>readArchive(row.archive_key)));
  }
  async function auditIds() { return (await db.query('SELECT id FROM market_lab.audit_heads ORDER BY created_at DESC LIMIT 60')).rows.map(row=>row.id); }
  async function journalRows(pk) {
    const r=await db.query("SELECT payload FROM market_lab.records WHERE pk=$1 AND sk LIKE 'forecast#%' AND (expires_at IS NULL OR expires_at>now()) ORDER BY sk LIMIT 101",[pk]);
    return {items:r.rows.slice(0,100).map(row=>row.payload),partial:r.rowCount>100};
  }
  async function pendingRows(now,limit) {
    return (await db.query("SELECT payload FROM market_lab.records WHERE payload->>'status'='pending' AND payload->>'pending_sk'<=$1 AND (expires_at IS NULL OR expires_at>now()) ORDER BY payload->>'pending_sk' LIMIT $2",[now+'~',limit])).rows.map(row=>row.payload);
  }
  async function reschedule(row,next) {
    await db.query("UPDATE market_lab.records SET payload=jsonb_set(payload,'{pending_sk}',to_jsonb($1::text)) WHERE pk=$2 AND sk=$3 AND payload->>'status'='pending'",[next,row.pk,row.sk]);
  }
  async function settle(row,score,asof) {
    const r=await db.query(`UPDATE market_lab.records SET payload=(payload-'pending_pk'-'pending_sk')||$1::jsonb
      WHERE pk=$2 AND sk=$3 AND payload->>'status'='pending' AND payload->>'freeze_hash'=$4 RETURNING pk`,
      [JSON.stringify({status:'settled',score,settlement_as_of:asof}),row.pk,row.sk,row.freeze_hash]);
    if(!r.rowCount)throw conflict('The journal record already changed');
  }
  return {kind:'postgres',db,get,put:item=>save(item),save,consume,lease,archive,readArchive,cached,appendAudit,readAudit,auditIds,
    journalRows,pendingRows,reschedule,settle,transaction,close:()=>db.end()};
}
