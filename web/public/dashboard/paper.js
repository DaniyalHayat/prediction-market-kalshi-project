/* Browser-local paper execution. No account, order, payment or authenticated endpoint. */
(function(root){
 'use strict';
 const number=v=>v===null||v===undefined||v===''||typeof v==='boolean'||!Number.isFinite(Number(v))?null:Number(v);
 const round=n=>Math.round(n*1e10)/1e10;
 const STORAGE='kalshi-market-lab:paper-journal:v1';
 const validTicker=t=>typeof t==='string'&&/^[A-Za-z0-9_.:-]{1,180}$/.test(t);
 function checkedBook(book,ticker,{now=Date.now(),live=true,maxAge=90}={}){
  if(!live)throw new Error('A live book is required. Saved or failed feeds cannot open a paper trade.');
  if(!validTicker(ticker)||book?.ticker!==ticker)throw new Error('The depth response must match this exact contract.');
  const time=Date.parse(book?.as_of),age=(now-time)/1000;
  if(!Number.isFinite(time)||age>=maxAge||age < -5)throw new Error('Refresh depth: the quote is missing, future-dated or at least 90 seconds old.');
  const fp=book?.raw?.orderbook_fp;
  if(!fp||!('yes_dollars' in fp)||!('no_dollars' in fp))throw new Error('A complete fixed-point book response is required.');
  const parse=key=>{
   if(fp[key]!==null&&!Array.isArray(fp[key]))throw new Error('Invalid depth array.');
   const merged=new Map();
   for(const level of fp[key]||[]){
    if(!Array.isArray(level)||level.length!==2)throw new Error('Invalid depth level.');
    const price=number(level[0]),quantity=number(level[1]);
    if(price===null||quantity===null||price<0||price>1||quantity<0)throw new Error('Invalid price or depth.');
    if(quantity)merged.set(price,(merged.get(price)||0)+quantity);
   }
   return [...merged].map(([price,quantity])=>({price,quantity})).sort((a,b)=>b.price-a.price);
  };
  const yes=parse('yes_dollars'),no=parse('no_dollars');
  if(yes.length&&no.length&&yes[0].price+no[0].price>1+1e-10)throw new Error('Crossed public book: paper execution is withheld.');
  return {yes,no,age,asOf:book.as_of,source:book.source_url||null};
 }
 function estimate(book,ticker,side,action,quantity,options={}){
  if(!['yes','no'].includes(side)||!['buy','sell'].includes(action))throw new Error('Choose YES/NO and buy/sell.');
  if(!Number.isFinite(quantity)||quantity<=0||quantity>1e6)throw new Error('Enter more than zero and no more than 1,000,000 contracts.');
  const {slippage=2,coefficient=.07,multiplier=1,budget=null,now=Date.now(),live=true}=options;
  if(![slippage,coefficient,multiplier].every(Number.isFinite)||slippage<0||slippage>100||coefficient<0||coefficient>1||multiplier<0||multiplier>100||(budget!==null&&(!Number.isFinite(budget)||budget<0)))throw new Error('Check slippage, budget and fee assumptions.');
  const checked=checkedBook(book,ticker,{now,live});
  const own=side==='yes'?checked.yes:checked.no,opposite=side==='yes'?checked.no:checked.yes;
  const levels=action==='buy'?opposite.map(l=>({price:round(1-l.price),quantity:l.quantity})).sort((a,b)=>a.price-b.price):own;
  const best=levels[0]?.price??null,limit=best===null?null:Math.max(0,Math.min(1,round(best+(action==='buy'?1:-1)*slippage/100)));
  const fee=(price,qty)=>Math.max(0,Math.ceil((coefficient*multiplier*qty*price*(1-price)-1e-10)*100)/100);
  let remaining=quantity,cost=0,fees=0;
  const fills=[];
  for(const level of levels){
   if(action==='buy'?level.price>limit+1e-10:level.price<limit-1e-10)break;
   let take=Math.min(remaining,level.quantity);
   if(action==='buy'&&budget!==null&&cost+fees+take*level.price+fee(level.price,take)>budget+1e-9){
    let low=0,high=take;
    for(let i=0;i<55;i++){const mid=(low+high)/2;if(cost+fees+mid*level.price+fee(level.price,mid)<=budget+1e-9)low=mid;else high=mid;}
    take=Math.floor((low+1e-10)*100)/100;
   }
   if(take<=0)break;
   const charge=fee(level.price,take),notional=take*level.price;
   fills.push({price:level.price,quantity:round(take),notional:round(notional),fee:charge});cost+=notional;fees+=charge;remaining-=take;
   if(remaining<1e-8)break;
  }
  const filled=round(quantity-remaining),notional=round(cost),totalFee=round(fees);
  return {ticker,side,action,requested:quantity,filled,unfilled:round(remaining),best,limit,vwap:filled?round(notional/filled):null,notional,fee:totalFee,cash:round(action==='buy'?notional+totalFee:notional-totalFee),fills,quote_as_of:checked.asOf,quote_source:checked.source,classification:'SIMULATED · static public depth, conservative fee assumptions',assumptions:{slippage,coefficient,multiplier,budget}};
 }
 function emptyLedger(){return {version:1,positions:[],trades:[]};}
 function readLedger(value){
  if(!value)return emptyLedger();
  let data;try{data=typeof value==='string'?JSON.parse(value):value;}catch{return emptyLedger();}
  if(data?.version!==1||!Array.isArray(data.positions)||!Array.isArray(data.trades))return emptyLedger();
  const positions=data.positions.filter(p=>typeof p.id==='string'&&validTicker(p.ticker)&&['yes','no'].includes(p.side)&&['original_quantity','remaining_quantity','entry_cost','entry_fee','remaining_basis','realized_pnl'].every(k=>Number.isFinite(p[k]))&&p.original_quantity>0&&p.remaining_quantity>=0&&p.remaining_quantity<=p.original_quantity+1e-8&&p.remaining_basis>=-1e-8).slice(-1000);
  const ids=new Set(positions.map(p=>p.id));
  const trades=data.trades.filter(t=>typeof t.id==='string'&&ids.has(t.position_id)&&validTicker(t.ticker)&&['buy','sell'].includes(t.action)&&Number.isFinite(t.filled)&&t.filled>0&&Number.isFinite(t.cash)&&Number.isFinite(t.fee)).slice(-5000);
  return {version:1,positions,trades};
 }
 function applyOpen(ledger,execution,{id,time=new Date().toISOString(),title='',vertical=''}={}){
  if(!id||ledger.positions.some(p=>p.id===id))throw new Error('A unique paper-trade identifier is required.');
  if(execution?.action!=='buy'||!validTicker(execution.ticker)||!['yes','no'].includes(execution.side)||!Number.isFinite(execution.filled)||execution.filled<=0||!['cash','notional','fee'].every(k=>Number.isFinite(execution[k])&&execution[k]>=0))throw new Error('No valid ask depth was filled. No paper position was opened.');
  if(ledger.positions.filter(p=>p.remaining_quantity>1e-8).length>=20)throw new Error('Close an open paper position before adding another; maximum 20 open positions.');
  const position={id,ticker:execution.ticker,title,vertical,side:execution.side,opened_at:time,original_quantity:execution.filled,remaining_quantity:execution.filled,entry_cost:execution.notional,entry_fee:execution.fee,remaining_basis:execution.cash,realized_pnl:0,quote_as_of:execution.quote_as_of,quote_source:execution.quote_source,entry_assumptions:execution.assumptions};
  const trade={...execution,id:`${id}:buy`,position_id:id,occurred_at:time};
  return {version:1,positions:[...ledger.positions,position].slice(-1000),trades:[...ledger.trades,trade].slice(-5000)};
 }
 function applyClose(ledger,positionId,execution,{id,time=new Date().toISOString()}={}){
  const p=ledger.positions.find(row=>row.id===positionId);
  if(!p||!id||ledger.trades.some(t=>t.id===id))throw new Error('A unique close record and existing position are required.');
  if(execution?.action!=='sell'||execution.ticker!==p.ticker||execution.side!==p.side||!Number.isFinite(execution.filled)||execution.filled<=0||execution.filled>p.remaining_quantity+1e-8||!['cash','notional','fee'].every(k=>Number.isFinite(execution[k])))throw new Error('Close must fill matching position depth without exceeding remaining contracts.');
  const basis=execution.filled>=p.remaining_quantity-1e-8?p.remaining_basis:p.remaining_basis*execution.filled/p.remaining_quantity;
  const realized=round(execution.cash-basis),remaining=round(Math.max(0,p.remaining_quantity-execution.filled));
  const updated={...p,remaining_quantity:remaining,remaining_basis:remaining?round(p.remaining_basis-basis):0,realized_pnl:round(p.realized_pnl+realized),...(remaining?{}:{closed_at:time})};
  const trade={...execution,id,position_id:positionId,occurred_at:time,released_basis:round(basis),realized_pnl:realized};
  return {version:1,positions:ledger.positions.map(row=>row.id===positionId?updated:row),trades:[...ledger.trades,trade].slice(-5000)};
 }
 function markPosition(position,book,options={}){
  if(!position.remaining_quantity)return {filled:0,unfilled:0,net_exit_value:0,unrealized_pnl:0,complete:true};
  const exit=estimate(book,position.ticker,position.side,'sell',position.remaining_quantity,options);
  const basis=position.remaining_basis*exit.filled/position.remaining_quantity;
  return {...exit,net_exit_value:exit.cash,marked_basis:round(basis),unrealized_pnl:exit.filled?round(exit.cash-basis):null,complete:exit.unfilled<1e-8};
 }
 function csv(rows){
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  const cell=v=>{let s=v&&typeof v==='object'?JSON.stringify(v):String(v??'');if(/^[\s\uFEFF]*[=+@-]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return [keys.map(cell).join(','),...rows.map(row=>keys.map(k=>cell(row[k])).join(','))].join('\r\n');
 }
 function createPanel(React,dataApp){
  const h=React.createElement,usd=n=>Number.isFinite(n)?n.toLocaleString('en-US',{style:'currency',currency:'USD'}):'—',qty=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:2}):'—',cents=n=>Number.isFinite(n)?`${(n*100).toFixed(2)}¢`:'—',when=t=>t?new Date(t).toLocaleString():'Unavailable';
  const identifier=()=>root.crypto?.randomUUID?.()||`paper-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const button=(text,fn,disabled=false)=>h(dataApp.Button||'button',{type:'button',onClick:fn,disabled},text);
  function Field({label,value,setValue,...props}){return h('label',null,label,h('input',{type:'number',value,onChange:e=>setValue(e.target.value),...props}));}
  return function KalshiPaper({selected,book,live=false,connector='',contracts=100,download,onInspect}){
   const [ledger,setLedger]=React.useState(()=>{try{return readLedger(root.localStorage?.getItem(STORAGE));}catch{return emptyLedger();}});
   const ledgerRef=React.useRef(ledger);ledgerRef.current=ledger;
   const [side,setSide]=React.useState('yes'),[size,setSize]=React.useState(String(contracts)),[mode,setMode]=React.useState('quantity'),[budget,setBudget]=React.useState('100'),[slippage,setSlippage]=React.useState('2'),[coefficient,setCoefficient]=React.useState('.07'),[multiplier,setMultiplier]=React.useState('1');
   const [marks,setMarks]=React.useState({}),[message,setMessage]=React.useState(''),[error,setError]=React.useState(''),[storageError,setStorageError]=React.useState(''),[busy,setBusy]=React.useState(''),[clock,setClock]=React.useState(Date.now),[tab,setTab]=React.useState('positions');
   const busyRef=React.useRef(false);
   React.useEffect(()=>{try{root.localStorage?.setItem(STORAGE,JSON.stringify(ledger));setStorageError('');}catch{setStorageError('Browser storage is unavailable. This paper journal currently lasts only for this open session.');}},[ledger]);
   React.useEffect(()=>{const timer=setInterval(()=>{if(typeof document==='undefined'||document.visibilityState==='visible')setClock(Date.now());},5000);return()=>clearInterval(timer);},[]);
   const openPositions=ledger.positions.filter(p=>p.remaining_quantity>1e-8);
   const openTickers=[...new Set(openPositions.map(p=>p.ticker))].sort().join('|');
   React.useEffect(()=>{
    if(!openTickers)return;
    let stopped=false;const controllers=new Set();
    let refreshing=false;
    const refresh=async()=>{
     if(typeof document!=='undefined'&&document.visibilityState!=='visible')return;
     if(refreshing)return;refreshing=true;
     const tickers=openTickers.split('|');
     for(const ticker of tickers){
      if(stopped)return;
      if(book?.ticker===ticker){try{checkedBook(book,ticker,{now:Date.now(),live});setMarks(p=>({...p,[ticker]:{book}}));continue;}catch{}}
      const controller=new AbortController();controllers.add(controller);const timeout=setTimeout(()=>controller.abort(),12000);
      try{const response=await fetch(`${connector}/api/book?ticker=${encodeURIComponent(ticker)}&contracts=100`,{signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error(`Quote refresh returned ${response.status}`);const value=await response.json();checkedBook(value,ticker,{now:Date.now()});if(!stopped)setMarks(p=>({...p,[ticker]:{book:value}}));}
      catch(e){if(!stopped)setMarks(p=>({...p,[ticker]:{...p[ticker],error:e.message}}));}
      finally{clearTimeout(timeout);controllers.delete(controller);}
     }
     refreshing=false;
    };
    refresh();const timer=setInterval(refresh,30000);return()=>{stopped=true;clearInterval(timer);controllers.forEach(c=>c.abort());};
   },[openTickers,connector,book?.ticker,book?.as_of,live]);
   const options={slippage:number(slippage),coefficient:number(coefficient),multiplier:number(multiplier),now:clock,live};
   let preview=null,previewError='';
   if(selected){try{preview=estimate(book,selected.ticker,side,'buy',mode==='budget'?1000000:Number(size),{...options,budget:mode==='budget'?(number(budget)??NaN):null});}catch(e){previewError=e.message;}}
   function commit(next){ledgerRef.current=next;setLedger(next);}
   function open(){
    if(busyRef.current)return;busyRef.current=true;setError('');setMessage('');
    try{if(!selected)throw new Error('Choose a contract first.');const result=estimate(book,selected.ticker,side,'buy',mode==='budget'?1000000:Number(size),{...options,now:Date.now(),budget:mode==='budget'?(number(budget)??NaN):null});commit(applyOpen(ledgerRef.current,result,{id:identifier(),title:selected.title,vertical:selected.vertical||''}));setMessage(`Paper position opened: ${qty(result.filled)} ${side.toUpperCase()} contracts for ${usd(result.cash)} including modeled fees.${result.unfilled>0?' Only available depth within your limit was filled.':''}`);setTab('positions');}catch(e){setError(e.message);}finally{busyRef.current=false;}
   }
   async function close(position){
    if(busyRef.current)return;busyRef.current=true;setBusy(position.id);setError('');setMessage('');
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
    try{let depth;try{checkedBook(book,position.ticker,{now:Date.now(),live});depth=book;}catch{const response=await fetch(`${connector}/api/book?ticker=${encodeURIComponent(position.ticker)}&contracts=${position.remaining_quantity}`,{signal:controller.signal,cache:'no-store'});if(!response.ok)throw new Error(`Close quote returned ${response.status}`);depth=await response.json();checkedBook(depth,position.ticker,{now:Date.now()});}
     const current=ledgerRef.current.positions.find(p=>p.id===position.id);if(!current||current.remaining_quantity<=0)throw new Error('This paper position is already closed.');
     const result=estimate(depth,current.ticker,current.side,'sell',current.remaining_quantity,{...options,live:true,now:Date.now()});commit(applyClose(ledgerRef.current,current.id,result,{id:identifier()}));setMarks(p=>({...p,[current.ticker]:{book:depth}}));setMessage(`Paper close: ${qty(result.filled)} contracts, ${usd(result.cash)} modeled net proceeds.${result.unfilled>0?' Remaining contracts stay open because bid depth was insufficient inside the limit.':''}`);
    }catch(e){setError(e.name==='AbortError'?'Close quote timed out; no paper trade recorded.':e.message);}finally{clearTimeout(timeout);busyRef.current=false;setBusy('');}
   }
   const marked=ledger.positions.map(position=>{let mark=null,markError='';if(position.remaining_quantity){const candidates=[book?.ticker===position.ticker?book:null,marks[position.ticker]?.book].filter(Boolean).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of));const current=candidates[0];try{mark=markPosition(position,current,{...options,live:current===book?live:true});}catch(e){markError=e.message;}}return {...position,mark,markError};});
   const rows=marked.map(p=>({...p,mark:p.mark,mark_error:p.markError}));
   const realized=ledger.positions.reduce((sum,p)=>sum+p.realized_pnl,0),openBasis=openPositions.reduce((sum,p)=>sum+p.remaining_basis,0),fullyMarked=marked.filter(p=>p.remaining_quantity>0).every(p=>p.mark?.complete),unrealized=fullyMarked&&openPositions.length?marked.reduce((sum,p)=>sum+(p.mark?.unrealized_pnl||0),0):null;
   function exportFile(kind){
    const payload={...ledger,exported_at:new Date().toISOString(),classification:'SIMULATED PAPER TRADES ONLY · browser-local journal; not brokerage records'};
    const text=kind==='json'?JSON.stringify(payload,null,2):csv(ledger.trades),type=kind==='json'?'application/json':'text/csv;charset=utf-8';
    const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=`kalshi-paper-journal.${kind}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
   }
   const currentAge=book&&selected&&book.ticker===selected.ticker?Math.max(0,Math.floor((clock-Date.parse(book.as_of))/1000)):null;
   const body=h('div',{className:'kp-panel'},
    h('div',{className:'kp-banner'},h('strong',null,'Paper trading · simulated only'),h('span',null,'Real public depth, virtual positions, no real orders or account access.')),
    h('div',{className:'kp-entry'},h('section',null,
     h('h3',null,selected?.title||'Select a contract'),h('p',{className:'km-note'},selected?`${selected.ticker} · ${currentAge===null?'matching book unavailable':`${currentAge}s old`}`:'A fresh matching book is required to record a paper trade.'),
     h('div',{className:'kp-side',role:'group','aria-label':'Paper trade side'},...['yes','no'].map(value=>h(dataApp.Button||'button',{key:value,type:'button','aria-pressed':side===value,onClick:()=>setSide(value)},`Buy ${value.toUpperCase()}`))),
     h('div',{className:'kp-fields'},h('label',null,'Size by',h('select',{value:mode,onChange:e=>setMode(e.target.value)},h('option',{value:'quantity'},'Contracts'),h('option',{value:'budget'},'Maximum all-in budget'))),mode==='quantity'?h(Field,{label:'Requested contracts',value:size,setValue:setSize,min:.01,max:1000000,step:.01}):h(Field,{label:'Maximum budget ($)',value:budget,setValue:setBudget,min:0,step:1}),h(Field,{label:'Allowed price slippage (¢)',value:slippage,setValue:setSlippage,min:0,max:100,step:.5})),
     h('details',{className:'kp-fees'},h('summary',null,'Paper fee assumptions'),h('div',{className:'kp-fields'},h(Field,{label:'Assumed fee coefficient',value:coefficient,setValue:setCoefficient,min:0,max:1,step:.0025}),h(Field,{label:'Assumed multiplier',value:multiplier,setValue:setMultiplier,min:0,max:100,step:.1})),h('p',{className:'km-note'},'Fees are conservatively rounded up to a cent for each price level. Actual market fee schedules, per-execution rounding and rebates differ. The same editable model applies to entries, exits and marks.')),
     previewError&&h('p',{className:'kp-error',role:'status'},previewError),
     button('Record paper buy',open,!preview?.filled||!!busy),h('p',{className:'km-note'},'Only currently available asks within your slippage cap are filled. Residual quantity is not assumed to rest or fill later.')),
     h('section',{className:'kp-preview','data-reviewed-rows':true},h('h3',null,`Estimated ${side.toUpperCase()} paper entry`),h('dl',null,...[['Best available ask',cents(preview?.best)],['Fillable contracts',qty(preview?.filled)],['Average entry price',cents(preview?.vwap)],['Contract cost',usd(preview?.notional)],['Modeled entry fee',usd(preview?.fee)],['All-in paper cost',usd(preview?.cash)],['Unfilled quantity',mode==='budget'?'Only budget-affordable available depth':qty(preview?.unfilled)]].map(([label,value])=>h('div',{key:label},h('dt',null,label),h('dd',null,value)))),h('p',{className:'km-note'},'This is a deterministic simulation of this snapshot. Depth can change immediately; a paper fill is not proof that a real order would execute.'))),
    h('div',{className:'kp-totals','data-reviewed-rows':true},...[["Open paper basis",usd(openBasis)],["Realized paper P/L",usd(realized)],["Unrealized paper P/L",usd(unrealized)]].map(([label,value])=>h('div',{key:label},h('span',null,label),h('strong',null,value)))),
    h('p',{className:'km-note'},'Unrealized P/L uses current selected-side bids, exit slippage and modeled exit fees. The total is withheld if any open position lacks enough fresh bid depth; partial marks never value unfillable residuals at the last price.'),
    storageError&&h('p',{className:'kp-error',role:'status'},storageError),message&&h('p',{className:'kp-success',role:'status'},message),error&&h('p',{className:'kp-error',role:'alert'},error),
    h('div',{className:'kp-tabs',role:'group','aria-label':'Paper journal view'},button(`Positions (${openPositions.length} open)`,()=>setTab('positions')),button(`Journal (${ledger.trades.length})`,()=>setTab('journal')),button('Export JSON',()=>exportFile('json'),!ledger.trades.length),button('Export CSV',()=>exportFile('csv'),!ledger.trades.length)),
    h('div',{className:'kp-table-wrap'},tab==='positions'?h('table',{'data-reviewed-rows':true},h('thead',null,h('tr',null,...['Paper position','Remaining / original','Open basis','Current bid exit','Unrealized P/L','Realized P/L','Action'].map(label=>h('th',{key:label},label)))),h('tbody',null,...marked.map(p=>h('tr',{key:p.id},h('th',{scope:'row'},`${p.side.toUpperCase()} · ${p.title||p.ticker}`,h('small',null,p.ticker)),h('td',null,`${qty(p.remaining_quantity)} / ${qty(p.original_quantity)}`),h('td',null,usd(p.remaining_basis)),h('td',null,p.mark?`${usd(p.mark.net_exit_value)} / ${qty(p.mark.filled)} contracts`:p.remaining_quantity?'Unavailable':'Closed',p.mark&&!p.mark.complete&&h('small',null,`${qty(p.mark.unfilled)} not markable`)),h('td',null,usd(p.mark?.unrealized_pnl)),h('td',null,usd(p.realized_pnl)),h('td',null,p.remaining_quantity?button(busy===p.id?'Refreshing close…':'Paper close at bids',()=>close(p),!!busy):h('span',null,'Closed')))))):h('table',{'data-reviewed-rows':true},h('thead',null,h('tr',null,...['Time','Action','Contract','Filled','Average price','Fee model','Cash flow','Realized P/L'].map(label=>h('th',{key:label},label)))),h('tbody',null,...[...ledger.trades].reverse().map(t=>h('tr',{key:t.id},h('td',null,when(t.occurred_at)),h('td',null,`PAPER ${t.action.toUpperCase()} ${t.side.toUpperCase()}`),h('th',{scope:'row'},t.ticker),h('td',null,qty(t.filled)),h('td',null,cents(t.vwap)),h('td',null,usd(t.fee)),h('td',null,`${t.action==='buy'?'−':'+'}${usd(t.cash)}`),h('td',null,usd(t.realized_pnl))))))),
    !ledger.trades.length&&h('p',{className:'km-empty'},'No paper trades yet. Choose a contract with fresh depth and record a simulated buy.'),
    h('p',{className:'km-note'},'Saved only in this browser. Marks refresh every 30 seconds while visible for up to 20 open positions; closing always rechecks fresh matching bid depth. No automatic settlement, guaranteed fills, real-money P/L or account synchronization.'));
   return h(dataApp.DataComponent,{id:'km-paper',queryId:'scenarios',kind:'table',title:'Paper trading · positions and execution journal',variant:'card',sourceRows:rows,displayRows:rows,description:'Simulated browser-local transactions from fresh matching public books; fee assumptions and source timestamps are saved with each execution. No real orders.'},body);
  };
 }
 root.KalshiPaper={checkedBook,estimate,emptyLedger,readLedger,applyOpen,applyClose,markPosition,csv,createPanel};
})(globalThis);
