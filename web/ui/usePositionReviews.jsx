'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api.mjs';
import {automaticReviewSignal,duePositionReviews,positionReviewInput,reviewSettings,REVIEW_SETTINGS_KEY,REVIEW_DEADLINE_MS} from './position-review-state.mjs';

export default function usePositionReviews(positions,model){
  const [results,setResults]=useState({}),[settings,setSettings]=useState({});
  const [notification,setNotification]=useState('default');
  const running=useRef(new Map()),latest=useRef(positions),currentSettings=useRef({}),mounted=useRef(false);
  const currentModel=useRef(model);currentModel.current=model;
  latest.current=positions;
  useEffect(()=>{
    mounted.current=true;
    const refresh=()=>{try{currentSettings.current=reviewSettings(localStorage.getItem(REVIEW_SETTINGS_KEY));setSettings(currentSettings.current);}catch{}};
    const storage=event=>{if(!event.key||event.key===REVIEW_SETTINGS_KEY)refresh();};
    refresh();
    setNotification(globalThis.Notification?.permission||'unsupported');
    window.addEventListener('storage',storage);
    return()=>{mounted.current=false;window.removeEventListener('storage',storage);for(const controller of running.current.values())controller.abort();running.current.clear();};
  },[]);
  function updateSetting(id,update){
    let all=currentSettings.current;
    try{all=reviewSettings(localStorage.getItem(REVIEW_SETTINGS_KEY));}catch{}
    const next={...all,[id]:{...all[id],...update}};
    currentSettings.current=next;setSettings(next);
    try{localStorage.setItem(REVIEW_SETTINGS_KEY,JSON.stringify(next));}catch{}
  }
  const run=useCallback(async(position,automatic=false)=>{
    const id=position.id;
    if(running.current.has(id)||position.remaining_quantity<=1e-8)return;
    const input=positionReviewInput(position,latest.current,model);
    const controller=new AbortController(),started=performance.now(),signature=JSON.stringify(input);
    running.current.set(id,controller);
    setResults(previous=>({...previous,[id]:{signature,started,automatic}}));
    try{
      const value=await api('/api/workspace/position-review',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...input,...(automatic?{automatic:true}:{})}),signal:controller.signal,timeoutMs:REVIEW_DEADLINE_MS});
      if(value.ticker!==position.ticker)throw new Error('The analysis returned a different contract.');
      const retained=latest.current.find(row=>row.id===id);
      if(!mounted.current||!retained||currentModel.current!==model||JSON.stringify(positionReviewInput(retained,latest.current,model))!==signature)return;
      const {notify,...signal}=automatic?automaticReviewSignal(value.action,currentSettings.current[id]):{};
      updateSetting(id,{checked:Date.now(),...signal});
      setResults(rows=>({...rows,[id]:{signature,value,elapsed:performance.now()-started,automatic}}));
      if(notify){
        if(globalThis.Notification?.permission==='granted')try{
          new Notification('Paper position review',{body:'SELL signal for '+(position.title||position.ticker),tag:'predictir-position-'+id});
        }catch{}
      }
    }catch(error){
      if(!mounted.current||controller.signal.aborted)return;
      if(automatic)updateSetting(id,{checked:Date.now()-22*60*1000});
      setResults(rows=>({...rows,[id]:{signature,error:error.message,elapsed:performance.now()-started,automatic}}));
    }finally{running.current.delete(id);}
  },[model]);
  useEffect(()=>{
    let active=true,busy=false;
    async function check(){
      if(!active||busy||document.hidden||running.current.size)return;
      busy=true;
      try{
        const sweep=async()=>{
          let preferences=currentSettings.current;
          try{preferences=reviewSettings(localStorage.getItem(REVIEW_SETTINGS_KEY));}catch{}
          const due=duePositionReviews(latest.current,preferences);
          for(const position of due){
            if(!active||document.hidden||running.current.size)return;
            const current=latest.current.find(row=>row.id===position.id);
            if(current?.remaining_quantity>1e-8&&!currentSettings.current[current.id]?.paused)await run(current,true);
          }
        };
        if(navigator.locks?.request)await navigator.locks.request('predictir-position-reviews',{ifAvailable:true},lock=>lock?sweep():undefined);
        else await sweep();
      }finally{busy=false;}
    }
    const first=setTimeout(check,3000),timer=setInterval(check,30000);
    document.addEventListener('visibilitychange',check);
    return()=>{active=false;clearTimeout(first);clearInterval(timer);document.removeEventListener('visibilitychange',check);};
  },[run]);
  const resultFor=position=>{
    const row=results[position.id];
    return row?.signature===JSON.stringify(positionReviewInput(position,positions,model))?row:null;
  };
  const alerts=positions.filter(row=>row.remaining_quantity>1e-8&&settings[row.id]?.unread).slice(0,8).map(row=>({
    id:row.id,title:row.title||row.ticker,reason:resultFor(row)?.value?.reason||'Open My Trades for the current bids and a fresh check.'
  }));
  return {run,resultFor,settings,alerts,dismiss:id=>updateSetting(id,{unread:false}),
    toggle:(id,enabled)=>updateSetting(id,{paused:!enabled}),
    notification,enableNotifications:async()=>{
      try{setNotification(await Notification.requestPermission());}catch{setNotification('unsupported');}
    }};
}
