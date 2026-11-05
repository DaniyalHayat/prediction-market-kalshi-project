import {PAPER_STORAGE,PAPER_BALANCE} from './paper-state.mjs';
export const GUEST_STORAGE='kalshi-market-lab:guest-session:v1';
export const ACTIVE_ACCOUNT='kalshi-market-lab:active-account:v1';
export const GUEST_DATA_LIFETIME=6*60*60*1000;
export const GUEST_INACTIVITY=8*60*60*1000;
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
export const accountCacheKey=account=>'kalshi-market-lab:account-cache:v1:'+account;
export function guestExpired(guest,now=Date.now()){
  const created=Date.parse(guest?.created_at),lastActive=Date.parse(guest?.last_active_at),expires=Date.parse(guest?.expires_at);
  return !Number.isFinite(created)||!Number.isFinite(lastActive)||!Number.isFinite(expires)||now>=Math.min(expires,created+GUEST_DATA_LIFETIME)||now-lastActive>=GUEST_INACTIVITY;
}
export function prepareGuestSession(storage,guest,now=Date.now()){
  if(typeof guest?.id!=='string'||!guest.id||guestExpired(guest,now))throw new Error('Your guest session has expired. Refresh to start a new paper account.');
  const previous=parse(storage.getItem(GUEST_STORAGE)),changed=Boolean(previous&&(previous.id!==guest.id||guestExpired(previous,now)));
  if(changed){storage.removeItem(PAPER_STORAGE);storage.removeItem(PAPER_BALANCE);storage.removeItem(accountCacheKey('guest:'+previous.id));storage.removeItem(accountCacheKey('watchlist:guest:'+previous.id));}
  storage.setItem(GUEST_STORAGE,JSON.stringify(guest));
  return {changed,guest};
}
export function switchPaperAccount(storage,account,{guest=null,now=Date.now()}={}){
  const previous=storage.getItem(ACTIVE_ACCOUNT),current=storage.getItem(PAPER_STORAGE);
  if(previous===account){if(guest)prepareGuestSession(storage,guest,now);return;}
  if(previous&&current)storage.setItem(accountCacheKey(previous),current);
  if(guest)prepareGuestSession(storage,guest,now);
  const cached=storage.getItem(accountCacheKey(account));
  if(cached)storage.setItem(PAPER_STORAGE,cached);
  else if(previous)storage.removeItem(PAPER_STORAGE);
  storage.setItem(ACTIVE_ACCOUNT,account);
}
