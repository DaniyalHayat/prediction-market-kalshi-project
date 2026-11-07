'use client';
import {useMemo,useRef,useState,useEffect} from 'react';
import {ArrowUpRight,Download,Loader2,Wallet} from 'lucide-react';
import {evaluatePaperPortfolio} from '../lib/workspace/positions.mjs';
import {api,cents,count,dateLabel,dollars,exportJSON,percent} from './api.mjs';
import usePortfolioFeed from './usePortfolioFeed.jsx';
import {portfolioTickers} from './paper-state.mjs';
import {portfolioTotals} from './portfolio-state.mjs';
import {paperCapital} from './paper-capital.mjs';
import Chart from './Chart.jsx';
import PaperCash from './PaperCash.jsx';
import {emitAnalytics} from '../app/components/analytics-policy.mjs';
import PositionReview from './PositionReview.jsx';
export default function Portfolio({onOpen,onMarkets,paperLedger,reviews,clock=Date.now(),model='validated',theme='graphite'}){
  const {engine,ledger,bankroll,adjustCash,commit,storageError,retry,retrying}=paperLedger;
  const [riskLimit,setRiskLimit]=useState(''),[showClosed,setShowClosed]=useState(false),[busy,setBusy]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState(''),[observations,setObservations]=useState([]);
  const acting=useRef(false),lastSample=useRef(0);
  const tickers=useMemo(()=>portfolioTickers(ledger?.positions),[ledger]);
  const {books,research,status,refreshing}=usePortfolioFeed(tickers,model);
  const evaluations=useMemo(()=>evaluatePaperPortfolio(ledger?.positions||[],books,Object.fromEntries(Object.entries(research).filter(([,value])=>value?.view_model===model)),
    {now:clock,experimental:model==='challenger',maxPositionLoss:riskLimit!==''&&Number.isFinite(Number(riskLimit))?Number(riskLimit):undefined}),[ledger,books,research,clock,riskLimit,model]);
  const totals=useMemo(()=>portfolioTotals(ledger,evaluations),[ledger,evaluations]);
  const capital=useMemo(()=>{try{return paperCapital(ledger,Number(bankroll));}catch{return null;}},[ledger,bankroll]);
  useEffect(()=>{if(!ledger||!totals.fully_marked||document.hidden||clock-lastSample.current<5000)return;lastSample.current=clock;
    setObservations(rows=>[...rows,{time:new Date(clock).toISOString(),value:totals.realized+totals.unrealized}].slice(-240));
  },[clock,ledger,totals.fully_marked,totals.realized,totals.unrealized]);
  async function close(position,fraction=1){
    if(acting.current)return;acting.current=true;setBusy(position.id);setError('');setMessage('');
    try{
      const quote=await api('/api/book?ticker='+encodeURIComponent(position.ticker)+'&contracts='+position.remaining_quantity);
      let recorded;
      await commit(current=>{const actual=current.positions.find(row=>row.id===position.id);if(!actual?.remaining_quantity)throw new Error('This paper position is already closed.');
        const requested=fraction===1?actual.remaining_quantity:Math.min(actual.remaining_quantity,Math.max(.01,Math.floor(actual.remaining_quantity*fraction*100)/100));
        recorded=engine.estimate(quote,actual.ticker,actual.side,'sell',requested,{coefficient:actual.entry_assumptions?.coefficient??.07,slippage:2,live:true});
        return engine.applyClose(current,actual.id,recorded,{id:crypto.randomUUID()});});
      setMessage(`Recorded ${count(recorded.filled)} paper contracts closed for ${dollars(recorded.cash)} net of modeled exit fees.${recorded.unfilled?' Unfilled contracts remain open.':''}`);
      emitAnalytics('paper_close',{ticker:position.ticker});
    }catch(e){setError(e.message);}finally{acting.current=false;setBusy('');}
  }
  async function settle(position){
    if(acting.current)return;acting.current=true;setBusy(position.id);setError('');setMessage('');
    try{const evidence=await api('/api/workspace/context?ticker='+encodeURIComponent(position.ticker));
      await commit(current=>engine.applySettlement(current,position.id,evidence,{id:crypto.randomUUID()}));setMessage('Recorded the confirmed exchange result in your paper ledger.');
    }catch(e){setError(e.message);}finally{acting.current=false;setBusy('');}
  }
  async function inspect(position,budget){setError('');try{await onOpen(position,budget);}catch(e){setError(e.message);}}
  const rows=(ledger?.positions||[]).filter(row=>showClosed||row.remaining_quantity>1e-8);
  return <section className="workspace-page portfolio-page" aria-labelledby="portfolio-title">
    <div className="page-heading"><div><span className="eyebrow">Your paper account</span><h1 id="portfolio-title">Portfolio</h1><p>Live bid-side value, recorded costs and a fresh review of each open position.</p></div><button className="secondary" disabled={!ledger} onClick={()=>exportJSON({...ledger,exported_at:new Date().toISOString(),classification:'SIMULATED PAPER RECORDS'},'predictir-paper-ledger.json')}><Download size={15}/>Export ledger</button></div>
    {model==='challenger'&&<p className="notice experimental-note"><strong>Experimental ensemble selected.</strong> Model comparisons are paper research. Unmet release requirements remain visible in each action.</p>}
    <div className="portfolio-metrics"><div><span>Available paper cash</span><strong>{dollars(capital?.available)}</strong></div><div><span>Open cost basis</span><strong>{dollars(totals.open_basis)}</strong></div><div><span>Net bid exit value</span><strong>{dollars(totals.marked_value)}</strong></div><div><span>Unrealized P/L</span><strong className={totals.unrealized>0?'positive':totals.unrealized<0?'negative':''}>{dollars(totals.unrealized)}</strong></div><div><span>Realized P/L</span><strong className={totals.realized>0?'positive':totals.realized<0?'negative':''}>{dollars(totals.realized)}</strong></div></div>
    <PaperCash capital={capital} ledger={ledger} onAdjust={adjustCash}/>
    <div className="portfolio-controls"><label>Optional per-position loss limit, $<input type="number" min="0" max="1000000000" placeholder="No limit set" value={riskLimit} onChange={e=>setRiskLimit(e.target.value)}/></label><span className="live-label"><span className="status-dot"/>{tickers.length} open contracts{refreshing&&<><Loader2 size={13} className="spin"/>Refreshing research</>}</span></div>
    {storageError&&<p className="notice error" role="alert">{storageError}<button className="text-button" disabled={retrying} onClick={retry}>{retrying?'Reconnecting…':'Retry paper account'}</button></p>}{error&&<p className="notice error" role="alert">{error}</p>}{message&&<p className="notice success" role="status">{message}</p>}
    {!totals.fully_marked&&totals.open_count>0&&<p className="notice">Full-portfolio exit value and unrealized P/L wait until every open position has enough fresh executable depth. Partial and stale marks are not treated as complete fills.</p>}
    {observations.length>1&&<details className="portfolio-performance"><summary>Observed portfolio P/L this session</summary><Chart rows={observations} unit="usd" height={180} theme={theme} label="Observed paper portfolio profit and loss during this visible session"/><p className="footnote">Realized P/L plus complete net bid marks, sampled while this view is visible. This series is not backfilled and resets when the page reloads.</p></details>}
    <div className="section-title portfolio-list-title"><h2>My Trades <span>{totals.open_count} open</span></h2><label className="checkbox-label"><input type="checkbox" checked={showClosed} onChange={e=>setShowClosed(e.target.checked)}/>Include closed</label></div>
    {reviews.notification==='default'&&<button className="text-button" onClick={reviews.enableNotifications}>Enable desktop sell alerts</button>}
    {!ledger&&<p className="loading-section" role="status"><Loader2 size={18} className="spin"/>Loading this device’s ledger…</p>}
    {ledger&&!rows.length&&<div className="workspace-empty"><Wallet size={28}/><h2>No {showClosed?'recorded':'open'} paper positions</h2><p>A paper buy appears here immediately. Its marks use actual matching bid depth and modeled exit fees.</p><button className="primary" onClick={onMarkets}>Explore markets <ArrowUpRight size={15}/></button></div>}
    <div className="position-grid">{rows.map(position=>{const value=evaluations[position.id],closed=position.remaining_quantity<=1e-8;
      return <article className="position-card" key={position.id} data-position-id={position.id}><div className="position-card-heading"><div><span className="position-side">{position.side.toUpperCase()} · {count(position.remaining_quantity)} contracts</span><button className="position-title" onClick={()=>inspect(position)}>{position.title||position.ticker}<ArrowUpRight size={14}/></button><small>{position.ticker}</small></div><span className={'action-badge '+value.action.toLowerCase()}>{value.action}</span></div>
        <div className="position-values"><div><span>Remaining basis</span><strong>{dollars(position.remaining_basis)}</strong></div><div><span>Net exit value</span><strong>{dollars(value.marked_value)}</strong></div><div><span>Unrealized P/L</span><strong className={value.unrealized_pnl>0?'positive':value.unrealized_pnl<0?'negative':''}>{dollars(value.unrealized_pnl)}</strong></div><div><span>Realized P/L</span><strong>{dollars(position.realized_pnl)}</strong></div></div>
        {!closed&&<><div className="position-review"><strong>{value.action==='REVIEW'?'Evidence check':value.action==='SETTLE'?'Confirmed result':'Position review'}</strong><p>{value.reason}</p>{value.liquidity_allocation&&<p className="footnote">{value.liquidity_allocation}</p>}{value.source_as_of&&<p className="footnote">Model data {dateLabel(value.source_as_of)} · {value.forecast_fresh?'current':'expired or unavailable for actions'}</p>}{Number.isFinite(value.probability)&&<div className="review-range"><span>Model chance of {position.side.toUpperCase()} <b>{percent(value.probability)}</b></span><span>Range <b>{value.interval?.map(percent).join(' – ')}</b></span></div>}{Array.isArray(value.expected_hold_profit_range)&&<p className="footnote">Expected payoff less remaining basis: {value.expected_hold_profit_range.map(dollars).join(' to ')} across the model range. This is distinct from the current bid exit.</p>}</div>
        <div className="position-footer"><small>{value.action==='SETTLE'?'Final exchange result':status[position.ticker]||value.status} · {value.as_of?dateLabel(value.as_of):'Waiting for matching quote'}{value.model&&<span>{value.model}</span>}</small><div className="toolbar">{value.action==='SETTLE'?<button className="primary" disabled={!!busy||!engine} onClick={()=>settle(position)}>{busy===position.id?'Verifying…':'Record settlement'}</button>:<><button className="secondary" disabled={!!busy||!engine||!value.fresh||!value.executable_quantity} onClick={()=>close(position)}>{busy===position.id?'Checking bids…':'Close at bids'}</button>{value.action==='TRIM'&&value.suggested_reduce_fraction>0&&<button className="secondary" disabled={!!busy||!engine} onClick={()=>close(position,value.suggested_reduce_fraction)}>Trim {percent(value.suggested_reduce_fraction)}</button>}</>}</div></div></>}
        {!closed&&value.action!=='SETTLE'&&<PositionReview position={position} reviews={reviews} onOpen={inspect}/>}
        {closed&&<p className="footnote">{position.settlement_result?'Settled '+position.settlement_result.toUpperCase():'Closed at recorded bids'} · {dateLabel(position.closed_at)}</p>}
      </article>;
    })}</div>
    <p className="footnote">The tracker streams up to 12 contracts and batches quotes for larger portfolios. Enabled position scans run about every 25 minutes while Predictir is open and visible. A SELL signal appears in the app and can also show a desktop alert. Entries and exits always require your click.</p>
  </section>;
}
