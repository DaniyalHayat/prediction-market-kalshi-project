import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzePublicTraderEvidence} from '../lib/workspace/trader-evidence.mjs';
const now=Date.parse('2026-11-04T18:00:00Z');
const row={provider:'fixture',trade_id:'1',public:true,trader:'Fixture trader',source_url:'https://example.com/public/1',ticker:'FIXTURE',side:'yes',quantity:10,entry_price:.4,entry_fee:.2,exit_fee:.1,cash_received:10,opened_at:'2026-10-30T00:00:00Z',closed_at:'2026-11-03T00:00:00Z'};
test('public trader analysis includes fees, excludes missing provenance and deduplicates records',()=>{
  const result=analyzePublicTraderEvidence([row,row,{...row,trade_id:'2',public:false}],{now});
  assert.equal(result.accepted,1);assert.equal(result.rejected.length,2);assert.equal(result.rankings.last_7_days[0].net_pnl,5.7);
  assert.match(result.scope,/not an official/);assert.match(result.model_use,/do not train/);
});
test('trader windows use closure dates, four calendar months and never fabricate unavailable ranks',()=>{
  const old={...row,trade_id:'2',closed_at:'2026-06-30T00:00:00Z',opened_at:'2026-06-29T00:00:00Z'};
  const result=analyzePublicTraderEvidence([row,old],{now});
  assert.equal(result.rankings.all_observed[0].trades,2);assert.equal(result.rankings.last_4_calendar_months[0].trades,1);assert.equal(result.rankings.all_observed.length,1);
});
