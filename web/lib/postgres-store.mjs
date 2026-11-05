import pg from 'pg';
import {createHash, randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {gzipSync,gunzipSync} from 'node:zlib';
import {structuredLog} from './runtime-observability.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
const conflict = message => Object.assign(new Error(message), {name:'ConditionalCheckFailedException', status:409});

export function makePostgresStore({connectionString=process.env.DATABASE_URL, pool,
  storageURL=process.env.SUPABASE_URL, storageKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
  bucket=process.env.MARKET_STORAGE_BUCKET || 'market-lab-evidence'} = {}) {
  const remote=connectionString && !['localhost','127.0.0.1','[::1]'].includes(new URL(connectionString).hostname);
  const keepWarm = remote && process.env.PREDICTIR_MODE==='live' && process.env.PREDICTIR_KEEP_CATALOG_WARM==='1';
  const db = pool || new pg.Pool({connectionString,max:4,min:keepWarm?1:0,idleTimeoutMillis:30000,connectionTimeoutMillis:10000,query_timeout:20000,application_name:'predictir',
    ...(remote ? {ssl:{rejectUnauthorized:true,...(process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT}:{})}} : {})});
  const storage = storageURL && storageKey ? createClient(storageURL,storageKey,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from(bucket) : null;
  const listeners=new Set();let closePromise;
  db.on?.('error',()=>structuredLog('database.pool_error',{error_code:'IDLE_CONNECTION_ERROR'}));
  async function transaction(fn) {
    const client=await db.connect();
    try { await client.query('BEGIN'); const value=await fn(client); await client.query('COMMIT'); return value; }
    catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function get(pk,sk='value') {
    const r=await db.query('SELECT payload FROM market_lab.records WHERE pk=$1 AND sk=$2 AND (expires_at IS NULL OR expires_at>clock_timestamp())',[pk,sk]);
    return r.rows[0]?.payload;
  }
  async function save(item,overwrite=false) {
    const expiry=Number.isFinite(item.expires_epoch) ? new Date(item.expires_epoch*1000) : null;
    try { await db.query('INSERT INTO market_lab.records AS retained(pk,sk,payload,expires_at) VALUES($1,$2,$3,$4)'+
      (overwrite?' ON CONFLICT(pk,sk) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE retained.payload IS DISTINCT FROM excluded.payload OR retained.expires_at IS DISTINCT FROM excluded.expires_at':''),[item.pk,item.sk,JSON.stringify(item),expiry]); }
    catch(error) { if(error.code==='23505')throw conflict('This record is already registered'); throw error; }
  }
  async function consume(key,limit,amount=1,ttl=172800) {
    if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(amount)||amount<1||amount>limit||!Number.isFinite(ttl)||ttl<1)throw new RangeError('Invalid quota');
    const r=await db.query(`INSERT INTO market_lab.quotas(key,used,expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET used=CASE WHEN market_lab.quotas.expires_at<=clock_timestamp() THEN excluded.used ELSE market_lab.quotas.used+excluded.used END,
      expires_at=clock_timestamp()+$3*interval '1 second' WHERE market_lab.quotas.expires_at<=clock_timestamp() OR market_lab.quotas.used<=$4 RETURNING used`,[key,amount,ttl,limit-amount]);
    return Boolean(r.rowCount);
  }
  async function reserveAssistantBudget(fingerprint,{month,day,monthlyUnits,reservedUnits=25,dailyLimit=20}={}){
    if(!/^[a-f0-9]{64}$/.test(fingerprint||'')||!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month||'')||!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||!day.startsWith(month+'-')||
      !Number.isSafeInteger(monthlyUnits)||monthlyUnits<reservedUnits||monthlyUnits>10000||!Number.isSafeInteger(reservedUnits)||reservedUnits<1||reservedUnits>25||
      !Number.isSafeInteger(dailyLimit)||dailyLimit<1||dailyLimit>200)throw new RangeError('Invalid assistant budget reservation');
    const monthlyKey='assistant-reserved-milliusd#'+month,dailyKey='assistant-ip#'+day+'#'+fingerprint;
    const id=randomUUID(),pk='assistant-reservation#'+id,payload={pk,sk:'value',id,kind:'assistant_budget',state:'reserved',monthly_key:monthlyKey,
      reserved_units:reservedUnits,billed_units:reservedUnits,created_at:new Date().toISOString()};
    await transaction(async client=>{
      for(const [key,limit,amount,ttl,label] of [[dailyKey,dailyLimit,1,172800,'Daily'],[monthlyKey,monthlyUnits,reservedUnits,45*86400,'Monthly']]){
        const result=await client.query(`INSERT INTO market_lab.quotas(key,used,expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 second')
          ON CONFLICT(key) DO UPDATE SET used=CASE WHEN market_lab.quotas.expires_at<=clock_timestamp() THEN excluded.used ELSE market_lab.quotas.used+excluded.used END,
          expires_at=clock_timestamp()+$3*interval '1 second' WHERE market_lab.quotas.expires_at<=clock_timestamp() OR market_lab.quotas.used<=$4 RETURNING used`,[key,amount,ttl,limit-amount]);
        if(!result.rowCount)throw Object.assign(new Error(label+' assistant allowance reached'),{status:429});
      }
      await client.query("INSERT INTO market_lab.records(pk,sk,payload,expires_at) VALUES($1,'value',$2,now()+interval '45 days')",[pk,payload]);
    });
    return {reservation_id:id,reserved_units:reservedUnits,monthly_units:monthlyUnits};
  }
  async function settleAssistantBudget(id,billedMilliusd){
    if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)||!Number.isSafeInteger(billedMilliusd)||billedMilliusd<0||billedMilliusd>25)throw new RangeError('Invalid assistant cost settlement');
    return transaction(async client=>{
      const result=await client.query("SELECT payload FROM market_lab.records WHERE pk=$1 AND sk='value' AND expires_at>clock_timestamp() FOR UPDATE",['assistant-reservation#'+id]);
      const row=result.rows[0]?.payload;
      if(!row||row.kind!=='assistant_budget')throw Object.assign(new Error('Assistant reservation was not found'),{status:404});
      if(!Number.isSafeInteger(row.reserved_units)||row.reserved_units<1||row.reserved_units>25||billedMilliusd>row.reserved_units)throw new RangeError('Assistant settlement exceeds its reservation');
      if(row.state==='settled')return {reservation_id:id,billed_units:row.billed_units,refunded_units:row.reserved_units-row.billed_units,already_settled:true};
      if(row.state!=='reserved'||typeof row.monthly_key!=='string'||!/^assistant-reserved-milliusd#\d{4}-\d{2}$/.test(row.monthly_key))throw new Error('Assistant reservation state is invalid');
      const refund=row.reserved_units-billedMilliusd;
      if(refund){const changed=await client.query('UPDATE market_lab.quotas SET used=used-$2 WHERE key=$1 AND used>=$2 AND expires_at>clock_timestamp() RETURNING used',[row.monthly_key,refund]);
        if(!changed.rowCount)throw conflict('Assistant allowance changed before settlement');}
      await client.query("UPDATE market_lab.records SET payload=payload||$2::jsonb WHERE pk=$1 AND sk='value'",['assistant-reservation#'+id,
        JSON.stringify({state:'settled',billed_units:billedMilliusd,settled_at:new Date().toISOString(),cost_basis:'completed-model-usage estimate'})]);
      return {reservation_id:id,billed_units:billedMilliusd,refunded_units:refund,already_settled:false};
    });
  }
  async function acquireLease(key,seconds) {
    if(!Number.isFinite(seconds)||seconds<=0)throw new RangeError('Invalid lease duration');
    const owner=randomUUID();
    const r=await db.query(`INSERT INTO market_lab.leases(key,owner,expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires_at=clock_timestamp()+$3*interval '1 second' WHERE market_lab.leases.expires_at<=clock_timestamp() RETURNING owner`,[key,owner,seconds]);
    if(!r.rowCount)return null;
    return {key,owner,release:async()=>{await db.query('DELETE FROM market_lab.leases WHERE key=$1 AND owner=$2',[key,owner]);}};
  }
  async function lease(key,seconds=30) {
    return (await acquireLease(key,seconds))?.release||null;
  }
  async function publishWhileLeased(lock,item){
    const expiry=Number.isFinite(item.expires_epoch)?new Date(item.expires_epoch*1000):null;
    const result=await db.query(`WITH locked AS MATERIALIZED(
      SELECT owner,expires_at FROM market_lab.leases WHERE key=$5 FOR UPDATE
    ),authorized AS MATERIALIZED(
      SELECT 1 FROM locked WHERE owner=$6 AND expires_at>clock_timestamp()
    ),written AS(
      INSERT INTO market_lab.records AS retained(pk,sk,payload,expires_at)
      SELECT $1,$2,$3::jsonb,$4::timestamptz FROM authorized
      ON CONFLICT(pk,sk) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at
      WHERE retained.payload IS DISTINCT FROM excluded.payload OR retained.expires_at IS DISTINCT FROM excluded.expires_at RETURNING pk
    ) SELECT EXISTS(SELECT 1 FROM authorized) AS authorized`,[item.pk,item.sk,JSON.stringify(item),expiry,lock.key,lock.owner]);
    if(!result.rows[0]?.authorized)throw Object.assign(new Error('This source refresh lost its lease; try again shortly'),{status:429,code:'CACHE_LEASE_LOST'});
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
    const lock=await acquireLease(pk,25);
    if(!lock) {
      for(let i=0;i<10;i++) { await new Promise(r=>setTimeout(r,150)); const hit=await get(pk); if(hit)return hit.value; }
      throw Object.assign(new Error('This source is refreshing; try again shortly'),{status:429,code:'CACHE_LEASE_BUSY'});
    }
    try {
      const refreshed=await get(pk);if(refreshed)return refreshed.value;
      if(!await consume('upstream#'+new Date().toISOString().slice(0,10),12000))throw Object.assign(new Error('Daily source-read allowance reached'),{status:429});
      const value=await producer({publishRecord:item=>publishWhileLeased(lock,item)});
      await publishWhileLeased(lock,{pk,sk:'value',value,expires_epoch:Math.floor(Date.now()/1000)+seconds});return value;
    }catch(error){
      if(error.code==='CACHE_LEASE_LOST'){const fresh=await get(pk);if(fresh)return fresh.value;}
      throw error;
    }finally{await lock.release();}
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
  async function searchMarkets(query,{limit=30}={}){
    if(typeof query!=='string'||query.trim().length<2||query.length>200||!Number.isInteger(limit)||limit<1||limit>50)throw new RangeError('Search needs 2–200 characters and a limit from 1 through 50');
    const result=await db.query(`WITH term AS(SELECT websearch_to_tsquery('english',$1) AS query),matches AS(
      SELECT m.ticker,m.title,m.outcome_label,m.category,m.observed_at,m.yes_bid,m.yes_ask,m.close_time,m.quality_flags,
        b.provider,b.source_url,b.source_as_of,b.sha256,ts_rank_cd(m.search_document,term.query) AS rank,
        row_number() OVER(PARTITION BY m.ticker ORDER BY m.observed_at DESC) AS recency
      FROM market_lab.market_snapshots m JOIN market_lab.source_batches b ON b.id=m.batch_id CROSS JOIN term
      WHERE m.search_document@@term.query AND m.observed_at>now()-interval '7 days')
      SELECT ticker,title,outcome_label,category,observed_at,yes_bid::float8,yes_ask::float8,close_time,quality_flags,rank,
        jsonb_build_object('provider',provider,'url',source_url,'observed_at',source_as_of,'sha256',sha256) AS source
      FROM matches WHERE recency=1 ORDER BY rank DESC,observed_at DESC,ticker LIMIT $2`,[query.trim(),limit]);
    return {rows:result.rows,as_of:new Date().toISOString(),scope:'English full-text search across the last seven days of retained public market observations; nested source provenance is joined in one parameterized query. Not a complete exchange search.'};
  }
  async function listenJobs(onWake,onDisconnect=()=>{}){
    if(closePromise)throw new Error('The database store is closing');
    const listener=new pg.Client({connectionString,application_name:'market-lab-job-listener',connectionTimeoutMillis:10000,
      ...(remote?{ssl:{rejectUnauthorized:true,...(process.env.DATABASE_CA_CERT?{ca:process.env.DATABASE_CA_CERT}:{})}}:{})});
    let closing=false,reported=false,ended;
    const close=()=>{if(!ended){closing=true;listeners.delete(close);ended=listener.end().catch(()=>{});}return ended;};
    listeners.add(close);
    const disconnected=()=>{if(!closing&&!reported){reported=true;void close();onDisconnect();}};
    listener.on('error',disconnected);listener.on('end',disconnected);
    listener.on('notification',message=>{if(message.channel==='market_lab_jobs')onWake();});
    try{await listener.connect();await listener.query('LISTEN market_lab_jobs');}
    catch(error){await close();throw error;}
    if(closePromise){await close();throw new Error('The database store is closing');}
    return close;
  }
  function close(){if(!closePromise)closePromise=(async()=>{await Promise.all([...listeners].map(end=>end()));await db.end();})();return closePromise;}
  async function readOwnerPortfolio(owner){
    if(typeof owner!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner))throw new RangeError('Invalid portfolio owner');
    const row=(await db.query('SELECT ledger,watchlist,revision FROM market_lab.owner_portfolios WHERE owner_id=$1',[owner])).rows[0];
    return row?{...row,revision:Number(row.revision)}:{ledger:null,watchlist:[],revision:0};
  }
  async function saveOwnerPortfolio(owner,{ledger,watchlist,revision}){
    if(typeof owner!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(owner)||!Number.isSafeInteger(revision)||revision<0||revision>1e9||!ledger||Array.isArray(ledger)||typeof ledger!=='object'||!Array.isArray(watchlist)||watchlist.length>200||watchlist.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_.-]{1,140}$/.test(value)))throw new RangeError('Invalid owner portfolio');
    const row=revision===0?(await db.query(`INSERT INTO market_lab.owner_portfolios(owner_id,ledger,watchlist,revision) VALUES($1,$2,$3,1)
      ON CONFLICT(owner_id) DO NOTHING RETURNING ledger,watchlist,revision`,[owner,ledger,watchlist])).rows[0]:
      (await db.query('UPDATE market_lab.owner_portfolios SET ledger=$2,watchlist=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND revision=$4 RETURNING ledger,watchlist,revision',[owner,ledger,watchlist,revision])).rows[0];
    if(row)return {conflict:false,value:{...row,revision:Number(row.revision)}};
    return {conflict:true,value:await readOwnerPortfolio(owner)};
  }
  return {kind:'postgres',db,get,put:item=>save(item),save,consume,lease,archive,readArchive,cached,appendAudit,readAudit,auditIds,readOwnerPortfolio,saveOwnerPortfolio,
    journalRows,pendingRows,reschedule,settle,searchMarkets,listenJobs,reserveAssistantBudget,settleAssistantBudget,transaction,close};
}
