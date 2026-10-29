import { request, book, marketDetails, trades, validateTicker, number, validQuote } from "../live.mjs";
import { CATEGORIES, categoryById } from "./catalog.mjs";
import { tsaSource, macroSource, weatherSource, cryptoSource, WEATHER_SITES, localDay, DAY, monthNumber } from "./sources.mjs";
import { MODEL_VERSION, timeSeriesModel, eventDate, marketBounds, empiricalProbability, gaussianProbability, cryptoModel, coherenceChecks, executionEstimate, quarterKelly, mean } from "./math.mjs";

const state = globalThis[Symbol.for("kalshi.independent.reports.v1")] ||= {cache:new Map(),inflight:new Map()};
export { CATEGORIES };
export async function sourceBundle(id) {
  const category=categoryById(id);
  const tasks=id==="travel" ? [tsaSource] : ["inflation","labor"].includes(id) ? [()=>macroSource(id)] :
    id==="weather" ? category.series.map(series=>()=>weatherSource(series)) : ["BTC","ETH"].map(asset=>()=>cryptoSource(asset));
  const sources=[],errors=[];
  // Bound simultaneous requests; datasets are independently cached and failures are never synthesized.
  for(let start=0;start<tasks.length;start+=2) {
    const results=await Promise.allSettled(tasks.slice(start,start+2).map(task=>task()));
    for(const result of results) {
      if(result.status==="fulfilled")sources.push(result.value);
      else errors.push(result.reason.message);
    }
  }
  return {sources,errors};
}
async function catalogMarkets(category) {
  const rows=[],lineage=[],coverage=[],errors=[];
  for(const series of category.series) {
    try {
      const result=await request("/markets",{series_ticker:series,status:"open",limit:"200"});
      rows.push(...(result.data.markets || []).map(row=>({...row,series})));
      lineage.push({series,as_of:result.as_of,source_url:result.source_url,sha256:result.sha256});
      coverage.push({series,records:(result.data.markets || []).length,truncated:!!result.data.cursor});
    } catch(error) {
      errors.push({series,error:error.message});
      if(error.upstream_status===429)break;
    }
  }
  return {rows:[...new Map(rows.map(row=>[row.ticker,row])).values()],lineage,coverage,errors};
}
function prepareModels(category, sources) {
  const models=new Map();
  if(["travel","inflation","labor"].includes(category.id) && sources[0]) {
    try {models.set("time",timeSeriesModel(sources[0].rows,category.id==="travel" ? "daily" : "monthly"));}
    catch(error) {models.set("error",error.message);}
  }
  return models;
}
function distribution(market, category, bundle, models, now=Date.now()) {
  const id=category.id, date=eventDate(market), bounds=marketBounds(market,["weather","travel"].includes(id) ? 1 : ["inflation","labor"].includes(id) ? .1 : .01);
  if(!bounds) return {reason:"Unsupported or ambiguous strike definition; probability withheld."};
  if(!date) return {reason:"Target observation date could not be read unambiguously."};
  if(Date.parse(market.close_time)<=now) return {reason:"Trading close has passed; not an open-trade research candidate."};
  if(["travel","inflation","labor"].includes(id)) {
    const source=bundle.sources[0], model=models.get("time");
    if(!source || !model)return {reason:models.get("error") || "External source unavailable."};
    const age=(now-Date.parse(source.latest_observation))/DAY;
    if(age>(id==="travel" ? 5 : 75)) return {reason:"Underlying observations are stale for this model."};
    const observation=source.rows.find(row=>row.date===date);
    if(observation) return {reason:"Target observation is already published. Verify first-release rules and official resolution.",observed:observation.value};
    const forecast=model.forecast(date);
    if(!forecast)return {reason:id==="travel" ? "Only the next seven observation days are modeled." : "Only the next unreleased observation month is modeled; longer horizons are withheld."};
    // These series have fixed published measurement conventions; other series are never inferred from names alone.
    const rules=`${market.rules_primary || ""} ${market.rules_secondary || ""}`;
    if(id==="travel" && (!/TSA|passenger screenings|transportation security/i.test(rules) || market.series!=="KXTSAD")) return {reason:"Only daily nationwide TSA screening rules are mapped; weekly/custom contracts are withheld."};
    if(id==="inflation" && !/CPI|consumer price index/i.test(rules))return {reason:"CPI resolution source is unconfirmed."};
    if(id==="inflation" && /year.over.year|12.month|not seasonally adjusted/i.test(rules) && !/month.over.month/i.test(rules))return {reason:"This model is seasonally adjusted month-over-month CPI, not a year-over-year or NSA contract."};
    if(id==="labor" && !/unemployment/i.test(rules))return {reason:"Unemployment resolution definition is unconfirmed."};
    const probability=empiricalProbability(forecast.center,model.errors,bounds,id==="travel" ? 7 : 3);
    return {...probability,center:forecast.center,range_80:[forecast.low,forecast.high],target_date:date,
      source_name:source.name,source_url:source.source_url,source_as_of:source.retrieved_at,source_sha256:source.sha256,
      model_name:category.model,validation:model.evaluation,
      inputs:{latest_observation:source.latest_observation,latest_value:source.rows.at(-1).value,horizon:forecast.horizon,ensemble_weights:model.weights,weight_fit_observations:model.training_n,calibration_residuals:model.calibration_n},
      warnings:[source.revision_note,...(source.snapshot ? [`FRED live retrieval failed (${source.fallback_reason}); this model uses the explicitly dated archived source snapshot.`] : []),"The probability interval covers residual sampling uncertainty, not all model risk.",
        ...(model.evaluation.rmse_skill<=0 ? ["This ensemble did not beat its naive baseline on the held-out underlying values."] : []),
        "No demonstrated out-of-sample Kalshi-contract or net-P&L advantage."]};
  }
  if(id==="weather") {
    const source=bundle.sources.find(row=>row.series===market.series), site=WEATHER_SITES[market.series];
    if(!source || !site)return {reason:"Station-specific NWS data unavailable."};
    if(!site.rule.test(`${market.rules_primary || ""} ${market.rules_secondary || ""}`))return {reason:`The rules must explicitly match ${site.name}; station mapping is not assumed.`};
    if(!source.updated_at || now-Date.parse(source.updated_at)>6*3600000)return {reason:"NWS forecast is more than six hours old."};
    const currentDay=localDay(now,site.zone),horizon=(Date.parse(date)-Date.parse(currentDay))/DAY;
    if(horizon<0 || horizon>5)return {reason:"Only today through five days ahead have a supported weather forecast."};
    const periods=source.rows.filter(row=>row.day===date && Date.parse(row.date)>=now-3600000);
    if(periods.length<3)return {reason:"Too few remaining hourly forecast periods for this date."};
    const observedRows=source.observation?.rows.filter(row=>row.day===date) || [];
    const observedMax=observedRows.length ? Math.max(...observedRows.map(row=>row.value)) : -Infinity;
    const localHour=Number(new Intl.DateTimeFormat("en-US",{hour:"numeric",hourCycle:"h23",timeZone:site.zone}).format(now));
    const latestObservation=source.observation?.rows.at(-1)?.date;
    if(horizon===0 && (localHour>=8 && (!latestObservation || now-Date.parse(latestObservation)>3*3600000))) return {reason:"Today’s observed daily maximum is incomplete or stale; a fresh matching-station observation is required."};
    const center=Math.max(observedMax,...periods.map(row=>row.value)), sigma=2.5+.6*horizon;
    const probability=gaussianProbability(center,sigma,bounds,observedMax);
    const variants=[.7,1,1.5].flatMap(multiplier=>[-1,0,1].map(shift=>gaussianProbability(center+shift,sigma*multiplier,bounds,observedMax)));
    return {probability,interval:[Math.min(...variants),Math.max(...variants)],interval_kind:"Assumed forecast-error sensitivity band; not a calibrated confidence interval",
      n:0,effective_n:0,center,range_80:[Math.max(observedMax,center-1.281551566*sigma),center+1.281551566*sigma],
      target_date:date,source_name:source.name,source_url:source.source_url,source_as_of:source.retrieved_at,source_sha256:source.sha256,model_name:category.model,
      inputs:{station:site.station,horizon_days:horizon,forecast_hours:periods.length,observed_max:Number.isFinite(observedMax) ? observedMax : null,assumed_sigma_f:sigma},
      validation:null,warnings:[source.revision_note,"Forecast-error sigma is an explicit assumption; no archived NWS forecast backtest is available.",
        "A grid-point forecast is not the exact climate-report station. Sensitivity is not calibrated prediction accuracy."]};
  }
  const asset=market.series==="KXBTC" ? "BTC" : market.series==="KXETH" ? "ETH" : null;
  const source=bundle.sources.find(row=>row.asset===asset);
  if(!source)return {reason:"Matching crypto source unavailable."};
  const age=now-Date.parse(source.spot_as_of);
  if(age>120000 || now-Date.parse(source.latest_observation)>2*3600000)return {reason:"Coinbase spot or completed candles are stale."};
  if(!/bitcoin|ether|ethereum|BTC|ETH/i.test(market.rules_primary || ""))return {reason:"Crypto settlement definition is unconfirmed."};
  if(/touch|at any time|ever |maximum|minimum/i.test(`${market.title} ${market.rules_primary}`))return {reason:"A terminal-price model cannot price a path-dependent barrier/touch contract."};
  const hours=(Date.parse(market.close_time)-now)/3600000;
  if(hours<2/60)return {reason:"The measurement window is imminent or underway; a terminal-price proxy is not used for last-minute settlement inference."};
  const model=cryptoModel(source.rows,source.spot,hours);
  if(!model)return {reason:"Only terminal-price horizons up to 72 hours are modeled."};
  return {...model.estimate(bounds),center:model.center,range_80:[model.low,model.high],target_date:date,
    source_name:source.name,source_url:source.source_url,source_as_of:source.spot_as_of,source_sha256:source.sha256,spot_sha256:source.spot_sha256,model_name:category.model,validation:null,
    inputs:{spot:source.spot,forecast_hours:hours,sigma_hourly:model.sigma_hourly,annualized_vol:model.annualized_vol,shrunken_hourly_drift:model.mu_hourly},
    warnings:[source.revision_note,"Horizon uses trading close, which must be checked against the contract’s exact measurement time/window.",
      "Gaussian log-return tails and volatility stability are assumptions. No calibrated contract backtest; not an index-basis arbitrage."]};
}
function quoteAnalysis(market, forecast) {
  const yesBid=number(market.yes_bid_dollars),yesAsk=number(market.yes_ask_dollars);
  if(!validQuote(yesBid,yesAsk) || !Number.isFinite(forecast.probability))return {yes_bid:yesBid,yes_ask:yesAsk,side:null,estimated_edge:null,conservative_edge:null};
  const choices=["yes","no"].map(side=>{
    const p=side==="yes" ? forecast.probability : 1-forecast.probability, lower=side==="yes" ? forecast.interval[0] : 1-forecast.interval[1];
    const ask=side==="yes" ? yesAsk : 1-yesBid;
    // One assumed 100-contract fill at the catalog ask. Real depth, market fee schedules and per-fill rounding still need inspection.
    const fee=Math.max(0,Math.ceil((.07*100*ask*(1-ask)-1e-10)*100)/100)/100;
    const cost=ask+fee;
    return {side,side_probability:p,side_lower_probability:lower,indicative_ask:ask,estimated_fee_per_contract:fee,indicative_all_in:cost,
      estimated_edge:p-cost,conservative_edge:lower-cost-.02,quarter_kelly:quarterKelly(lower,cost)};
  }).sort((a,b)=>b.conservative_edge-a.conservative_edge);
  return {yes_bid:yesBid,yes_ask:yesAsk,spread_cents:(yesAsk-yesBid)*100,...choices[0]};
}
export function modelEvidence(forecast) {
  const evaluation=forecast.validation;
  return !Number.isFinite(forecast.probability) || forecast.probability<0 || forecast.probability>1 ? {tier:0,label:"Probability withheld"} :
    evaluation?.rmse_skill<=0 ? {tier:0,label:"Underperforms naive baseline"} :
    evaluation && evaluation.interval_80_coverage<.7 ? {tier:0,label:"Prediction interval undercoverage"} :
    evaluation && evaluation.n>=30 ? {tier:2,label:"Underlying-value holdout only"} :
    {tier:1,label:"Uncalibrated proxy / sensitivity only"};
}
function marketReport(market, category, bundle, models, now) {
  const forecast=distribution(market,category,bundle,models,now),quote=quoteAnalysis(market,forecast);
  const evidence=modelEvidence(forecast);
  return {ticker:market.ticker,event_ticker:market.event_ticker,series:market.series,title:market.title,close_time:market.close_time,
    strike_type:market.strike_type,floor_strike:market.floor_strike,cap_strike:market.cap_strike,volume_24h:number(market.volume_24h_fp),
    rules_primary:market.rules_primary || null,...forecast,...quote,
    evidence,
    status:forecast.probability===undefined ? "withheld" : evidence.tier===0 ? "validation warning" :
      quote.side && quote.conservative_edge>0 ? evidence.tier===2 ? "research candidate" : "provisional hypothesis" : "no conservative edge"};
}
export async function researchReport(id) {
  const category=categoryById(id),cached=state.cache.get(id);
  if(cached && Date.now()-cached.at<30000)return cached.value;
  if(state.inflight.has(id))return state.inflight.get(id);
  const task=(async()=>{
    const [catalog,bundle]=await Promise.all([catalogMarkets(category),sourceBundle(id)]);
    const models=prepareModels(category,bundle.sources),now=Date.now();
    const rows=catalog.rows.map(market=>marketReport(market,category,bundle,models,now))
      .sort((a,b)=>b.evidence.tier-a.evidence.tier || (b.conservative_edge ?? -Infinity)-(a.conservative_edge ?? -Infinity) || (b.volume_24h || 0)-(a.volume_24h || 0));
    const model=models.get("time");
    const value={
      category,model_version:MODEL_VERSION,as_of:new Date(now).toISOString(),quote_lineage:catalog.lineage,
      status:bundle.sources.length && catalog.lineage.length ? catalog.errors.length || bundle.errors.length || bundle.sources.some(source=>source.snapshot) ? "partial" : "live inputs" : "unavailable",
      coverage:catalog.coverage,partial:catalog.coverage.some(row=>row.truncated) || !!catalog.errors.length,
      markets:rows,coherence:coherenceChecks(catalog.rows),sources:bundle.sources,
      errors:[...catalog.errors.map(item=>`${item.series}: ${item.error}`),...bundle.errors, ...(models.has("error") ? [models.get("error")] : [])],
      evaluation:model?.evaluation || null,model_weights:model?.weights || null,
      chart:model?.chart || bundle.sources[0]?.rows.slice(-100).map(row=>({date:row.date,observed:row.value})) || [],
      summary:{markets:rows.length,modeled:rows.filter(row=>row.probability!==undefined).length,
        conservative_candidates:rows.filter(row=>row.status==="research candidate").length,
        provisional_candidates:rows.filter(row=>row.status==="provisional hypothesis").length,
        validation_warnings:rows.filter(row=>row.status==="validation warning").length,withheld:rows.filter(row=>row.status==="withheld").length},
      ranking:"Evidence tier first, then conservative model probability minus catalog ask, assumed 7% taker-formula fee and a 2¢ slippage/model buffer. Underperforming/undercovered models never become screened candidates. Not executable prices or proven alpha.",
      validation_disclaimer:"These are research hypotheses, not calibrated trading recommendations. Underlying-value holdouts are not historical Kalshi P&L. No profits or win rates are claimed."
    };
    state.cache.set(id,{at:now,value});
    return value;
  })();
  state.inflight.set(id,task);
  try{return await task;}finally{state.inflight.delete(id);}
}
function microstructure(raw, tape) {
  const rows=key=>(raw.orderbook_fp?.[key] || []).filter(row=>Number(row[1])>0).map(row=>row.map(Number)).sort((a,b)=>b[0]-a[0]);
  const yes=rows("yes_dollars"),no=rows("no_dollars"),bid=yes[0]?.[0],ask=no.length ? 1-no[0][0] : null;
  const bidDepth=yes.slice(0,3).reduce((sum,[,q])=>sum+q,0),askDepth=no.slice(0,3).reduce((sum,[,q])=>sum+q,0);
  const tradeRows=(tape?.trades || []).filter(row=>number(row.count_fp ?? row.count)!==null);
  const yesFlow=tradeRows.filter(row=>row.taker_side==="yes").reduce((sum,row)=>sum+Number(row.count_fp ?? row.count),0);
  const noFlow=tradeRows.filter(row=>row.taker_side==="no").reduce((sum,row)=>sum+Number(row.count_fp ?? row.count),0);
  return {top3_bid_depth:bidDepth,top3_ask_depth:askDepth,depth_imbalance:bidDepth+askDepth ? (bidDepth-askDepth)/(bidDepth+askDepth) : null,
    microprice:validQuote(bid ?? null,ask) && yes[0]?.[1]+no[0]?.[1]>0 ? (ask*yes[0][1]+bid*no[0][1])/(yes[0][1]+no[0][1]) : null,
    taker_flow_imbalance:yesFlow+noFlow ? (yesFlow-noFlow)/(yesFlow+noFlow) : null,
    trade_count:tradeRows.length,trade_page_partial:tape?.partial ?? null,trade_as_of:tape?.as_of || null,
    caveat:"Depth and bounded trade-flow indicators are descriptive, not an independently validated forecast."};
}
export async function analyzeExecution(id,ticker,{contracts=100,slippage=2,coefficient=.07,bankroll=1000,risk=1}={}) {
  const category=categoryById(id);validateTicker(ticker);
  if(!category.series.some(series=>ticker.startsWith(series+"-")))throw new RangeError("Ticker does not belong to the chosen category");
  if(!Number.isFinite(bankroll) || bankroll<0 || bankroll>1e12 || !Number.isFinite(risk) || risk<0 || risk>100)throw new RangeError("Invalid bankroll or risk budget");
  // Input validation occurs before any provider requests.
  executionEstimate({orderbook_fp:{}},"yes",contracts,slippage,coefficient);
  const [detail,depth,bundle,tapeResult]=await Promise.all([marketDetails(ticker),book(ticker,contracts),sourceBundle(id),trades(ticker).catch(()=>null)]);
  const market={...detail.market,series:category.series.find(series=>ticker.startsWith(series+"-"))};
  const report=marketReport(market,category,bundle,prepareModels(category,bundle.sources),Date.now());
  const side=report.side || "yes",execution=executionEstimate(depth.raw,side,contracts,slippage,coefficient);
  const probability=report.probability===undefined ? null : side==="yes" ? report.probability : 1-report.probability;
  const lower=report.probability===undefined ? null : side==="yes" ? report.interval[0] : 1-report.interval[1];
  const cost=execution.breakeven,conservativeKelly=lower!==null && cost!==null && report.evidence.tier>0 ? quarterKelly(lower,cost) : 0;
  const budget=bankroll*Math.min(risk/100,conservativeKelly);
  let low=0,high=budget>0 ? Math.min(1e6,Math.floor(execution.available)) : 0;
  while(low<high) {
    const middle=Math.ceil((low+high)/2),trial=executionEstimate(depth.raw,side,middle,slippage,coefficient);
    if(trial.all_in<=budget+1e-10)low=middle;else high=middle-1;
  }
  return {ticker,category:id,model_version:MODEL_VERSION,as_of:new Date().toISOString(),forecast:report,
    market:detail.market,market_as_of:detail.as_of,market_source:detail.source_url,book_as_of:depth.as_of,book_source:depth.source_url,
    execution,expected_pnl:probability!==null && execution.filled ? probability*execution.filled-execution.all_in : null,
    conservative_edge:lower!==null && cost!==null ? lower-cost-.02 : null,
    sizing:{bankroll,risk_percent:risk,quarter_kelly_fraction:conservativeKelly,loss_budget:budget,depth_and_budget_cap:low},
    microstructure:microstructure(depth.raw,tapeResult),assumptions:{slippage_cents:slippage,fee_coefficient:coefficient,additional_uncertainty_buffer:.02},
    warnings:[...(report.warnings || []),...(execution.unfilled ? ["Insufficient eligible depth; estimates apply only to the modeled filled portion."] : []),
      "Verify the exact settlement rules and fee schedule. Sizing is hypothetical, unvalidated and not a recommendation."]};
}
