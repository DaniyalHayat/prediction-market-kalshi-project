import {createHash} from 'node:crypto';
import {store,cloudEnabled} from '../cloud/store.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active=()=>cloudEnabled()&&store().kind==='postgres'?store():null;

export async function publishDataset(provider,source,payload,rows,kind) {
  const s=active();if(!s)return {persisted:false,reason:'Relational history is not configured'};
  if(!source.url?.startsWith('https://')||!Array.isArray(rows))throw new RangeError('A source URL and typed rows are required');
  const digest=hash(payload),key=`sources/${provider}/${digest}.json`;
  const existing=await s.db.query('SELECT id FROM market_lab.source_batches WHERE provider=$1 AND sha256=$2',[provider,digest]);
  if(existing.rowCount)return {persisted:true,id:existing.rows[0].id,replayed:true};
  await s.archive(key,{source:source.url,source_as_of:source.as_of||null,payload});
  const observed=new Date().toISOString();
  return s.transaction(async c=>{
    const batch=await c.query(`INSERT INTO market_lab.source_batches(provider,source_url,source_as_of,sha256,archive_key,schema_version,row_count)
      VALUES($1,$2,$3,$4,$5,1,$6) ON CONFLICT(provider,sha256) DO NOTHING RETURNING id`,
      [provider,source.url,source.as_of||null,digest,key,rows.length]);
    if(!batch.rowCount)return {persisted:true,replayed:true};
    const id=batch.rows[0].id;
    if(kind==='markets') {
      if(new Set(rows.map(row=>row.ticker)).size!==rows.length)throw new Error('Duplicate contract keys in source batch');
      const values=rows.map(row=>({...row,observed_at:observed,
        yes_bid:row.catalog_quote_valid?row.yes_bid:null,yes_ask:row.catalog_quote_valid?row.yes_ask:null,
        quality_flags:row.catalog_quote_valid?[]:['invalid_or_missing_quote']}));
      await c.query(`INSERT INTO market_lab.market_snapshots(ticker,observed_at,event_ticker,title,outcome_label,category,yes_bid,yes_ask,volume_24h,close_time,batch_id,quality_flags)
        SELECT ticker,observed_at,event_ticker,title,yes_sub_title,category,yes_bid,yes_ask,volume_24h,close_time,$2,quality_flags
        FROM jsonb_to_recordset($1::jsonb) AS x(ticker text,observed_at timestamptz,event_ticker text,title text,yes_sub_title text,category text,
          yes_bid numeric,yes_ask numeric,volume_24h numeric,close_time timestamptz,quality_flags text[]) ON CONFLICT DO NOTHING`,[JSON.stringify(values),id]);
    } else if(kind==='sports') {
      if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error('Duplicate game keys in source batch');
      await c.query(`INSERT INTO market_lab.sports_games(provider,id,league,played_at,home_id,away_id,home_name,away_name,home_score,away_score,batch_id)
        SELECT $2,id,league,played_at,home_id,away_id,home_name,away_name,home_score,away_score,$3
        FROM jsonb_to_recordset($1::jsonb) AS x(id text,league text,played_at timestamptz,home_id text,away_id text,home_name text,away_name text,home_score int,away_score int)
        ON CONFLICT(provider,id) DO UPDATE SET home_score=excluded.home_score,away_score=excluded.away_score,batch_id=excluded.batch_id`,[JSON.stringify(rows),provider,id]);
    } else if(kind==='observations') {
      const identities=rows.map(r=>[r.entity,r.scope,r.metric,r.measurement_date].join('|'));
      if(new Set(identities).size!==rows.length||rows.some(r=>!Number.isFinite(r.value)||!r.unit||!/^\d{4}-\d{2}-\d{2}$/.test(r.measurement_date)))throw new Error('Observation grain or value validation failed');
      await c.query(`INSERT INTO market_lab.source_observations(provider,entity,scope,metric,measurement_date,value,unit,batch_id)
        SELECT $2,entity,scope,metric,measurement_date,value,unit,$3 FROM jsonb_to_recordset($1::jsonb)
        AS x(entity text,scope text,metric text,measurement_date date,value numeric,unit text)`,[JSON.stringify(rows),provider,id]);
    } else throw new RangeError('Unsupported dataset type');
    return {persisted:true,id,rows:rows.length};
  });
}

export async function retainMarketHistory(result) {
  const s=active();if(!s)return;
  const slot=Math.floor(Date.now()/900000);
  if(!await s.consume(`catalog-history#${result.category}#${slot}`,1,1,3600))return;
  const rows=result.markets.slice(0,40);
  return publishDataset('kalshi-'+result.category,{url:'https://external-api.kalshi.com/trade-api/v2/markets',as_of:result.as_of},rows,rows,'markets');
}
export async function chartHistory(provider,scope,metric,entity) {
  const s=active();if(!s)return [];
  const r=await s.db.query(`SELECT DISTINCT ON(o.measurement_date) o.measurement_date::text AS date,o.value::float8 AS value,
    b.ingested_at,b.source_as_of,b.source_url FROM market_lab.source_observations o JOIN market_lab.source_batches b ON b.id=o.batch_id
    WHERE o.provider=$1 AND o.scope=$2 AND o.metric=$3 AND o.entity=$4 ORDER BY o.measurement_date DESC,b.ingested_at DESC LIMIT 400`,[provider,scope,metric,entity]);
  return r.rows.reverse();
}
export async function warehouseStatus() {
  const s=active();if(!s)return {configured:false};
  const r=await s.db.query(`SELECT (SELECT count(*) FROM market_lab.source_batches)::int AS source_batches,
    (SELECT count(*) FROM market_lab.market_snapshots)::int AS market_observations,
    (SELECT count(*) FROM market_lab.source_observations)::int AS source_observations,
    (SELECT count(*) FROM market_lab.sports_games)::int AS completed_games,
    (SELECT max(ingested_at) FROM market_lab.source_batches) AS latest_ingestion`);
  return {configured:true,storage:'Supabase Postgres and private evidence storage',...r.rows[0]};
}
export async function marketAttribution(){
  const s=active();if(!s)return {rows:[],scope:'Relational history is not configured'};
  const result=await s.db.query('SELECT * FROM market_lab.market_attribution ORDER BY abs(observed_price_change) DESC NULLS LAST,last_observed DESC LIMIT 30');
  return {rows:result.rows,as_of:new Date().toISOString(),scope:'Seven-day observed exchange price changes and spreads. Requires at least two observations for a change. These are not causal explanations, strategy returns or realized P&L.'};
}
