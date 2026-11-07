'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowUp,Check,MessageSquare,Square,X} from 'lucide-react';
import {contractTitle} from './selection.mjs';
import {usePanelFocus} from './Modal.jsx';
import {assistantPayload} from './assistant-context.mjs';
function Answer({text}) {
  return <div className="answer">{text.split('\n').filter(line=>line.trim()).map((line,i)=>line.startsWith('## ')?
    <h3 key={i}>{line.slice(3)}</h3>:<p key={i}>{line.split(/(\[[^\]]+\]\(https:\/\/[^\s)]+\))/g).map((part,j)=>{
    const link=part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);return link?<a key={j} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>:part;
  })}</p>)}</div>;
}
function requestHistory(history) {
  const rows=history.slice(-8).map(row=>({...row,content:row.content.slice(0,2000)}));
  while(rows.length>1&&(rows[0].role!=='user'||new TextEncoder().encode(JSON.stringify(rows)).length>15000))rows.shift();
  return rows;
}
export default function Assistant({market,research,onClose,model='validated',launch}) {
  const [messages,setMessages]=useState([]),[input,setInput]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const cancel=useRef(null),turns=useRef([]),retryHistory=useRef(null),tail=useRef(null),panel=useRef(null);
  const executionControls=launch?.executionControls;
  usePanelFocus(panel,onClose,{modal:false});
  useEffect(()=>()=>{
    const active=cancel.current;cancel.current=null;active?.abort();
  },[]);
  useEffect(()=>{
    if(!launch?.question)return;
    const timer=setTimeout(()=>send(launch.question),0);
    return()=>clearTimeout(timer);
  },[launch?.question]);
  useEffect(()=>{tail.current?.scrollIntoView({block:'nearest'});},[messages]);
  async function send(question=input,retry=false) {
    const history=retry?retryHistory.current:question.trim()?[...turns.current,{role:'user',content:question.trim()}]:null;
    if(!history||cancel.current)return;
    if(!retry)setInput('');retryHistory.current=null;setError('');setBusy(true);
    setMessages([...history,{role:'assistant',content:''}]);
    const controller=new AbortController();cancel.current=controller;
    const deadline=setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),65000);
    let text='',reader;
    try {
      const response=await fetch('/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify(assistantPayload(market.ticker,model,requestHistory(history),launch))});
      if(!response.ok) {let detail;try{detail=await response.json();}catch{}throw new Error(detail?.error||'The assistant is temporarily unavailable');}
      if(!response.body||!(response.headers.get('content-type')||'').includes('text/plain'))throw new Error('The assistant returned an unexpected response');
      reader=response.body.getReader();const decoder=new TextDecoder();
      while(true){
        const {value,done}=await reader.read();
        if(done)break;
        text+=decoder.decode(value,{stream:true});
        if(cancel.current===controller)setMessages([...history,{role:'assistant',content:text}]);
      }
      text+=decoder.decode();
      if(!text.trim())throw new Error('The assistant did not return an answer.');
      if(cancel.current===controller){turns.current=[...history,{role:'assistant',content:text}];setMessages(turns.current);}
    } catch(e){
      if(cancel.current!==controller)return;
      retryHistory.current=history;
      setError(controller.signal.aborted?controller.signal.reason?.name==='TimeoutError'?'The response timed out.':'Response stopped.':e.message||'The assistant is temporarily unavailable.');
    } finally {
      clearTimeout(deadline);reader?.releaseLock();
      if(cancel.current===controller){cancel.current=null;setBusy(false);}
    }
  }
  const prompts=['What would change this view?','Which source matters for settlement?',executionControls?'Explain the execution lab with my selected settings.':'Explain the probability range and costs.'];
  return <aside ref={panel} tabIndex={-1} className="assistant-panel" aria-label="Contract research assistant">
    <div className="assistant-heading"><div><MessageSquare size={17}/><strong>Ask Why</strong></div><button className="icon-button" aria-label="Close assistant" onClick={onClose}><X size={18}/></button></div>
    <div className="assistant-context"><span>{launch?.label||'Selected contract'}</span><strong>{contractTitle(market)}</strong><small>{market.ticker}</small>{executionControls&&<small>{executionControls.action==='sell'?'Sell':'Buy'} {executionControls.side.toUpperCase()} · {executionControls.contracts} contracts · {executionControls.horizon_seconds}s</small>}</div>
    <div className="assistant-messages" aria-live="polite">
      {!messages.length&&<div className="assistant-start"><h3>What would you like to check?</h3><p>I can inspect the rules, explain the model and compare the evidence. Calculations come from the research tools.</p>{prompts.map(prompt=><button key={prompt} onClick={()=>send(prompt)}>{prompt}<ArrowUp size={14}/></button>)}</div>}
      {messages.map((message,i)=>(message.content||busy)&&<div className={'chat-message '+message.role} key={i}><small>{message.role==='user'?'You':'Research assistant'}</small>{message.content?<Answer text={message.content}/>:<p className="muted">Checking the selected contract and source tools…</p>}</div>)}
      {error&&<div className="notice error" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={()=>send('',true)}>Retry question</button></div>}<div ref={tail}/>
    </div>
    <div className="assistant-tools"><Check size={13}/>{executionControls?'Selected execution scenario and public research tools available':research?'Market, research and source tools available':'Market and source tools available'}</div>
    <form className="assistant-form" onSubmit={event=>{event.preventDefault();send();}}><label className="sr-only" htmlFor="assistant-question">Question about this contract</label><textarea id="assistant-question" data-initial-focus value={input} onChange={e=>setInput(e.target.value)} placeholder="Ask a follow-up…" rows={2} maxLength={2000}/>{busy?<button type="button" className="send" aria-label="Stop response" onClick={()=>cancel.current?.abort()}><Square size={16}/></button>:<button className="send" aria-label="Send question" disabled={!input.trim()}><ArrowUp size={18}/></button>}</form>
    <small className="assistant-note">Public evidence only. Paper budgets and private journal tokens are not sent to the model.</small>
  </aside>;
}
