import WebSocket from 'ws';
import {createPrivateKey,sign,constants,randomUUID} from 'node:crypto';
import {streamCredentials,cloudEnabled,store} from './store.mjs';
import {PriceIndex} from '../price-index.mjs';

export const WS_URL='wss://external-api-ws.kalshi.com/trade-api/ws/v2';
export function websocketHeaders(credentials,now=Date.now()) {
  const key=createPrivateKey(credentials.pem.replaceAll('\\n','\n'));
  const timestamp=String(now),message=Buffer.from(timestamp+'GET/trade-api/ws/v2');
  const signature=key.asymmetricKeyType==='ed25519'?sign(null,message,key):sign('sha256',message,
    {key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST});
  return {'KALSHI-ACCESS-KEY':credentials.id,'KALSHI-ACCESS-TIMESTAMP':timestamp,'KALSHI-ACCESS-SIGNATURE':signature.toString('base64')};
}
export class BookReplica {
  constructor(){this.books=new Map();this.sequences=new Map();}
  reset(){this.books.clear();this.sequences.clear();}
  apply(event,now=Date.now(),materialize=true) {
    if(Number.isInteger(event.sid)&&Number.isInteger(event.seq)){
      const prior=this.sequences.get(event.sid);
      if(prior!==undefined && event.seq!==prior+1)throw new Error('Sequence gap; a new snapshot is required');
      this.sequences.set(event.sid,event.seq);
    }
    if(!['orderbook_snapshot','orderbook_delta'].includes(event.type))return null;
    const data=event.msg||{},ticker=data.market_ticker;
    if(typeof ticker!=='string'||!Number.isInteger(event.sid)||!Number.isInteger(event.seq))throw new Error('Missing stream identity');
    if(event.type==='orderbook_snapshot') {
      const parse=rows=>{
        if(!Array.isArray(rows)||rows.length>5000)throw new Error('Invalid book snapshot');
        const values=new PriceIndex();
        for(const [p,q] of rows){const price=Number(p),quantity=Number(q);
          if(!Number.isFinite(price)||price<0||price>1||!Number.isFinite(quantity)||quantity<0)throw new Error('Invalid snapshot value');
          if(quantity)values.set(price,(values.get(price)||0)+quantity);}
        return values;
      };
      this.books.set(ticker,{yes:parse(data.yes_dollars_fp || data.yes_dollars || []),no:parse(data.no_dollars_fp || data.no_dollars || [])});
    } else {
      const book=this.books.get(ticker);if(!book)throw new Error('Delta arrived before its snapshot');
      if(!['yes','no'].includes(data.side))throw new Error('Invalid book side');
      const price=Number(data.price_dollars),delta=Number(data.delta_fp);
      if(!Number.isFinite(price)||price<0||price>1||!Number.isFinite(delta))throw new Error('Invalid book delta');
      const level=(book[data.side].get(price)||0)+delta;
      if(level < -1e-8)throw new Error('Book quantity underflow');
      if(level>1e-8)book[data.side].set(price,level);else book[data.side].delete(price);
    }
    const book=this.books.get(ticker);
    if(book.yes.size && book.no.size && book.yes.best()+book.no.best()>1+1e-9)throw new Error('Crossed stream book');
    book.metadata={ticker,as_of:new Date(now).toISOString(),received_at:new Date(now).toISOString(),transport:'exchange-websocket',
      exchange_sending_ts_ms:Number.isFinite(event.sending_ts_ms)?event.sending_ts_ms:null,exchange_clock:data.clock??null,
      sequence:event.seq,subscription_id:event.sid,source_url:WS_URL};
    return materialize?this.snapshot(ticker):book.metadata;
  }
  snapshot(ticker) {
    const book=this.books.get(ticker);if(!book)return null;
    const levels=side=>book[side].top(100).map(([p,q])=>[String(p),String(q)]);
    return {...book.metadata,depth_limit:100,depth_truncated:book.yes.size>100||book.no.size>100,
      raw:{orderbook_fp:{yes_dollars:levels('yes'),no_dollars:levels('no')}}};
  }
}
export class MarketFeed {
  constructor({credentials=streamCredentials,socket=(url,options)=>new WebSocket(url,options),now=Date.now,maximumTickers=Number(process.env.MARKET_STREAM_TICKERS||64)}={}) {
    if(!Number.isInteger(maximumTickers)||maximumTickers<1||maximumTickers>256)throw new RangeError('Streaming watchlist capacity must be 1–256');
    this.maximumTickers=maximumTickers;
    this.credentials=credentials;this.socketFactory=socket;this.now=now;this.clients=new Map();this.replica=new BookReplica();this.nextId=1;this.status='disconnected';
    this.samples=[];this.lastSample=new Map();this.archiveChunks=0;this.dirty=new Set();this.pendingRemovals=new Set();this.subscriptionId=null;
  }
  async add(ticker,listener) {
    if(!/^[A-Za-z0-9_.-]{1,140}$/.test(ticker)||ticker.includes('..'))throw new RangeError('Invalid market ticker');
    if(!this.clients.has(ticker)&&this.clients.size>=this.maximumTickers)throw new RangeError('The streaming watchlist is full');
    const added=!this.clients.has(ticker);
    if(added)this.clients.set(ticker,new Set());
    this.clients.get(ticker).add(listener);
    try{
      if(this.socket?.readyState===WebSocket.OPEN){if(added)this.subscribe([ticker]);}
      else await this.connect();
      const snapshot=this.replica.snapshot(ticker);if(snapshot)listener({kind:'quote',...snapshot});
    }catch(error){
      const listeners=this.clients.get(ticker);listeners?.delete(listener);if(!listeners?.size)this.clients.delete(ticker);
      throw error;
    }
    let removed=false;return ()=>{
      if(removed)return;removed=true;
      const listeners=this.clients.get(ticker);listeners?.delete(listener);if(!listeners?.size)this.clients.delete(ticker);
      if(!listeners?.size){
        this.replica.books.delete(ticker);this.dirty.delete(ticker);this.lastSample.delete(ticker);
        if(this.clients.size){this.pendingRemovals.add(ticker);this.removeUnusedMarkets();}
        else {clearTimeout(this.reconnect);this.socket?.close();this.replica.reset();this.pendingRemovals.clear();this.flush().catch(()=>{});}
      }
    };
  }
  send(ticker,payload){for(const fn of this.clients.get(ticker)||[])try{fn(payload);}catch{}}
  broadcast(payload){for(const ticker of this.clients.keys())this.send(ticker,payload);}
  subscribe(tickers) {
    for(const ticker of tickers)this.pendingRemovals.delete(ticker);
    this.socket.send(JSON.stringify({id:this.nextId++,cmd:'subscribe',params:{channels:['orderbook_delta'],market_tickers:tickers}}));
  }
  removeUnusedMarkets(){
    if(!Number.isInteger(this.subscriptionId)||this.socket?.readyState!==WebSocket.OPEN)return;
    const tickers=[...this.pendingRemovals].filter(ticker=>!this.clients.has(ticker));this.pendingRemovals.clear();
    if(tickers.length)this.socket.send(JSON.stringify({id:this.nextId++,cmd:'update_subscription',params:{sids:[this.subscriptionId],market_tickers:tickers,action:'delete_markets'}}));
  }
  metrics(){return {status:this.status,tickers:this.clients.size,subscribers:[...this.clients.values()].reduce((n,rows)=>n+rows.size,0),pending_snapshots:this.samples.length};}
  sample(quote) {
    if(!cloudEnabled()||this.now()-(this.lastSample.get(quote.ticker)||0)<1000)return;
    if(this.samples.length>=500)throw new Error('Archive backpressure; reconnect after pending snapshots are persisted');
    this.lastSample.set(quote.ticker,this.now());
    const top=rows=>rows.slice(0,100);
    this.samples.push({...quote,raw:{orderbook_fp:{yes_dollars:top(quote.raw.orderbook_fp.yes_dollars),no_dollars:top(quote.raw.orderbook_fp.no_dollars)}},depth_limit:100});
    if(this.samples.length>=30)this.flush().catch(()=>this.broadcast({kind:'connection',status:'archive retrying',reason:'Sample persistence is delayed; sequence gaps are not filled with synthetic observations'}));
  }
  async flush() {
    if(this.flushing||!this.samples.length)return;
    const rows=this.samples.splice(0);this.flushing=true;
    try{
      const created=new Date(this.now()).toISOString();
      await store().archive('streams/'+created.slice(0,10)+'/'+randomUUID()+'.json',
        {created_at:created,source:WS_URL,sampling:'At most one observed snapshot of the top 100 price levels per side, second and ticker; not a complete tick archive',rows});
      this.archiveChunks++;
    }catch(error){this.samples.unshift(...rows);throw error;}
    finally{this.flushing=false;}
  }
  async connect() {
    if(this.connectionAttempt)return this.connectionAttempt;
    const pending=this.openConnection();this.connectionAttempt=pending;
    try{return await pending;}finally{if(this.connectionAttempt===pending)this.connectionAttempt=null;}
  }
  async openConnection() {
    if(this.connecting || this.socket?.readyState===WebSocket.OPEN || this.socket?.readyState===WebSocket.CONNECTING)return;
    this.connecting=true;
    try {
      const credentials=await this.credentials();
      if(!credentials)throw new Error('An exchange streaming key is not configured');
      const socket=this.socketFactory(WS_URL,{headers:websocketHeaders(credentials,this.now()),handshakeTimeout:12000,maxPayload:2e6});
      this.socket=socket;this.status='connecting';
      socket.on('open',()=>{if(socket!==this.socket)return;this.status='connected';this.replica.reset();this.subscriptionId=null;this.pendingRemovals.clear();this.subscribe([...this.clients.keys()]);
        clearInterval(this.emitTimer);this.emitTimer=setInterval(()=>this.emitDirty(),100);this.emitTimer.unref?.();
        this.broadcast({kind:'connection',status:this.status,transport:'exchange-websocket'});});
      socket.on('message',raw=>{
        if(socket!==this.socket)return;
        try {
          const event=JSON.parse(raw.toString());
          if(event.type==='error')throw new Error('Exchange subscription was rejected');
          if(event.type==='subscribed'&&event.msg?.channel==='orderbook_delta')this.subscriptionId=event.msg.sid;
          if(Number.isInteger(event.sid)&&['orderbook_snapshot','orderbook_delta'].includes(event.type))this.subscriptionId=event.sid;
          const tracked=!event.msg?.market_ticker||this.clients.has(event.msg.market_ticker);
          const update=this.replica.apply(tracked?event:{...event,type:'ignored'},this.now(),false);if(update)this.dirty.add(update.ticker);
          this.removeUnusedMarkets();
        } catch(error) {this.status='resynchronizing';this.broadcast({kind:'connection',status:this.status,reason:error.message});socket.close();}
      });
      socket.on('error',()=>{if(socket!==this.socket)return;this.status='unavailable';this.broadcast({kind:'connection',status:this.status,reason:'Exchange stream unavailable; reconnecting with backoff'});});
      socket.on('close',()=>{
        if(socket!==this.socket)return;
        clearInterval(this.emitTimer);this.dirty.clear();this.status='disconnected';this.replica.reset();this.subscriptionId=null;this.pendingRemovals.clear();
        if(this.clients.size)this.reconnect=setTimeout(()=>this.connect().catch(()=>{}),15000);
      });
    } finally {this.connecting=false;}
  }
  emitDirty() {
    for(const ticker of this.dirty) {
      const quote=this.replica.snapshot(ticker);if(!quote)continue;
      try {this.sample(quote);this.send(ticker,{kind:'quote',...quote});}
      catch(error) {this.broadcast({kind:'connection',status:'archive retrying',reason:error.message});this.socket?.close();}
    }
    this.dirty.clear();
  }
}
export const marketFeed=new MarketFeed();
