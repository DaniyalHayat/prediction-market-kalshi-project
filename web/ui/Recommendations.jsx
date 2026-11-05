'use client';
import {useEffect,useState} from 'react';
import {ArrowUpRight,Loader2,RefreshCw,SlidersHorizontal} from 'lucide-react';
import {api,cents,count,dateLabel,dollars,percent} from './api.mjs';
import {createVisibleRefresh,screenFreshness,screenRefreshDelay} from './screen-freshness.mjs';
function DoubleChance({value}){
  if(typeof value==='number')return <strong>{percent(value)}</strong>;
  if(!value||!Number.isFinite(value.probability))return <strong>Not established</strong>;
  return <><strong>{percent(value.probability)}{value.possible===false?' · not reachable':''}</strong>{Array.isArray(value.interval)&&<small>{value.interval.map(percent).join(' – ')} model range</small>}{value.reason&&<small>{value.reason}</small>}</>;
}
function Candidate({row,budget,onOpen,experimental}){
  const side=String(row.side||'PASS').toUpperCase(),fresh=row._freshness?.current!==false,hasScenario=fresh&&Number.isFinite(row.cost)&&row.contracts>0;
  const probability=Number.isFinite(row.probability_yes)?row.probability_yes:row.probability;
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
  const [input,setInput]=useState('20'),[budget,setBudget]=useState(20),[value,setValue]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0),[showAll,setShowAll]=useState(false),[clock,setClock]=useState(Date.now());
  useEffect(()=>{const number=Number(input);if(!Number.isFinite(number)||number<1||number>10000)return;const timer=setTimeout(()=>setBudget(number),350);return()=>clearTimeout(timer);},[input]);
  useEffect(()=>{
    let stopped=false,nextDue=0;
    setValue(null);setError('');setBusy(true);
    const refresher=createVisibleRefresh(async(signal,force)=>{
      if(!force&&Date.now()<nextDue)return;setBusy(true);nextDue=Date.now()+20000;
      try{const result=await api('/api/workspace/recommendations?'+new URLSearchParams({category,budget:String(budget),model}),{signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
        if(!stopped&&!signal.aborted&&!document.hidden){const now=Date.now(),expiry=[...(result.candidates||[]),...(result.watchlist||[])].map(row=>screenFreshness(row,{now,checkedAt:result.as_of}).expires_at).filter(Number.isFinite);
          nextDue=Math.max(now+10000,Math.min(now+screenRefreshDelay(result),expiry.length?Math.min(...expiry)-5000:Infinity));setClock(now);setValue(result);setError('');}}
      catch(e){if(!stopped&&!signal.aborted&&!document.hidden){setError(e.name==='TimeoutError'?'This screen took too long. Retry when the sources are ready.':e.message);nextDue=Date.now()+20000;}}
      finally{if(!stopped)setBusy(false);}
    },{visible:()=>!document.hidden&&!stopped});
    const tick=()=>{if(!document.hidden){setClock(Date.now());refresher.refresh();}},visible=()=>{if(!document.hidden)setClock(Date.now());refresher.visibilityChanged();};
    setClock(Date.now());refresher.refresh(true);const timer=setInterval(tick,5000);document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;refresher.stop();clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[category,budget,model,revision]);
  const ranked=Array.isArray(value?.candidates)?value.candidates:[],separateWatchlist=Array.isArray(value?.watchlist);
  const labelFreshness=row=>({...row,_freshness:screenFreshness(row,{now:clock,checkedAt:value?.as_of,error})});
  const rankedRows=ranked.map(labelFreshness),qualified=rankedRows.filter(row=>row._freshness.current&&(separateWatchlist||row.eligible||model==='challenger'&&row.scenario_eligible));
  const withheld=rankedRows.filter(row=>!qualified.includes(row)),watchlist=separateWatchlist?[...withheld,...value.watchlist.map(labelFreshness)]:withheld,candidates=[...qualified,...watchlist],staleCount=candidates.filter(row=>!row._freshness.current).length;
  const valid=Number.isFinite(Number(input))&&Number(input)>=1&&Number(input)<=10000;
  return <section className="workspace-page recommendations-page" aria-labelledby="recommendations-title">
    <div className="page-heading"><div><span className="eyebrow">{categoryName} · independent research</span><h1 id="recommendations-title">Recommended trades</h1><p>Ranked by modeled value after visible entry costs, fees and uncertainty.</p></div><button className="secondary" onClick={()=>setRevision(v=>v+1)} disabled={busy}><RefreshCw size={15} className={busy?'spin':''}/>Refresh screen</button></div>
    <div className="screen-controls"><label><span>Paper budget per scenario</span><div className="currency-input"><b>$</b><input type="number" min="1" max="10000" step="1" value={input} onChange={e=>setInput(e.target.value)} aria-describedby="budget-explanation"/></div></label><div><strong>{model==='challenger'?'Experimental ensemble':'Validated model view'}</strong><p id="budget-explanation">Each card uses the same budget independently. The cards do not form a jointly funded portfolio.</p></div><span className="screen-count"><SlidersHorizontal size={16}/>{qualified.length} current · {candidates.length} screened{staleCount?' · '+staleCount+' stale':''}</span></div>
    {!valid&&<p className="notice" role="status">Enter a paper budget from $1 to $10,000. The last valid screen stays visible.</p>}
    {model==='challenger'&&<p className="notice experimental-note"><strong>Experimental paper research.</strong> This model has a measured holdout comparison, with statistical uncertainty. Experimental scenarios remain separate from validated release gates.</p>}
    {error&&<p className="notice error" role="alert">{error}<button className="text-button" onClick={()=>setRevision(v=>v+1)}>Try again</button></p>}
    {busy&&!value&&<div className="workspace-empty" role="status"><Loader2 size={25} className="spin"/><h2>Screening matching contracts</h2><p>Checking independent models, fresh depth and budget-sized costs.</p></div>}
    {value&&<><div className="screen-result-heading"><h2>{qualified.length?'Current candidates':staleCount?'Candidates awaiting a fresh check':'No qualifying entries in this screen'}</h2><small>Checked {dateLabel(value.as_of)}{busy?' · refreshing':''}</small></div>
      {!qualified.length&&<p className="notice">{staleCount?'Expired or failed screens are withheld until their quotes and independent sources can be checked again.':'The current evidence did not support a qualifying entry. The watchlist below shows available model estimates, budget scenarios and the exact reason each trade was withheld.'}</p>}
      <div className="recommendation-grid">{qualified.map(row=><Candidate key={row.ticker+'#'+row.side} row={row} budget={budget} experimental={model==='challenger'} onOpen={onOpen}/>)}</div>
      {watchlist.length>0&&<><div className="section-title watchlist-title"><h2>Screened watchlist <span>{watchlist.length}</span></h2><button className="text-button" onClick={()=>setShowAll(v=>!v)}>{showAll?'Show fewer':'Show all'}</button></div><div className="recommendation-grid">{watchlist.slice(0,showAll?watchlist.length:6).map(row=><Candidate key={row.ticker+'#'+row.side} row={row} budget={budget} onOpen={onOpen}/>)}</div></>}
      {!candidates.length&&<p className="empty">No supported contracts were returned for this bounded category sample.</p>}
      <details className="method"><summary>Coverage and calculation assumptions</summary>{value.scope&&<p>{value.scope}</p>}{value.coverage&&<pre>{typeof value.coverage==='string'?value.coverage:JSON.stringify(value.coverage,null,2)}</pre>}{Array.isArray(value.assumptions)?value.assumptions.map((item,i)=><p key={i}>{typeof item==='string'?item:JSON.stringify(item)}</p>):value.assumptions&&<p>{typeof value.assumptions==='string'?value.assumptions:JSON.stringify(value.assumptions)}</p>}<p>Expected profit is a probability-weighted estimate, not a future balance. A binary contract has discrete win and loss outcomes. Chance of doubling applies to the displayed target and includes the entry scenario’s fees and unused budget.</p></details>
    </>}
  </section>;
}
