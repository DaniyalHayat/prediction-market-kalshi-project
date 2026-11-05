'use client';
import {useEffect,useRef,useState} from 'react';
import {PAPER_STORAGE,PAPER_BALANCE,PAPER_EVENT,PAPER_LOCK,readStartingBalance,updateStoredLedger} from './paper-state.mjs';
let enginePromise;
const loadEngine=()=>enginePromise||(enginePromise=import('../public/dashboard/paper.js').then(()=>globalThis.KalshiPaper));
let localWrites=Promise.resolve();
export default function usePaperLedger(){
  const [engine,setEngine]=useState(null),[ledger,setLedger]=useState(null),[bankroll,setBankroll]=useState(1000),[storageError,setStorageError]=useState('');
  const latest=useRef(null);latest.current=ledger;
  useEffect(()=>{
    let disposed=false;
    const sync=api=>{if(disposed)return;try{const value=api.readLedger(localStorage.getItem(PAPER_STORAGE));latest.current=value;setLedger(value);setBankroll(readStartingBalance(localStorage.getItem(PAPER_BALANCE)));setStorageError('');}
      catch{setStorageError('Browser storage is unavailable. Export your paper records before leaving this page.');if(!latest.current){latest.current=api.emptyLedger();setLedger(latest.current);}}};
    const update=event=>{if(event?.type==='storage'&&![PAPER_STORAGE,PAPER_BALANCE,null].includes(event.key))return;loadEngine().then(sync);};
    loadEngine().then(api=>{if(!disposed){setEngine(api);sync(api);}}).catch(()=>{if(!disposed)setStorageError('The paper engine could not load. Refresh to try again.');});
    window.addEventListener(PAPER_EVENT,update);window.addEventListener('storage',update);
    return()=>{disposed=true;window.removeEventListener(PAPER_EVENT,update);window.removeEventListener('storage',update);};
  },[]);
  async function commit(updater){
    const api=engine||await loadEngine();
    const write=()=>{const next=updateStoredLedger(api,localStorage,updater,latest.current);latest.current=next;setLedger(next);window.dispatchEvent(new Event(PAPER_EVENT));return next;};
    try{
      if(navigator.locks?.request)return await navigator.locks.request(PAPER_LOCK,write);
      const pending=localWrites.then(write);localWrites=pending.catch(()=>{});return await pending;
    }catch(error){setStorageError('The paper update could not be saved. No successful paper execution is assumed.');throw error;}
  }
  function changeBankroll(value){setBankroll(value);const number=Number(value);if(!Number.isFinite(number)||number<=0||number>1e9)return;
    try{localStorage.setItem(PAPER_BALANCE,String(number));window.dispatchEvent(new Event(PAPER_EVENT));setStorageError('');}catch{setStorageError('The starting balance could not be saved.');}}
  return {engine,ledger,bankroll,changeBankroll,commit,storageError};
}
