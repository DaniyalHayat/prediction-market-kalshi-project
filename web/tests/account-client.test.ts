import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAccountSession,accountSnapshot,resolveAccountConflict} from '../ui/useAccount.jsx';
import {PAPER_STORAGE,initializePaperAccount} from '../ui/paper-state.mjs';
import {ACTIVE_ACCOUNT,accountCacheKey} from '../ui/guest-session.mjs';
const memory=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)}});
Object.defineProperty(globalThis,'window',{configurable:true,value:new EventTarget()});
const guest={kind:'guest',guest:{id:'guest-test',created_at:new Date().toISOString(),last_active_at:new Date().toISOString(),expires_at:new Date(Date.now()+21600000).toISOString()}};
const owner={kind:'owner',owner:{email:'owner@example.test'},guest:guest.guest};
const ledger=(amount=0)=>({...initializePaperAccount({version:1,positions:[],trades:[]}),cash_movements:amount?[{id:'cash-'+amount,action:'add',amount,occurred_at:new Date().toISOString()}]:[]});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
test('session request failure retains the local paper ledger and blocks writes pending recovery',async()=>{
  memory.clear();const retained=JSON.stringify(ledger(25));memory.set(PAPER_STORAGE,retained);
  globalThis.fetch=async()=>{throw new Error('Offline');};
  assert.equal(await loadAccountSession(true),null);assert.equal(memory.get(PAPER_STORAGE),retained);assert.equal(accountSnapshot().status,'error');
});
test('an empty owner account never replaces unsynced local paper records and saves them with the observed revision',async()=>{
  memory.clear();memory.set(ACTIVE_ACCOUNT,'owner:'+owner.owner.email);const retained=JSON.stringify(ledger(25));memory.set(PAPER_STORAGE,retained);
  const writes:any[]=[];
  globalThis.fetch=async(input,options)=>{
    const path=String(input);if(path.endsWith('/api/session'))return json(owner);
    if(options?.method==='PUT'){const value=JSON.parse(String(options.body));writes.push(value);return json({...value,revision:1});}
    return json({ledger:null,watchlist:[],revision:0});
  };
  await loadAccountSession(true);assert.equal(memory.get(PAPER_STORAGE),retained);
  await new Promise(resolve=>setTimeout(resolve,850));assert.equal(writes.length,1);assert.equal(writes[0].revision,0);assert.deepEqual(writes[0].ledger,JSON.parse(retained));assert.equal(accountSnapshot().sync,'Saved to your account');
});
test('divergent owner records preserve both versions, stop automatic saves and require an explicit choice',async()=>{
  memory.clear();memory.set(ACTIVE_ACCOUNT,'owner:'+owner.owner.email);const baseline=ledger(),local=ledger(25),remote=ledger(50);memory.set(PAPER_STORAGE,JSON.stringify(local));memory.set(accountCacheKey('owner-meta:'+owner.owner.email),JSON.stringify({synced:JSON.stringify(baseline),revision:1,watchlist:[]}));
  let writes=0;globalThis.fetch=async(input,options)=>{if(String(input).endsWith('/api/session'))return json(owner);if(options?.method==='PUT')writes++;return json({ledger:remote,watchlist:['KXTEST-YES'],revision:2});};
  await loadAccountSession(true);assert.deepEqual(JSON.parse(memory.get(PAPER_STORAGE)!),local);const conflict=accountSnapshot().conflict as unknown as {local:unknown,remote:{ledger:unknown}};assert.deepEqual(conflict.local,local);assert.deepEqual(conflict.remote.ledger,remote);
  await new Promise(resolve=>setTimeout(resolve,850));assert.equal(writes,0);resolveAccountConflict('account');assert.deepEqual(JSON.parse(memory.get(PAPER_STORAGE)!),remote);assert.equal(accountSnapshot().conflict,null);assert.deepEqual(accountSnapshot().watchlist,['KXTEST-YES']);
});
