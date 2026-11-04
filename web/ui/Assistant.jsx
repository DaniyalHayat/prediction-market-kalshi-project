'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowUp,Check,MessageSquare,Square,X} from 'lucide-react';
import {contractTitle} from './selection.mjs';
import {usePanelFocus} from './Modal.jsx';
function Answer({text}) {
  return <div className="answer">{text.split('\n').map((line,i)=><p key={i}>{line.split(/(\[[^\]]+\]\(https:\/\/[^\s)]+\))/g).map((part,j)=>{
    const link=part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);return link?<a key={j} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>:part;
  })}</p>)}</div>;
}
export default function Assistant({market,research,onClose}) {
  const [messages,setMessages]=useState([]),[input,setInput]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const cancel=useRef(null),tail=useRef(null),panel=useRef(null);usePanelFocus(panel,onClose,{modal:false});
  useEffect(()=>()=>cancel.current?.abort(),[]);
  useEffect(()=>{tail.current?.scrollIntoView({block:'nearest'});},[messages]);
  async function send(question=input) {
    if(!question.trim()||busy)return;setInput('');setError('');setBusy(true);
    const history=[...messages,{role:'user',content:question.trim()}];setMessages([...history,{role:'assistant',content:''}]);
    const controller=new AbortController();cancel.current=controller;
    try {
      const response=await fetch('/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify({ticker:market.ticker,messages:history.slice(-8)})});
      if(!response.ok) {let detail;try{detail=await response.json();}catch{}throw new Error(detail?.error||'The assistant is temporarily unavailable');}
      if(!(response.headers.get('content-type')||'').includes('text/plain'))throw new Error('The assistant returned an unexpected response');
      const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
      while(true){const {value,done}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});setMessages([...history,{role:'assistant',content:text}]);}
    } catch(e){if(e.name!=='AbortError')setError(e.message);}finally{setBusy(false);}
  }
  const prompts=['What would change this view?','Which source matters for settlement?','Explain the probability range and costs.'];
  return <aside ref={panel} tabIndex={-1} className="assistant-panel" aria-label="Contract research assistant">
    <div className="assistant-heading"><div><MessageSquare size={17}/><strong>Ask about this contract</strong></div><button className="icon-button" aria-label="Close assistant" onClick={onClose}><X size={18}/></button></div>
    <div className="assistant-context"><span>Selected contract</span><strong>{contractTitle(market)}</strong><small>{market.ticker}</small></div>
    <div className="assistant-messages" aria-live="polite">
      {!messages.length&&<div className="assistant-start"><h3>What would you like to check?</h3><p>I can inspect the rules, explain the model and compare the evidence. Calculations come from the research tools.</p>{prompts.map(prompt=><button key={prompt} onClick={()=>send(prompt)}>{prompt}<ArrowUp size={14}/></button>)}</div>}
      {messages.map((message,i)=><div className={'chat-message '+message.role} key={i}><small>{message.role==='user'?'You':'Research assistant'}</small>{message.content?<Answer text={message.content}/>:<p className="muted">Checking the selected contract and source tools…</p>}</div>)}
      {error&&<div className="notice error" role="alert">{error}</div>}<div ref={tail}/>
    </div>
    <div className="assistant-tools"><Check size={13}/>{research?'Market, research and source tools available':'Market and source tools available'}</div>
    <form className="assistant-form" onSubmit={event=>{event.preventDefault();send();}}><label className="sr-only" htmlFor="assistant-question">Question about this contract</label><textarea id="assistant-question" data-initial-focus value={input} onChange={e=>setInput(e.target.value)} placeholder="Ask a follow-up…" rows={2} maxLength={2000}/>{busy?<button type="button" className="send" aria-label="Stop response" onClick={()=>cancel.current?.abort()}><Square size={16}/></button>:<button className="send" aria-label="Send question" disabled={!input.trim()}><ArrowUp size={18}/></button>}</form>
    <small className="assistant-note">Public evidence only. Paper budgets and private journal tokens are not sent to the model.</small>
  </aside>;
}
