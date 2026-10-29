import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/dashboard/paper.js';
const {checkedBook,estimate,emptyLedger,readLedger,applyOpen,applyClose,markPosition,csv,createPanel}=globalThis.KalshiPaper;
const now=Date.parse('2026-10-28T12:00:00Z');
const depth={ticker:'KXTEST-YES',as_of:'2026-10-28T11:59:30Z',source_url:'https://example.test/public-book',raw:{orderbook_fp:{yes_dollars:[['.35','10'],['.34','20']],no_dollars:[['.60','10'],['.59','20'],['.50','100']]}}};
const settings={now,live:true};
test('execution requires exact ticker, live source and at most90s age',()=>{
 assert.equal(checkedBook(depth,depth.ticker,settings).age,30);
 for(const [book,ticker,options]of [[depth,'OTHER',settings],[depth,depth.ticker,{...settings,live:false}],[depth,depth.ticker,{now:now+60000}],[depth,depth.ticker,{now:now+61000}],[{...depth,as_of:'2026-10-28T12:01:00Z'},depth.ticker,settings],[{...depth,as_of:null},depth.ticker,settings]])assert.throws(()=>checkedBook(book,ticker,options));
});
test('YES buys consume actual complemented NO asks and honor2cent cap',()=>{
 const e=estimate(depth,depth.ticker,'yes','buy',50,settings);assert.equal(e.filled,30);assert.equal(e.unfilled,20);assert.equal(e.notional,12.2);assert.equal(e.fee,.51);assert.equal(e.cash,12.71);assert.equal(e.fills.length,2);
});
test('NO entry and exit use their own sides of the book',()=>{
 const entry=estimate(depth,depth.ticker,'no','buy',10,settings);assert.equal(entry.best,.65);assert.equal(entry.notional,6.5);
 const exit=estimate(depth,depth.ticker,'no','sell',10,settings);assert.equal(exit.best,.6);assert.equal(exit.notional,6);assert.equal(exit.fee,.17);assert.equal(exit.cash,5.83);
});
test('budget size includes modeled fees, never exceeds budget and retains partial depth',()=>{
 const e=estimate(depth,depth.ticker,'yes','buy',1000000,{...settings,budget:5});assert.ok(e.filled>0);assert.ok(e.cash<=5+1e-8);assert.ok(e.filled<30);assert.ok(e.unfilled>0);
 const zero=estimate(depth,depth.ticker,'yes','buy',1,{...settings,budget:0});assert.equal(zero.filled,0);
 assert.throws(()=>estimate(depth,depth.ticker,'yes','buy',1,{...settings,budget:NaN}));
});
test('fractional visible depth is preserved in a paper entry',()=>{
 const b={...depth,raw:{orderbook_fp:{yes_dollars:[['.35','1']],no_dollars:[['.60','.12']]}}};const e=estimate(b,b.ticker,'yes','buy',1,settings);assert.equal(e.filled,.12);assert.equal(e.notional,.048);assert.equal(e.fee,.01);
});
test('invalid, crossed, one-sided and empty depth cannot invent fills',()=>{
 assert.throws(()=>estimate({...depth,raw:{orderbook_fp:{yes_dollars:[['.9','1']],no_dollars:[['.5','1']]}}},depth.ticker,'yes','buy',1,settings));
 assert.throws(()=>estimate({...depth,raw:{orderbook_fp:{yes_dollars:[],no_dollars:[['bad','1']]}}},depth.ticker,'yes','buy',1,settings));
 const empty=estimate({...depth,raw:{orderbook_fp:{yes_dollars:null,no_dollars:[]}}},depth.ticker,'yes','buy',1,settings);assert.equal(empty.filled,0);assert.equal(empty.vwap,null);
 const noAsk=estimate({...depth,raw:{orderbook_fp:{yes_dollars:[['.3','10']],no_dollars:[]}}},depth.ticker,'yes','buy',1,settings);assert.equal(noAsk.filled,0);
});
test('paper entry journals source evidence and starts a fee-inclusive basis',()=>{
 const e=estimate(depth,depth.ticker,'yes','buy',10,settings);const l=applyOpen(emptyLedger(),e,{id:'first',time:'2026-10-28T12:00:00Z',title:'Test'});assert.equal(l.positions[0].remaining_quantity,10);assert.equal(l.positions[0].remaining_basis,4.17);assert.equal(l.trades[0].quote_as_of,depth.as_of);assert.equal(l.trades[0].classification.startsWith('SIMULATED'),true);assert.equal(emptyLedger().positions.length,0);
 assert.throws(()=>applyOpen(l,e,{id:'first'}));assert.throws(()=>applyOpen(l,{...e,filled:0},{id:'zero'}));
});
test('partial close allocates entry basis proportionally and retains residualposition',()=>{
 const entry=estimate(depth,depth.ticker,'yes','buy',20,settings);const original=applyOpen(emptyLedger(),entry,{id:'p'});const exit=estimate(depth,depth.ticker,'yes','sell',5,settings);const next=applyClose(original,'p',exit,{id:'close-1'}),p=next.positions[0];
 assert.equal(p.remaining_quantity,15);assert.ok(Math.abs(p.remaining_basis-original.positions[0].remaining_basis*.75)<1e-8);assert.ok(Math.abs(p.realized_pnl-(exit.cash-original.positions[0].remaining_basis*.25))<1e-8);assert.equal(original.positions[0].remaining_quantity,20);
});
test('full close zeroesremainingbasis and accumulatesrealized P/L withoutdoubleclosing',()=>{
 const entry=estimate(depth,depth.ticker,'yes','buy',10,settings),l=applyOpen(emptyLedger(),entry,{id:'p'}),exit=estimate(depth,depth.ticker,'yes','sell',10,settings),closed=applyClose(l,'p',exit,{id:'c'});assert.equal(closed.positions[0].remaining_quantity,0);assert.equal(closed.positions[0].remaining_basis,0);assert.equal(closed.positions[0].realized_pnl,round(exit.cash-entry.cash));assert.throws(()=>applyClose(closed,'p',exit,{id:'c2'}));
});
function round(n){return Math.round(n*1e10)/1e10;}
test('closing rejects mismatchedticker, mismatchedside, overfills and duplicatejournalIDs',()=>{
 const entry=estimate(depth,depth.ticker,'yes','buy',10,settings),l=applyOpen(emptyLedger(),entry,{id:'p'}),exit=estimate(depth,depth.ticker,'yes','sell',5,settings);
 for(const e of [{...exit,ticker:'OTHER'},{...exit,side:'no'},{...exit,filled:11}])assert.throws(()=>applyClose(l,'p',e,{id:'c'}));
 const next=applyClose(l,'p',exit,{id:'c'});assert.throws(()=>applyClose(next,'p',exit,{id:'c'}));
});
test('mark-to-bid includes modeled exit costs and withholds unfillableresidual',()=>{
 const entry=estimate(depth,depth.ticker,'yes','buy',40,{...settings,slippage:100}),l=applyOpen(emptyLedger(),entry,{id:'p'}),mark=markPosition(l.positions[0],depth,settings);assert.equal(mark.filled,30);assert.equal(mark.unfilled,10);assert.equal(mark.complete,false);assert.equal(mark.net_exit_value,round(mark.notional-mark.fee));assert.ok(Math.abs(mark.unrealized_pnl-(mark.cash-l.positions[0].remaining_basis*.75))<1e-8);
});
test('journal recovery validates schema and avoids invalidpositions',()=>{
 assert.deepEqual(readLedger('{broken'),emptyLedger());assert.deepEqual(readLedger({version:1,positions:[{id:'bad'}],trades:[]}),emptyLedger());const e=estimate(depth,depth.ticker,'yes','buy',1,settings),l=applyOpen(emptyLedger(),e,{id:'p'});assert.deepEqual(readLedger(JSON.stringify(l)),l);
});
test('CSV exports quote cells and neutralize formula injection including leadingwhitespace',()=>{
 const data=csv([{title:'  =HYPERLINK("bad")',negative:-4,ordinary:'Safe, text'}]);assert.ok(data.includes("'  =HYPERLINK"));assert.ok(data.includes('""bad""'));assert.ok(data.includes('"\'-4"'));assert.ok(data.includes('"Safe, text"'));
});
test('empty selection panel renders withoutrequestingaccountdata',()=>{
 const effects=[];const React={createElement:(type,props,...children)=>({type,props,children}),useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useRef:value=>({current:value}),useEffect:fn=>effects.push(fn)};
 const Panel=createPanel(React,{Button:'button',DataComponent:'section'});assert.doesNotThrow(()=>Panel({selected:null,book:null,live:false,contracts:100}));assert.ok(effects.length>0);
});
