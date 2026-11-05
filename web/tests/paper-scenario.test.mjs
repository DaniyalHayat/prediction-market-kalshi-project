import test from 'node:test';
import assert from 'node:assert/strict';
import {marketSignal} from '../lib/workspace/market-signal.mjs';
import {paperScenarios,rankPaperScenarios} from '../lib/workspace/paper-scenario.mjs';
import {WORKSPACE_CATEGORIES} from '../lib/workspace/catalog.mjs';
import {explainContract} from '../lib/workspace/assistant.mjs';

const now=Date.parse('2026-11-05T11:00:00Z'),as_of=new Date(now).toISOString();
const market={ticker:'PAPER-EXAMPLE',event_ticker:'PAPER',status:'active',close_time:new Date(now+60_000).toISOString()};
const book={ticker:market.ticker,as_of,raw:{orderbook_fp:{yes_dollars:[['0.19','150']],no_dollars:[['0.80','150']]}}};

test('each workspace category compares actual all-in costs and preserves absent probabilities',()=>{
  for(const {id} of WORKSPACE_CATEGORIES){
    const scenarios=paperScenarios({...market,category:id},book,{}, {now,budget:20});
    assert.equal(scenarios.length,2);
    for(const row of scenarios){
      assert.equal(row.category,id);
      assert.equal(row.eligible,false);
      assert.equal(row.expected_profit,null);
      assert.ok(row.cost<=20&&row.contracts>0&&row.break_even>=row.price);
    }
    assert.equal(rankPaperScenarios(scenarios).length,1);
  }
  assert.deepEqual(paperScenarios(market,book,{}, {now:now+90_000}),[]);
  assert.deepEqual(paperScenarios(market,{...book,ticker:'OTHER'},{},{now}),[]);
});

test('three-way payout models include tie cash and do not substitute opponent win with 1−P(YES)',()=>{
  const forecast={probability:.35,interval:[.25,.45],outcomes:{win:.35,tie:.10,loss:.55},
    expected_settlement_value:.40,settlement_value_interval:[.30,.50],source_as_of:as_of,eligible:false};
  const [yes,no]=paperScenarios(market,book,{ticker:market.ticker,forecast},{now,budget:20});
  assert.equal(yes.settlement_value,.4);
  assert.equal(no.settlement_value,.6);
  assert.equal(yes.probability_yes,null);
  assert.equal(yes.chance_double.probability,.35+.10);
  assert.ok(Math.abs(no.expected_profit-(.60*no.contracts-no.cost))<1e-10);
});

test('the quote model validates time and separates selection, calibration, and replay',()=>{
  const rows=Array.from({length:121},(_,i)=>({time:new Date(now-(120-i)*60000).toISOString(),value:1,midpoint:.2+.001*i,value_kind:'last_trade'}));
  const signal=marketSignal({rows},now);
  assert.equal(signal.status,'available');
  assert.equal(signal.replay.selection_n,60);
  assert.equal(signal.replay.calibration_n,36);
  assert.equal(signal.replay.replay_n,24);
  assert.ok(signal.prediction>signal.last_midpoint&&signal.replay.model_rmse<signal.replay.persistence_rmse);
  assert.equal(marketSignal({rows},now+180001).status,'unavailable');
  assert.equal(marketSignal({rows:rows.map((row,i)=>({...row,time:new Date(now-120000*(120-i)).toISOString()}))},now).status,'unavailable');
});

test('assistant explains a priced setup and links attributed evidence without an outcome probability',()=>{
  const packet={ticker:market.ticker,title:'Example match',paper_scenarios:paperScenarios(market,book,{}, {now}),
    evidence:[{title:'Match report',url:'https://www.nfl.com/',excerpt:'Reported in the official game center.'}]};
  const response=explainContract(packet,market.ticker,now);
  assert.match(response,/YES would take/);
  assert.match(response,/fees included/);
  assert.match(response,/\[Match report\]\(https:\/\/www\.nfl\.com\/\)/);
  assert.doesNotMatch(response,/chance to win|independent model/);
});
