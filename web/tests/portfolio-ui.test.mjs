import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/dashboard/paper.js';
import {appearance,DEFAULT_PREFERENCES,THEMES,contrastRatio} from '../ui/preferences.mjs';
import {attachEntryContext,portfolioTickers,PAPER_STORAGE,PAPER_BALANCE,updateStoredLedger} from '../ui/paper-state.mjs';
import {acceptPortfolioBook,portfolioTotals} from '../ui/portfolio-state.mjs';
import {paperCapital} from '../ui/paper-capital.mjs';
import {mergeResearchRefresh,researchRefreshDelay} from '../ui/research-state.mjs';
import {initialSelection,selectionReducer,refreshMarketRows} from '../ui/selection.mjs';
const paper=globalThis.KalshiPaper,now=Date.parse('2026-11-04T17:00:00Z');
const book={ticker:'KXTEST-YES',as_of:'2026-11-04T16:59:50Z',source_url:'https://api.elections.kalshi.com/trade-api/v2/markets/KXTEST-YES/orderbook',raw:{orderbook_fp:{yes_dollars:[['.35','100']],no_dollars:[['.6','100']]}}};
const entry=()=>paper.estimate(book,book.ticker,'yes','buy',10,{now});
const opened=()=>paper.applyOpen(paper.emptyLedger(),entry(),{id:'p',time:'2026-11-04T16:59:55Z'});
const settlement=(result='yes')=>({market:{ticker:book.ticker,status:'finalized',result,market_type:'binary'},as_of:new Date(now).toISOString(),source_url:'https://api.elections.kalshi.com/trade-api/v2/markets/'+book.ticker});
test('all appearance options retain readable body, secondary text and interactive colors',()=>{
  assert.deepEqual(appearance('{broken'),DEFAULT_PREFERENCES);
  assert.deepEqual(appearance({theme:'other',layout:'full-screen',density:'tiny',model:'magic'}),DEFAULT_PREFERENCES);
  assert.deepEqual(appearance({theme:'light',layout:'wide-list',density:'compact',model:'challenger'}),{theme:'light',layout:'wide-list',density:'compact',model:'challenger'});
  for(const theme of Object.values(THEMES)){assert.ok(contrastRatio(theme.ink,theme.panel)>=7);assert.ok(contrastRatio(theme.muted,theme.panel)>=4.5);assert.ok(contrastRatio(theme.accent,theme.panel)>=4.5);}
});
test('stream updates cannot put another contract or an older observation into a position',()=>{
  assert.equal(acceptPortfolioBook(book,{...book,ticker:'OTHER'},[book.ticker],now),book);
  assert.equal(acceptPortfolioBook(book,{...book,as_of:'2026-11-04T16:59:00Z'},[book.ticker],now),book);
  assert.equal(acceptPortfolioBook(book,{...book,as_of:'2026-11-04T17:01:00Z'},[book.ticker],now),book);
  const latest={...book,as_of:new Date(now).toISOString()};assert.equal(acceptPortfolioBook(book,latest,[book.ticker],now),latest);
});
test('portfolio totals withhold residual values when any position has incomplete executable depth',()=>{
  const ledger=opened(),first=ledger.positions[0],second={...first,id:'q',ticker:'OTHER',remaining_basis:3,realized_pnl:1};ledger.positions.push(second);
  const complete={p:{status:'live',marked_value:5,unrealized_pnl:5-first.remaining_basis},q:{status:'live',marked_value:4,unrealized_pnl:1}};
  const totals=portfolioTotals(ledger,complete);assert.equal(totals.marked_value,9);assert.equal(totals.realized,1);assert.equal(totals.fully_marked,true);
  for(const status of ['partial','stale','unavailable']){const result=portfolioTotals(ledger,{...complete,q:{...complete.q,status}});assert.equal(result.marked_value,null);assert.equal(result.unrealized,null);assert.equal(result.realized,1);}
  const pendingSettlement=portfolioTotals(ledger,{...complete,q:{...complete.q,status:'settled'}});assert.equal(pendingSettlement.marked_value,9);
});
test('ledger writes use the latest retained balance before authorizing another entry',()=>{
  const memory=new Map([[PAPER_STORAGE,JSON.stringify(paper.emptyLedger())],[PAPER_BALANCE,'5']]);
  const storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)};
  const stale=paper.emptyLedger(),buy=(id)=>(current,balance)=>{const cost=entry();assert.ok(paperCapital(current,balance).available>=cost.cash,'Insufficient remaining cash');return paper.applyOpen(current,cost,{id});};
  updateStoredLedger(paper,storage,buy('first'),stale);
  assert.throws(()=>updateStoredLedger(paper,storage,buy('second'),stale),/Insufficient/);
  assert.equal(paper.readLedger(storage.getItem(PAPER_STORAGE)).positions.length,1);
});
test('entry model context remains distinct from subjective inputs and survives recovery',()=>{
  const value=attachEntryContext(opened(),'p',{probability:.6,interval:[.5,.7],source:'experimental_model',model:'Trained challenger',as_of:new Date(now).toISOString()});
  const recovered=paper.readLedger(JSON.stringify(value));assert.equal(recovered.positions[0].entry_probability,.6);assert.equal(recovered.positions[0].entry_probability_source,'experimental_model');
  assert.deepEqual(attachEntryContext(value,'p',{probability:.9,interval:[.2,.5]}),value);
  assert.deepEqual(portfolioTickers([{ticker:'B',remaining_quantity:1},{ticker:'A',remaining_quantity:1},{ticker:'B',remaining_quantity:2},{ticker:'C',remaining_quantity:0},{ticker:'bad/token',remaining_quantity:1}]),['A','B']);
});
test('confirmed binary settlement realizes remaining basis once and is never represented as a bid execution',()=>{
  const ledger=opened(),exit=paper.estimate(book,book.ticker,'yes','sell',4,{now}),part=paper.applyClose(ledger,'p',exit,{id:'partial'});
  const result=paper.applySettlement(part,'p',settlement(),{id:'settlement',now,time:new Date(now).toISOString()}),position=result.positions[0],last=result.trades.at(-1);
  assert.equal(position.remaining_quantity,0);assert.equal(position.remaining_basis,0);assert.equal(last.action,'settle');assert.equal(last.cash,6);assert.equal(last.fee,0);
  assert.ok(Math.abs(position.realized_pnl-(exit.cash+6-ledger.positions[0].remaining_basis))<1e-8);assert.match(last.classification,/no bid execution/);
  assert.deepEqual(paper.readLedger(JSON.stringify(result)),result);assert.throws(()=>paper.applySettlement(result,'p',settlement(),{id:'again',now}));
  const loss=paper.applySettlement(ledger,'p',settlement('no'),{id:'loss',now});assert.equal(loss.trades.at(-1).cash,0);assert.equal(loss.positions[0].realized_pnl,-ledger.positions[0].remaining_basis);
});
test('settlement refuses unconfirmed, mismatched, stale and non-exchange evidence',()=>{
  const good=settlement();
  const bad=[{...good,market:{...good.market,status:'closed'}},{...good,market:{...good.market,ticker:'OTHER'}},{...good,market:{...good.market,result:'scalar'}},{...good,market:{...good.market,market_type:'scalar'}},
    {...good,as_of:'2026-11-04T16:00:00Z'},{...good,as_of:'2026-11-04T18:00:00Z'},{...good,source_url:'https://example.com/markets/'+book.ticker},{...good,source_url:'https://api.elections.kalshi.com/trade-api/v2/markets/OTHER'}];
  for(const evidence of bad)assert.throws(()=>paper.applySettlement(opened(),'p',evidence,{id:'s',now}));
});
test('compact research updates live probabilities without relabeling old full-source context as new data',()=>{
  const news={status:'live',articles:[{title:'Team report',retrieved_at:'2026-11-04T16:00:00Z'}]},availability=[{name:'Player',status:'Out'}];
  const previous={ticker:book.ticker,view_model:'challenger',forecast:{probability:.6},news,extensions:{sports:{availability,availability_note:'Original report'},music:{source_date:'2026-11-03'}},sources:[{url:'https://example.test/injury',retrieved_at:'2026-11-04T16:00:00Z'}]};
  const next={ticker:book.ticker,view_model:'challenger',forecast:{probability:.7,max_source_age_seconds:30},news:{status:'not_queried',articles:[]},extensions:{sports:{availability:[],live_score:{home_score:4}}},sources:[{url:'https://example.test/live',retrieved_at:new Date(now).toISOString()}]};
  const merged=mergeResearchRefresh(previous,next);assert.equal(merged.forecast.probability,.7);assert.equal(merged.news,news);assert.equal(merged.extensions.sports.availability,availability);assert.equal(merged.sources[0].retrieved_at,'2026-11-04T16:00:00Z');assert.equal(researchRefreshDelay(merged),20000);assert.equal(researchRefreshDelay(previous),60000);
  assert.equal(mergeResearchRefresh(previous,{...next,ticker:'OTHER'}).news,next.news);
});
test('a fresh settlement status in matching research closes the selected stream condition without changing category',()=>{
  const selected=selectionReducer(initialSelection,{type:'select',market:{ticker:book.ticker,status:'active',category:'sports'}});
  const updated=selectionReducer(selected,{type:'research',ticker:book.ticker,generation:selected.generation,value:{ticker:book.ticker,market:{ticker:book.ticker,status:'finalized',result:'yes'}}});
  assert.equal(updated.market.status,'finalized');assert.equal(updated.market.category,'sports');assert.equal(updated.market.result,'yes');
  assert.equal(selectionReducer(updated,{type:'research',ticker:'OTHER',generation:selected.generation,value:{ticker:'OTHER',market:{ticker:'OTHER',status:'active'}}}),updated);
});
test('background catalog refresh preserves row order while updating quotes and removing absent contracts',()=>{
  const current=[{ticker:'A',yes_ask:.3},{ticker:'B',yes_ask:.5},{ticker:'C',yes_ask:.8}],incoming=[{ticker:'B',yes_ask:.6},{ticker:'A',yes_ask:.4},{ticker:'D',yes_ask:.2}];
  const refreshed=refreshMarketRows(current,incoming);assert.deepEqual(refreshed.map(row=>row.ticker),['A','B','D']);assert.equal(refreshed[0].yes_ask,.4);assert.equal(current[0].yes_ask,.3);
});
