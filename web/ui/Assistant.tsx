'use client';
import {useEffect,useRef,useState} from 'react';
import type {UIEvent} from 'react';
import dynamic from 'next/dynamic';
import {ArrowDown,ArrowUp,ArrowUpRight,BookOpen,Check,FlaskConical,MessageSquare,Square,X} from 'lucide-react';
import {cents,dateLabel,percent} from './api.mjs';
import {contractTitle} from './selection';
import {usePanelFocus} from './Modal';
import {assistantPayload} from './assistant-context.mjs';
import {answerSections,linkParts} from './assistant-reading.mjs';
import type {Book,Evidence,Launch,Message,Model,Snapshot} from './assistant-types';
import './assistant-workbench.css';

const ExplanationLab=dynamic(()=>import('./ExplanationLab'),{loading:()=> <p className="assistant-stage" role="status">Opening the scenario tools…</p>});
const screens={PASS:'No entry signal',YES:'YES clears the screen',NO:'NO clears the screen'};
const handoff={analysis:'Why did this screen reach its conclusion?',evidence:'What do the matched reports tell us?',
  history:'What do the observed prices show?',execution:'What drove this execution result?',rules:'What exactly pays out?',
  sources:'Which sources can I verify?',paper:'What determines this paper entry?'};
const prompts={
  analysis:['What would change this view?','How much room is there after fees?'],
  evidence:['Which report matters most?','What is still unverified?'],
  history:['What moved in this window?','How can I tell price from probability?'],
  execution:['Where does the fill get expensive?','Which assumptions drive the schedule?'],
  rules:['What exactly settles YES?','Is there a partial payout?'],
  sources:['Which source decides settlement?','What evidence is missing?'],
  paper:['How does order size change the fill?','What is the all-in break-even?']
};

function Lines({lines}:{lines:string[]}){
  return lines.map((line,i)=><p key={i}>{(linkParts(line) as {text:string;url?:string}[]).map((part,j)=>part.url?
    <a key={j} href={part.url} target="_blank" rel="noreferrer">{part.text}</a>:part.text)}</p>);
}

function Answer({text,deep}:{text:string;deep:boolean}){
  const {sections,sources}=answerSections(text);
  const [lead,...more]=sections;
  return <div className="answer">
    {lead&&<section className="answer-lead"><h3>{lead.title}</h3><Lines lines={lead.lines}/></section>}
    {more.length>0&&<details className="answer-details" open={deep||undefined}><summary>Read the reasoning <small>{more.length} {more.length===1?'section':'sections'}</small></summary>
      {more.map(({title,lines},i)=><section className="answer-step" key={i}><h3>{title}</h3><Lines lines={lines}/></section>)}
    </details>}
    {sources.length>0&&<details className="answer-details"><summary>Open source links <small>{sources.length}</small></summary><ul className="answer-sources">
      {sources.map(row=><li key={row.url}><a href={row.url} target="_blank" rel="noreferrer">{row.text}<ArrowUpRight size={13}/></a></li>)}
    </ul></details>}
  </div>;
}

function requestHistory(history:Message[]){
  const rows=history.slice(-8).map(({role,content})=>({role,content:content.slice(0,2000)}));
  while(rows.length>1&&(rows[0].role!=='user'||new TextEncoder().encode(JSON.stringify(rows)).length>15000))rows.shift();
  return rows;
}

type Props=Snapshot&{onClose:()=>void;model?:Model;launch?:Launch};

export default function Assistant({market,book,fees,research,history,onClose,model='validated',launch}:Props){
  const [messages,setMessages]=useState<Message[]>([]),[input,setInput]=useState(''),[stage,setStage]=useState(''),[error,setError]=useState('');
  const [mode,setMode]=useState<'answer'|'lab'>('answer'),[evidence,setEvidence]=useState<Evidence|undefined>(launch?.evidence),[snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [compact,setCompact]=useState(false);
  const cancel=useRef<AbortController|null>(null),turns=useRef<Message[]>([]),retryHistory=useRef<Message[]|null>(null);
  const scroller=useRef<HTMLDivElement|null>(null),panel=useRef<HTMLElement|null>(null),prepared=useRef(false);
  const followLatest=useRef(false),executionControls=launch?.executionControls;
  const busy=Boolean(stage),automatic=Boolean(launch?.question),deep=launch?.detail==='full';
  usePanelFocus(panel,onClose,{modal:compact});
  useEffect(()=>{
    const query=window.matchMedia('(max-width:760px)');
    const sync=()=>setCompact(query.matches);
    sync();query.addEventListener('change',sync);
    return()=>query.removeEventListener('change',sync);
  },[]);
  useEffect(()=>()=>{const active=cancel.current;cancel.current=null;active?.abort();},[]);
  useEffect(()=>{
    const question=launch?.question;
    if(!question)return;
    const timer=setTimeout(()=>send(question),0);
    return()=>clearTimeout(timer);
  },[launch?.question]);
  useEffect(()=>{
    const node=scroller.current;
    if(node&&mode==='answer'&&followLatest.current)node.scrollTop=node.scrollHeight;
  },[messages,mode]);

  function selectMode(next:'answer'|'lab'){
    if(next===mode)return;
    if(next==='lab'&&!snapshot)captureInputs();
    followLatest.current=false;
    if(scroller.current)scroller.current.scrollTop=0;
    setMode(next);
  }
  function captureInputs(replacement:Book|null|undefined=book){
    setSnapshot({market,book:replacement,fees,research,history});
  }
  function trackScroll(event:UIEvent<HTMLDivElement>){
    const node=event.currentTarget;
    followLatest.current=node.scrollHeight-node.scrollTop-node.clientHeight<55;
  }
  async function send(question=input,retry=false){
    const prior=turns.current;
    const asked=question.trim();
    const next:Message[]|null=retry?retryHistory.current:asked?[...prior,{role:'user',content:asked}]:null;
    if(!next||cancel.current)return;
    if(!retry)setInput('');
    retryHistory.current=null;setError('');setMode('answer');
    followLatest.current=next.length>1||!automatic;
    setStage(!prepared.current&&launch?.prepare?'reporting':'research');
    setMessages([...next,{role:'assistant',content:''}]);
    const controller=new AbortController();cancel.current=controller;
    const deadline=setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),65000);
    let text='',reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try{
      if(!prepared.current&&launch?.prepare){
        const value=await launch.prepare(controller.signal);
        controller.signal.throwIfAborted();
        if(value?.ticker===market.ticker)setEvidence(value);
        prepared.current=true;
      }
      setStage('research');
      const response=await fetch('/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify(assistantPayload(market.ticker,model,requestHistory(next),launch))});
      if(!response.ok){
        let detail;try{detail=await response.json();}catch{}
        throw new Error(detail?.error||'The assistant is temporarily unavailable.');
      }
      if(!response.body||!(response.headers.get('content-type')||'').includes('text/plain'))throw new Error('The assistant returned an unexpected response.');
      reader=response.body.getReader();
      const decoder=new TextDecoder();
      let lastPaint=0;
      while(true){
        const {value,done}=await reader.read();
        if(done)break;
        text+=decoder.decode(value,{stream:true});
        if(cancel.current===controller&&performance.now()-lastPaint>90){
          lastPaint=performance.now();setStage('writing');setMessages([...next,{role:'assistant',content:text}]);
        }
      }
      text+=decoder.decode();
      if(!text.trim())throw new Error('The assistant did not return an answer.');
      if(cancel.current===controller){turns.current=[...next,{role:'assistant',content:text}];setMessages(turns.current);}
    }catch(e){
      if(cancel.current!==controller)return;
      retryHistory.current=next;
      setError(controller.signal.aborted?controller.signal.reason?.name==='TimeoutError'?'The response timed out.':'Response stopped.':e instanceof Error?e.message:'The assistant is temporarily unavailable.');
    }finally{
      clearTimeout(deadline);reader?.releaseLock();
      if(cancel.current===controller){cancel.current=null;setStage('');}
    }
  }

  const suggested=launch?.panel?prompts[launch.panel]:['What decides this market?','What does the current quote leave out?'];
  const quote=book?.ticker===market.ticker?book:null;
  const forecast=research?.ticker===market.ticker&&!research.error?research.forecast:null;
  const probability=forecast?.probability;
  const payout=forecast?.outcomes?forecast.expected_settlement_value:null;
  const latest=messages.at(-1);
  const state=stage==='reporting'?'Fetching reporting for this contract…':stage==='research'?'Checking the contract and its evidence…':
    stage==='writing'?'Answer arriving…':error?'':latest?.role==='assistant'&&latest.content?'Answer ready':'';

  return <aside ref={panel} tabIndex={-1} className="assistant-panel assistant-workbench" role={compact?'dialog':undefined}
    aria-modal={compact||undefined} aria-label="Contract research assistant">
    <header className="assistant-heading">
      <div className="assistant-brand"><span className="assistant-glyph"><MessageSquare size={17}/></span><div><h2 tabIndex={-1} data-initial-focus={automatic?'':undefined}>Ask Why</h2><small>Contract research</small></div></div>
      <button type="button" className="icon-button" aria-label="Close assistant" onClick={onClose}><X size={19}/></button>
    </header>
    <div className="assistant-identity">
      <p className="assistant-eyebrow">{launch?.label||'Selected contract'} <span>·</span> {model==='challenger'?'Challenger':'Baseline model'}</p>
      <strong>{contractTitle(market)}</strong>
      <code>{market.ticker}</code>
      {automatic&&launch?.panel&&<small>{handoff[launch.panel]}</small>}
      {executionControls&&<small>{executionControls.action==='sell'?'Sell':'Buy'} {executionControls.side.toUpperCase()} · {executionControls.contracts} contracts · {executionControls.horizon_seconds}s</small>}
    </div>
    <div className="assistant-modes" role="group" aria-label="Ask Why view">
      <button type="button" aria-pressed={mode==='answer'} onClick={()=>selectMode('answer')}><BookOpen size={15}/> Answer</button>
      <button type="button" aria-pressed={mode==='lab'} onClick={()=>selectMode('lab')}><FlaskConical size={15}/> Test the idea</button>
    </div>
    <div className="assistant-scroll" ref={scroller} onScroll={trackScroll}>
      <div hidden={mode!=='answer'}>
        <div className="assistant-brief">
          <div><span>Research screen</span><strong>{research?.error?'Refresh needed':research?.opinion?.side?screens[research.opinion.side]:'Awaiting research'}</strong></div>
          <div><span>{Number.isFinite(payout)?'Model payout / contract':Number.isFinite(probability)?'Model P(YES)':'Observed YES ask'}</span>
            <strong>{Number.isFinite(payout)?cents(payout):Number.isFinite(probability)?percent(probability):cents(quote?.metrics?.book_ask)}</strong>
            {!Number.isFinite(payout)&&!Number.isFinite(probability)&&quote?.as_of&&<small>{dateLabel(quote.as_of)}</small>}
          </div>
        </div>
        {!messages.length&&!automatic&&<div className="assistant-start"><h3>Make the case.</h3><p>Start with the rule, test the price, or follow the evidence behind the model.</p></div>}
        {busy&&!latest?.content&&<p className="assistant-stage" aria-hidden="true"><span/> {state}</p>}
        <div className="assistant-transcript">
          {messages.map((message,i)=>message.role==='user'?
            i===0&&automatic?null:<p className="assistant-question" key={i}><small>Your question</small>{message.content}</p>:
            message.content?<Answer key={i} text={message.content} deep={deep}/>:null)}
        </div>
        {error&&<div className="notice error assistant-retry" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={()=>send('',true)}>Retry question</button></div>}
        {!busy&&!error&&(!automatic||latest?.content)&&<div className="assistant-next">
          <h3>Follow a lead</h3>
          {suggested.map(question=><button key={question} type="button" onClick={()=>send(question)}>{question}<ArrowUpRight size={14}/></button>)}
          <button type="button" onClick={()=>selectMode('lab')}>Test an assumption <ArrowUpRight size={14}/></button>
        </div>}
        {busy&&messages.length>2&&<button type="button" className="assistant-jump text-button" onClick={()=>{followLatest.current=true;const node=scroller.current;if(node)node.scrollTop=node.scrollHeight;}}>Latest answer <ArrowDown size={14}/></button>}
      </div>
      {snapshot&&<div hidden={mode!=='lab'}><ExplanationLab active={mode==='lab'} snapshot={snapshot} evidence={evidence} onEvidence={setEvidence} onRefresh={captureInputs} model={model}/></div>}
    </div>
    <div className="assistant-status" role="status">{state&&<>{state==='Answer ready'?<Check size={14}/>:busy?<span className="assistant-pulse"/>:null}{state}</>}</div>
    <form className="assistant-form" onSubmit={event=>{event.preventDefault();send();}}>
      <label className="sr-only" htmlFor="assistant-question">Question about this contract</label>
      <textarea id="assistant-question" data-initial-focus={!automatic?'':undefined} value={input} onChange={e=>setInput(e.target.value)} placeholder="Ask a follow-up…" rows={1} maxLength={2000}/>
      {busy?<button type="button" className="send" aria-label="Stop response" onClick={()=>cancel.current?.abort()}><Square size={16}/></button>:
        <button type="submit" className="send" aria-label="Send question" disabled={!input.trim()}><ArrowUp size={18}/></button>}
    </form>
    <small className="assistant-note">Public contract data · Paper scenarios</small>
  </aside>;
}
