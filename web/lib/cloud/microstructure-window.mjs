import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

export class MicrostructureWindow {
  constructor({capacity=1024,clock=()=>performance.timeOrigin/1000+performance.now()/1000}={}){
    if(!Number.isSafeInteger(capacity)||capacity<2||capacity>4096)throw new RangeError('Invalid quote history capacity');
    this.capacity=capacity;this.clock=clock;this.windows=new Map();
  }
  reset(ticker){if(ticker)this.windows.delete(ticker);else this.windows.clear();}
  append(ticker,book,event){
    if(event.type==='orderbook_snapshot')this.reset(ticker);
    let window=this.windows.get(ticker);
    if(!window){window={rows:new Array(this.capacity),head:0,count:0,sequence:0,generation:randomUUID()};this.windows.set(ticker,window);}
    const bid=book.yes.best(),no=book.no.best(),ask=no===null?null:Math.round((1-no)*10000)/10000;
    if(bid===null||ask===null){this.reset(ticker);return;}
    const row={time_seconds:this.clock(),received_at:book.metadata.received_at,sequence:++window.sequence,generation:window.generation,
      bid_price:bid,bid_size:book.yes.get(bid),ask_price:ask,ask_size:book.no.get(no),exchange_sequence:event.seq,exchange_subscription_id:event.sid,
      clock_kind:'local_monotonic_receive_clock',observation_kind:'validated_orderbook_update'};
    window.rows[window.head]=row;window.head=(window.head+1)%this.capacity;window.count=Math.min(this.capacity,window.count+1);
  }
  read(ticker,limit=512){
    if(!Number.isSafeInteger(limit)||limit<1||limit>this.capacity)throw new RangeError('Invalid quote history limit');
    const window=this.windows.get(ticker);if(!window)return [];
    const count=Math.min(limit,window.count),start=(window.head-count+this.capacity)%this.capacity;
    return Array.from({length:count},(_,i)=>({...window.rows[(start+i)%this.capacity]}));
  }
}
