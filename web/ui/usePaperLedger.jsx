'use client';
import {useEffect,useRef,useState} from 'react';
import {DEFAULT_PAPER_BALANCE,PAPER_STORAGE,PAPER_BALANCE,PAPER_EVENT,PAPER_LOCK,initializePaperAccount,adjustPaperCash,updateStoredLedger} from './paper-state.mjs';
import {assertPaperSession,loadAccountSession,queueOwnerSave} from './useAccount.jsx';
let enginePromise;
const loadEngine=()=>enginePromise||(enginePromise=import('../public/dashboard/paper.js').then(()=>globalThis.KalshiPaper));
let localWrites=Promise.resolve();
export default function usePaperLedger(){
  const [engine,setEngine]=useState(null),[ledger,setLedger]=useState(null),[bankroll,setBankroll]=useState(DEFAULT_PAPER_BALANCE),[storageError,setStorageError]=useState('');
  const latest=useRef(null);latest.current=ledger;
  useEffect(()=>{
    let disposed=false;
    const sync=api=>{if(disposed)return;try{const stored=api.readLedger(localStorage.getItem(PAPER_STORAGE)),value=initializePaperAccount(stored);if(value!==stored)localStorage.setItem(PAPER_STORAGE,JSON.stringify(value));latest.current=value;setLedger(value);setBankroll(value.starting_balance);setStorageError('');}
      catch{setStorageError('Your paper account could not be loaded. Refresh before recording changes.');}};
    const update=event=>{if(event?.type==='storage'&&![PAPER_STORAGE,PAPER_BALANCE,null].includes(event.key))return;loadEngine().then(sync);};
    Promise.all([loadEngine(),loadAccountSession()]).then(([api,session])=>{if(!disposed){if(!session)throw new Error('Your paper account could not load.');setEngine(api);sync(api);}}).catch(()=>{if(!disposed)setStorageError('Your paper account could not load. Refresh to try again.');});
    window.addEventListener(PAPER_EVENT,update);window.addEventListener('storage',update);
    return()=>{disposed=true;window.removeEventListener(PAPER_EVENT,update);window.removeEventListener('storage',update);};
  },[]);
  async function commit(updater){
    const api=engine||await loadEngine();
    const write=()=>{assertPaperSession();const next=updateStoredLedger(api,localStorage,updater,latest.current);latest.current=next;setLedger(next);queueOwnerSave(next);window.dispatchEvent(new Event(PAPER_EVENT));return next;};
    try{
      if(navigator.locks?.request)return await navigator.locks.request(PAPER_LOCK,write);
      const pending=localWrites.then(write);localWrites=pending.catch(()=>{});return await pending;
    }catch(error){setStorageError('The paper update could not be saved. No successful paper execution is assumed.');throw error;}
  }
  const adjustCash=(action,amount)=>commit(current=>adjustPaperCash(current,action,amount,{id:crypto.randomUUID()}));
  return {engine,ledger,bankroll,adjustCash,commit,storageError};
}
