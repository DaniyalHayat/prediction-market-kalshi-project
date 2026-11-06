import test from 'node:test';
import assert from 'node:assert/strict';
import {localPositionReview} from '../lib/workspace/mcp.mjs';
import {parsePositionReview,reviewPaperPosition,summarizePositionFlow} from '../lib/workspace/position-review.mjs';
import {screenAvailabilityForecast} from '../lib/workspace/nba-availability-feedback.mjs';
import {POST} from '../app/api/[...path]/route.js';
import {proxyBackend} from '../lib/workspace/proxy.mjs';

const date=now=>new Date(now).toISOString();
function setup(ticker,options={}){
  const now=Date.now(),as_of=date(now-1000);
  const market={ticker,event_ticker:'same-event',status:options.status||'active',close_time:date(now+60000)};
  const quote={ticker:options.bookTicker||ticker,as_of:date(now-(options.quoteAge||1000)),source_url:'https://kalshi.test/book',
    raw:{orderbook_fp:{yes_dollars:[['.38',options.depth||'100']],no_dollars:[['.59','100']]}},metrics:{book_spread_cents:3}};
  const forecast={probability:options.p??.7,interval:options.interval||[.6,.8],model_name:'Fixture outcome model',
    source_as_of:as_of,validation:{passed:true},evidence:{tier:2},experimental:options.experimental,eligible:options.eligible??true};
  const dependencies={
    marketDetails:async()=>({market,as_of,source_url:'https://kalshi.test/contract'}),
    book:async()=>quote,workspaceResearch:async()=>({ticker,market,forecast,fee_coefficient:.07}),
    workspaceEvidence:async()=>({ticker,items:[{title:'Matched report',publisher:'Publisher',url:'https://publisher.test/report'}]}),
    trades:async()=>({trades:[{ticker,trade_id:'trade',count_fp:'2.50',taker_outcome_side:'yes',created_time:as_of}],source_url:'https://kalshi.test/trades'}),
    contractHistory:async()=>({ticker,source_url:'https://kalshi.test/history',market_signal:{status:'available',last_midpoint:.4,prediction:.41,observed_at:as_of}}),
    recentPositionIdeas:async()=>({checked_categories:['macro','sports'],scanned_contracts:5,rows:[{ticker,event_ticker:'same-event'},
      {ticker:'SIBLING',event_ticker:'same-event'},{ticker:'IDEA-1'},{ticker:'IDEA-2'},{ticker:'IDEA-3'},{ticker:'IDEA-4'}]})
  };
  return {position:{ticker,side:'yes',quantity:10,basis:5},dependencies};
}

test('the scoped in-process MCP holds a losing lot using current net bids versus future value',async()=>{
  const {position,dependencies}=setup('HOLD-REVIEW');
  const result=await localPositionReview(position,{dependencies});
  assert.equal(result.action,'HOLD');
  assert.ok(result.evaluation.unrealized_pnl<0);
  assert.deepEqual(result.evaluation.fair_value_range,[6,8]);
  assert.equal(result.flow.yes_taker_contracts,2.5);
  assert.ok(result.sources.some(row=>row.url==='https://publisher.test/report'));
  assert.match(result.sections[0].text,/down \$1\.37/);
  assert.match(result.sections[1].text,/lower estimate beats a sale/);
  assert.equal(result.timings_ms.total,result.duration_ms);
});

test('SELL requires a released interval below bids and filters recommendations by shared event',async()=>{
  const {position,dependencies}=setup('SELL-REVIEW',{p:.2,interval:[.1,.3]});
  const result=await reviewPaperPosition({...position,automatic:true},{dependencies});
  assert.equal(result.action,'SELL');
  assert.ok(result.evaluation.hold_vs_exit_range[1]<0);
  assert.deepEqual(result.alternatives.map(row=>row.ticker),['IDEA-1','IDEA-2','IDEA-3']);
  assert.equal(result.alternative_coverage.category_count,8);
  assert.deepEqual(result.alternative_coverage.checked_categories,['macro','sports']);
});
test('automatic and manual paper scans account for a matched lineup scenario before issuing HOLD',async()=>{
  const {position,dependencies}=setup('KXNBAGAME-26NOV06PORLAL-LAL',{p:.51,interval:[.42,.63]});
  const baseResearch=dependencies.workspaceResearch;
  assert.equal((await reviewPaperPosition(position,{dependencies})).action,'HOLD');
  dependencies.workspaceResearch=async(ticker,options)=>{
    const value=await baseResearch(ticker,options);
    return {...value,forecast:{...value.forecast,availability_feedback:{status:'unavailable',baseline_probability:.51,
      reason:'There are too few comparable games.',source:{url:'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=100'}}}};
  };
  const insufficient=await reviewPaperPosition(position,{dependencies});
  assert.equal(insufficient.action,'HOLD');
  assert.match(insufficient.sections.find(row=>row.heading==='Lineup check').text,/51% YES.*too few comparable games/);
  dependencies.workspaceResearch=async(ticker,options)=>{
    assert.equal(options.refreshAvailability,true);
    const value=await baseResearch(ticker,options);
    const feedback={status:'available',baseline_probability:.51,decision_interval:[.30,.63],
      scenarios:[{name:'Sample player',status:'Out',conditional_probability:.39,dnp_games:3,regular_games:5}]};
    return {...value,forecast:screenAvailabilityForecast(value.forecast,feedback)};
  };
  for(const automatic of [false,true]){
    const result=await reviewPaperPosition({...position,automatic},{dependencies});
    assert.equal(result.action,'REVIEW');
    assert.deepEqual(result.evaluation.fair_value_range,[3,6.3]);
    assert.match(result.sections.find(row=>row.heading.includes('lineup evidence')).text,/39% YES/);
  }
});

test('mismatched or stale bids, experimental models and shared partial depth do not trigger alerts',async()=>{
  const scenarios=[
    ['WRONG-REVIEW',{bookTicker:'OTHER'},{}],
    ['STALE-REVIEW',{quoteAge:150000},{}],
    ['CHALLENGER-REVIEW',{experimental:true},{}],
    ['POOLED-REVIEW',{depth:'10'},{shared_quantity:20}],
    ['CLOSED-REVIEW',{status:'closed'},{}],
    ['UNCERTAIN-REVIEW',{p:.4,interval:[.2,.5]},{}],
  ];
  for(const [ticker,options,changes] of scenarios){
    const {position,dependencies}=setup(ticker,options);
    const result=await reviewPaperPosition({...position,...changes},{dependencies});
    assert.equal(result.action,'REVIEW',ticker);
    if(changes.shared_quantity)assert.equal(result.evaluation.executable_quantity,5);
  }
});

test('deadline returns partial result, coalesces concurrent public inputs and preserves explicit source errors',async()=>{
  const {position,dependencies}=setup('DEADLINE-REVIEW');
  let started=0,finish;
  dependencies.workspaceResearch=()=>{started++;return new Promise(resolve=>{finish=resolve;});};
  dependencies.trades=async()=>{throw Object.assign(new Error('limited'),{upstream_status:429});};
  const options={dependencies,deadlineMs:35};
  const results=await Promise.all([reviewPaperPosition(position,options),reviewPaperPosition({...position,quantity:2},options)]);
  finish(null);
  assert.equal(started,1);
  for(const result of results){
    assert.equal(result.action,'REVIEW');
    assert.equal(result.partial,true);
    assert.equal(result.source_status.research,'pending');
    assert.equal(result.source_status.flow,'rate_limited');
    assert.ok(result.duration_ms<250);
  }
});

test('flow keeps only recent exact public fills and recognizes partial windows',()=>{
  const now=Date.now(),ticker='FLOW',created_time=date(now-60000);
  const good={ticker,trade_id:'yes',created_time,count_fp:'2.5',taker_outcome_side:'yes',taker_side:'no'};
  const rows=[good,good,{...good,trade_id:'other',ticker:'ELSE'},{...good,trade_id:'old',created_time:date(now-26*60000)},
    {...good,trade_id:'future',created_time:date(now+1000)},{...good,trade_id:'block',is_block_trade:true},
    {ticker,trade_id:'no',created_time,count_fp:'1.2',taker_side:'no'}];
  assert.deepEqual(summarizePositionFlow({trades:rows,partial:true},ticker,now),{sample_trades:2,yes_taker_contracts:2.5,
    no_taker_contracts:1.2,sample_truncated:true,window_minutes:25,as_of:null});
});

test('position route rejects invalid inputs and cross-site requests before touching providers',async()=>{
  const {position}=setup('ROUTE-REVIEW');
  for(const extra of [{quantity:'10'},{quantity:0},{basis:-1},{shared_quantity:1},{ticker:'../private'},{side:'buy'},{automatic:'yes'}])
    assert.throws(()=>parsePositionReview({...position,...extra}),RangeError);
  const routeContext={privateRuntime:true,params:Promise.resolve({path:['workspace','position-review']})};
  const response=await POST(new Request('http://localhost/api/workspace/position-review',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...position,quantity:-1})}),routeContext);
  assert.equal(response.status,400);
});

test('the proxy forwards timings, enforces same origin and keeps inputs out of cache',async t=>{
  const original=process.env.MARKET_BACKEND_URL;
  process.env.MARKET_BACKEND_URL='https://backend.test';
  t.after(()=>{if(original===undefined)delete process.env.MARKET_BACKEND_URL;else process.env.MARKET_BACKEND_URL=original;});
  const path=['workspace','position-review'];
  const request=origin=>new Request('https://predictir.dev/api/workspace/position-review',{method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});
  assert.equal((await proxyBackend(request('https://evil.test'),path,{fetcher:()=>assert.fail('cross-site request forwarded')})).status,403);
  const reply=await proxyBackend(request('https://predictir.dev'),path,{fetcher:async()=>new Response('{}',{headers:{'Server-Timing':'total;dur=620'}})});
  assert.equal(reply.headers.get('server-timing'),'total;dur=620');
  assert.equal(reply.headers.get('cache-control'),'no-store');
});
