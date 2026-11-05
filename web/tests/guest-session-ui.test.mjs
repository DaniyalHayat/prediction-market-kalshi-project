import test from 'node:test';
import assert from 'node:assert/strict';
import {PAPER_STORAGE,PAPER_BALANCE} from '../ui/paper-state.mjs';
import {ACTIVE_ACCOUNT,GUEST_STORAGE,GUEST_DATA_LIFETIME,GUEST_INACTIVITY,accountCacheKey,guestExpired,prepareGuestSession,switchPaperAccount} from '../ui/guest-session.mjs';
const now=Date.parse('2026-11-04T17:00:00Z');
const guest=(id='guest-one',created=now)=>({id,created_at:new Date(created).toISOString(),last_active_at:new Date(created).toISOString(),expires_at:new Date(created+GUEST_DATA_LIFETIME).toISOString()});
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
test('guest data expires at six hours even with recent activity and malformed dates cannot persist it',()=>{
  const value=guest();assert.equal(guestExpired(value,now+GUEST_DATA_LIFETIME-1),false);assert.equal(guestExpired({...value,last_active_at:new Date(now+GUEST_DATA_LIFETIME-1).toISOString()},now+GUEST_DATA_LIFETIME),true);
  assert.equal(guestExpired({...value,expires_at:'broken'},now),true);
  assert.equal(guestExpired({...value,created_at:new Date(now-1000).toISOString(),last_active_at:new Date(now-GUEST_INACTIVITY).toISOString()},now),true);
});
test('binding an existing browser retains paper records but confirmed session rotation starts fresh',()=>{
  const store=storage();store.setItem(PAPER_STORAGE,'retained ledger');store.setItem(PAPER_BALANCE,'1000');
  assert.equal(prepareGuestSession(store,guest(),now).changed,false);assert.equal(store.getItem(PAPER_STORAGE),'retained ledger');
  assert.equal(prepareGuestSession(store,{...guest(),ip:'different network'},now+1000).changed,false);assert.equal(store.getItem(PAPER_STORAGE),'retained ledger');
  assert.equal(prepareGuestSession(store,guest('guest-two'),now+2000).changed,true);assert.equal(store.getItem(PAPER_STORAGE),null);assert.equal(store.getItem(PAPER_BALANCE),null);
});
test('switching between guest and owner keeps separate paper records and discards expired guest caches',()=>{
  const store=storage();switchPaperAccount(store,'guest:guest-one',{guest:guest(),now});store.setItem(PAPER_STORAGE,'guest ledger');
  switchPaperAccount(store,'owner:me@example.test');assert.equal(store.getItem(PAPER_STORAGE),null);store.setItem(PAPER_STORAGE,'owner ledger');
  switchPaperAccount(store,'guest:guest-one',{guest:guest(),now:now+1000});assert.equal(store.getItem(PAPER_STORAGE),'guest ledger');assert.equal(store.getItem(accountCacheKey('owner:me@example.test')),'owner ledger');
  switchPaperAccount(store,'guest:guest-two',{guest:guest('guest-two',now+GUEST_DATA_LIFETIME),now:now+GUEST_DATA_LIFETIME});assert.equal(store.getItem(PAPER_STORAGE),null);assert.equal(store.getItem(accountCacheKey('guest:guest-one')),null);assert.equal(store.getItem(ACTIVE_ACCOUNT),'guest:guest-two');assert.equal(JSON.parse(store.getItem(GUEST_STORAGE)).id,'guest-two');
});
