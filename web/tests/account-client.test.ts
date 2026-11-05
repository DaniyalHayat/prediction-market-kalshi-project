import test from 'node:test';
import assert from 'node:assert/strict';
import {loadAccountSession,accountSnapshot,resolveAccountConflict,assertPaperSession} from '../ui/useAccount.jsx';
import {PAPER_STORAGE,initializePaperAccount} from '../ui/paper-state.mjs';
import {ACTIVE_ACCOUNT,accountCacheKey} from '../ui/guest-session.mjs';
import {readVerifiedPaperLedger} from '../ui/paper-session.mjs';
import '../public/dashboard/paper.js';
const memory=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)}});
Object.defineProperty(globalThis,'window',{configurable:true,value:new EventTarget()});
const guest={kind:'guest',guest:{id:'guest-test',created_at:new Date().toISOString(),last_active_at:new Date().toISOString(),expires_at:new Date(Date.now()+21600000).toISOString()}};
const owner={kind:'owner',owner:{email:'owner@example.test'},guest:guest.guest};
const ledger=(amount=0)=>({...initializePaperAccount({version:1,positions:[],trades:[]}),cash_movements:amount?[{id:'cash-'+amount,action:'add',amount,occurred_at:new Date().toISOString()}]:[]});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const sessionKind=()=>((accountSnapshot().session as unknown as {kind:string}|null)?.kind);
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
test('an account change in another tab blocks writes before accepting that tab’s retained ledger',async()=>{
  assert.equal(sessionKind(),'owner');
  const changed=JSON.stringify(ledger(75));memory.set(ACTIVE_ACCOUNT,'guest:other-tab');memory.set(PAPER_STORAGE,changed);
  globalThis.fetch=async()=>json(guest);
  assert.throws(()=>assertPaperSession(),/changed in another tab/);assert.equal(memory.get(PAPER_STORAGE),changed);assert.equal(accountSnapshot().status,'loading');
  await loadAccountSession();assert.equal(sessionKind(),'guest');assert.equal(memory.get(ACTIVE_ACCOUNT),'guest:'+guest.guest.id);
});
test('a late session response cannot replace a newer verified account identity',async()=>{
  let release:(response:Response)=>void=()=>{};const delayed=new Promise<Response>(resolve=>{release=resolve;});let calls=0;
  globalThis.fetch=async()=>++calls===1?delayed:json(guest);
  const old=loadAccountSession(true),current=loadAccountSession(true);await current;assert.equal(sessionKind(),'guest');
  const retained=memory.get(PAPER_STORAGE);release(json(owner));await old;
  assert.equal(sessionKind(),'guest');assert.equal(memory.get(ACTIVE_ACCOUNT),'guest:'+guest.guest.id);assert.equal(memory.get(PAPER_STORAGE),retained);assert.equal(calls,2);
});

test('an explicit retry after initial 503 restores guest paper funds without resetting retained records',async()=>{
  const engine=(globalThis as any).KalshiPaper;
  for(const existing of [null,JSON.stringify(ledger(25))]){
    memory.clear();memory.set(ACTIVE_ACCOUNT,'guest:'+guest.guest.id);if(existing)memory.set(PAPER_STORAGE,existing);
    let calls=0;globalThis.fetch=async()=>++calls===1?json({error:'Temporarily unavailable'},503):json(guest);
    assert.equal(await loadAccountSession(true),null);assert.equal(accountSnapshot().status,'error');assert.equal(memory.get(PAPER_STORAGE),existing??undefined);
    assert.throws(()=>readVerifiedPaperLedger({engine,storage:localStorage,assertSession:assertPaperSession}),/loading/);
    assert.equal((await loadAccountSession(true) as any).kind,'guest');
    const recovered=readVerifiedPaperLedger({engine,storage:localStorage,assertSession:assertPaperSession});
    assert.equal(recovered.starting_balance,20000);assert.equal(calls,2);
    if(existing)assert.equal(memory.get(PAPER_STORAGE),existing);else assert.equal(JSON.parse(memory.get(PAPER_STORAGE)!).starting_balance,20000);
    await loadAccountSession();assert.equal(calls,2);
  }
});

test('an owner identity outage cannot initialize or switch to a guest paper account',async()=>{
  memory.clear();const retained=JSON.stringify(ledger(75));memory.set(ACTIVE_ACCOUNT,'owner:'+owner.owner.email);memory.set(PAPER_STORAGE,retained);
  globalThis.fetch=async()=>json({error:'Identity provider temporarily unavailable'},503);
  assert.equal(await loadAccountSession(true),null);
  assert.throws(()=>readVerifiedPaperLedger({engine:(globalThis as any).KalshiPaper,storage:localStorage,assertSession:assertPaperSession}),/loading/);
  assert.equal(memory.get(ACTIVE_ACCOUNT),'owner:'+owner.owner.email);assert.equal(memory.get(PAPER_STORAGE),retained);
});
