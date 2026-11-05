import {request,marketDetails,book,batchBooks,validateTicker,number,validQuote} from '../live.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {marketFees} from '../cloud/resolve.mjs';
import {marketBrief} from '../intelligence/brief.mjs';
import {executionEstimate} from '../intelligence/math.mjs';
import {workspaceCatalog,categorySnapshot,inferCategory,inferResearchFamily} from './catalog.mjs';
import {warehouseStatus,marketAttribution,searchPublicMarkets} from './warehouse.mjs';
import {sportsResearch} from './sports.mjs';
import {musicResearch} from './music.mjs';
import {contractEvidence} from './evidence.mjs';
import {retainPublicEvidence,searchRetainedEvidence,embeddingStatus} from './semantic.mjs';
import {providerStatus,boundedMap} from './providers.mjs';
import {tradeCandidates,rankCandidates} from './recommendations.mjs';
import {paperScenarios,rankPaperScenarios} from './paper-scenario.mjs';
import {marketSignal} from './market-signal.mjs';
import {settlementCalibrationDiagnostic} from './settlement-calibration.mjs';
import settlementValidation from '../../public/research/settlement-calibration.json' with {type:'json'};
const researchCache=new Map(),researchInflight=new Map();
const scanCache=new Map(),scanInflight=new Map();
const evidenceCache=new Map(),evidenceInflight=new Map();
function modelChoice(model='baseline'){
  if(!['baseline','validated','challenger'].includes(model))throw new RangeError('Choose the validated baseline or experimental challenger');
  return model==='validated'?'baseline':model;
}

export function candleRows(payload,end=Math.floor(Date.now()/1000)) {
  return (payload.candlesticks||[]).flatMap(row=>{
    const bid=number(row.yes_bid?.close_dollars),ask=number(row.yes_ask?.close_dollars);
    const direct=number(row.price?.close_dollars),time=number(row.end_period_ts);
    const midpoint=validQuote(bid,ask)?(bid+ask)/2:null;
    const value=direct!==null?direct:midpoint;
    return time!==null&&value!==null&&value>=0&&value<=1&&time<=end?
      [{time:new Date(time*1000).toISOString(),value,volume:number(row.volume_fp),value_kind:direct!==null?'last_trade':'quoted_midpoint',midpoint}]:[];
  });
}
export async function contractHistory(ticker,hours=24) {
  validateTicker(ticker);
  if(![24,168].includes(hours))throw new RangeError('Choose 24 hours or seven days');
  const series={ticker:ticker.split('-')[0]};
  const period=hours===24?1:60,end=Math.floor(Date.now()/(period*60000))*period*60;
  const result=await request(`/series/${series.ticker}/markets/${ticker}/candlesticks`,{
    start_ts:String(end-hours*3600),end_ts:String(end),period_interval:String(period)});
  const rows=candleRows(result.data,end);
  const history={ticker,rows,as_of:result.as_of,source_url:result.source_url,scope:'Exchange candle closes. Missing intervals are left blank.'};
  return hours===24?{...history,market_signal:marketSignal(history)}:history;
}

export function screenSportsForecast(market,forecast,depth,{coefficient=.07,feeVerified=false,coverage=null,mappingReason=null,now=Date.now()}={}) {
  if(forecast?.outcomes)return {side:'insufficient_edge',label:'See the paper scenario',reasons:['The paper scenario prices the $0.50 tie separately from a win.'],candidates:[]};
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
export async function workspaceResearch(ticker,{fast=false,assistant=false,model='baseline',evidence=false}={},dependencies={}) {
  validateTicker(ticker);
  model=modelChoice(model);
  const key=ticker+'#'+model+'#'+(fast?'fast':assistant?'assistant':'full')+'#'+Number(evidence),useCache=!Object.keys(dependencies).length,hit=researchCache.get(key);
  if(useCache&&hit&&hit.until>Date.now())return hit.value;
  if(useCache&&researchInflight.has(key))return researchInflight.get(key);
  const deps={marketDetails,book,marketBrief,marketFees,sportsResearch,musicResearch,contractHistory,...dependencies};
  const task=(async()=>{
    const detail=await deps.marketDetails(ticker),market=detail.market;
    if(market?.ticker!==ticker)throw new Error('Research identity does not match the selected contract');
    const depthPromise=deps.book(ticker,1).catch(()=>null),feesPromise=deps.marketFees(ticker).catch(()=>null);
    const briefPromise=deps.marketBrief(ticker,{contracts:1},{marketDetails:async()=>detail,book:()=>depthPromise,
      ...((fast||assistant||!evidence)?{headlines:async()=>({status:'not_queried',articles:[],reason:'Use Load contract news for explicit evidence retrieval.'})}:{})});
    const sportsPromise=deps.sportsResearch(market,{includeAvailability:!fast&&!assistant}).catch(()=>({reason:'Matched sports evidence could not be refreshed. Its source or shared cache is temporarily unavailable.',error:true}));
    const musicPromise=!fast?deps.musicResearch(market,{includeSpotify:!assistant,includeAlternatives:evidence&&!assistant}).catch(error=>({forecast:{probability:null,reason:error.message},error:true})):null;
    const signalPromise=assistant&&(!Object.keys(dependencies).length||dependencies.contractHistory)?
      deps.contractHistory(ticker).then(history=>history.market_signal).catch(()=>null):null;
    const [brief,depth,fees,sports,music,market_signal]=await Promise.all([briefPromise,depthPromise,feesPromise,sportsPromise,musicPromise,signalPromise]);
    let forecast=brief.forecast,decision=brief.decision,summary=brief.summary,status=brief.status;
    const errors=[...(brief.errors||[])];
    if(sports?.error){errors.push({source:'Sports evidence',error:sports.reason});forecast={probability:null};decision={...decision,side:'insufficient_edge',reasons:[sports.reason]};summary=sports.reason;status='unavailable';}
    const alternative=model==='challenger'&&sports?.challenger?.available?sports.challenger:null;
    if(sports?.forecast||alternative){
      const selected=alternative?{...(sports.forecast||{}),...alternative}:sports.forecast;
      forecast={...selected,evidence:{tier:selected.eligible?2:1,label:alternative&&!selected.eligible?(selected.inplay?'Experimental score-clock model':'Experimental calibrated ensemble'):selected.eligible?'Chronological matchup holdout':selected.validation?.passed&&sports.coverage?.partial?'Holdout passed; source coverage incomplete':'Unvalidated matchup scenario'}};
      decision=screenSportsForecast(market,forecast,depth,{coefficient:Number.isFinite(fees?.coefficient)?fees.coefficient:.07,feeVerified:Number.isFinite(fees?.coefficient),coverage:sports.coverage,mappingReason:sports.reason});
      if(alternative&&!alternative.eligible)decision.reasons.unshift(alternative.promotion_reason||'The experimental model has not passed its promotion gate.');
      status='modeled';summary=forecast.outcomes?
        `${forecast.model_name} estimates a ${(forecast.probability*100).toFixed(1)}% win chance for the YES team. The paper scenario includes the $0.50 tie payout.`:
        `${forecast.model_name||'The matchup model'} estimates ${(forecast.probability*100).toFixed(1)}% YES. ${decision.reasons[0]||'The lower end of the model range clears the modeled entry cost and buffer.'}`;
    }
    else if(sports?.league&&!sports.error){
      const started=sports.event&&Date.parse(sports.event.played_at)<=Date.now(),completed=sports.event?.completed;
      const reason=sports.reason||(completed?'This matched game is complete. A new pregame trade estimate is not produced.':started?'This matched game has started. The validated pregame model is withheld after tip-off. '+(sports.challenger?.available&&sports.challenger?.inplay?'A separately labeled experimental score-clock view is available, but its recommendation promotion gate has not passed.':'No released live estimate is available for this event.'):'The fixture is matched, but an independent matchup estimate is unavailable. '+(sports.model?.validation?.reason||'Check model and source coverage.'));
      forecast={probability:null,interval:null,model_name:null,reason,evidence:{tier:0,label:started?'Pregame estimate withheld after start':'Matched sports estimate unavailable'}};
      decision={...decision,side:'insufficient_edge',reasons:[reason],candidates:[]};summary=reason;status='evidence_only';
    }
    const side=['yes','no'].includes(decision.side)?decision.side.toUpperCase():'PASS';
    const value={...brief,forecast,decision,summary,status,market_signal,fee_coefficient:fees?.coefficient??null,quote_as_of:depth?.as_of,model_selection:{requested:model,applied:alternative?'challenger':'baseline',reason:model==='challenger'&&!alternative?'An audited challenger is unavailable for this exact contract; baseline research is shown.':null},
      opinion:{side,reason:decision.reasons?.[0]||(side==='PASS'?'No supported cost advantage was established.':'The modeled conservative bound clears one-contract entry costs; inspect validation and assumptions.'),
        basis:'Independent-data research screen; conditional paper sizing is available in Paper position.',supported_allocation:side==='PASS'?0:null},
      extensions:{...(sports?{sports}:{}),...(music?{music}:{}),post_status:'not_queried',post_note:'Public social feeds are loaded only by the selected-contract evidence action.'},
      sources:[...(brief.sources||[]),...(sports?.sources||[]),...(music?.sources||[])],errors};
    value.paper_scenarios=paperScenarios(market,depth,value,{coefficient:fees?.coefficient??.07});
    const quote=value.paper_scenarios.find(row=>row.side==='YES')?.quote_reference;
    value.settlement_diagnostic=settlementCalibrationDiagnostic(quote,settlementValidation,inferCategory(market));
    if(useCache){if(researchCache.size>=512)researchCache.delete(researchCache.keys().next().value);researchCache.set(key,{until:Date.now()+(forecast?.inplay?5000:30000),value});}
    return value;
  })();
  if(useCache)researchInflight.set(key,task);
  try{return await task;}finally{if(useCache)researchInflight.delete(key);}
}
export async function workspaceEvidence(ticker,{reddit=false,includeX=false,model='baseline',preview=false}={},dependencies={}){
  validateTicker(ticker);model=modelChoice(model);
  if(typeof reddit!=='boolean'||typeof includeX!=='boolean')throw new RangeError('Evidence source toggles must be booleans');
  const deps={marketDetails,request,contractEvidence,retainPublicEvidence,...dependencies},key=[ticker,model,Number(reddit),Number(includeX),Number(preview)].join('#'),useCache=!Object.keys(dependencies).length,hit=evidenceCache.get(key);
  if(useCache&&hit&&hit.until>Date.now())return hit.value;
  if(useCache&&evidenceInflight.has(key))return evidenceInflight.get(key);
  const task=(async()=>{
    const {market}=await deps.marketDetails(ticker);
    if(market?.ticker!==ticker)throw new Error('Evidence identity does not match the selected contract');
    const series=[market.series_ticker,market.series,market.event_ticker?.split('-')[0],ticker.split('-')[0]]
      .find(value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,140}$/.test(value)&&!value.includes('..'));
    const settlementSources=Promise.race([deps.request('/series/'+encodeURIComponent(series))
      .then(result=>result.data?.series?.settlement_sources||[]).catch(()=>[]),delay(1000,[],{ref:false})]);
    const recent=['full','assistant','fast'].map(mode=>researchCache.get([ticker,model,mode,0].join('#')))
      .find(entry=>entry?.until>Date.now())?.value;
    const value=await deps.contractEvidence(market,{enabled:true,selectedTicker:ticker,redditEnabled:reddit,includeX,
      sports:recent?.extensions?.sports,music:recent?.extensions?.music,settlementSources,headlineMode:preview?'official':'full'});
    const retention=preview?null:await deps.retainPublicEvidence(market,value,{enabled:true,selectedTicker:ticker,deferEmbedding:true})
      .catch(()=>({status:'unavailable',reason:'Evidence remains readable; retained search is temporarily unavailable.'}));
    const result=retention?{...value,retention}:value;
    if(useCache){if(evidenceCache.size>=100)evidenceCache.delete(evidenceCache.keys().next().value);evidenceCache.set(key,{until:Date.now()+60000,value:result});}
    return result;
  })();
  if(useCache)evidenceInflight.set(key,task);try{return await task;}finally{if(useCache)evidenceInflight.delete(key);}
}
export async function workspaceOpinions(raw,{research=workspaceResearch,model='baseline'}={}) {
  if(typeof raw!=='string'||raw.length>1200)throw new RangeError('Supply one to eight exact tickers');
  const tickers=[...new Set(raw.split(',').filter(Boolean))];
  if(!tickers.length||tickers.length>8)throw new RangeError('Supply one to eight exact tickers');
  tickers.forEach(validateTicker);
  const opinions=await boundedMap(tickers,2,async ticker=>{
    try {const value=await research(ticker,{fast:true,model:modelChoice(model)});return {ticker,...value.opinion,probability:value.forecast?.probability??null,
      interval:value.forecast?.interval??null,as_of:value.as_of,model:value.forecast?.model_name||null,
      source_as_of:value.forecast?.source_as_of,max_source_age_seconds:value.forecast?.max_source_age_seconds,inplay:Boolean(value.forecast?.inplay)};}
    catch{return {ticker,side:'PASS',reason:'Current research could not be verified. Open the contract to retry.',supported_allocation:0};}
  });
  return {opinions,as_of:new Date().toISOString(),scope:'Compact deterministic screens. Headlines, paid X reads, Spotify references and availability retrieval are omitted.'};
}

export async function workspaceRecommendations(category='sports',budget=20,model='baseline',dependencies={}) {
  model=modelChoice(model);
  if(!Number.isFinite(budget)||budget<1||budget>10000)throw new RangeError('Choose a paper budget from $1 to $10,000');
  const deps={markets:categorySnapshot,research:workspaceResearch,book,batchBooks,...dependencies};
  const useCache=!Object.keys(dependencies).length,key=category+'#'+model;
  const scan=async()=>{
    const list=await deps.markets(category),seen=new Set(),ordered=[...list.markets].sort((a,b)=>{
      const priority=m=>/^KXNFLGAME-/.test(m.ticker)?0:/^KX(?:NBA|EPL)GAME-/.test(m.ticker)||inferResearchFamily(m.ticker)?1:2;
      return priority(a)-priority(b)||(b.volume_24h||0)-(a.volume_24h||0);
    });
    const selected=[];for(const row of ordered){const event=row.event_ticker||row.ticker;if(!seen.has(event)){seen.add(event);selected.push(row);}if(selected.length>=12)break;}
    const researchByTicker=new Map();
    for(const {ticker} of selected)for(const mode of ['fast','full']){
      const cached=researchCache.get(ticker+'#'+model+'#'+mode+'#0');
      if(cached?.until>Date.now()&&!researchByTicker.has(ticker))researchByTicker.set(ticker,cached.value);
    }
    const probe=selected.filter(row=>!researchByTicker.has(row.ticker)&&(/^KX(?:NFL|NBA|EPL)GAME-/.test(row.ticker)||inferResearchFamily(row.ticker))).slice(0,3);
    let deadline;
    const budgetedResearch=Promise.race([Promise.allSettled(probe.map(async ({ticker})=>{
      const value=await deps.research(ticker,{fast:true,model});
      if(value?.market?.ticker===ticker)researchByTicker.set(ticker,value);
    })),new Promise(resolve=>{deadline=setTimeout(resolve,2500);})]).finally(()=>clearTimeout(deadline));
    const batch=selected.length?await deps.batchBooks(selected.map(row=>row.ticker)).catch(()=>new Map()):new Map();
    const missing=selected.filter(row=>!batch.has(row.ticker)).slice(0,3);
    await Promise.all([budgetedResearch,...missing.map(async ({ticker})=>{
      try{const depth=await deps.book(ticker,1);if(depth?.ticker===ticker)batch.set(ticker,depth);}catch{}
    })]);
    const rows=selected.map(market=>{
      const research=researchByTicker.get(market.ticker),depth=batch.get(market.ticker);
      return depth?{market:{...market,...research?.market},research,depth,fee_coefficient:research?.fee_coefficient}:
        {market,error:'A matching public book was unavailable for this scan.'};
    });
    return {rows,as_of:new Date().toISOString(),coverage:{catalog_contracts:list.markets.length,scanned_events:selected.length,maximum_events:12,
      books_returned:batch.size,model_checks:researchByTicker.size,catalog_partial:Boolean(list.partial),source_errors:list.errors||[],
      scope:'A bounded liquid-event scan with batch depth and up to three additional model checks.'}};
  };
  let data=useCache?scanCache.get(key):null;
  const lifetime=data?.rows.some(row=>row.research?.forecast?.inplay)?5000:30000;
  if(!data||Date.now()-Date.parse(data.as_of)>lifetime){
    let task=useCache?scanInflight.get(key):null;
    if(!task){task=scan();if(useCache)scanInflight.set(key,task);}
    try{data=await task;if(useCache){if(scanCache.size>=16)scanCache.delete(scanCache.keys().next().value);scanCache.set(key,data);}}
    finally{if(useCache)scanInflight.delete(key);}
  }
  const candidates=data.rows.flatMap(row=>row.error?[{ticker:row.market.ticker,title:row.market.title,event_ticker:row.market.event_ticker,side:'PASS',eligible:false,reasons:[row.error]}]:
    tradeCandidates(row.market,row.depth,row.research,{budget,coefficient:Number.isFinite(row.fee_coefficient)?row.fee_coefficient:.07,experimental:model==='challenger'})
      .map(value=>({...value,fee_source:Number.isFinite(row.fee_coefficient)?'series_metadata':'general_assumption'})));
  const result=rankCandidates(candidates,{experimental:model==='challenger'});
  const selectedEvents=new Set(result.candidates.map(row=>row.event_ticker||row.ticker));
  const scenarios=rankPaperScenarios(data.rows.flatMap(row=>row.error||selectedEvents.has(row.market.event_ticker||row.market.ticker)?[]:
    paperScenarios(row.market,row.depth,row.research,{budget,coefficient:row.fee_coefficient??.07})));
  return {...result,paper_scenarios:scenarios,as_of:data.as_of,budget,model,coverage:data.coverage,
    assumptions:{paper_only:true,independent_probability:true,entry_buffer_cents:2,slippage_cents:2,settlement_payout_per_contract:1,settlement_fee:0,quantity_step:1,fee_policy:'Series coefficient when supplied; otherwise the explicit general 0.07 assumption. Rounded per price level. Exchange billing can differ.',
      risk_size:{drawdown_floor:.8,drawdown_probability:.1},budget_scope:'Each row is a separate use of this budget; do not add the scenarios as if each had its own extra cash.'}};
}

export async function workspaceGET(endpoint,params,dependencies={}) {
  const deps={workspaceEvidence,searchRetainedEvidence,...dependencies};
  if(endpoint==='workspace/catalog')return workspaceCatalog();
  if(endpoint==='workspace/markets')return categorySnapshot(params.get('category')||'sports');
  if(endpoint==='workspace/context') {
    const ticker=validateTicker(params.get('ticker'));
    const [detail,profile,fees]=await Promise.all([marketDetails(ticker),request('/series/'+ticker.split('-')[0]).catch(()=>null),marketFees(ticker).catch(()=>null)]);
    return {ticker,market:{...detail.market,category:inferCategory(detail.market,profile?[profile.data.series]:[])},fees,as_of:detail.as_of,source_url:detail.source_url};
  }
  if(endpoint==='workspace/history')return contractHistory(params.get('ticker'),Number(params.get('hours')||24));
  if(endpoint==='workspace/research')return workspaceResearch(validateTicker(params.get('ticker')),{fast:params.get('compact')==='1',model:params.get('model')||'baseline'});
  if(endpoint==='workspace/evidence'){
    if(!['0','1'].includes(params.get('reddit')||'0')||!['0','1'].includes(params.get('x')||'0'))throw new RangeError('Use 0 or 1 for evidence source toggles');
    const preview=params.get('preview')==='1';
    return deps.workspaceEvidence(validateTicker(params.get('ticker')),{reddit:!preview&&params.get('reddit')==='1',includeX:!preview&&params.get('x')==='1',model:params.get('model')||'baseline',preview});
  }
  if(endpoint==='workspace/evidence/search')return deps.searchRetainedEvidence(validateTicker(params.get('ticker')),params.get('q')||'',{limit:Number(params.get('limit')||6)});
  if(endpoint==='workspace/opinions')return workspaceOpinions(params.get('tickers'),{model:params.get('model')||'baseline'});
  if(endpoint==='workspace/recommendations')return workspaceRecommendations(params.get('category')||'sports',Number(params.get('budget')||20),params.get('model')||'baseline');
  if(endpoint==='workspace/search')return searchPublicMarkets(params.get('q')||'',Number(params.get('limit')||30));
  if(endpoint==='workspace/attribution')return marketAttribution();
  if(endpoint==='workspace/sources')return {warehouse:await warehouseStatus(),providers:providerStatus(),semantic:embeddingStatus(),as_of:new Date().toISOString()};
  throw Object.assign(new Error('Unknown workspace route'),{status:404});
}
