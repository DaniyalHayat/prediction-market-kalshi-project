'use client';
import React,{useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,ArrowUpRight,FlaskConical,Loader2,RefreshCw} from 'lucide-react';
import {cents,count,dollars,exportJSON,percent} from './api.mjs';
import {EXECUTION_DEFAULTS,EXECUTION_FEATURES,executionControls,executionDepth,executionFingerprint,requestExecution} from './execution-state.mjs';
import QuantScenarios from './QuantScenarios.jsx';

const number=(value,digits=4)=>Number.isFinite(value)?value.toLocaleString('en-US',{maximumFractionDigits:digits}):'Not available';
const utc=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString().slice(0,19).replace('T',' ')+' UTC':'Not available';
function Note({value}){return typeof value==='string'&&value?<p className="execution-note">{value}</p>:null;}
function LiveDepth({book,market,controls,fees,clock,closed,onRefresh}){
  const [refreshing,setRefreshing]=useState(false),[error,setError]=useState('');
  const request=useRef(null);
  useEffect(()=>()=>{request.current?.abort();},[]);
  async function refresh(){
    if(!onRefresh||request.current)return;
    const controller=new AbortController();request.current=controller;setRefreshing(true);setError('');
    try{await onRefresh(controller.signal);}
    catch(failure){if(!controller.signal.aborted)setError(failure.message||'The order book could not be refreshed.');}
    finally{if(!controller.signal.aborted){request.current=null;setRefreshing(false);}}
  }
  const {side,action,contracts}=controls;
  const depth=executionDepth({book,ticker:market.ticker,side,action,contracts,fees,now:clock,closed}),quote=depth.quote;
  const usable=depth.status==='fresh'||depth.status==='empty';
  const status={closed:'Trading is closed for this contract.',missing:'Waiting for a matching public order book.',stale:'The last book is stale. Refresh to estimate a fill.',unusable:'The current book could not be used to estimate a fill.'};
  return <section aria-label="Executable depth estimate">
    <div className="section-title"><div><h3>Executable depth estimate</h3><small>{depth.asOf?<><time dateTime={depth.asOf}>{utc(depth.asOf)}</time> · {depth.stream?'Exchange stream':'REST snapshot'}{usable?` · ${depth.age}s ago`:''}</>:'Public order book'}</small></div>
      {onRefresh&&<button type="button" className="secondary" disabled={refreshing||closed} onClick={refresh}>{refreshing?<Loader2 size={14} className="spin"/>:<RefreshCw size={14}/>} {refreshing?'Refreshing…':'Refresh depth'}</button>}</div>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {usable?<div className="execution-live-quote">
      <div><strong>{count(depth.available)} contracts</strong><span>{action==='sell'?'Sell':'Buy'} {side.toUpperCase()} available within 2¢ of the best price{depth.best!==null?` (${cents(depth.best)} to ${cents(depth.limit)})`:''}</span></div>
      <div><strong>{quote?`${count(quote.filled)} / ${count(quote.requested)} estimated fill`:'Enter a valid quantity'}</strong><span>{quote?`${count(quote.unfilled)} unfilled · ${quote.vwap===null?'No average fill price':cents(quote.vwap)+' average fill price'}`:'Use 1 to 10,000 whole contracts.'}</span></div>
      {quote&&<div><strong>{dollars(quote.cash)}</strong><span>{action==='sell'?'Net proceeds':'Cash required'} for the estimated fill · {dollars(quote.fee)} modeled fee</span></div>}
      <p>{depth.feeVerified?'Fee uses the reported series coefficient.':'Fee assumes the general 0.07 coefficient.'} Public snapshot for paper research. Quotes can move before any real trade.</p>
    </div>:<p className="notice" role="status">{status[depth.status]}</p>}
  </section>;
}
function FeatureResult({title,value,children}){
  return <details className="execution-feature-result"><summary><span>{title}</span><small>{value?.enabled===false?'Off':value?.available===false||value?.status==='unavailable'?'Needs more data':value?.applied===true?'Applied to this scenario':value?.applied===false?'Not applied':'Model detail'}</small></summary>
    <Note value={value?.reason||value?.note}/>{children}
  </details>;
}
export function ExecutionResults({value,outdated=false,onAssistant}){
  const [exporting,setExporting]=useState(false),[exportError,setExportError]=useState('');
  const forecast=value.forecast||{},market=value.market_state||{},schedule=value.schedule||{},baseline=schedule.benchmark_twap||{},rows=schedule.rows||[],quality=value.data_quality||{},side=String(market.side||value.controls?.side||'yes').toUpperCase(),immediate=value.immediate_execution;
  const largestSlice=Math.max(1,...rows.map(item=>item.contracts||0));
  const gaps=Array.isArray(quality.gaps)?quality.gaps:[],limitations=Array.isArray(value.limitations)?value.limitations:[];
  const ofi=value.order_flow||{},arrivals=value.arrival_model||{},quotes=value.inventory_quotes||{},settlement=value.settlement||{};
  const buy=value.controls?.action!=='sell',difference=value.comparison?.objective_reduction,outcomes=forecast.outcomes;
  async function downloadPDF(){
    setExporting(true);setExportError('');
    try{const {downloadExecutionPDF}=await import('./execution-pdf.mjs');await downloadExecutionPDF(value);}
    catch{setExportError('The PDF could not be downloaded. Try again or export the scenario as JSON.');}
    finally{setExporting(false);}
  }
  return <div className={'execution-results '+(outdated?'outdated':'')}>
    {outdated&&<p className="notice" role="status">Settings changed. These results use the previous settings. Run the scenario again to update them.</p>}
    <div className="execution-result-heading"><div><span className="eyebrow">{value.enabled===false?'Baseline scenario':'Execution research'}</span><h4>Cost, timing and position risk</h4><small>Book observed {utc(value.book_as_of||value.as_of)}</small></div><span className="tag">Paper only</span></div>
    <div className="execution-result-actions"><button type="button" className="secondary" disabled={exporting} onClick={downloadPDF}>{exporting?<Loader2 size={14} className="spin"/>:<ArrowDownToLine size={14}/>} {exporting?'Preparing PDF…':'Download PDF'}</button>{onAssistant&&<button type="button" className="text-button" aria-label="Ask why about the submitted execution scenario" onClick={()=>onAssistant(value)}>Ask why <ArrowUpRight size={14}/></button>}</div>
    {exportError&&<p className="notice error" role="alert">{exportError}</p>}
    {immediate&&<p className="execution-note"><strong>{buy?'Buy':'Sell'} {side} · {count(immediate.requested)} contracts.</strong> The scenario book estimates {count(immediate.filled)} filled and {count(immediate.unfilled)} unfilled. {Number.isFinite(difference)&&Math.abs(difference)>=.005?`The selected schedule’s modeled risk-adjusted cost is ${dollars(Math.abs(difference))} ${difference>0?'lower':'higher'} than even pacing under the stated assumptions.`:'The modeled cost comparison uses the same inputs for both schedules.'}</p>}
    <div className="execution-metrics"><div><small>Scenario {side} bid / ask</small><strong>{cents(market.bid)} <span>/</span> {cents(market.ask)}</strong></div><div><small>{side} spread</small><strong>{cents(market.spread)}</strong></div><div><small>{outcomes?'YES team win chance':'Independent P(YES)'}</small><strong>{Number.isFinite(forecast.probability)?percent(forecast.probability):'No eligible estimate'}</strong></div></div>
    {outcomes&&<p className="execution-note">Opposing team win chance {percent(outcomes.loss)} · Tie chance {percent(outcomes.tie)} · Modeled YES settlement {dollars(forecast.expected_settlement_value)} per contract. A tie pays $0.50 per contract.</p>}
    <p className="execution-note">The outcome forecast stays separate. Execution assumptions change the cost and timing scenario; they do not create a new probability of settlement.</p>
    {forecast.experimental&&<p className="execution-note">The selected outcome estimate is experimental. Its release checks have not passed.</p>}
    <Note value={value.fee_schedule?.note}/>
    {gaps.length>0&&<div className="execution-gaps"><strong>Data coverage</strong><ul>{gaps.map((gap,index)=><li key={index}>{typeof gap==='string'?gap:gap.reason||gap.detail||'A required observation is missing.'}</li>)}</ul></div>}
    <p className="execution-note">{count(quality.contiguous_events)} retained book events · {number(quality.quote_event_span_seconds,1)} seconds observed{quality.timestamp_ties>0?` · ${count(quality.timestamp_ties)} tied receive timestamps`:''}. {quality.scope}</p>
    {immediate&&<div className="execution-live-quote"><div><strong>Scenario book quote</strong><span>{buy?'Buy':'Sell'} {side} · {count(immediate.filled)} / {count(immediate.requested)} contracts filled by this snapshot</span></div><div><strong>{dollars(immediate.cash)}</strong><span>{buy?'Cash required':'Net proceeds'} for filled quantity · {dollars(immediate.fee)} estimated fees</span></div>{!immediate.complete&&<p>The book does not fill the full requested size. The unfilled quantity is excluded from these cash and fee figures.</p>}</div>}
    <div className="execution-comparison"><div><span>{schedule.applied===false?'Selected schedule':'Risk-aware schedule'}</span><strong>{dollars(schedule.expected_cost)}</strong><small>Modeled execution cost above reference price</small><dl><div><dt>Cost variance</dt><dd>{number(schedule.risk_variance)} USD²</dd></div><div><dt>Risk-adjusted objective</dt><dd>{dollars(schedule.objective)}</dd></div></dl></div><div><span>Even-paced benchmark</span><strong>{dollars(baseline.expected_cost)}</strong><small>Same horizon and assumptions</small><dl><div><dt>Cost variance</dt><dd>{number(baseline.risk_variance)} USD²</dd></div><div><dt>Risk-adjusted objective</dt><dd>{dollars(baseline.objective)}</dd></div></dl></div></div>
    <Note value={schedule.note}/>
    {rows.length>0&&<details className="execution-schedule" open><summary>Execution schedule <small>{rows.length} steps</small></summary><div className="execution-schedule-chart" role="img" aria-label="Planned contracts at each execution step">{rows.map((row,index)=><div key={index} title={`${number(row.time_seconds,0)} seconds: ${number(row.contracts,3)} contracts`}><span style={{height:`${Math.max(1,100*(row.contracts||0)/largestSlice)}%`}}/></div>)}</div><div className="execution-chart-caption"><span>Start</span><span>{number(value.controls?.horizon_seconds,0)} seconds</span></div><div className="table-scroll"><table><thead><tr><th>Elapsed seconds</th><th>Planned contracts</th><th>Remaining contracts</th></tr></thead><tbody>{rows.map((row,index)=><tr key={index}><td>{number(row.time_seconds,0)}</td><td>{number(row.contracts,3)}</td><td>{number(row.remaining,3)}</td></tr>)}</tbody></table></div></details>}
    <div className="execution-detail-list">
      <FeatureResult title="Order-flow pressure" value={ofi}><dl className="execution-definitions"><div><dt>Observed event transitions</dt><dd>{count(ofi.transitions??ofi.observations)}</dd></div><div><dt>Net order-flow imbalance</dt><dd>{number(ofi.ofi??ofi.value)}</dd></div><div><dt>Depth-normalized pressure</dt><dd>{number(ofi.normalized_imbalance??ofi.normalized)}</dd></div><div><dt>Applied next-quote adjustment</dt><dd>{cents(ofi.applied_next_mid_change)}</dd></div>{ofi.evaluation&&<><div><dt>Held-out quote error improvement</dt><dd>{percent(ofi.evaluation.relative_mse_skill)}</dd></div><div><dt>Held-out observations</dt><dd>{count(ofi.evaluation.holdout_n)}</dd></div><div><dt>80% interval coverage</dt><dd>{percent(ofi.evaluation.interval_80_coverage)}</dd></div></>}</dl></FeatureResult>
      <FeatureResult title="Event-arrival model" value={arrivals}><dl className="execution-definitions"><div><dt>Model</dt><dd>{arrivals.method||arrivals.model||'Not fitted'}</dd></div><div><dt>Branching ratio</dt><dd>{number(arrivals.branching_ratio)}</dd></div><div><dt>Current intensity</dt><dd>{number(arrivals.intensity)} events / second</dd></div><div><dt>Poisson baseline rate</dt><dd>{number(arrivals.poisson_rate_per_second)} events / second</dd></div><div><dt>Scenario volatility multiplier</dt><dd>{number(arrivals.risk_multiplier,3)}×</dd></div>{arrivals.evaluation&&<><div><dt>Holdout log-likelihood gain</dt><dd>{number(arrivals.evaluation.holdout_log_likelihood_gain)}</dd></div><div><dt>Held-out observations</dt><dd>{count(arrivals.evaluation.holdout_n)}</dd></div></>}</dl></FeatureResult>
      <FeatureResult title="Inventory-aware quotes" value={quotes}><dl className="execution-definitions"><div><dt>Reservation value</dt><dd>{cents(quotes.reservation_price)}</dd></div><div><dt>Model bid / ask</dt><dd>{cents(quotes.bid)} / {cents(quotes.ask)}</dd></div></dl><p className="execution-note">These are model quotes under your risk assumptions, not submitted orders or a promise that someone will trade at them.</p></FeatureResult>
      <FeatureResult title="Settlement versus an exit now" value={settlement}><p className="execution-note">A hypothetical existing position of {count(value.controls?.contracts)} {side} contracts. This does not open, close or read your paper positions.</p><dl className="execution-definitions"><div><dt>Expected settlement value</dt><dd>{dollars(settlement.hold_expected_value)}</dd></div><div><dt>Current exit value after costs</dt><dd>{dollars(settlement.sell_now_value)}</dd></div><div><dt>Release-gated comparison</dt><dd>{settlement.decision?.replaceAll('_',' ')||'No eligible comparison'}</dd></div>{settlement.scenario_decision&&settlement.scenario_decision!==settlement.decision&&<div><dt>Experimental scenario only</dt><dd>{settlement.scenario_decision}</dd></div>}</dl></FeatureResult>
    </div>
    {limitations.length>0&&<details className="method"><summary>Assumptions and validation</summary>{limitations.map((note,index)=><Note key={index} value={typeof note==='string'?note:note.detail}/>)}</details>}
    <div className="execution-result-actions"><button type="button" className="secondary" onClick={()=>exportJSON(value,`${value.ticker}-execution-research.json`)}><ArrowDownToLine size={14}/>Export scenario JSON</button></div>
  </div>;
}
export default function ExecutionLab({market,book,fees,clock,closed,onRefreshDepth,onControlsChange,onAssistant,initialControls=null,model='validated',paperWorkspace=false}){
  const [controls,setControls]=useState(()=>executionControls(initialControls||EXECUTION_DEFAULTS)),[result,setResult]=useState(null),[submitted,setSubmitted]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const request=useRef(null),revision=useRef(0),notify=useRef(onControlsChange),resultsHeading=useRef(null);notify.current=onControlsChange;
  useEffect(()=>()=>request.current?.abort(),[]);
  useEffect(()=>{try{notify.current?.(executionControls(controls));}catch{notify.current?.(null);}},[controls]);
  function change(key,value){request.current?.abort();revision.current++;setLoading(false);setError('');setControls(current=>({...current,[key]:value}));}
  async function run(event){
    event.preventDefault();request.current?.abort();const controller=new AbortController();request.current=controller;const generation=++revision.current;setLoading(true);setError('');
    try{const normalized=executionControls(controls),value=await requestExecution(market.ticker,normalized,{signal:controller.signal,model});if(!controller.signal.aborted&&generation===revision.current){setResult(value);setSubmitted(executionFingerprint(normalized));requestAnimationFrame(()=>resultsHeading.current?.focus());}}
    catch(failure){if(failure.name!=='AbortError'&&!controller.signal.aborted&&generation===revision.current)setError(failure.message);}
    finally{if(!controller.signal.aborted&&generation===revision.current)setLoading(false);}
  }
  let outdated=true;try{outdated=submitted!==executionFingerprint(controls);}catch{}
  return <section className="execution-lab" aria-label="Execution research lab"><div className="readout-heading"><div><span className="eyebrow">Separate research model</span><h3>Execution lab</h3></div><span className="execution-lab-icon"><FlaskConical size={19}/></span></div><p className="execution-intro">Test how trade size, timing and inventory change execution costs. Start with the selected contract’s public book, then compare a risk-aware schedule with an even-paced one.</p>
    <LiveDepth book={book} market={market} controls={controls} fees={fees} clock={clock} closed={closed} onRefresh={onRefreshDepth}/>
    <form className="execution-form" onSubmit={run}><div className="execution-primary-controls"><label>Side<select value={controls.side} onChange={event=>change('side',event.target.value)}><option value="yes">YES</option><option value="no">NO</option></select></label><label>Action<select value={controls.action} onChange={event=>change('action',event.target.value)}><option value="buy">Buy</option><option value="sell">Sell</option></select></label><label>Contracts<input type="number" min="1" max="10000" step="1" required value={controls.contracts} onChange={event=>change('contracts',event.target.value)}/></label><label>Horizon · seconds<input type="number" min="30" max="86400" step="1" required value={controls.horizon_seconds} onChange={event=>change('horizon_seconds',event.target.value)}/></label></div>
      <div className="execution-toggle-heading"><h4>Model components</h4><label className="execution-master-toggle"><input type="checkbox" checked={controls.enabled} onChange={event=>change('enabled',event.target.checked)}/>Enable research model</label></div><div className="execution-toggles">{EXECUTION_FEATURES.map(feature=><label key={feature.key} className={controls.enabled?'':'disabled'}><input type="checkbox" checked={controls[feature.key]} disabled={!controls.enabled} onChange={event=>change(feature.key,event.target.checked)}/><span><strong>{feature.title}</strong><small>{feature.description}</small></span></label>)}</div>
      <details className="execution-assumptions"><summary>Scenario assumptions <small>Editable, not fitted by default</small></summary><p>These starting values are assumptions for comparison. They are not measured impact or volatility estimates for this contract.</p><div className="execution-assumption-grid">{[
        ['volatility','Price volatility · USD / contract / √min','0','1','0.001'],['temporary_impact','Temporary impact · USD × min / contract²','0.00000001','1','any'],['risk_aversion','Risk aversion · 1/USD','0','10','any'],['inventory','Starting inventory · contracts','-10000','10000','1'],['steps','Schedule steps','2','60','1']
      ].map(([key,label,min,max,step])=><label key={key}>{label}<input type="number" min={min} max={max} step={step} required value={controls[key]} onChange={event=>change(key,event.target.value)}/></label>)}</div></details>
      <div className="execution-run"><button className="primary" disabled={loading}>{loading?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>} {loading?'Calculating…':result?'Recalculate scenario':'Run scenario'}</button><span>No orders are sent. A scenario does not use your paper balance.</span></div>
    </form>{error&&<p className="notice error" role="alert">{error}</p>}{loading&&<p className="execution-loading" role="status">Checking the current book and calculating the selected model components…</p>}
    <p className="execution-note"><a href="/research/execution-research-audit.pdf" target="_blank" rel="noreferrer">Methods, tests and source audit (PDF)</a></p>
    {result?<section ref={resultsHeading} tabIndex={-1} aria-label="Submitted execution scenario"><ExecutionResults value={result} outdated={outdated} onAssistant={onAssistant}/></section>:<div className="execution-empty"><FlaskConical size={21}/><div><strong>A comparison you can inspect</strong><p>Run the scenario to see its schedule, cost assumptions, live-data coverage and the unchanged independent outcome forecast.</p></div></div>}
    <details className="execution-feature-result">
      <summary>Compare quantitative model components</summary>
      <QuantScenarios key={market.ticker} workspaceTicker={paperWorkspace?market.ticker:null}/>
    </details>
  </section>;
}
