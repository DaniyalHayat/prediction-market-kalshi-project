'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {api} from './api.mjs';
import {createVisibleRefresh,displayedOpinion,screenRefreshDelay} from './screen-freshness.mjs';

export default function useOpinions(root,markets,model='validated',enabled=true) {
  const [visible,setVisible]=useState([]),[opinions,setOpinions]=useState({}),[clock,setClock]=useState(Date.now());
  const cache=useRef(new Map());
  useEffect(()=>{
    const list=root.current;if(!list||!enabled)return;
    setVisible([]);
    const seen=new Set(),observer=new IntersectionObserver(entries=>{
      for(const entry of entries){const ticker=entry.target.dataset.marketTicker;if(entry.isIntersecting)seen.add(ticker);else seen.delete(ticker);}
      const next=[...seen].sort();setVisible(current=>current.join(',')===next.join(',')?current:next);
    },{root:list,rootMargin:'0px'});
    list.querySelectorAll('[data-market-ticker]').forEach(element=>observer.observe(element));
    return()=>observer.disconnect();
  },[root,markets,enabled]);
  useEffect(()=>{cache.current.clear();setOpinions({});},[model]);
  const visibleKey=visible.slice(0,24).join(',');
  useEffect(()=>{
    if(!enabled||!visibleKey)return;
    let stopped=false;const tracked=visibleKey.split(',');
    const refresher=createVisibleRefresh(async(signal,force)=>{
      const now=Date.now(),pending=tracked.filter(ticker=>force||!cache.current.has(ticker)||now>=cache.current.get(ticker).next_due);
      const batches=[];for(let i=0;i<pending.length;i+=6)batches.push(pending.slice(i,i+6));let next=0;
      const worker=async()=>{while(next<batches.length&&!signal.aborted&&!document.hidden){const tickers=batches[next++];
        for(const ticker of tickers){const previous=cache.current.get(ticker);cache.current.delete(ticker);cache.current.set(ticker,{...previous,next_due:Date.now()+20000});}
        try{
          const value=await api('/api/workspace/opinions?tickers='+encodeURIComponent(tickers.join(','))+'&model='+model,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
          if(signal.aborted||stopped||document.hidden)return;
          const rows=Array.isArray(value.opinions)?value.opinions:Array.isArray(value.results)?value.results:[],byTicker=new Map(rows.map(row=>[row.ticker,row])),updates={};
          for(const ticker of tickers){const row=byTicker.get(ticker),opinion=row?.opinion||row;
            const result=opinion&&['YES','NO','PASS'].includes(opinion.side)?{...row,...opinion,ticker,view_model:model,as_of:row.as_of||value.as_of}:
              {ticker,view_model:model,side:'STALE',refresh_error:true,reason:'The matching screen was not returned.'};
            updates[ticker]=result;cache.current.set(ticker,{value:result,next_due:Date.now()+screenRefreshDelay(result)});
          }
          setOpinions(previous=>({...previous,...updates}));
        }catch(error){if(!signal.aborted&&!stopped&&!document.hidden){const updates={};for(const ticker of tickers){const previous=cache.current.get(ticker)?.value;
            const result={...previous,ticker,view_model:model,side:'STALE',refresh_error:true,reason:'The matching screen could not be refreshed.'};updates[ticker]=result;cache.current.set(ticker,{value:result,next_due:Date.now()+20000});}
          setOpinions(previous=>({...previous,...updates}));}}
      }};
      await Promise.all([worker(),worker()]);
      while(cache.current.size>512)cache.current.delete(cache.current.keys().next().value);
    },{visible:()=>!document.hidden&&!stopped});
    const tick=()=>{if(!document.hidden){setClock(Date.now());refresher.refresh();}},visibility=()=>{if(!document.hidden)setClock(Date.now());refresher.visibilityChanged();};
    setClock(Date.now());refresher.refresh();const timer=setInterval(tick,5000);document.addEventListener('visibilitychange',visibility);
    return()=>{stopped=true;refresher.stop();clearInterval(timer);document.removeEventListener('visibilitychange',visibility);};
  },[visibleKey,model,enabled]);
  return useMemo(()=>Object.fromEntries(Object.entries(opinions).filter(([,row])=>row.view_model===model).map(([ticker,row])=>[ticker,displayedOpinion(row,clock)])),[opinions,clock,model]);
}
