import {fetchJSON} from '../lib/transport.mjs';
export const API_BASE=(process.env.NEXT_PUBLIC_MARKET_API_BASE||'').replace(/\/$/,'');
export const api=(path,options={})=>fetchJSON(API_BASE+path,{cache:'no-store',source:'Market Lab',...options});
export const dollars=value=>Number.isFinite(value)?value.toLocaleString('en-US',{style:'currency',currency:'USD'}):'—';
export const cents=value=>Number.isFinite(value)?`${(value*100).toFixed(2).replace(/\.00$/,'')}¢`:'—';
export const percent=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'—';
export const count=value=>Number.isFinite(value)?value.toLocaleString('en-US',{maximumFractionDigits:2}):'—';
export const dateLabel=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not available';
export function exportJSON(value,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
