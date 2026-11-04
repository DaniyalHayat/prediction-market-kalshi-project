'use client';
import {useEffect,useState} from 'react';
import {Download,RefreshCw,Upload,X} from 'lucide-react';
import {api,exportJSON,dateLabel,percent} from './api.mjs';
import Modal from './Modal.jsx';
export function journalToken() {
  let token=localStorage.getItem('market-lab-journal-token');
  if(!/^[a-f0-9]{64}$/.test(token||'')){token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');localStorage.setItem('market-lab-journal-token',token);}
  return token;
}
export default function Journal({onClose}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const load=async()=>{setLoading(true);setError('');try{setData(await api('/api/journal',{headers:{Authorization:'Bearer '+journalToken()}}));}catch(e){setError(e.message);}finally{setLoading(false);}};
  useEffect(()=>{load();},[]);
  async function importAccess(event) {
    try{const file=event.target.files?.[0];if(!file||file.size>2000000)throw new Error('Choose a journal export below 2 MB');
      const value=JSON.parse(await file.text());if(!/^[a-f0-9]{64}$/.test(value.private_access_token||''))throw new Error('The export does not contain a valid access token');
      localStorage.setItem('market-lab-journal-token',value.private_access_token);await load();}catch(e){setError(e.message);}
  }
  function exportAccess(){try{exportJSON({private_access_token:journalToken(),journal:data},'kalshi-private-journal.json');}catch(e){setError(e.message);}}
  return <Modal className="journal-dialog" titleId="journal-title" onClose={onClose}>
    <div className="dialog-heading"><div><h2 id="journal-title">Forecast journal</h2><p>Predictions registered before close, scored after settlement.</p></div><button className="icon-button" aria-label="Close journal" onClick={onClose}><X size={20}/></button></div>
    <div className="journal-summary"><div><span>Settled</span><strong>{data?.evaluation?.n??'—'}</strong></div><div><span>Your Brier score</span><strong>{data?.evaluation?.brier?.toFixed(4)??'—'}</strong></div><div><span>Market baseline</span><strong>{data?.evaluation?.baseline_brier?.toFixed(4)??'—'}</strong></div></div>
    <div className="toolbar"><button className="secondary" onClick={load} disabled={loading}><RefreshCw size={15}/>{loading?'Loading…':'Refresh'}</button><button className="secondary" onClick={exportAccess}><Download size={15}/>Export access & records</button><label className="secondary upload"><Upload size={15}/>Import access<input type="file" accept="application/json" onChange={importAccess} aria-label="Import private journal access"/></label></div>
    {error&&<div className="notice error" role="alert">{error}</div>}
    <div className="table-scroll"><table><thead><tr><th>Contract</th><th>Probability</th><th>Registered</th><th>Status</th><th>Brier</th></tr></thead><tbody>{data?.records?.map(row=><tr key={row.id}><td><strong>{row.frozen.title}</strong><small>{row.frozen.ticker}</small></td><td>{percent(row.frozen.probability)}</td><td>{dateLabel(row.frozen.created_at)}</td><td>{row.status}</td><td>{row.score?.brier?.toFixed(4)??'—'}</td></tr>)}</tbody></table></div>
    {data&&!data.records.length&&<p className="empty">No predictions in this journal. Open a contract, enter a probability range and register it before close.</p>}
    {data?.attribution?.some(row=>row.n>0)&&<details className="method"><summary>Settled forecast scores by series</summary><p>Only this private journal’s pre-registered, settled forecasts are included. Pending predictions have no score.</p><div className="table-scroll"><table><thead><tr><th>Series</th><th>Settled forecasts</th><th>Your Brier score</th><th>Market baseline</th></tr></thead><tbody>{data.attribution.filter(row=>row.n>0).map(row=><tr key={row.series}><td>{row.series}</td><td>{row.n}</td><td>{Number.isFinite(row.brier)?row.brier.toFixed(4):'—'}</td><td>{Number.isFinite(row.baseline_brier)?row.baseline_brier.toFixed(4):'—'}</td></tr>)}</tbody></table></div></details>}
    <p className="footnote">Lower Brier scores are better. Pending outcomes are excluded. Your private access token stays in this browser; exporting it lets you reopen the journal on another device.</p>
  </Modal>;
}
