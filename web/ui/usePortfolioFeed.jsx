'use client';
import {useEffect,useRef,useState} from 'react';
import {api,API_BASE} from './api.mjs';
import {acceptPortfolioBook} from './portfolio-state.mjs';
export default function usePortfolioFeed(tickers,model='validated'){
  const [books,setBooks]=useState({}),[research,setResearch]=useState({}),[status,setStatus]=useState({}),[refreshing,setRefreshing]=useState(false);
  const key=tickers.join(','),latest=useRef(books);latest.current=books;
  useEffect(()=>{
    const tracked=key?key.split(','):[];
    setBooks(current=>{const next=Object.fromEntries(Object.entries(current).filter(([ticker])=>tracked.includes(ticker)));latest.current=next;return next;});
    setResearch(current=>Object.fromEntries(Object.entries(current).filter(([ticker])=>tracked.includes(ticker))));
    setStatus(current=>Object.fromEntries(Object.entries(current).filter(([ticker])=>tracked.includes(ticker))));
    if(!key)return;
    const streamed=tracked.slice(0,12),controller=new AbortController();
    let stopped=false,stream,bookBusy=false,researchBusy=false,retryTimer,retries=0,frame;
    const pending=new Map(),lastResearch=new Map(),currentResearch=new Map();
    function receive(value){
      if(stopped||!tracked.includes(value?.ticker))return;
      pending.set(value.ticker,value);
      if(frame)return;
      frame=requestAnimationFrame(()=>{frame=null;const batch=[...pending.values()];pending.clear();setBooks(current=>{
        const next={...current};for(const value of batch)next[value.ticker]=acceptPortfolioBook(next[value.ticker],value,tracked);latest.current=next;return next;
      });});
    }
    async function bounded(values,operation){let index=0;await Promise.all([0,1].map(async()=>{while(index<values.length&&!stopped){const ticker=values[index++];await operation(ticker);}}));}
    async function refreshBooks(force=false){
      if(stopped||document.hidden||bookBusy)return;bookBusy=true;
      try{await bounded(tracked,async ticker=>{
        if(!force&&stream&&streamed.includes(ticker)&&Date.now()-Date.parse(latest.current[ticker]?.as_of)<15000)return;
        try{const value=await api('/api/book?ticker='+encodeURIComponent(ticker)+'&contracts=1',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});receive({...value,transport:'public-rest-snapshot'});}
        catch(error){if(!stopped&&error.name!=='AbortError')setStatus(current=>({...current,[ticker]:'Quote unavailable'}));}
      });}finally{bookBusy=false;}
    }
    async function refreshResearch(force=false){
      if(stopped||document.hidden||researchBusy)return;researchBusy=true;setRefreshing(true);
      const due=tracked.filter(ticker=>force||Date.now()-(lastResearch.get(ticker)||0)>=(currentResearch.get(ticker)?.forecast?.max_source_age_seconds<=60?20000:60000));
      try{await bounded(due,async ticker=>{
        lastResearch.set(ticker,Date.now());
        try{const value=await api('/api/workspace/research?ticker='+encodeURIComponent(ticker)+'&compact=1&model='+model,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])});
          if(!stopped&&value.ticker===ticker){currentResearch.set(ticker,value);setResearch(current=>({...current,[ticker]:{...value,view_model:model}}));}}
        catch(error){if(!stopped&&error.name!=='AbortError')setResearch(current=>({...current,[ticker]:{...current[ticker],ticker,error:error.message}}));}
      });}finally{researchBusy=false;if(!stopped)setRefreshing(false);}
    }
    function connect(){
      if(stopped||document.hidden||stream||!streamed.length)return;
      stream=new EventSource(API_BASE+'/api/portfolio/stream?tickers='+encodeURIComponent(streamed.join(',')));
      stream.addEventListener('book',event=>{try{const value=JSON.parse(event.data);if(!tracked.includes(value.ticker))return;receive({...value,transport:'exchange-websocket'});retries=0;setStatus(current=>({...current,[value.ticker]:'Live stream'}));}catch{}});
      stream.addEventListener('status',event=>{try{const value=JSON.parse(event.data);if(tracked.includes(value.ticker))setStatus(current=>({...current,[value.ticker]:String(value.status||'Connecting')}));}catch{}});
      stream.onerror=()=>{stream?.close();stream=null;if(!stopped&&!document.hidden){refreshBooks();retryTimer=setTimeout(connect,Math.min(30000,1000*2**Math.min(retries++,5)));}};
    }
    const visible=()=>{if(document.hidden){stream?.close();stream=null;clearTimeout(retryTimer);}else{refreshBooks(true);refreshResearch(true);connect();}};
    refreshBooks(true);refreshResearch(true);connect();const quotesTimer=setInterval(refreshBooks,30000),researchTimer=setInterval(refreshResearch,20000);
    document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;controller.abort();stream?.close();clearInterval(quotesTimer);clearInterval(researchTimer);clearTimeout(retryTimer);cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',visible);};
  },[key,model]);
  return {books,research,status,refreshing};
}
