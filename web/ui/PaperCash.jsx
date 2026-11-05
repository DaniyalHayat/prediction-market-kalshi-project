'use client';
import {useState} from 'react';
import {Plus,Minus,ChevronDown} from 'lucide-react';
import {dollars,dateLabel} from './api.mjs';
import {emitAnalytics} from '../app/components/analytics-policy.mjs';
export default function PaperCash({capital,ledger,onAdjust,compact=false}){
  const [action,setAction]=useState('add'),[amount,setAmount]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  async function submit(event){
    event.preventDefault();if(busy)return;setBusy(true);setError('');setMessage('');
    try{await onAdjust(action,Number(amount));emitAnalytics('paper_cash_adjustment',{action});setMessage(`${action==='add'?'Added':'Decreased'} paper cash by ${dollars(Number(amount))}.`);setAmount('');}catch(error){setError(error.message);}finally{setBusy(false);}
  }
  const movements=ledger?.cash_movements||[];
  return <section className={'paper-account '+(compact?'compact-account':'')} aria-label="Paper cash account">
    <div className="paper-account-heading"><div><span>Available paper cash</span><strong>{dollars(capital?.available)}</strong></div><span className="tag">Simulated</span></div>
    <div className="paper-account-detail"><span>Starting funds <b>{dollars(capital?.startingBalance)}</b></span><span>Cash adjustments <b>{dollars(capital?.cashAdjustments)}</b></span><span>In positions <b>{dollars(capital?.committed)}</b></span></div>
    <details className="cash-controls"><summary>Manage paper money <ChevronDown size={14}/></summary><form onSubmit={submit}>
      <div className="cash-actions" role="group" aria-label="Cash adjustment type"><button type="button" aria-pressed={action==='add'} onClick={()=>{setAction('add');setError('');}}><Plus size={14}/>Add money</button><button type="button" aria-pressed={action==='decrease'} onClick={()=>{setAction('decrease');setError('');}}><Minus size={14}/>Decrease money</button></div>
      <label>Amount, $<input type="number" inputMode="decimal" min="0.01" max={action==='decrease'?capital?.available:1000000000} step="0.01" placeholder="0.00" value={amount} onChange={event=>setAmount(event.target.value)} required/></label><button className="secondary" disabled={!ledger||busy||!amount}>{busy?'Saving…':action==='add'?'Add paper money':'Decrease paper money'}</button>
    </form><p className="footnote">Cash changes are recorded separately from trading profit. Only available cash can be decreased.</p></details>
    {message&&<p className="notice success" role="status">{message}</p>}{error&&<p className="notice error" role="alert">{error}</p>}
    {movements.length>0&&<details className="cash-history"><summary>Cash history <span>{movements.length}</span></summary><ol>{[...movements].reverse().slice(0,25).map(row=><li key={row.id}><span>{row.action==='add'?'Added paper money':'Decreased paper money'}<small>{dateLabel(row.occurred_at)}</small></span><strong>{row.action==='add'?'+':'−'}{dollars(row.amount)}</strong></li>)}</ol>{movements.length>25&&<p className="footnote">Showing the latest 25 adjustments. Export the ledger for the full history.</p>}</details>}
  </section>;
}
