'use client';
import {useEffect,useMemo,useState} from 'react';
import {Download} from 'lucide-react';
import {sizePaperPosition} from '../lib/paper/risk.ts';
import {api,dollars,count,exportJSON} from './api.mjs';
import {journalToken} from './Journal.jsx';
import {paperCapital} from './paper-capital.mjs';
const STORAGE='predictir:paper-journal:v1';
const BANKROLL='predictir:paper-starting-balance:v1';
export default function Paper({market,book,forecast,fees,now=Date.now()}) {
  const [engine,setEngine]=useState(null),[ledger,setLedger]=useState(null),[bankroll,setBankroll]=useState(1000),[budget,setBudget]=useState(25),
    [low,setLow]=useState(''),[point,setPoint]=useState(''),[high,setHigh]=useState(''),[side,setSide]=useState('yes'),[quantity,setQuantity]=useState(10),
    [message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const coefficient=fees?.coefficient??.07;
  const closed=['closed','settled','finalized'].includes(market.status)||Date.parse(market.close_time)<=now;
  const canEnter=['active','open'].includes(market.status)&&Number.isFinite(Date.parse(market.close_time))&&Date.parse(market.close_time)>now;
  const entered=[low,point,high].map(value=>value===''?NaN:Number(value)/100);
  const validForecast=entered.every(Number.isFinite)&&0<=entered[0]&&entered[0]<=entered[1]&&entered[1]<=entered[2]&&entered[2]<=1;
  const capital=useMemo(()=>{try{return paperCapital(ledger,Number(bankroll));}catch{return null;}},[ledger,bankroll]);
  useEffect(()=>{let disposed=false;import('../public/dashboard/paper.js').then(()=>{if(disposed)return;const api=globalThis.KalshiPaper;setEngine(api);try{setLedger(api.readLedger(localStorage.getItem(STORAGE)));const saved=Number(localStorage.getItem(BANKROLL));if(saved>0&&Number.isFinite(saved))setBankroll(saved);}catch{setLedger(api.emptyLedger());setError('Browser storage is unavailable; export the paper journal to keep it.');}}).catch(()=>{if(!disposed)setError('The paper engine could not load. Refresh to try again.');});return()=>{disposed=true;};},[]);
  function changeBankroll(value){setBankroll(value);if(Number(value)>0&&Number.isFinite(Number(value)))try{localStorage.setItem(BANKROLL,value);}catch{setError('Starting balance could not be saved on this device.');}}
  function save(next){setLedger(next);try{localStorage.setItem(STORAGE,JSON.stringify(next));}catch{setError('Browser storage is unavailable; export the paper journal to keep it.');}}
  const sizing=useMemo(()=>{
    if(!book||[low,point,high].some(v=>v===''))return null;
    if(closed)return {error:'This contract has closed. A new paper entry cannot be recorded.'};
    if(!canEnter)return {error:'The contract must be confirmed open with a future close time.'};
    if(!capital||capital.available<=0)return {error:'No uncommitted simulated cash is available for another entry.'};
    const a=Number(low)/100,b=Number(high)/100,p=Number(point)/100;if(!Number.isFinite(p)||p<a||p>b)return {error:'The probability must be inside the range'};
    try{return sizePaperPosition({ticker:market.ticker,quoteTicker:book.ticker,asOf:book.as_of,bankroll:capital.available,budget:Math.min(Number(budget),capital.available),
      probabilityLow:side==='yes'?a:1-b,probabilityHigh:side==='yes'?b:1-a,riskFraction:.99,feeCoefficient:coefficient,
      levels:(book.raw?.orderbook_fp?.[side==='yes'?'no_dollars':'yes_dollars']||[]).map(([p,q])=>({price:1-Number(p),quantity:Number(q)}))},now);}
    catch(e){return {error:e.message};}
  },[book,low,point,high,capital,budget,side,market.ticker,coefficient,closed,canEnter,now]);
  async function open() {
    setError('');setMessage('');setBusy(true);
    try{if(!['active','open'].includes(market.status)||!Number.isFinite(Date.parse(market.close_time))||Date.parse(market.close_time)<=Date.now())throw new Error('The contract is not confirmed open before its trading close');
      const available=paperCapital(ledger,Number(bankroll)).available;
      if(available<=0)throw new Error('No uncommitted simulated cash remains');
      if(ledger.positions.length>=1000)throw new Error('This paper ledger reached its retained-history limit. Export it before starting a new ledger.');
      const fresh=await api('/api/book?ticker='+encodeURIComponent(market.ticker)+'&contracts='+quantity);
      const execution=engine.estimate(fresh,market.ticker,side,'buy',Number(quantity),{coefficient,slippage:2,budget:Math.min(Number(budget),available),live:true});
      if(execution.cash>available+1e-8)throw new Error('The simulated purchase exceeds available cash');
      save(engine.applyOpen(ledger,execution,{id:crypto.randomUUID(),title:market.title}));setMessage(`Recorded ${count(execution.filled)} paper contracts for ${dollars(execution.cash)}, including fees.`);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function close(position) {
    setBusy(true);setError('');setMessage('');
    try{const fresh=await api('/api/book?ticker='+encodeURIComponent(position.ticker)+'&contracts='+position.remaining_quantity);
      const execution=engine.estimate(fresh,position.ticker,position.side,'sell',position.remaining_quantity,{coefficient:position.entry_assumptions.coefficient,slippage:2,live:true});
      save(engine.applyClose(ledger,position.id,execution,{id:crypto.randomUUID()}));setMessage(`Paper close recorded for ${count(execution.filled)} contracts at observed bids.`);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function freeze() {
    setBusy(true);setError('');setMessage('');
    try{await api('/api/journal',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+journalToken()},
      body:JSON.stringify({ticker:market.ticker,probability:Number(point)/100,probability_low:Number(low)/100,probability_high:Number(high)/100})});setMessage('Forecast registered. It will be scored after the exchange reports a binary settlement.');}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <div className="paper-panel"><div className="section-title"><h3>Paper position</h3><span className="tag">Simulation</span></div><p className="muted">Use your own probability range, then check the size against visible depth and modeled fees.</p>
    <div className="field-grid"><label>Simulated starting balance, $<input type="number" min="1" value={bankroll} onChange={e=>changeBankroll(e.target.value)}/></label><label>Maximum entry loss, $<input type="number" min="0.01" step="1" value={budget} onChange={e=>setBudget(e.target.value)}/></label></div>
    {capital&&<div className="paper-cash"><span>Available paper cash <strong>{dollars(capital.available)}</strong></span><span>Committed cost basis <strong>{dollars(capital.committed)}</strong></span><span>Realized P/L <strong>{dollars(capital.realized)}</strong></span></div>}
    {capital?.shortfall>0&&<p className="notice">The retained ledger exceeds the entered starting balance by {dollars(capital.shortfall)}. New entries are blocked.</p>}
    <div className="field-grid three"><label>Lower, %<input type="number" min="0" max="100" value={low} onChange={e=>setLow(e.target.value)}/></label><label>Your estimate, %<input type="number" min="0" max="100" value={point} onChange={e=>setPoint(e.target.value)}/></label><label>Upper, %<input type="number" min="0" max="100" value={high} onChange={e=>setHigh(e.target.value)}/></label></div>
    {Number.isFinite(forecast?.probability)&&Array.isArray(forecast.interval)&&forecast.interval.length===2&&<button className="text-button" onClick={()=>{setPoint((forecast.probability*100).toFixed(2));setLow((forecast.interval[0]*100).toFixed(2));setHigh((forecast.interval[1]*100).toFixed(2));}}>Use the model as a scenario</button>}
    <div className="segmented"><button aria-pressed={side==='yes'} onClick={()=>setSide('yes')}>YES</button><button aria-pressed={side==='no'} onClick={()=>setSide('no')}>NO</button></div>
    {sizing&&!sizing.error&&<div className="sizing-result"><strong>{sizing.contracts?`${sizing.contracts} ${side.toUpperCase()} contracts`:'No position under this range'}</strong><span>{dollars(sizing.cost)} maximum modeled loss · worst-case log-growth criterion</span></div>}
    {sizing?.error&&<p className="notice">{sizing.error}</p>}
    <div className="field-grid"><label>Paper contracts<input type="number" min="1" max="10000" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><div className="field-action">{sizing?.contracts>0&&<button className="secondary" onClick={()=>setQuantity(sizing.contracts)}>Use calculated size</button>}</div></div>
    <div className="toolbar"><button className="primary" disabled={!engine||!book||busy||!canEnter||!capital?.available} onClick={open}>{busy?'Checking…':'Record paper buy'}</button><button className="secondary" disabled={!validForecast||busy||!canEnter} onClick={freeze}>Register forecast</button></div>
    <p className="footnote">Fee coefficient {coefficient.toFixed(4)}{fees?.coefficient===null||!fees?' is a general assumption':' from series metadata'}. Entry is limited to observed asks within 2¢; a real fill is not assumed. Available cash is based on the retained paper ledger, with close proceeds and fees included. The starting balance is your simulation assumption, not an account balance. It and sizing stay on this device.</p>
    {message&&<p className="notice success" role="status">{message}</p>}{error&&<p className="notice error" role="alert">{error}</p>}
    <div className="section-title"><h3>Paper ledger</h3><button className="text-button" disabled={!ledger} onClick={()=>exportJSON(ledger,'kalshi-paper-ledger.json')}><Download size={14}/>Export</button></div>
    {ledger?.positions.length?<div className="table-scroll"><table><thead><tr><th>Position</th><th>Open contracts</th><th>Open basis</th><th>Realized P/L</th><th/></tr></thead><tbody>{ledger.positions.map(p=><tr key={p.id}><td><strong>{p.side.toUpperCase()}</strong><small>{p.title||p.ticker}</small></td><td>{count(p.remaining_quantity)}</td><td>{dollars(p.remaining_basis)}</td><td>{dollars(p.realized_pnl)}</td><td>{p.remaining_quantity>0&&<button className="text-button" disabled={busy} onClick={()=>close(p)}>Close at bids</button>}</td></tr>)}</tbody></table></div>:<p className="empty">No paper positions yet.</p>}
  </div>;
}
