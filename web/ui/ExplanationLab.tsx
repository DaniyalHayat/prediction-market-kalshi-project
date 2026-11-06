'use client';
import {useEffect,useRef,useState} from 'react';
import {Activity,ArrowUpRight,Calculator,Clock,FileCheck,Layers,Newspaper,Pin,RefreshCw,Scale,Shield} from 'lucide-react';
import {EXPLANATION_LABS,evaluateExplanationLab} from '../lib/workspace/explanation-lab.mjs';
import {api,dateLabel,dollars} from './api.mjs';
import {newsURL} from './news-reading.mjs';
import type {Book,Evidence,Model,Snapshot} from './assistant-types';

const icons=[Calculator,Layers,Shield,ArrowUpRight,Scale,Clock,Newspaper,Activity];
const defaults={side:'yes',quantity:'5',basis:'',slippage:'2',depthRetained:'50',windowMinutes:'30',sourceIndex:'0',priceDelta:'0'};
const fields={
  quantity:['Contracts',1,10000,1],basis:['All-in basis ($)',0,1e9,.01],slippage:['Slippage band (¢)',0,100,.5],
  depthRetained:['Depth remaining (%)',0,100,1],windowMinutes:['Minutes each side',1,1440,1],priceDelta:['Change in cost (¢)',-100,100,.5]
};
const newsTools=new Set(['news-replay','evidence-check']);
const sliders=new Set(['depthRetained','priceDelta']);
type InputKey=keyof typeof defaults;
type Metric={label:string;value:number|string|null;unit:string};
type Result={status:'ready'|'unavailable';classification:string;summary:string;metrics:Metric[];
  rows:{label:string;text?:string;url?:string;as_of?:string;metrics?:Metric[]}[];
  note?:string;sources:{url:string;label:string}[];options:{value:number;label:string}[]};
type Props={active:boolean;snapshot:Snapshot;evidence?:Evidence;model:Model;
  onEvidence:(value:Evidence|undefined)=>void;onRefresh:(value:Book)=>void};

function metricValue(value:Metric['value'],unit:string){
  if(unit==='text')return value||'—';
  if(typeof value!=='number'||!Number.isFinite(value))return '—';
  if(unit==='usd')return dollars(value);
  const formatted=value.toLocaleString('en-US',{maximumFractionDigits:2});
  return formatted+({cents:'¢',percent:'%',contracts:' contracts',minutes:' min'}[unit]||'');
}

function Metrics({rows=[],baseline=[]}:{rows?:Metric[];baseline?:Metric[]}){
  return rows.length>0&&<dl className="explain-lab-metrics">{rows.map(row=>{
    const old=baseline.find(item=>item.label===row.label&&item.unit===row.unit);
    const delta=typeof old?.value==='number'&&typeof row.value==='number'?row.value-old.value:null;
    return <div key={row.label}><dt>{row.label}</dt><dd>{metricValue(row.value,row.unit)}
      {delta!==null&&Math.abs(delta)>1e-8&&<small>{delta>0?'+':''}{metricValue(delta,row.unit)} vs pinned</small>}</dd></div>;
  })}</dl>;
}

export default function ExplanationLab({active,snapshot,evidence,onEvidence,onRefresh,model}:Props){
  const [tool,setTool]=useState(EXPLANATION_LABS[0]),[inputs,setInputs]=useState(defaults),[now,setNow]=useState(Date.now());
  const [pending,setPending]=useState(''),[error,setError]=useState('');
  const [pins,setPins]=useState<Record<string,{metrics:Metric[];as_of:string}|null>>({});
  const [replay,setReplay]=useState<{evidence?:Evidence;history:{ticker:string}|null}|null>(null);
  const request=useRef<AbortController|null>(null);
  const id=tool.id,ticker=snapshot.market.ticker;
  useEffect(()=>()=>request.current?.abort(),[]);
  useEffect(()=>{
    if(!active)return;
    setNow(Date.now());
    const interval=setInterval(()=>setNow(Date.now()),5000);
    return()=>clearInterval(interval);
  },[active]);
  const args=Object.fromEntries(Object.entries(inputs).map(([key,value])=>[key,key==='side'?value:value===''?(key==='basis'?null:NaN):Number(value)]));
  const replayInputs=id==='news-replay'&&replay?replay:{evidence,history:snapshot.history};
  const result=evaluateExplanationLab(id,{...snapshot,...args,...replayInputs,now}) as Result;
  const needsNews=newsTools.has(id);
  const observation=snapshot.book?.ticker===ticker?snapshot.book.as_of:null;
  const pinned=pins[id];
  const change=(key:InputKey,value:string)=>setInputs(previous=>({...previous,[key]:value}));

  async function refresh(kind:'news'|'book'){
    if(request.current)return;
    const controller=new AbortController();request.current=controller;
    setPending(kind);setError('');
    try{
      if(kind==='news'&&id==='news-replay'){
        const result=await api('/api/workspace/graphql',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({operationName:'HeadlineReplay',variables:{ticker,model}}),signal:controller.signal,timeoutMs:15000});
        const packet=result.data?.headlineReplay;
        if(packet?.ticker!==ticker||packet.model!==model)throw new Error(result.errors?.[0]?.message||'Replay inputs did not match this contract and model.');
        if(!controller.signal.aborted){
          setReplay({
            evidence:packet.evidence?.ticker===ticker?packet.evidence:undefined,
            history:packet.history?.ticker===ticker?packet.history:null,
          });
          if(packet.unavailable_sources?.length)setError('Replay sources unavailable: '+packet.unavailable_sources.join(', ')+'.');
          change('sourceIndex','0');
        }
      }else if(kind==='news'){
        const value=await api('/api/workspace/evidence?'+new URLSearchParams({ticker,model}),{signal:controller.signal,timeoutMs:15000});
        if(value.ticker!==ticker)throw new Error('Reporting did not match this contract.');
        if(!controller.signal.aborted){onEvidence(value);change('sourceIndex','0');}
      }else{
        const value=await api('/api/book?'+new URLSearchParams({ticker,contracts:'1'}),{signal:controller.signal,timeoutMs:7500});
        if(value.ticker!==ticker)throw new Error('The order book did not match this contract.');
        if(!controller.signal.aborted)onRefresh(value);
      }
      if(!controller.signal.aborted)setNow(Date.now());
    }catch(e){
      if(!controller.signal.aborted)setError(e instanceof Error?e.message:'The source could not be refreshed.');
    }finally{
      request.current=null;
      if(!controller.signal.aborted)setPending('');
    }
  }

  return <section className="explain-lab" aria-label="Contract scenario tools">
    <div className="explain-lab-intro"><h3>Pick a question to test.</h3><small>Each tool uses the selected contract and labels any assumption you change.</small></div>
    <div className="explain-lab-tools" role="group" aria-label="Choose a scenario tool">
      {EXPLANATION_LABS.map((row,i)=>{const Icon=icons[i];return <button key={row.id} type="button" aria-pressed={row.id===id}
        onClick={()=>{setTool(row);change('sourceIndex','0');setError('');}}><Icon size={15}/>{row.label}</button>;})}
    </div>
    <section className="explain-lab-work" aria-labelledby="scenario-tool-title">
      <h3 id="scenario-tool-title">{tool.label}</h3><p>{tool.description}</p>
      <div className="explain-lab-controls">
        {(tool.controls as InputKey[]).map(key=>{
          const fieldId='explain-control-'+key;
          if(key==='side')return <label key={key} htmlFor={fieldId}>Side<select id={fieldId} value={inputs.side} onChange={e=>change(key,e.target.value)}><option value="yes">YES</option><option value="no">NO</option></select></label>;
          if(key==='sourceIndex')return <label key={key} htmlFor={fieldId}>{id==='news-replay'?'Public report':'Publisher to set aside'}<select id={fieldId}
            value={result.options.length?inputs.sourceIndex:''} disabled={!result.options.length} onChange={e=>change(key,e.target.value)}>
            {result.options.length?result.options.map(row=><option key={row.value} value={row.value}>{row.label}</option>):<option value="">Load matching reporting</option>}
          </select></label>;
          const [label,min,max,step]=fields[key];
          if(sliders.has(key))return <label key={key} htmlFor={fieldId} className="explain-slider"><span>{label}<output htmlFor={fieldId}>{inputs[key]}{key==='depthRetained'?'%':'¢'}</output></span>
            <input id={fieldId} type="range" min={min} max={max} step={step} value={inputs[key]} onChange={e=>change(key,e.target.value)}/></label>;
          return <label key={key} htmlFor={fieldId}>{label}<input id={fieldId} type="number" value={inputs[key]} min={min} max={max} step={step}
            placeholder={key==='basis'?'Optional':undefined} onChange={e=>change(key,e.target.value)}/></label>;
        })}
      </div>
      <div className="explain-lab-actions">
        <button type="button" disabled={Boolean(pending)} onClick={()=>refresh(needsNews?'news':'book')}><RefreshCw size={14}/>
          {pending?(pending==='news'?'Loading reporting…':'Checking depth…'):needsNews?'Load reporting':'Refresh depth'}
        </button>
        <button type="button" onClick={()=>setInputs(defaults)}>Reset inputs</button>
        <button type="button" aria-pressed={Boolean(pinned)} disabled={!pinned&&result.status!=='ready'}
          onClick={()=>setPins(previous=>({...previous,[id]:pinned?null:{metrics:result.metrics,as_of:new Date().toISOString()}}))}>
          <Pin size={13}/>{pinned?'Clear baseline':'Pin baseline'}
        </button>
      </div>
      {error&&<p className="notice error" role="alert">{error}</p>}
      {observation&&!needsNews&&<small className="explain-lab-note">Order book observed <time dateTime={observation}>{dateLabel(observation)}</time></small>}
    </section>
    <section className="explain-lab-result" aria-label="Scenario result" data-ready={result.status==='ready'}>
      <small>{result.status==='ready'&&<FileCheck size={13}/>} {result.classification}</small>
      <p>{result.summary}</p><Metrics rows={result.metrics} baseline={pinned?.metrics}/>
      {pinned&&<p className="explain-lab-note">Baseline pinned <time dateTime={pinned.as_of}>{dateLabel(pinned.as_of)}</time></p>}
    </section>
    {result.rows.length>0&&<div className="explain-lab-rows">
      {result.rows.map((row,i)=><div className="explain-lab-option" key={i}>
        <h3>{row.url&&newsURL(row.url)?<a href={row.url} target="_blank" rel="noreferrer">{row.label} <ArrowUpRight size={12}/></a>:row.label}</h3>
        {row.text&&<p>{row.text}</p>}{row.as_of&&<small><time dateTime={row.as_of}>{dateLabel(row.as_of)}</time></small>}
        <Metrics rows={row.metrics}/>
      </div>)}
    </div>}
    {result.note&&<p className="explain-lab-note">{result.note}</p>}
    {result.sources.length>0&&<details className="answer-details"><summary>Scenario sources <small>{result.sources.length}</small></summary>
      <ul className="answer-sources">{result.sources.map(row=><li key={row.url}><a href={row.url} target="_blank" rel="noreferrer">{row.label}<ArrowUpRight size={13}/></a></li>)}</ul>
    </details>}
  </section>;
}
