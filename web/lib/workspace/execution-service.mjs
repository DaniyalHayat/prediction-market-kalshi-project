import {book,validateTicker} from '../live.mjs';
import {marketFees} from '../cloud/resolve.mjs';
import {marketFeed} from '../cloud/feed.mjs';
import {workspaceResearch} from './router.mjs';
import {usableForecast} from './positions.mjs';
import {executionResearch,normalizeExecutionControls} from './execution-research.mjs';

export function parseExecutionRequest(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['ticker','controls','model'].includes(key)))throw new RangeError('Review the execution lab request');
  const ticker=validateTicker(input.ticker),model=input.model??'baseline';
  if(!['baseline','validated','challenger'].includes(model))throw new RangeError('Unknown research model');
  return {ticker,controls:normalizeExecutionControls(input.controls),model:model==='validated'?'baseline':model};
}

export async function workspaceExecutionResearch(ticker,{controls={},model='baseline'}={},dependencies={}){
  const parsed=parseExecutionRequest({ticker,controls,model}),deps={book,workspaceResearch,marketFees,feed:marketFeed,now:Date.now,...dependencies};
  const [research,restDepth,fees]=await Promise.all([deps.workspaceResearch(ticker,{fast:true,model:parsed.model}),deps.book(ticker,1),deps.marketFees(ticker).catch(()=>null)]);
  if(research.ticker!==ticker||research.market?.ticker!==ticker||restDepth.ticker!==ticker)throw new RangeError('The execution inputs do not match the selected contract');
  const now=deps.now(),source=research.forecast||{},forecast={...usableForecast(research,now,ticker),source_as_of:source.source_as_of,validation:source.validation};
  const captured=deps.feed.researchSnapshot?.(ticker),rows=captured?.rows||deps.feed.observations?.(ticker)||[],lastRow=rows.at(-1),last=Date.parse(lastRow?.received_at||''),recent=Number.isFinite(last)&&last<=now+5000&&now-last<=90000;
  function matches(depth){
    try{const checked=globalThis.KalshiPaper.checkedBook(depth,ticker,{now}),bid=checked.yes[0],no=checked.no[0];
      return bid&&no&&Math.abs(lastRow.bid_price-bid.price)<1e-9&&Math.abs(lastRow.ask_price-(1-no.price))<1e-9&&Math.abs(lastRow.bid_size-bid.quantity)<1e-8&&Math.abs(lastRow.ask_size-no.quantity)<1e-8;
    }catch{return false;}
  }
  const native=recent&&captured?.connected===true&&captured.book?.ticker===ticker&&captured.book.sequence===lastRow.exchange_sequence&&matches(captured.book);
  const depth=native?captured.book:restDepth,aligned=recent&&(captured?native:matches(depth)),history=aligned?rows:[],feeVerified=Number.isFinite(fees?.coefficient)&&fees.coefficient>=0&&fees.coefficient<=1,coefficient=feeVerified?fees.coefficient:.07;
  const result=executionResearch({market:research.market,book:depth,forecast,book_history:history,observation_end_seconds:native?captured.observed_until_seconds:undefined,controls:parsed.controls,fee_coefficient:coefficient,now});
  return {...result,ticker,title:research.market.yes_sub_title||research.title||research.market.title,as_of:new Date(now).toISOString(),book_as_of:depth.as_of,
    forecast:{...result.forecast,eligible:forecast.eligible,experimental:forecast.experimental,release_reason:forecast.reason},
    data_quality:{...result.data_quality,gaps:[...(result.data_quality?.gaps||[]),...(!aligned?[recent?'The current book and event window are unaligned; live flow adjustments are withheld.':'A recent continuous stream window is unavailable; live flow adjustments are withheld.']:[])]},
    fee_schedule:{status:feeVerified?'series_coefficient_available':'assumed_default',coefficient,
      note:feeVerified?'Uses the reported series coefficient with the modeled taker formula; individual market exceptions are not verified.':'The current fee coefficient could not be verified. A 0.07 general taker assumption is used for this scenario.'},
    assumptions:{...result.assumptions,fees:feeVerified?'Reported series coefficient; observed-depth quotes use per-level cent rounding. Market-specific exceptions remain unverified.':'Assumed general 0.07 coefficient because current fee metadata is unavailable or unsupported. This is not a verified fee quote.'},
    settlement:feeVerified?result.settlement:{...result.settlement,decision:'REVIEW',fee_verified:false,reason:'Current fee metadata is unverified. The hold-versus-exit result is an assumption-based scenario; a released decision is withheld.'},
    immediate_execution:{...result.immediate_execution,side:parsed.controls.side,action:parsed.controls.action,fee_coefficient:coefficient,slippage_cents:2,
      unit:'USD and contract quantities',scope:'Current visible depth and per-level modeled taker fees; a snapshot estimate, not a guaranteed fill.'},
    live_history:{status:aligned&&history.length>1?'observed':recent&&!aligned?'unaligned':'collecting',observations:history.length,capacity:1024,analysis_limit:512,book_source:native?'aligned_native_stream':'REST',
      sampling:'Every validated order-book message before browser throttling, while this backend has an active subscription. The subscription explicitly requests non-conflated updates. A replacement snapshot, one-sided book or connection gap starts a new generation.',
      clock:'Local monotonic receipt time; arrival clustering describes quote updates, not trade or news arrival intensity.',
      reason:recent&&!aligned?'The current book does not match the retained event window. Flow adjustments are withheld until an aligned sequence is available.':recent?null:'No recent continuous live sequence is retained for this exact contract. Open live streaming and rerun after updates arrive.'},
    account_balances_available:false,paper_only:true,independent_forecast_unchanged:true,
    sources:[{label:'Kalshi public order book',url:depth.source_url,as_of:depth.as_of},...(research.sources||[]).filter(row=>typeof row.url==='string'&&!row.url.includes('api.spotify.com')).slice(0,3)],
    scope:'Separate experimental execution and risk model. It cannot place orders, read balances or replace the released outcome forecast.'};
}

export function executionToolPacket(value){
  const arrival=value.arrival_model?{...value.arrival_model}:undefined;
  if(arrival){delete arrival.events;delete arrival.residuals;delete arrival.intensities;delete arrival.optimization_trace;}
  const flow=value.order_flow?{...value.order_flow}:undefined;
  if(flow){delete flow.rows;delete flow.observations;delete flow.training_rows;delete flow.test_rows;}
  const schedule=value.schedule?{...value.schedule,rows:value.schedule.rows?.slice(0,24),rows_shown:Math.min(value.schedule.rows?.length||0,24),rows_total:value.schedule.rows?.length||0}:undefined;
  if(schedule?.benchmark_twap){schedule.benchmark_twap={...schedule.benchmark_twap};delete schedule.benchmark_twap.rows;}
  return {...value,arrival_model:arrival,order_flow:flow,schedule};
}
