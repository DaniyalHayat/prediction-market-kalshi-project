import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {executionResearch,almgrenChrissSchedule} from '../lib/workspace/execution-research.mjs';
import {contiguousBookHistory,fitOrderFlowChallenger,exponentialHawkesLikelihood} from '../lib/workspace/microstructure-model.mjs';

const NOW=Date.parse('2026-11-05T03:00:00Z'),root=new URL('../../',import.meta.url),privateCache=new URL('../.research/ibm-daily-execution-input.json',import.meta.url),average=rows=>rows.reduce((sum,x)=>sum+x,0)/rows.length;
const quantile=(rows,p)=>{const sorted=[...rows].sort((a,b)=>a-b),index=(sorted.length-1)*p,lower=Math.floor(index);return sorted[lower]+(sorted[Math.ceil(index)]-sorted[lower])*(index-lower);};
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
function generator(seed){let state=seed>>>0;const uniform=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return (state+.5)/4294967296;};return {uniform,normal:()=>Math.sqrt(-2*Math.log(uniform()))*Math.cos(2*Math.PI*uniform())};}
function history(seed,{signal=true,clustered=true}={}){
  const random=generator(seed),rows=[];let mid=.5,previous=0,time=0;
  for(let i=0;i<512;i++){
    mid=Math.max(.2,Math.min(.8,mid+(signal?.004*previous:0)+(random.uniform()-.5)*.001));
    const imbalance=(random.uniform()-.5)*1.5;time+=clustered?(i%8===0?4:.015):.1+random.uniform();
    rows.push({sequence:i,generation:'seeded-validation',time_seconds:time,bid_price:mid-.01,ask_price:mid+.01,bid_size:100*(1+imbalance),ask_size:100*(1-imbalance)});previous=imbalance;
  }
  return rows;
}
const profiles=[['sports',.45,.47,1500,.03],['macro',.6,.63,800,.015],['crypto',.48,.5,2000,.08],['travel',.55,.58,200,.02],['weather',.3,.36,75,.05],['science',.4,.55,20,.015],['climate',.2,.4,10,.02],['culture',.48,.62,45,.035]];
const suppliedForecast={valid:true,fresh:true,eligible:true,probability:.65,interval:[.61,.69],model:'explicit synthetic validation probability',source_as_of:new Date(NOW).toISOString()};
const cases=[];
for(const [category,bid,ask,depth,volatility] of profiles)for(const side of ['yes','no'])for(const action of ['buy','sell']){
  const ticker='SYNTHETIC-'+category,book={ticker,as_of:new Date(NOW).toISOString(),raw:{orderbook_fp:{yes_dollars:[[String(bid),String(depth)]],no_dollars:[[String(1-ask),String(depth)]]}}},input={market:{ticker,category},book,forecast:suppliedForecast,now:NOW,book_history:history(127),controls:{side,action,inventory:100,risk_aversion:.1,volatility}},result=executionResearch(input),baseline=executionResearch({...input,controls:{...input.controls,enabled:false}});
  assert.equal(result.forecast.probability,baseline.forecast.probability);assert.ok(result.schedule.objective<=result.schedule.benchmark_twap.objective+1e-8);assert.ok(Math.abs(result.schedule.rows.reduce((sum,row)=>sum+row.contracts,0)-20)<1e-9);
  cases.push({category,side,action,classification:'synthetic_adapter_and_cost_scenario_not_category_forecast_validation',forecast_unchanged:true,full_depth:result.immediate_execution.complete,settlement_decision:result.settlement.decision,scenario_decision:result.settlement.scenario_decision,objective:result.schedule.objective,twap_objective:result.schedule.benchmark_twap.objective,objective_reduction:result.comparison.objective_reduction,cost_change:result.comparison.expected_cost_change,first_slice:result.schedule.rows[0].contracts,baseline_first_slice:baseline.schedule.rows[0].contracts,quote_reference_change:result.comparison.quote_reference_change,arrival_multiplier:result.arrival_model.risk_multiplier});
}

const source=cases[0],baseInput={market:{ticker:'ABLATION',category:source.category},book:{ticker:'ABLATION',as_of:new Date(NOW).toISOString(),raw:{orderbook_fp:{yes_dollars:[['.48','1000']],no_dollars:[['.48','1000']]}}},now:NOW,forecast:suppliedForecast,book_history:history(127),controls:{inventory:100,risk_aversion:.1}},full=executionResearch(baseInput);
const toggles=[];
for(const feature of ['order_flow','arrival_clustering','inventory_skew','optimal_schedule','enabled']){
  const off=executionResearch({...baseInput,controls:{...baseInput.controls,[feature]:false}}),metric=feature==='order_flow'?'quote_reference_change':feature==='arrival_clustering'?'arrival_risk_multiplier':feature==='inventory_skew'?'inventory_reference_change':'first_slice_change',onValue=full.comparison[metric],offValue=off.comparison[metric];assert.notEqual(onValue,offValue);
  toggles.push({feature,metric,on:onValue,off:offValue,changes_actual_calculation:true,settlement_probability_unchanged:off.forecast.probability===full.forecast.probability});
}

const calibrationChecks=[];
for(const seed of [127,271,761,981,2026])for(const signal of [true,false]){
  const fit=fitOrderFlowChallenger(history(seed,{signal,clustered:false}));calibrationChecks.push({seed,fixture:signal?'known_predictive_signal_positive_control':'independent_noise_null_control',promoted:fit.applied,fit_n:fit.evaluation.fit_n,calibration_n:fit.evaluation.calibration_n,holdout_n:fit.evaluation.holdout_n,mse:fit.evaluation.mse,baseline_mse:fit.evaluation.zero_change_baseline_mse,relative_mse_skill:fit.evaluation.relative_mse_skill,paired_mse_improvement_interval_95:fit.evaluation.paired_mse_improvement_interval_95,interval_80_coverage:fit.evaluation.interval_80_coverage});
}
const timings=[];for(let i=0;i<46;i++){const start=performance.now();executionResearch(baseInput);if(i>=5)timings.push(performance.now()-start);}
const timing={trials:timings.length,warmups:5,observations_ms:timings,p50_ms:quantile(timings,.5),p95_ms:quantile(timings,.95),p99_ms:quantile(timings,.99),percentile_method:'Linear interpolation of empirical order statistics; 41 trials have limited tail resolution.',scope:'Local JavaScript CPU calculation over 512 synthetic quote updates; excludes network, browser rendering, database and exchange latency.'};

async function stockInput(){
  if(process.argv.includes('--fetch-stock')){
    const response=await fetch('https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=IBM&apikey=demo',{signal:AbortSignal.timeout(12000)}),text=await response.text();if(!response.ok||text.length>200000)throw new Error('The bounded public IBM daily dataset is unavailable');
    const data=JSON.parse(text),series=data['Time Series (Daily)'];if(!series||data['Meta Data']?.['2. Symbol']!=='IBM')throw new Error('The response is not the requested public IBM dataset');
    const rows=Object.entries(series).map(([date,row])=>({date,close:Number(row['4. close'])})).filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.date)&&row.date<='2026-11-04'&&Number.isFinite(row.close)&&row.close>0).sort((a,b)=>a.date.localeCompare(b.date));if(rows.length<80)throw new Error('At least 80 bounded daily closes are required');
    const fixture={symbol:'IBM',provider:'Alpha Vantage public demonstration endpoint',source_url:'https://www.alphavantage.co/documentation/#daily',retrieved_at:new Date().toISOString(),response_sha256:digest(text),rows};await mkdir(new URL('../.research/',import.meta.url),{recursive:true});await writeFile(privateCache,JSON.stringify(fixture,null,2));return fixture;
  }
  try{return JSON.parse(await readFile(privateCache,'utf8'));}catch{return null;}
}
const stock=await stockInput();
function simulateExecutionRisk({volatility,paths=10000,seed=78129,kind}){
  const parameters={contracts:2000,horizon_seconds:1800,steps:30,risk_aversion:.001,temporary_impact:.00002,volatility,fixed_cost:20},optimal=almgrenChrissSchedule(parameters),twap=almgrenChrissSchedule({...parameters,optimal:false}),random=generator(seed),modelCosts=[],twapCosts=[],differences=[],dt=parameters.horizon_seconds/60/parameters.steps;
  for(let simulation=0;simulation<paths;simulation++){
    let modelCost=optimal.expected_cost,twapCost=twap.expected_cost;for(let i=0;i<parameters.steps;i++){const jump=kind==='jump_stress'&&random.uniform()<.01?(random.uniform()<.5?-1:1)*volatility*10:0,move=volatility*Math.sqrt(dt)*random.normal()+jump;modelCost-=optimal.rows[i].remaining*move;twapCost-=twap.rows[i].remaining*move;}modelCosts.push(modelCost);twapCosts.push(twapCost);differences.push(modelCost-twapCost);
  }
  const summarize=rows=>{const mean=average(rows),variance=average(rows.map(value=>(value-mean)**2));return {mean_cost:mean,cost_variance:variance,standard_error_mean:Math.sqrt(variance/rows.length),p05_cost:quantile(rows,.05),p50_cost:quantile(rows,.5),p95_cost:quantile(rows,.95)};},model=summarize(modelCosts),benchmark=summarize(twapCosts),difference=summarize(differences);
  return {classification:'conditional_stock_liquidation_simulation_not_trading_profit',kind,paths,seed,parameters,model_analytic:{expected_cost:optimal.expected_cost,variance:optimal.risk_variance,objective:optimal.objective},twap_analytic:{expected_cost:twap.expected_cost,variance:twap.risk_variance,objective:twap.objective},model_simulated:model,twap_simulated:benchmark,paired_cost_difference:{mean:difference.mean_cost,monte_carlo_interval_95:[difference.mean_cost-1.96*difference.standard_error_mean,difference.mean_cost+1.96*difference.standard_error_mean]},risk_adjusted_simulated:{model:model.mean_cost+parameters.risk_aversion*model.cost_variance,twap:benchmark.mean_cost+parameters.risk_aversion*benchmark.cost_variance},assumptions:kind==='jump_stress'?'Independent zero-mean Gaussian increments plus an explicit 1% per-minute symmetric ten-sigma jump stress; not a fitted jump process.':'Independent zero-drift Gaussian increments with supplied volatility; costs, impact and risk preferences are assumptions. No alpha or directional stock forecast.'};
}
let stockCalibration=null;
if(stock){
  const returns=stock.rows.slice(1).map((row,i)=>({date:row.date,value:Math.log(row.close/stock.rows[i].close)})),fitEnd=Math.floor(returns.length*.6),calEnd=Math.floor(returns.length*.8),fit=returns.slice(0,fitEnd),calibration=returns.slice(fitEnd,calEnd),holdout=returns.slice(calEnd),sigma=Math.sqrt(average(fit.map(row=>row.value**2))),bounds=[quantile(calibration.map(row=>row.value),.05),quantile(calibration.map(row=>row.value),.95)],reference=stock.rows[fitEnd].close,volatility=Math.min(1,reference*sigma/Math.sqrt(390));
  stockCalibration={symbol:stock.symbol,source_url:stock.source_url,provider:stock.provider,retrieved_at:stock.retrieved_at,input_response_sha256:stock.response_sha256,data_start:stock.rows[0].date,data_end:stock.rows.at(-1).date,fit_n:fit.length,calibration_n:calibration.length,holdout_n:holdout.length,fit_daily_zero_mean_log_return_rms:sigma,fit_reference_price:reference,assumed_intraday_volatility:volatility,heldout_zero_mean_rmse:Math.sqrt(average(holdout.map(row=>row.value**2))),calibration_90_percent_return_interval:bounds,heldout_interval_coverage:average(holdout.map(row=>Number(row.value>=bounds[0]&&row.value<=bounds[1]))),raw_data_publicly_redistributed:false,interpretation:'Historical daily closes calibrate only a volatility scale. Dividing daily variance by 390 assumes uniform intraday variance and ignores overnight/intraday differences. No intraday order-flow, impact, fill or profit validation is implied. Raw provider data remain in ignored local research storage.'};
}
const stockSimulations=[simulateExecutionRisk({volatility:.2,kind:'zero_drift_diffusion'}),simulateExecutionRisk({volatility:.2,kind:'jump_stress'}),...(stockCalibration?[simulateExecutionRisk({volatility:stockCalibration.assumed_intraday_volatility,kind:'historical_daily_scale_diffusion'})]:[])];
const result={version:'execution-research-validation-v1',generated_at:new Date().toISOString(),runtime:{node:process.version,platform:process.platform,architecture:process.arch},scope:'Reproducible model arithmetic, controlled positive/null experiments, all-category adapters and conditional stock execution simulations. This is not a Kalshi or stock profitability backtest.',source_hashes:{core:digest(await readFile(new URL('../lib/workspace/execution-research.mjs',import.meta.url),'utf8')),challenger:digest(await readFile(new URL('../lib/workspace/microstructure-model.mjs',import.meta.url),'utf8'))},category_cases:cases,toggle_ablations:toggles,quote_challenger_controls:calibrationChecks,latency:timing,stock_calibration:stockCalibration,stock_simulations:stockSimulations,limitations:['Synthetic category fixtures test adapters and invariants, not empirical category-specific forecasting accuracy.','Positive controls intentionally contain a planted next-quote signal; null controls intentionally do not. Neither estimates real-market alpha.','Repeated local holdout gates are diagnostics; prospective locked protocols and independent labeled data are still required for model promotion.','Monte Carlo intervals measure simulation error conditional on assumptions, not uncertainty about those assumptions.','Impact, spread and variance scales are not exchange-validated; simulated objective savings are not realized P&L.']};
await mkdir(new URL('review/',root),{recursive:true});await writeFile(new URL('review/execution-research-validation.json',root),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify({category_cases:cases.length,toggles:toggles.length,quote_controls:calibrationChecks.length,local_cpu_p50_ms:timing.p50_ms,local_cpu_p95_ms:timing.p95_ms,stock_dataset:stockCalibration?{symbol:stockCalibration.symbol,fit_n:stockCalibration.fit_n,calibration_n:stockCalibration.calibration_n,holdout_n:stockCalibration.holdout_n}:null,stock_simulations:stockSimulations.length,classification:result.scope},null,2)+'\n');
