import {book,bookMetrics,validateTicker} from '../live.mjs';

export const PUBLIC_BOOK_TRANSPORT='public-rest-poll';
const officialHosts=new Set(['external-api.kalshi.com','api.elections.kalshi.com','api.kalshi.com']);

function pollSnapshot(value,ticker,now){
  const stamp=Date.parse(value?.as_of),source=new URL(value?.source_url);
  if(value?.ticker!==ticker||!Number.isFinite(stamp)||stamp>now+5000||now-stamp>90000||
    source.protocol!=='https:'||source.username||source.password||source.port||source.hash||!officialHosts.has(source.hostname)||
    [...source.searchParams.keys()].some(key=>key!=='depth')||
    !source.pathname.endsWith('/markets/'+encodeURIComponent(ticker)+'/orderbook'))throw new Error('Invalid public snapshot');
  const levels=value.raw?.orderbook_fp;
  const yes=levels?.yes_dollars??[],no=levels?.no_dollars??[];
  if(!levels||!Array.isArray(yes)||!Array.isArray(no)||yes.length>100||no.length>100)throw new Error('Invalid public snapshot depth');
  const raw={orderbook_fp:{yes_dollars:yes,no_dollars:no}};
  if(bookMetrics(raw,1).book_state==='crossed')throw new Error('Invalid public snapshot spread');
  return {kind:'quote',ticker,transport:PUBLIC_BOOK_TRANSPORT,as_of:value.as_of,source_url:source.href,depth_limit:100,raw};
}

export class PublicBookFeed {
  constructor({fetchBook=book,reserve=async()=>true,now=Date.now,schedule=setTimeout,cancel=clearTimeout,
    intervalMs=8000,startSpacingMs=1000,maximumTickers=24,maximumConcurrent=2}={}){
    this.fetchBook=fetchBook;this.reserve=reserve;this.now=now;this.schedule=schedule;this.cancel=cancel;
    this.intervalMs=intervalMs;this.startSpacingMs=startSpacingMs;this.maximumTickers=maximumTickers;this.maximumConcurrent=maximumConcurrent;
    this.entries=new Map();this.reading=0;this.nextStart=0;this.cooldownUntil=0;this.throttleCount=0;
    this.cooldownStatus=null;this.timer=null;this.closed=false;
  }

  get transport(){return PUBLIC_BOOK_TRANSPORT;}
  get status(){return this.cooldownUntil>this.now()?this.cooldownStatus?.status||'backoff':this.entries.size?'polling':'idle';}

  async add(ticker,listener){
    validateTicker(ticker);
    if(this.closed)throw new Error('Public quote polling is closed');
    let entry=this.entries.get(ticker);
    if(!entry){
      if(this.entries.size>=this.maximumTickers)throw new RangeError('Public quote polling capacity is full');
      entry={ticker,listeners:new Set(),due:this.now(),failures:0,reading:false};
      this.entries.set(ticker,entry);
    }
    entry.listeners.add(listener);
    const publish=message=>{try{listener(message);}catch{}};
    if(this.cooldownUntil>this.now())publish(this.cooldownStatus);
    else if(!entry.failures&&entry.snapshot&&this.now()-Date.parse(entry.snapshot.as_of)<=90000)publish(entry.snapshot);
    else publish({kind:'connection',transport:this.transport,status:'connecting'});
    this.scheduleNext();
    let removed=false;
    return ()=>{
      if(removed)return;
      removed=true;entry.listeners.delete(listener);
      if(!entry.listeners.size&&!entry.reading)this.entries.delete(ticker);
      this.scheduleNext();
    };
  }

  metrics(){
    return {status:this.status,transport:this.transport,
      tickers:[...this.entries.values()].filter(entry=>entry.listeners.size).length,
      subscribers:[...this.entries.values()].reduce((total,entry)=>total+entry.listeners.size,0),polls_in_flight:this.reading};
  }

  send(entry,message){for(const listener of entry.listeners)try{listener(message);}catch{}}

  scheduleNext(){
    if(this.timer!==null){this.cancel(this.timer);this.timer=null;}
    if(this.closed||this.reading>=this.maximumConcurrent)return;
    let due=Infinity;
    for(const entry of this.entries.values())if(entry.listeners.size&&!entry.reading)due=Math.min(due,entry.due);
    if(!Number.isFinite(due))return;
    const delay=Math.max(0,Math.max(due,this.nextStart,this.cooldownUntil)-this.now());
    this.timer=this.schedule(()=>{this.timer=null;this.startPoll();},Math.min(delay,2147483647));
    this.timer?.unref?.();
  }

  startPoll(){
    const now=this.now();
    if(this.closed||this.reading>=this.maximumConcurrent||now<this.nextStart||now<this.cooldownUntil){this.scheduleNext();return;}
    let selected;
    for(const entry of this.entries.values()){
      if(entry.listeners.size&&!entry.reading&&entry.due<=now&&(!selected||entry.due<selected.due))selected=entry;
    }
    if(!selected){this.scheduleNext();return;}
    this.nextStart=now+this.startSpacingMs;
    selected.reading=true;this.reading++;
    void this.poll(selected);
    this.scheduleNext();
  }

  pause(until,status,reason){
    this.cooldownUntil=Math.max(this.cooldownUntil,until);
    this.cooldownStatus={kind:'connection',transport:this.transport,status,reason,retry_at:new Date(this.cooldownUntil).toISOString()};
    for(const entry of this.entries.values())this.send(entry,this.cooldownStatus);
  }

  async poll(entry){
    try{
      if(!await this.reserve(this.now())){
        const nextDay=Math.floor(this.now()/86400000)*86400000+86400000;
        this.pause(nextDay,'allowance reached','The shared public quote polling allowance is used for today.');
        return;
      }
      if(this.closed||!entry.listeners.size||this.cooldownUntil>this.now())return;
      const snapshot=pollSnapshot(await this.fetchBook(entry.ticker,1),entry.ticker,this.now());
      if(this.closed||!entry.listeners.size)return;
      entry.failures=0;
      if(this.cooldownUntil<=this.now())this.throttleCount=0;
      entry.due=this.now()+this.intervalMs;
      if(!entry.snapshot||Date.parse(snapshot.as_of)>Date.parse(entry.snapshot.as_of)){
        entry.snapshot=snapshot;this.send(entry,snapshot);
      }
    }catch(error){
      if(this.closed)return;
      entry.failures=Math.min(entry.failures+1,5);
      const now=this.now(),status=error?.upstream_status||error?.status;
      if(status===429){
        if(now>=this.cooldownUntil)this.throttleCount=Math.min(this.throttleCount+1,4);
        const providerDelay=Number.isFinite(error?.retry_after_seconds)?Math.min(86400,error.retry_after_seconds)*1000:0;
        this.pause(now+Math.max(60000*2**Math.max(0,this.throttleCount-1),providerDelay),'backoff','Kalshi rate limited public polling. The last snapshot keeps its original time.');
      }else if(entry.listeners.size){
        entry.due=now+Math.max(status===404?60000:0,this.intervalMs*2**entry.failures);
        this.send(entry,{kind:'connection',transport:this.transport,status:'snapshot unavailable',
          reason:'The latest public order-book snapshot could not be verified.'});
      }
    }finally{
      this.reading--;entry.reading=false;
      if(!entry.listeners.size)this.entries.delete(entry.ticker);
      this.scheduleNext();
    }
  }

  close(){
    this.closed=true;
    for(const entry of this.entries.values())entry.listeners.clear();
    this.entries.clear();
    this.scheduleNext();
  }
}
