'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Download} from 'lucide-react';
import {sizePaperPosition} from '../lib/paper/risk.ts';
import {api,dollars,count,exportJSON} from './api.mjs';
import {journalToken} from './Journal.jsx';
import {paperCapital} from './paper-capital.mjs';
import usePaperLedger from './usePaperLedger.jsx';
import {attachEntryContext} from './paper-state.mjs';
export default function Paper({market,book,forecast,fees,now=Date.now(),preset,onPortfolio}) {
  const {engine,ledger,bankroll,changeBankroll,commit,storageError}=usePaperLedger();
  const [budget,setBudget]=useState(25),
    [low,setLow]=useState(''),[point,setPoint]=useState(''),[high,setHigh]=useState(''),[side,setSide]=useState('yes'),[quantity,setQuantity]=useState(10),
    [message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[scenarioSource,setScenarioSource]=useState('subjective'),
    [scenarioModel,setScenarioModel]=useState(null),[scenarioAsOf,setScenarioAsOf]=useState(null);
  const acting=useRef(false),verifiedFee=Number.isFinite(fees?.coefficient)&&fees.coefficient>=0&&fees.coefficient<=1;
  const coefficient=verifiedFee?fees.coefficient:.07;
  const closed=['closed','settled','finalized'].includes(market.status)||Date.parse(market.close_time)<=now;
  const canEnter=['active','open'].includes(market.status)&&Number.isFinite(Date.parse(market.close_time))&&Date.parse(market.close_time)>now;
  const entered=[low,point,high].map(value=>value===''?NaN:Number(value)/100);
  const validForecast=entered.every(Number.isFinite)&&0<=entered[0]&&entered[0]<=entered[1]&&entered[1]<=entered[2]&&entered[2]<=1;
  const capital=useMemo(()=>{try{return paperCapital(ledger,Number(bankroll));}catch{return null;}},[ledger,bankroll]);
  useEffect(()=>{if(preset?.ticker!==market.ticker)return;if(['yes','no'].includes(preset.side))setSide(preset.side);if(preset.quantity>0)setQuantity(preset.quantity);if(preset.budget>0)setBudget(preset.budget);
    if(Number.isFinite(preset.probability)&&Array.isArray(preset.interval)){setLow((preset.interval[0]*100).toFixed(2));setPoint((preset.probability*100).toFixed(2));setHigh((preset.interval[1]*100).toFixed(2));setScenarioSource(preset.source||'model_scenario');setScenarioModel(preset.model);setScenarioAsOf(preset.as_of);}},[preset,market.ticker]);
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
    if(acting.current)return;acting.current=true;
    setError('');setMessage('');setBusy(true);
    try{if(!['active','open'].includes(market.status)||!Number.isFinite(Date.parse(market.close_time))||Date.parse(market.close_time)<=Date.now())throw new Error('The contract is not confirmed open before its trading close');
      const fresh=await api('/api/book?ticker='+encodeURIComponent(market.ticker)+'&contracts='+quantity);
      let execution;
      await commit((current,startingBalance)=>{const available=paperCapital(current,startingBalance).available;
        if(available<=0)throw new Error('No uncommitted simulated cash remains');
        if(current.positions.length>=1000)throw new Error('This paper ledger reached its retained-history limit. Export it before starting a new ledger.');
        execution=engine.estimate(fresh,market.ticker,side,'buy',Number(quantity),{coefficient,slippage:2,budget:Math.min(Number(budget),available),live:true});
        if(execution.cash>available+1e-8)throw new Error('The simulated purchase exceeds available cash');
        const id=crypto.randomUUID(),next=engine.applyOpen(current,execution,{id,title:market.title,vertical:market.category});
        return validForecast?attachEntryContext(next,id,{probability:entered[1],interval:[entered[0],entered[2]],source:scenarioSource,
          model:scenarioSource==='subjective'?null:scenarioModel,as_of:scenarioSource==='subjective'?null:scenarioAsOf}):next;});
      setMessage(`Recorded ${count(execution.filled)} paper contracts for ${dollars(execution.cash)}, including fees. Live performance is now tracked in Portfolio.`);
    }catch(e){setError(e.message);}finally{acting.current=false;setBusy(false);}
  }
  async function close(position) {
    if(acting.current)return;acting.current=true;
    setBusy(true);setError('');setMessage('');
    try{const fresh=await api('/api/book?ticker='+encodeURIComponent(position.ticker)+'&contracts='+position.remaining_quantity);
      let execution;await commit(current=>{const actual=current.positions.find(row=>row.id===position.id);if(!actual?.remaining_quantity)throw new Error('This paper position is already closed.');
        execution=engine.estimate(fresh,actual.ticker,actual.side,'sell',actual.remaining_quantity,{coefficient:actual.entry_assumptions?.coefficient??.07,slippage:2,live:true});return engine.applyClose(current,actual.id,execution,{id:crypto.randomUUID()});});
      setMessage(`Paper close recorded for ${count(execution.filled)} contracts at observed bids.`);
    }catch(e){setError(e.message);}finally{acting.current=false;setBusy(false);}
  }
  async function freeze() {
    if(acting.current)return;acting.current=true;
    setBusy(true);setError('');setMessage('');
    try{await api('/api/journal',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+journalToken()},
      body:JSON.stringify({ticker:market.ticker,probability:Number(point)/100,probability_low:Number(low)/100,probability_high:Number(high)/100})});setMessage('Forecast registered. It will be scored after the exchange reports a binary settlement.');}
    catch(e){setError(e.message);}finally{acting.current=false;setBusy(false);}
  }
  return <div className="paper-panel"><div className="section-title"><h3>Paper position</h3><button className="text-button" onClick={onPortfolio}>Live portfolio</button></div><p className="muted">Set a probability range, inspect the size and record a paper entry against fresh depth.</p>
    {forecast?.experimental&&<p className="notice experimental-note">Experimental model scenario selected. Its promotion gate remains separate from this manual paper setup.</p>}
    <div className="field-grid"><label>Simulated starting balance, $<input type="number" min="1" value={bankroll} onChange={e=>changeBankroll(e.target.value)}/></label><label>Maximum entry loss, $<input type="number" min="0.01" step="1" value={budget} onChange={e=>setBudget(e.target.value)}/></label></div>
    {capital&&<div className="paper-cash"><span>Available paper cash <strong>{dollars(capital.available)}</strong></span><span>Committed cost basis <strong>{dollars(capital.committed)}</strong></span><span>Realized P/L <strong>{dollars(capital.realized)}</strong></span></div>}
    {capital?.shortfall>0&&<p className="notice">The retained ledger exceeds the entered starting balance by {dollars(capital.shortfall)}. New entries are blocked.</p>}
    <div className="field-grid three"><label>Lower P(YES), %<input type="number" min="0" max="100" value={low} onChange={e=>{setLow(e.target.value);setScenarioSource('subjective');}}/></label><label>Your P(YES), %<input type="number" min="0" max="100" value={point} onChange={e=>{setPoint(e.target.value);setScenarioSource('subjective');}}/></label><label>Upper P(YES), %<input type="number" min="0" max="100" value={high} onChange={e=>{setHigh(e.target.value);setScenarioSource('subjective');}}/></label></div>
    {Number.isFinite(forecast?.probability)&&Array.isArray(forecast.interval)&&forecast.interval.length===2&&<button className="text-button" onClick={()=>{setPoint((forecast.probability*100).toFixed(2));setLow((forecast.interval[0]*100).toFixed(2));setHigh((forecast.interval[1]*100).toFixed(2));setScenarioSource(forecast.experimental?'experimental_model':'model_scenario');setScenarioModel(forecast.model_name);setScenarioAsOf(forecast.source_as_of);}}>Use the model as a scenario</button>}
    {validForecast&&<p className="model-caption">Scenario source: {scenarioSource==='subjective'?'your entered probability':scenarioModel||'selected model'}{scenarioSource==='experimental_model'?' · experimental':''}.</p>}
    <div className="segmented"><button aria-pressed={side==='yes'} onClick={()=>setSide('yes')}>YES</button><button aria-pressed={side==='no'} onClick={()=>setSide('no')}>NO</button></div>
    {sizing&&!sizing.error&&<div className="sizing-result"><strong>{sizing.contracts?`${sizing.contracts} ${side.toUpperCase()} contracts`:'No position under this range'}</strong><span>{dollars(sizing.cost)} maximum modeled loss · worst-case log-growth criterion</span></div>}
    {sizing?.error&&<p className="notice">{sizing.error}</p>}
    <div className="field-grid"><label>Paper contracts<input type="number" min="1" max="10000" value={quantity} onChange={e=>setQuantity(e.target.value)}/></label><div className="field-action">{sizing?.contracts>0&&<button className="secondary" onClick={()=>setQuantity(sizing.contracts)}>Use calculated size</button>}</div></div>
    <div className="toolbar"><button className="primary" disabled={!engine||!book||busy||!canEnter||!capital?.available} onClick={open}>{busy?'Checking…':'Record paper buy'}</button><button className="secondary" disabled={!validForecast||busy||!canEnter} onClick={freeze}>Register forecast</button></div>
    <p className="footnote">Fee coefficient {coefficient.toFixed(4)}{verifiedFee?' from series metadata':' is a general assumption'}. Entry is limited to observed asks within 2¢. Available cash includes recorded closes, settlement and fees. The probability scenario and starting balance stay on this device; they are not sent to the assistant.</p>
    {storageError&&<p className="notice error" role="alert">{storageError}</p>}{message&&<p className="notice success" role="status">{message}<button className="text-button" onClick={onPortfolio}>View performance</button></p>}{error&&<p className="notice error" role="alert">{error}</p>}
    <div className="section-title"><h3>Paper ledger</h3><button className="text-button" disabled={!ledger} onClick={()=>exportJSON(ledger,'kalshi-paper-ledger.json')}><Download size={14}/>Export</button></div>
    {ledger?.positions.length?<div className="table-scroll"><table><thead><tr><th>Position</th><th>Open contracts</th><th>Open basis</th><th>Realized P/L</th><th/></tr></thead><tbody>{ledger.positions.map(p=><tr key={p.id}><td><strong>{p.side.toUpperCase()}</strong><small>{p.title||p.ticker}</small></td><td>{count(p.remaining_quantity)}</td><td>{dollars(p.remaining_basis)}</td><td>{dollars(p.realized_pnl)}</td><td>{p.remaining_quantity>0&&<button className="text-button" disabled={busy} onClick={()=>close(p)}>Close at bids</button>}</td></tr>)}</tbody></table></div>:<p className="empty">No paper positions yet.</p>}
  </div>;
}
