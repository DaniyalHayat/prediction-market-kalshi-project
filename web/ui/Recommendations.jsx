'use client';
import {useEffect,useState} from 'react';
import {ArrowUpRight,Loader2,RefreshCw,SlidersHorizontal} from 'lucide-react';
import {api,cents,count,dateLabel,dollars,percent} from './api.mjs';
import {createVisibleRefresh,screenFreshness,screenRefreshDelay} from './screen-freshness.mjs';
function DoubleChance({value}){
  if(typeof value==='number')return <strong>{percent(value)}</strong>;
  if(!value||!Number.isFinite(value.probability))return <><strong>{value?.possible?'Possible on a full payout':'Unavailable'}</strong>{value?.reason&&<small>{value.reason}</small>}</>;
  return <><strong>{percent(value.probability)}{value.possible===false?' · not reachable':''}</strong>{Array.isArray(value.interval)&&<small>{value.interval.map(percent).join(' – ')} model range</small>}{value.reason&&<small>{value.reason}</small>}</>;
}
function Candidate({row,budget,onOpen,experimental}){
  const side=String(row.side||'PASS').toUpperCase(),fresh=row._freshness?.current!==false,hasScenario=fresh&&Number.isFinite(row.cost)&&row.contracts>0;
  const probability=Number.isFinite(row.probability_yes)?row.probability_yes:row.probability;
  if(row.paper_scenario)return <article className="recommendation-card" data-recommendation-ticker={row.ticker}><div className="recommendation-heading"><div><small>{row.ticker}</small><h2>{row.title}</h2></div><span className={'verdict '+(row.scenario_eligible?'experimental':'unchecked')}>{side} scenario</span></div>
    {!fresh&&<p className="notice">{row._freshness.reason}</p>}
    {fresh&&<><div className="recommendation-model"><div><span>All-in break-even</span><strong>{cents(row.break_even)}</strong></div><div><span>{Number.isFinite(row.settlement_value)?'Model value at settlement':'Quoted midpoint'}</span><strong>{cents(row.settlement_value??row.quote_reference)}</strong></div><div><span>Entry VWAP</span><strong>{cents(row.price)}</strong></div></div>
      <p className="model-caption">{row.model||'Exchange pricing scenario'} · {count(row.contracts)} contracts for {dollars(row.cost)} with fees</p>
      <div className="budget-projection"><div className="projection-outcomes"><div><span>Full payout balance</span><strong>{dollars(row.win_value)}</strong></div><div><span>Zero payout balance</span><strong>{dollars(row.lose_value)}</strong></div></div></div>
      <div className="recommendation-estimates"><div><span>{Number.isFinite(row.expected_profit)?'Model expected profit':'Additional value needed above quote'}</span><strong>{Number.isFinite(row.expected_profit)?dollars(row.expected_profit):cents(row.required_edge)}</strong>{Number.isFinite(row.tie_value)&&<small>Tie balance {dollars(row.tie_value)}</small>}</div><div><span>Chance of reaching {dollars(row.chance_double?.target)}</span><DoubleChance value={row.chance_double}/></div></div>
    </>}
    <div className="candidate-reasons">{row.reasons.map(reason=><p key={reason}>{reason}</p>)}</div>
    <button className="secondary" onClick={()=>onOpen(row,fresh?budget:undefined)}>{fresh?'Open paper setup':'Inspect fresh evidence'}<ArrowUpRight size={14}/></button>
  </article>;
  return <article className="recommendation-card" data-recommendation-ticker={row.ticker}><div className="recommendation-heading"><div><small>{row.ticker}</small><h2>{row.title}</h2></div><span className={'verdict '+(!fresh?'stale':row.eligible?side.toLowerCase():row.scenario_eligible?'experimental':'pass')}>{!fresh?'STALE':row.eligible?side:row.scenario_eligible?'EXPERIMENTAL':'PASS'}</span></div>
    {!fresh&&<p className="notice" role="status">{row._freshness.reason} Previous profitability projections are withheld.</p>}
    <div className="recommendation-model"><div><span>{Number.isFinite(row.probability_yes)?'Model P(YES)':'Model chance of '+side}</span><strong>{fresh?percent(probability):'Withheld'}</strong></div><div><span>Model range</span><strong>{fresh?(Number.isFinite(row.probability_yes)?row.interval_yes:row.interval)?.map(percent).join(' – ')||'Not established':'Refresh required'}</strong></div><div><span>{side==='PASS'?'Observed ask':side+' entry price'}</span><strong>{fresh?cents(row.price):'Withheld'}</strong></div></div>
    {row.model&&<p className="model-caption">{row.model}{row.experimental||experimental?' · experimental paper scenario':''}</p>}
    {hasScenario&&<><div className="budget-projection"><div className="projection-start"><span>Budget {dollars(budget)}</span><strong>{count(row.contracts)} {side} contracts</strong><small>{dollars(row.cost)} all-in entry · {dollars(row.unspent_cash)} unspent</small></div><div className="projection-outcomes"><div><span>Balance if {side} wins</span><strong>{dollars(row.win_value??row.payout_if_win)}</strong><small>{dollars(row.profit_if_win)} profit after modeled entry costs</small></div><div><span>Balance if {side} loses</span><strong>{dollars(row.lose_value??row.unspent_cash)}</strong><small>{dollars(row.loss_if_lose??row.cost)} maximum entry loss</small></div></div></div>
      <div className="recommendation-estimates"><div><span>Expected profit</span><strong className={row.expected_profit>0?'positive':row.expected_profit<0?'negative':''}>{dollars(row.expected_profit)}</strong><small>{row.expected_profit_range?.map(dollars).join(' to ')} across model range</small></div><div><span>Chance of reaching {dollars(row.chance_double?.target??budget*2)}</span><DoubleChance value={row.chance_double}/></div></div>
      {Number.isFinite(row.max_entry_price)&&<p className="price-discipline">All-in entry ceiling: {cents(row.max_entry_price)} per contract. {row.max_entry_price_note||row.price_reason}</p>}
      {row.risk_size&&<details className="method"><summary>Risk-constrained size</summary><p>{count(row.risk_size.contracts)} contracts · {dollars(row.risk_size.cost)} modeled cost.</p><p>{row.risk_size.scope}</p></details>}
    </>}
    <div className="candidate-reasons">{(row.reasons||[row.reason]).filter(Boolean).map((reason,i)=><p key={i}>{reason}</p>)}</div>
    <button className="secondary" onClick={()=>onOpen(row,fresh?budget:undefined)}>{!fresh?'Inspect fresh evidence':hasScenario?'Open paper setup':'Inspect evidence'}<ArrowUpRight size={14}/></button>
  </article>;
}
export default function Recommendations({category='sports',categoryName='Sports',model='validated',onOpen}){
  const [input,setInput]=useState('20'),[budget,setBudget]=useState(20),[screen,setScreen]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0),[showAll,setShowAll]=useState(false),[clock,setClock]=useState(Date.now());
  const requestedBudget=Number(input),valid=Number.isFinite(requestedBudget)&&requestedBudget>=1&&requestedBudget<=10000;
  const requestKey=JSON.stringify([category,budget,model,revision]);
  const budgetPending=valid&&requestedBudget!==budget;
  const value=!budgetPending&&screen?.requestKey===requestKey?screen.result:null;
  useEffect(()=>{const number=Number(input);if(!Number.isFinite(number)||number<1||number>10000)return;const timer=setTimeout(()=>setBudget(number),350);return()=>clearTimeout(timer);},[input]);
  useEffect(()=>{
    let stopped=false,nextDue=0;
    setScreen(null);setError('');setBusy(true);
    const refresher=createVisibleRefresh(async(signal,force)=>{
      if(!force&&Date.now()<nextDue)return;setBusy(true);nextDue=Date.now()+20000;
      try{const result=await api('/api/workspace/recommendations?'+new URLSearchParams({category,budget:String(budget),model}),{signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
        if(!stopped&&!signal.aborted&&!document.hidden){const now=Date.now(),expiry=[...(result.candidates||[]),...(result.paper_scenarios||[]),...(result.watchlist||[])].map(row=>screenFreshness(row,{now,checkedAt:result.as_of}).expires_at).filter(Number.isFinite);
          nextDue=Math.max(now+10000,Math.min(now+screenRefreshDelay(result),expiry.length?Math.min(...expiry)-5000:Infinity));setClock(now);setScreen({requestKey,result});setError('');}}
      catch(e){if(!stopped&&!signal.aborted&&!document.hidden){setError(e.name==='TimeoutError'?'This screen took too long. Retry when the sources are ready.':e.message);nextDue=Date.now()+20000;}}
      finally{if(!stopped)setBusy(false);}
    },{visible:()=>!document.hidden&&!stopped});
    const tick=()=>{if(!document.hidden){setClock(Date.now());refresher.refresh();}},visible=()=>{if(!document.hidden)setClock(Date.now());refresher.visibilityChanged();};
    setClock(Date.now());refresher.refresh(true);const timer=setInterval(tick,5000);document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;refresher.stop();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[category,budget,model,requestKey]);
  const ranked=Array.isArray(value?.candidates)?value.candidates:[],separateWatchlist=Array.isArray(value?.watchlist);
  const labelFreshness=row=>({...row,_freshness:screenFreshness(row,{now:clock,checkedAt:value?.as_of,error})});
  const rankedRows=ranked.map(labelFreshness),qualified=rankedRows.filter(row=>row._freshness.current&&(separateWatchlist||row.eligible||model==='challenger'&&row.scenario_eligible));
  const scenarios=(value?.paper_scenarios||[]).map(labelFreshness),scenarioTickers=new Set(scenarios.map(row=>row.ticker));
  const withheld=rankedRows.filter(row=>!qualified.includes(row)),watchlist=(separateWatchlist?[...withheld,...value.watchlist.map(labelFreshness)]:withheld).filter(row=>!scenarioTickers.has(row.ticker)),candidates=[...qualified,...scenarios,...watchlist],staleCount=candidates.filter(row=>!row._freshness.current).length;
  return <section className="workspace-page recommendations-page" aria-labelledby="recommendations-title">
    <div className="page-heading"><div><span className="eyebrow">{categoryName} · paper trading</span><h1 id="recommendations-title">Recommended trades</h1><p>Compare model-backed ideas and priced paper setups at the latest observed depth.</p></div><button className="secondary" onClick={()=>setRevision(v=>v+1)} disabled={busy}><RefreshCw size={15} className={busy?'spin':''}/>Refresh screen</button></div>
    <div className="screen-controls"><label><span>Paper budget per scenario</span><div className="currency-input"><b>$</b><input type="number" min="1" max="10000" step="1" value={input} onChange={e=>setInput(e.target.value)} aria-describedby="budget-explanation"/></div></label><div><strong>{model==='challenger'?'Experimental ensemble':'Baseline model'}</strong><p id="budget-explanation">Each card uses the same budget independently. The cards do not form a jointly funded portfolio.</p></div><span className="screen-count"><SlidersHorizontal size={16}/>{qualified.length} current · {candidates.length} screened{staleCount?' · '+staleCount+' stale':''}</span></div>
    {!valid&&<p className="notice" role="status">Enter a paper budget from $1 to $10,000. The last valid screen stays visible.</p>}
    {model==='challenger'&&<p className="notice experimental-note"><strong>Experimental paper research.</strong> This model has a measured holdout comparison, with statistical uncertainty. Experimental scenarios remain separate from validated release gates.</p>}
    {error&&<p className="notice error" role="alert">{error}<button className="text-button" onClick={()=>setRevision(v=>v+1)}>Try again</button></p>}
    {(busy||budgetPending)&&!value&&<div className="workspace-empty" role="status"><Loader2 size={25} className="spin"/><h2>Screening matching contracts</h2><p>Checking independent models, fresh depth and budget-sized costs.</p></div>}
    {value&&<><div className="screen-result-heading"><h2>{qualified.length?'Model-backed entries':scenarios.length?'Ranked paper setups':'Watchlist'}</h2><small>{dollars(budget)} per setup · Checked {dateLabel(value.as_of)}{busy?' · refreshing':''}</small></div>
      {!qualified.length&&scenarios.length>0&&<p className="notice">Model ideas rank by estimated value after cost. Where outcome evidence is thin, the closest break-even setups rank first.</p>}
      <div className="recommendation-grid">{qualified.map(row=><Candidate key={row.ticker+'#'+row.side} row={row} budget={budget} experimental={model==='challenger'} onOpen={onOpen}/>)}</div>
      {qualified.length>0&&scenarios.length>0&&<h2 className="watchlist-title">More paper setups</h2>}
      {scenarios.length>0&&<div className="recommendation-grid">{scenarios.slice(0,showAll?scenarios.length:6).map(row=><Candidate key={row.ticker+'#'+row.side} row={row} budget={budget} onOpen={onOpen}/>)}</div>}
      {scenarios.length>6&&!watchlist.length&&<button className="text-button" onClick={()=>setShowAll(v=>!v)}>{showAll?'Show fewer':'Show all setups'}</button>}
      {watchlist.length>0&&<><div className="section-title watchlist-title"><h2>Screened watchlist <span>{watchlist.length}</span></h2><button className="text-button" onClick={()=>setShowAll(v=>!v)}>{showAll?'Show fewer':'Show all'}</button></div><div className="recommendation-grid">{watchlist.slice(0,showAll?watchlist.length:6).map(row=><Candidate key={row.ticker+'#'+row.side} row={row} budget={budget} onOpen={onOpen}/>)}</div></>}
      {!candidates.length&&<p className="empty">No supported contracts were returned for this bounded category sample.</p>}
      <details className="method"><summary>Coverage and calculation assumptions</summary>{value.scope&&<p>{value.scope}</p>}{value.coverage&&<pre>{typeof value.coverage==='string'?value.coverage:JSON.stringify(value.coverage,null,2)}</pre>}{Array.isArray(value.assumptions)?value.assumptions.map((item,i)=><p key={i}>{typeof item==='string'?item:JSON.stringify(item)}</p>):value.assumptions&&<p>{typeof value.assumptions==='string'?value.assumptions:JSON.stringify(value.assumptions)}</p>}<p>Expected profit is a probability-weighted estimate, not a future balance. A binary contract has discrete win and loss outcomes. Chance of doubling applies to the displayed target and includes the entry scenario’s fees and unused budget.</p></details>
    </>}
  </section>;
}
