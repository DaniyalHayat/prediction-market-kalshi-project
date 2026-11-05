import {randomBytes} from 'node:crypto';

const nonzero=value=>!/^[0]+$/.test(value);
export function parseTraceparent(value){
  if(typeof value!=='string'||!/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(value))return null;
  const [,traceId,parentId,flags]=value.split('-');
  return nonzero(traceId)&&nonzero(parentId)?{traceId,parentId,sampled:(parseInt(flags,16)&1)===1}:null;
}
export function validTracestate(value){
  if(typeof value!=='string'||!value||value.length>512)return false;
  const members=value.split(',');if(members.length>32)return false;
  const keys=new Set();
  return members.every(member=>{
    const [key,...rest]=member.trim().split('='),entry=rest.join('=');
    if(!/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/.test(key)||keys.has(key)||!entry||entry.length>256||!/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]+$/.test(entry)||entry.endsWith(' '))return false;
    keys.add(key);return true;
  });
}
export function traceContext(headers,{trusted=false}={}){
  const read=name=>typeof headers?.get==='function'?headers.get(name):headers?.[name];
  const incoming=trusted?parseTraceparent(read('traceparent')):null;
  const traceId=incoming?.traceId||randomBytes(16).toString('hex'),spanId=randomBytes(8).toString('hex');
  const flags=incoming?.sampled?'01':'00';
  return {traceId,spanId,parentId:incoming?.parentId||null,traceparent:`00-${traceId}-${spanId}-${flags}`,
    tracestate:'marketlab='+spanId,baggageDropped:Boolean(read('baggage'))};
}
const fields=new Set(['status','method','route','duration_ms','trace_id','span_id','parent_id','error_code','open_streams','tickers','subscribers',
  'baggage_dropped','event_loop_p99_ms','heap_mb','rss_mb','pool_total','pool_idle','pool_waiting','result','attempts','kind']);
export function structuredLog(event,values={},write=line=>console.log(line)){
  if(typeof event!=='string'||!/^[a-z][a-z0-9_.-]{0,63}$/.test(event))throw new RangeError('Invalid log event');
  const output={event,time:new Date().toISOString()};
  for(const [key,value] of Object.entries(values))if(fields.has(key)&&((typeof value==='number'&&Number.isFinite(value))||typeof value==='boolean'||typeof value==='string'&&value.length<=120))output[key]=value;
  write(JSON.stringify(output));return output;
}
