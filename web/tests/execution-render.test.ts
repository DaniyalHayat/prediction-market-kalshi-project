import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ExecutionLab,{ExecutionResults} from '../ui/ExecutionLab.jsx';
import {EXECUTION_DEFAULTS} from '../ui/execution-state.mjs';
import {executionResearch} from '../lib/workspace/execution-research.mjs';

test('the execution lab renders usable scenario controls without an automatic calculation or fabricated result',()=>{
  const html=renderToStaticMarkup(createElement(ExecutionLab,{market:{ticker:'KXTEST-A'},book:null,fees:null,clock:Date.now(),closed:false,
    onRefreshDepth:async()=>{},onControlsChange:()=>{},onAssistant:()=>{}}));
  assert.match(html,/Execution lab/);assert.match(html,/Run scenario/);assert.match(html,/Risk-aware schedule/);assert.match(html,/Editable, not fitted by default/);
  assert.match(html,/min="30"/);assert.match(html,/Scenario assumptions/);assert.ok(!html.includes('Modeled execution cost'));assert.ok(!html.includes('No eligible estimate'));
  assert.equal((html.match(/type="checkbox"/g)||[]).length,9);
});

test('execution results retain zero values, show missing coverage and label conditional costs separately from settlement probability',()=>{
  const value={ticker:'KXTEST-A',as_of:'2026-11-05T03:00:00Z',enabled:true,controls:EXECUTION_DEFAULTS,forecast:{probability:0,unchanged:true},market_state:{bid:0,ask:.01,spread:.01},
    data_quality:{gaps:['Event history is unavailable.']},schedule:{expected_cost:0,risk_variance:0,objective:0,benchmark_twap:{expected_cost:.2,risk_variance:.01,objective:.21},rows:[{time_seconds:0,contracts:20,remaining:0}]},
    order_flow:{available:false,reason:'Two consecutive book events are required.'},arrival_model:{available:false},inventory_quotes:{bid:0,ask:.01,reservation_price:0},settlement:{available:false,reason:'A full current exit is not executable.'},limitations:['Conditional simulation, not an outcome backtest.']};
  const html=renderToStaticMarkup(createElement(ExecutionResults,{value,outdated:true,onAssistant:()=>{}}));
  assert.match(html,/0\.0%/);assert.match(html,/\$0\.00/);assert.match(html,/USD²/);assert.match(html,/Event history is unavailable/);assert.match(html,/Two consecutive book events/);assert.match(html,/previous settings/);assert.match(html,/do not create a new probability/);assert.match(html,/not an outcome backtest/);assert.match(html,/No eligible comparison/);
});

test('actual execution outputs render for every market category and NO quotes retain the correct side label',()=>{
  const now=Date.now(),ticker='KXTEST-A',book={ticker,as_of:new Date(now).toISOString(),raw:{orderbook_fp:{yes_dollars:[['.35','100']],no_dollars:[['.60','100']]}}};
  for(const category of ['sports','macro','crypto','travel','weather','science','climate','culture']){
    const input={market:{ticker,category},book,forecast:{valid:true,fresh:true,eligible:true,probability:.6,interval:[.5,.7]},controls:{...EXECUTION_DEFAULTS,side:'no'},now};
    const value=executionResearch(input);
    const html=renderToStaticMarkup(createElement(ExecutionResults,{value,outdated:false,onAssistant:()=>{}}));
    assert.match(html,/Scenario NO bid \/ ask/);assert.ok(!html.includes('Scenario YES bid / ask'));assert.match(html,/Independent P\(YES\)/);assert.match(html,/60\.0%/);assert.match(html,/20 \/ 20 contracts filled/);assert.match(html,/Risk-aware schedule/);assert.match(html,/Needs more data/);assert.ok(!html.includes('[object Object]'));
  }
});

test('NFL scenario distinguishes the three event outcomes from the tie-adjusted expected settlement',()=>{
  const value={ticker:'KX-NFL-FIXTURE',controls:EXECUTION_DEFAULTS,
    forecast:{probability:.61,outcomes:{win:.61,loss:.37,tie:.02},expected_settlement_value:.62}};
  const html=renderToStaticMarkup(createElement(ExecutionResults,{value,onAssistant:()=>{}}));
  assert.match(html,/YES team win chance/);assert.match(html,/61\.0%/);assert.match(html,/Opposing team win chance 37\.0%/);
  assert.match(html,/Tie chance 2\.0%/);assert.match(html,/Modeled YES settlement \$0\.62/);assert.match(html,/A tie pays \$0\.50/);
  assert.match(html,/Download PDF/);assert.match(html,/Ask why/);
});
