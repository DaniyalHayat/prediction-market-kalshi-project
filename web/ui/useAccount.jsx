'use client';
import {useEffect,useSyncExternalStore} from 'react';
import {fetchJSON} from '../lib/transport.mjs';
import {PAPER_STORAGE,PAPER_EVENT,initializePaperAccount} from './paper-state.mjs';
import {emitAnalytics} from '../app/components/analytics-policy.mjs';
import {ACTIVE_ACCOUNT,GUEST_STORAGE,GUEST_DATA_LIFETIME,GUEST_INACTIVITY,guestExpired,purgeExpiredGuestData,switchPaperAccount,accountCacheKey} from './guest-session.mjs';
const listeners=new Set(),initial={session:null,status:'loading',error:'',sync:'',conflict:null,watchlist:[]};
let state=initial,loading=null,loadIntent=0,saveTimer=null,revision=0,synced=null,pendingSave=null,saving=false;
export const accountSnapshot=()=>state;
const serverSnapshot=()=>initial;
const publish=patch=>{state={...state,...patch};listeners.forEach(listener=>listener());};
const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
const notifyPaper=()=>window.dispatchEvent(new Event(PAPER_EVENT));
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const ownerMetaKey=email=>accountCacheKey('owner-meta:'+email.toLowerCase());
const accountAPI=(path,options={})=>fetchJSON(path,{cache:'no-store',source:'Account',credentials:'same-origin',...options});
function ownerMeta(){return parse(localStorage.getItem(ownerMetaKey(state.session?.owner?.email||'')));}
export async function loadAccountSession(force=false){
  if(loading&&!force)return loading;
  const intent=++loadIntent;
  loading=(async()=>{
    publish({status:'loading',error:''});
    try{
      const session=await accountAPI('/api/session',{signal:AbortSignal.timeout(15000)});
      if(intent!==loadIntent)return loading;
      if(session.kind==='owner'){
        const email=session.owner?.email;if(typeof email!=='string')throw new Error('Your account could not be identified. Sign in again.');
        switchPaperAccount(localStorage,'owner:'+email.toLowerCase(),{guest:session.guest});
        const saved=await accountAPI('/api/account/portfolio',{signal:AbortSignal.timeout(15000)}),local=parse(localStorage.getItem(PAPER_STORAGE)),meta=parse(localStorage.getItem(ownerMetaKey(email)));
        if(intent!==loadIntent)return loading;
        revision=saved.revision||0;synced=meta?.synced??null;
        const localChanged=local&&JSON.stringify(local)!==synced;
        const remoteChanged=JSON.stringify(saved.ledger)!==synced;
        if(localChanged&&remoteChanged&&saved.ledger&&JSON.stringify(local)!==JSON.stringify(saved.ledger))publish({conflict:{local,remote:saved,revision}});
        else if(saved.ledger&&!localChanged){localStorage.setItem(PAPER_STORAGE,JSON.stringify(saved.ledger));synced=JSON.stringify(saved.ledger);}
        else if(localChanged&&JSON.stringify(local)===JSON.stringify(saved.ledger))synced=JSON.stringify(local);
        const watchlist=[...new Set([...(saved.watchlist||[]),...(meta?.watchlist||[])])].slice(0,200);
        localStorage.setItem(ownerMetaKey(email),JSON.stringify({revision,synced,watchlist}));
        publish({session,status:'ready',watchlist,sync:state.conflict?'Review saved versions':localChanged&&synced!==JSON.stringify(local)?'Changes saved on this browser':'Saved to your account'});
        notifyPaper();
        if(!state.conflict&&(localChanged&&synced!==JSON.stringify(local)||JSON.stringify(watchlist)!==JSON.stringify(saved.watchlist||[])))queueOwnerSave(local||saved.ledger||initializePaperAccount({version:1,positions:[],trades:[]}));
      }else{
        switchPaperAccount(localStorage,'guest:'+session.guest?.id,{guest:session.guest});revision=0;synced=null;pendingSave=null;clearTimeout(saveTimer);
        const watchlist=parse(localStorage.getItem(accountCacheKey('watchlist:guest:'+session.guest.id)))||[];
        publish({session,status:'ready',watchlist,sync:'',conflict:null});notifyPaper();
      }
      return session;
    }catch(error){if(intent!==loadIntent)return loading;publish({status:'error',error:error.message});return null;}
  })();
  return loading;
}
export function assertPaperSession(){
  if(state.status!=='ready')throw new Error('Your paper account is still loading. Try again shortly.');
  const expected=state.session.kind==='owner'?'owner:'+state.session.owner.email.toLowerCase():'guest:'+state.session.guest.id;
  if(localStorage.getItem(ACTIVE_ACCOUNT)!==expected){loadAccountSession(true);throw new Error('Your account changed in another tab. Wait for the current account to finish loading.');}
  if(state.session.kind==='guest'){
    const guest=parse(localStorage.getItem(GUEST_STORAGE));
    if(guestExpired(guest)){loadAccountSession(true);throw new Error('Your guest session ended. A fresh paper account is loading.');}
    localStorage.setItem(GUEST_STORAGE,JSON.stringify({...guest,last_active_at:new Date().toISOString()}));
  }
}
export function queueOwnerSave(ledger){
  if(state.session?.kind!=='owner')return;
  localStorage.setItem(accountCacheKey(localStorage.getItem(ACTIVE_ACCOUNT)),JSON.stringify(ledger));
  pendingSave=ledger;clearTimeout(saveTimer);publish({sync:state.conflict?'Review saved versions':'Saving…',...(state.conflict?{conflict:{...state.conflict,local:ledger}}:{})});
  if(!state.conflict)saveTimer=setTimeout(flushOwnerSave,750);
}
async function flushOwnerSave(){
  if(saving||!pendingSave||state.conflict||state.status!=='ready'||state.session?.kind!=='owner'||localStorage.getItem(ACTIVE_ACCOUNT)!=='owner:'+state.session.owner.email.toLowerCase())return;
  saving=true;const ledger=pendingSave,email=state.session.owner.email;pendingSave=null;
  const currentOwner=()=>state.status==='ready'&&state.session?.kind==='owner'&&state.session.owner.email===email&&localStorage.getItem(ACTIVE_ACCOUNT)==='owner:'+email.toLowerCase();
  try{
    const response=await fetch('/api/account/portfolio',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({ledger,watchlist:ownerMeta()?.watchlist||[],revision}),cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15000)});
    const value=await response.json();
    if(!currentOwner())return;
    if(response.status===409){publish({conflict:{local:pendingSave||ledger,remote:value,revision:value.revision},sync:'Review saved versions'});return;}
    if(!response.ok)throw new Error(value.error||'Account save failed.');
    revision=value.revision;synced=JSON.stringify(ledger);localStorage.setItem(ownerMetaKey(state.session.owner.email),JSON.stringify({revision,synced,watchlist:state.watchlist}));
    publish({sync:pendingSave?'Saving…':'Saved to your account'});
  }catch{if(currentOwner()){pendingSave=pendingSave||ledger;publish({sync:'Saved on this browser · account sync unavailable'});}}
  finally{saving=false;if(pendingSave&&state.sync==='Saving…'&&!state.conflict)saveTimer=setTimeout(flushOwnerSave,750);}
}
export async function signInOwner(email,password){
  await accountAPI('/api/account/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(15000)});
  loading=null;return loadAccountSession(true);
}
export async function signOutOwner(){
  clearTimeout(saveTimer);if(saving)throw new Error('Your account is saving. Try signing out in a moment.');
  await accountAPI('/api/account/logout',{method:'POST',signal:AbortSignal.timeout(15000)});pendingSave=null;loading=null;publish({conflict:null});return loadAccountSession(true);
}
export function resolveAccountConflict(choice){
  const conflict=state.conflict;if(!conflict)return;
  revision=conflict.revision||0;const ledger=choice==='account'?conflict.remote.ledger:parse(localStorage.getItem(PAPER_STORAGE))||conflict.local;
  if(!ledger)throw new Error('This saved version has no paper account.');
  localStorage.setItem(PAPER_STORAGE,JSON.stringify(ledger));
  publish({conflict:null,sync:'Saving…'});notifyPaper();
  if(choice==='account'){pendingSave=null;synced=JSON.stringify(ledger);localStorage.setItem(ownerMetaKey(state.session.owner.email),JSON.stringify({revision,synced,watchlist:conflict.remote.watchlist||[]}));publish({sync:'Saved to your account',watchlist:conflict.remote.watchlist||[]});}
  else queueOwnerSave(ledger);
}
export function toggleSavedMarket(ticker){
  if(!/^KX[A-Z0-9_.]{1,40}-[A-Z0-9_.-]+$/.test(ticker)||ticker.includes('..'))return;
  assertPaperSession();const removed=state.watchlist.includes(ticker),watchlist=removed?state.watchlist.filter(value=>value!==ticker):[...state.watchlist,ticker];
  if(watchlist.length>200)throw new Error('Your watchlist has reached 200 contracts. Remove a contract before saving another.');
  if(state.session.kind==='owner'){
    localStorage.setItem(ownerMetaKey(state.session.owner.email),JSON.stringify({...ownerMeta(),watchlist}));
    const ledger=parse(localStorage.getItem(PAPER_STORAGE))||initializePaperAccount({version:1,positions:[],trades:[]});queueOwnerSave(ledger);
  }else localStorage.setItem(accountCacheKey('watchlist:guest:'+state.session.guest.id),JSON.stringify(watchlist));
  publish({watchlist});emitAnalytics('saved_market',{ticker,action:removed?'remove':'save'});
}
export default function useAccount(){
  const value=useSyncExternalStore(subscribe,accountSnapshot,serverSnapshot);
  useEffect(()=>{loadAccountSession();},[]);
  useEffect(()=>{
    const retry=()=>flushOwnerSave();
    const changed=event=>{if(event.key===ACTIVE_ACCOUNT)loadAccountSession(true);};
    window.addEventListener('online',retry);window.addEventListener('storage',changed);
    return()=>{window.removeEventListener('online',retry);window.removeEventListener('storage',changed);};
  },[]);
  useEffect(()=>{
    let timer;
    const check=()=>{
      clearTimeout(timer);
      try{
        const result=purgeExpiredGuestData(localStorage);
        if(result.activeReset){notifyPaper();if(state.status==='ready')loadAccountSession(true);return;}
        const guest=parse(localStorage.getItem(GUEST_STORAGE));if(!guest)return;
        const deadline=Math.min(Date.parse(guest.expires_at),Date.parse(guest.created_at)+GUEST_DATA_LIFETIME,Date.parse(guest.last_active_at)+GUEST_INACTIVITY);
        timer=setTimeout(check,Math.max(1,deadline-Date.now()+50));
      }catch{}
    };
    const visible=()=>{if(!document.hidden)check();},changed=event=>{if(event.key===GUEST_STORAGE)check();};
    check();document.addEventListener('visibilitychange',visible);window.addEventListener('storage',changed);
    return()=>{clearTimeout(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('storage',changed);};
  },[value.session,value.status]);
  return value;
}
