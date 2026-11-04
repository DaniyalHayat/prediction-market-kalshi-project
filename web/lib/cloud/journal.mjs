import {createHash,randomUUID} from 'node:crypto';
import {store} from './store.mjs';
import {marketDetails,book,validateTicker} from '../live.mjs';

const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export function binaryOutcome(market) {
  return ['settled','finalized'].includes(market.status)&&['yes','no'].includes(market.result)?Number(market.result==='yes'):null;
}
export function ownerKey(token) {
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new RangeError('Use a browser-generated 256-bit journal token');
  return 'journal#'+hash(token);
}
export function scoreForecast(frozen,outcome) {
  if(![0,1].includes(outcome))throw new RangeError('A binary settled outcome is required');
  const p=frozen.probability,baseline=frozen.market_midpoint;
  return {outcome,brier:(p-outcome)**2,market_brier:baseline===null?null:(baseline-outcome)**2,
    log_loss:-(outcome*Math.log(Math.max(p,1e-12))+(1-outcome)*Math.log(Math.max(1-p,1e-12))),
    log_loss_floor:1e-12};
}
export function validatePrediction(input) {
  if(!input||typeof input!=='object')throw new RangeError('Supply prediction inputs');
  validateTicker(input.ticker);
  const values=[input.probability,input.probability_low,input.probability_high];
  if(!values.every(x=>typeof x==='number'&&Number.isFinite(x))||values[1]<0||values[2]>1||values[0]<values[1]||values[0]>values[2])throw new RangeError('Probability must lie inside supplied bounds between zero and one');
  return input;
}
export async function freezeForecast(input,token) {
  const pk=ownerKey(token);validatePrediction(input);
  const {market,as_of,source_url}=await marketDetails(input.ticker);
  if(!['open','active'].includes(market.status)||Date.parse(market.close_time)<=Date.now())throw new RangeError('Choose an open market that has not closed');
  const depth=await book(input.ticker,1),fp=depth.raw.orderbook_fp;
  const yes=fp.yes_dollars||[],no=fp.no_dollars||[];
  const bid=yes.length?Math.max(...yes.map(r=>Number(r[0]))):null;
  const ask=no.length?1-Math.max(...no.map(r=>Number(r[0]))):null;
  const id=randomUUID(),created=new Date().toISOString();
  if(Date.parse(market.close_time)<=Date.now())throw new RangeError('Market closed while obtaining its quote');
  const frozen={id,ticker:input.ticker,title:market.title,created_at:created,close_time:market.close_time,
    probability:input.probability,probability_low:input.probability_low,probability_high:input.probability_high,
    market_midpoint:bid!==null&&ask!==null&&bid<=ask?(bid+ask)/2:null,
    rules_primary:market.rules_primary||null,rules_secondary:market.rules_secondary||null,
    quote_as_of:depth.as_of,market_as_of:as_of,source_url,raw_book:depth.raw,
    probability_basis:'User-supplied assessment; not a trained or calibrated model probability',
    interpretation:'Prospective probability record. Scoring waits for a binary exchange settlement; no profitability claim.'};
  const freeze_hash=hash(frozen),key=`forecasts/${id}/freeze-${freeze_hash}.json`;
  await store().archive(key,frozen);
  await store().put({pk,sk:'forecast#'+input.ticker,id,frozen,freeze_hash,status:'pending',
    pending_pk:'pending',pending_sk:market.close_time+'#'+id,expires_epoch:Math.floor(Date.now()/1000)+180*86400});
  return {id,frozen,freeze_hash,status:'pending'};
}
export async function listForecasts(token) {
  const pk=ownerKey(token),s=store();
  const r=await s.journalRows(pk);
  const records=r.items,settled=records.filter(r=>r.status==='settled');
  const grouped=new Map();
  for(const row of settled){const series=row.frozen.ticker.split('-')[0],items=grouped.get(series)||[];items.push(row);grouped.set(series,items);}
  const attribution=[...grouped].map(([series,items])=>({series,n:items.length,brier:items.reduce((s,r)=>s+r.score.brier,0)/items.length,
    baseline_brier:items.every(r=>r.score.market_brier!==null)?items.reduce((s,r)=>s+r.score.market_brier,0)/items.length:null}));
  return {records:records.map(({pk,sk,pending_pk,pending_sk,expires_epoch,...value})=>value),
    attribution,
    evaluation:{n:settled.length,brier:settled.length?settled.reduce((s,r)=>s+r.score.brier,0)/settled.length:null,
      baseline_brier:settled.length&&settled.every(r=>r.score.market_brier!==null)?settled.reduce((s,r)=>s+r.score.market_brier,0)/settled.length:null,
      note:'Only prospectively frozen, binary-settled records are scored. Pending records are retained; no retrospective predictions are inserted.'},
    partial:r.partial};
}
export async function settleDue(limit=24) {
  const s=store(),now=new Date().toISOString();
  const rows=await s.pendingRows(now,limit);
  const results=[];
  for(const row of rows) {
    try {
    const {market,as_of,source_url}=await marketDetails(row.frozen.ticker);
    const outcome=binaryOutcome(market);
    if(outcome===null) {
      await s.reschedule(row,new Date(Date.now()+3600000).toISOString()+'#'+row.id);
      results.push({id:row.id,status:'not_binary_settled'});continue;
    }
    const score=scoreForecast(row.frozen,outcome),settlement={checked_at:now,as_of,source_url,market,score,freeze_hash:row.freeze_hash};
    await s.archive(`forecasts/${row.id}/settlement-${hash(settlement)}.json`,settlement);
    await s.settle(row,score,as_of);
    results.push({id:row.id,status:'settled'});
    } catch(error) {
      results.push({id:row.id,status:error.name==='ConditionalCheckFailedException'?'already_updated':'retry_pending'});
    }
  }
  return results;
}
