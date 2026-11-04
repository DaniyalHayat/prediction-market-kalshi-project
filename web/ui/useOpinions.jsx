'use client';
import {useEffect,useRef,useState} from 'react';
import {api} from './api.mjs';

export default function useOpinions(root,markets) {
  const [visible,setVisible]=useState([]),[opinions,setOpinions]=useState({});
  const cache=useRef(new Map());
  useEffect(()=>{
    const list=root.current;if(!list)return;
    setVisible([]);
    const seen=new Set(),observer=new IntersectionObserver(entries=>{
      for(const entry of entries){const ticker=entry.target.dataset.marketTicker;if(entry.isIntersecting)seen.add(ticker);else seen.delete(ticker);}
      setVisible([...seen]);
    },{root:list,rootMargin:'150px 0px'});
    list.querySelectorAll('[data-market-ticker]').forEach(element=>observer.observe(element));
    return()=>observer.disconnect();
  },[root,markets]);
  useEffect(()=>{
    const controller=new AbortController(),now=Date.now(),pending=visible.filter(ticker=>!cache.current.has(ticker)||now-cache.current.get(ticker).at>120000).slice(0,24);
    if(!pending.length)return;
    const batches=[];for(let i=0;i<pending.length;i+=6)batches.push(pending.slice(i,i+6));
    let next=0;
    const run=async()=>{while(next<batches.length&&!controller.signal.aborted){const tickers=batches[next++];
      try{
        const value=await api('/api/workspace/opinions?tickers='+encodeURIComponent(tickers.join(',')),{signal:controller.signal});
        if(controller.signal.aborted)return;
        const rows=Array.isArray(value.opinions)?value.opinions:Array.isArray(value.results)?value.results:[];
        const updates={};for(const row of rows){if(!tickers.includes(row.ticker))continue;const opinion=row.opinion||row;
          if(!['YES','NO','PASS'].includes(opinion.side))continue;
          updates[row.ticker]={...opinion,as_of:row.as_of||value.as_of};cache.current.set(row.ticker,{at:Date.now(),value:updates[row.ticker]});
        }
        setOpinions(previous=>({...previous,...updates}));
      }catch(error){if(error.name!=='AbortError'){const updates=Object.fromEntries(tickers.map(ticker=>[ticker,{side:null,reason:error.message}]));setOpinions(previous=>({...previous,...updates}));}}
    }};
    Promise.all([run(),run()]);return()=>controller.abort();
  },[visible]);
  return opinions;
}
