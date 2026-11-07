'use client';
import {useEffect,useRef,useState} from 'react';
import {DEFAULT_PAPER_BALANCE,PAPER_STORAGE,PAPER_BALANCE,PAPER_EVENT,PAPER_LOCK,adjustPaperCash,updateStoredLedger} from './paper-state.mjs';
import {assertPaperSession,loadAccountSession,queueOwnerSave} from './useAccount.jsx';
import {readVerifiedPaperLedger} from './paper-session.mjs';
let enginePromise;
const loadEngine=()=>enginePromise||(enginePromise=import('../public/dashboard/paper.js').then(()=>globalThis.PredictirPaper));
let localWrites=Promise.resolve();
export default function usePaperLedger(){
  const [engine,setEngine]=useState(null),[ledger,setLedger]=useState(null),[bankroll,setBankroll]=useState(DEFAULT_PAPER_BALANCE),[storageError,setStorageError]=useState(''),[retrying,setRetrying]=useState(false);
  const latest=useRef(null),mounted=useRef(false);latest.current=ledger;
  const sync=api=>{if(!mounted.current)return;try{const value=readVerifiedPaperLedger({engine:api,storage:localStorage,assertSession:assertPaperSession});latest.current=value;setEngine(api);setLedger(value);setBankroll(value.starting_balance);setStorageError('');}
    catch{setStorageError('Your paper account could not be loaded. Retry before recording changes.');}};
  useEffect(()=>{
    mounted.current=true;
    const update=event=>{if(event?.type==='storage'&&![PAPER_STORAGE,PAPER_BALANCE,null].includes(event.key))return;loadEngine().then(sync);};
    Promise.all([loadEngine(),loadAccountSession()]).then(([api,session])=>{if(mounted.current){if(!session)throw new Error('Your paper account could not load.');sync(api);}}).catch(()=>{if(mounted.current)setStorageError('Your paper account could not load. Retry to reconnect.');});
    window.addEventListener(PAPER_EVENT,update);window.addEventListener('storage',update);
    return()=>{mounted.current=false;window.removeEventListener(PAPER_EVENT,update);window.removeEventListener('storage',update);};
  },[]);
  async function retry(){
    if(retrying)return;setRetrying(true);
    try{const [api,session]=await Promise.all([loadEngine(),loadAccountSession(true)]);if(!session)throw new Error('Account recovery failed');sync(api);}
    catch{if(mounted.current)setStorageError('Your paper account could not reconnect. Your saved records have been kept.');}
    finally{if(mounted.current)setRetrying(false);}
  }
  async function commit(updater){
    const api=engine||await loadEngine();
    const write=()=>{assertPaperSession();const next=updateStoredLedger(api,localStorage,updater,latest.current);latest.current=next;setLedger(next);queueOwnerSave(next);window.dispatchEvent(new Event(PAPER_EVENT));return next;};
    try{
      if(navigator.locks?.request)return await navigator.locks.request(PAPER_LOCK,write);
      const pending=localWrites.then(write);localWrites=pending.catch(()=>{});return await pending;
    }catch(error){setStorageError('The paper update could not be saved. No successful paper execution is assumed.');throw error;}
  }
  const adjustCash=(action,amount)=>commit(current=>adjustPaperCash(current,action,amount,{id:crypto.randomUUID()}));
  return {engine,ledger,bankroll,adjustCash,commit,storageError,retry,retrying};
}
