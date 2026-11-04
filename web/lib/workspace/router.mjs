import {request,marketDetails,book,validateTicker,number,validQuote} from '../live.mjs';
import {marketFees} from '../cloud/resolve.mjs';
import {marketBrief} from '../intelligence/brief.mjs';
import {executionEstimate} from '../intelligence/math.mjs';
import {workspaceCatalog,workspaceMarkets,inferCategory} from './catalog.mjs';
import {retainMarketHistory,warehouseStatus,marketAttribution} from './warehouse.mjs';
import {sportsResearch} from './sports.mjs';
import {musicResearch,musicContract,chartPosts} from './music.mjs';
import {providerStatus,boundedMap} from './providers.mjs';
const researchCache=new Map(),researchInflight=new Map();

export function candleRows(payload,end=Math.floor(Date.now()/1000)) {
  return (payload.candlesticks||[]).flatMap(row=>{
    const bid=number(row.yes_bid?.close_dollars),ask=number(row.yes_ask?.close_dollars);
    const direct=number(row.price?.close_dollars),time=number(row.end_period_ts);
    const value=direct!==null?direct:validQuote(bid,ask)?(bid+ask)/2:null;
    return time!==null&&value!==null&&value>=0&&value<=1&&time<=end?
      [{time:new Date(time*1000).toISOString(),value,volume:number(row.volume_fp),value_kind:direct!==null?'last_trade':'quoted_midpoint'}]:[];
  });
}
export async function contractHistory(ticker,hours=24) {
  validateTicker(ticker);
  if(![24,168].includes(hours))throw new RangeError('Choose 24 hours or seven days');
  const series={ticker:ticker.split('-')[0]};
  const end=Math.floor(Date.now()/1000),period=hours===24?1:60;
  const result=await request(`/series/${series.ticker}/markets/${ticker}/candlesticks`,{
    start_ts:String(end-hours*3600),end_ts:String(end),period_interval:String(period)});
  const rows=candleRows(result.data,end);
  return {ticker,rows,as_of:result.as_of,source_url:result.source_url,scope:'Returned exchange candle closes; missing observations are not filled'};
}

export function screenSportsForecast(market,forecast,depth,{coefficient=.07,feeVerified=false,coverage=null,mappingReason=null,now=Date.now()}={}) {
  const reasons=[],candidates=[],valid=Number.isFinite(forecast?.probability)&&Array.isArray(forecast?.interval)&&forecast.interval.length===2&&
    forecast.interval.every(Number.isFinite)&&forecast.interval[0]>=0&&forecast.interval[0]<=forecast.probability&&forecast.interval[1]>=forecast.probability&&forecast.interval[1]<=1;
  if(!valid)reasons.push('The exact event and YES outcome lack a usable independent estimate.');
  const released=forecast?.eligible&&coverage?.partial!==true&&!mappingReason;
  if(valid&&!released){
    if(forecast.validation?.passed!==true)reasons.push('The matchup model has not passed its chronological holdout release requirements.');
    if(coverage?.partial){
      const count=Number.isInteger(coverage.schedules_returned)&&Number.isInteger(coverage.schedules_expected)?`only ${coverage.schedules_returned} of ${coverage.schedules_expected} schedule sources are available`:'schedule source coverage is incomplete';
      reasons.push(`${forecast.validation?.passed===true?'The historical holdout passed, but ':''}${count[0].toLowerCase()+count.slice(1)}. The screen is withheld until source coverage is complete.`);
    }
    if(mappingReason)reasons.push(mappingReason);
    if(!reasons.length)reasons.push('The exact event or source coverage has not met all release requirements.');
  }
  const age=now-Date.parse(depth?.as_of||''),sourceAge=now-Date.parse(forecast?.source_as_of||'');
  const fresh=Number.isFinite(age)&&age>=-5000&&age<=90000,sourceFresh=Number.isFinite(sourceAge)&&sourceAge>=-60000&&sourceAge<=86400000;
  if(!fresh)reasons.push('A matching order book less than 90 seconds old is required.');
  if(valid&&!sourceFresh)reasons.push('The independent data retrieval is stale or missing.');
  const open=['active','open'].includes(market.status)&&Date.parse(market.close_time)>now;
  if(!open)reasons.push('The exchange contract is not confirmed open before close.');
  if(depth?.ticker!==market.ticker)reasons.push('The order book does not match the selected contract.');
  if(valid&&depth?.raw&&depth.ticker===market.ticker)for(const side of ['yes','no']){
    try {
      const execution=executionEstimate(depth.raw,side,1,2,coefficient),probability=side==='yes'?forecast.probability:1-forecast.probability;
      const lower=side==='yes'?forecast.interval[0]:1-forecast.interval[1],cost=execution.breakeven;
      candidates.push({side,probability,lower_probability:lower,execution,expected_edge:cost===null?null:probability-cost,
        conservative_edge:cost===null?null:lower-cost-.02,eligible:released&&fresh&&sourceFresh&&open&&execution.unfilled===0&&execution.filled===1});
    }catch{reasons.push('The public book could not support a valid cost estimate.');}
  }
  const best=candidates.filter(c=>c.eligible&&c.conservative_edge>0).sort((a,b)=>b.conservative_edge-a.conservative_edge)[0];
  if(!best&&!reasons.length)reasons.push('Neither side clears filled-book costs, fees and the extra 2¢ buffer at the model range lower bound.');
  return {side:best?.side||'insufficient_edge',label:best?best.side.toUpperCase()+' · research hypothesis':'Insufficient supported edge',
    conservative_edge:best?.conservative_edge??null,expected_edge:best?.expected_edge??null,reasons,candidates,
    assumptions:{contracts:1,slippage_cents:2,fee_coefficient:coefficient,uncertainty_buffer:.02,
      fee_note:feeVerified?'General taker formula with the exchange series multiplier; individual-market exceptions still require inspection.':'Explicit general taker-fee assumption; a market-specific schedule was not verified.'},
    validation_note:'A historical team-strength holdout and parameter range do not establish calibrated contract uncertainty, injury effects, profitable fills or optimal real-world trades. Position size remains conditional on your own budget and assumptions.'};
}
export async function workspaceResearch(ticker,{fast=false,assistant=false}={},dependencies={}) {
  validateTicker(ticker);
  const key=ticker+'#'+(fast?'fast':assistant?'assistant':'full'),useCache=!Object.keys(dependencies).length,hit=researchCache.get(key);
  if(useCache&&hit&&hit.until>Date.now())return hit.value;
  if(useCache&&researchInflight.has(key))return researchInflight.get(key);
  const deps={marketDetails,book,marketBrief,marketFees,sportsResearch,musicResearch,chartPosts,...dependencies};
  const task=(async()=>{
    const detail=await deps.marketDetails(ticker),market=detail.market;
    if(market?.ticker!==ticker)throw new Error('Research identity does not match the selected contract');
    const depthPromise=deps.book(ticker,1).catch(()=>null),feesPromise=deps.marketFees(ticker).catch(()=>null);
    const briefPromise=deps.marketBrief(ticker,{contracts:1},{marketDetails:async()=>detail,book:()=>depthPromise,
      ...((fast||assistant)?{headlines:async()=>({status:'not_queried',articles:[],reason:'Headline retrieval is omitted from compact research.'})}:{})});
    const sportsPromise=deps.sportsResearch(market,{includeAvailability:!fast&&!assistant}).catch(error=>({reason:error.message,error:true}));
    const musicPromise=!fast?deps.musicResearch(market,{includeSpotify:!assistant}).catch(error=>({forecast:{probability:null,reason:error.message},error:true})):null;
    const postsPromise=!fast&&!assistant&&musicContract(market)?deps.chartPosts().catch(error=>({status:'unavailable',posts:[],reason:error.message})):null;
    const [brief,depth,fees,sports,music,posts]=await Promise.all([briefPromise,depthPromise,feesPromise,sportsPromise,musicPromise,postsPromise]);
    let forecast=brief.forecast,decision=brief.decision,summary=brief.summary,status=brief.status;
    const errors=[...(brief.errors||[])];
    if(sports?.error)errors.push({source:'Sports evidence',error:sports.reason});
    if(sports?.forecast){
      forecast={...sports.forecast,evidence:{tier:sports.forecast.eligible?2:1,label:sports.forecast.eligible?'Chronological matchup holdout':sports.forecast.validation?.passed&&sports.coverage?.partial?'Holdout passed; source coverage incomplete':'Unvalidated matchup scenario'}};
      decision=screenSportsForecast(market,forecast,depth,{coefficient:Number.isFinite(fees?.coefficient)?fees.coefficient:.07,feeVerified:Number.isFinite(fees?.coefficient),coverage:sports.coverage,mappingReason:sports.reason});
      status='modeled';summary=`The matched-event historical team model estimates ${(forecast.probability*100).toFixed(1)}% YES. Its displayed range is parameter uncertainty or sensitivity, not a calibrated injury-adjusted outcome interval. ${decision.reasons[0]||'The conservative screen clears assumed entry costs; this remains a research hypothesis.'}`;
    }
    const side=['yes','no'].includes(decision.side)?decision.side.toUpperCase():'PASS';
    const value={...brief,forecast,decision,summary,status,
      opinion:{side,reason:decision.reasons?.[0]||(side==='PASS'?'No supported cost advantage was established.':'The modeled conservative bound clears one-contract entry costs; inspect validation and assumptions.'),
        basis:'Independent-data research screen; conditional paper sizing is available in Paper position.',supported_allocation:side==='PASS'?0:null},
      extensions:{...(sports?{sports}:{}),...(music?{music}:{}),...(posts?{posts:posts.posts,post_status:posts.status,post_note:posts.note}: {})},
      sources:[...(brief.sources||[]),...(sports?.sources||[]),...(music?.sources||[])],errors};
    if(useCache){if(researchCache.size>=512)researchCache.delete(researchCache.keys().next().value);researchCache.set(key,{until:Date.now()+30000,value});}
    return value;
  })();
  if(useCache)researchInflight.set(key,task);
  try{return await task;}finally{if(useCache)researchInflight.delete(key);}
}
export async function workspaceOpinions(raw,{research=workspaceResearch}={}) {
  if(typeof raw!=='string'||raw.length>1200)throw new RangeError('Supply one to eight exact tickers');
  const tickers=[...new Set(raw.split(',').filter(Boolean))];
  if(!tickers.length||tickers.length>8)throw new RangeError('Supply one to eight exact tickers');
  tickers.forEach(validateTicker);
  const opinions=await boundedMap(tickers,2,async ticker=>{
    try {const value=await research(ticker,{fast:true});return {ticker,...value.opinion,probability:value.forecast?.probability??null,
      interval:value.forecast?.interval??null,as_of:value.as_of,model:value.forecast?.model_name||null};}
    catch{return {ticker,side:'PASS',reason:'Current research could not be verified. Open the contract to retry.',supported_allocation:0};}
  });
  return {opinions,as_of:new Date().toISOString(),scope:'Compact deterministic screens. Headlines, paid X reads, Spotify references and availability retrieval are omitted.'};
}

export async function workspaceGET(endpoint,params) {
  if(endpoint==='workspace/catalog')return workspaceCatalog();
  if(endpoint==='workspace/markets') {
    const value=await workspaceMarkets(params.get('category')||'sports');
    try{value.persistence=await retainMarketHistory(value);}catch{value.persistence={persisted:false,reason:'History publication is delayed'};}
    return value;
  }
  if(endpoint==='workspace/context') {
    const ticker=validateTicker(params.get('ticker'));
    const [detail,profile,fees]=await Promise.all([marketDetails(ticker),request('/series/'+ticker.split('-')[0]).catch(()=>null),marketFees(ticker).catch(()=>null)]);
    return {ticker,market:{...detail.market,category:inferCategory(detail.market,profile?[profile.data.series]:[])},fees,as_of:detail.as_of,source_url:detail.source_url};
  }
  if(endpoint==='workspace/history')return contractHistory(params.get('ticker'),Number(params.get('hours')||24));
  if(endpoint==='workspace/research')return workspaceResearch(validateTicker(params.get('ticker')));
  if(endpoint==='workspace/opinions')return workspaceOpinions(params.get('tickers'));
  if(endpoint==='workspace/attribution')return marketAttribution();
  if(endpoint==='workspace/sources')return {warehouse:await warehouseStatus(),providers:providerStatus(),as_of:new Date().toISOString()};
  throw Object.assign(new Error('Unknown workspace route'),{status:404});
}
