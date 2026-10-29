import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { STRATEGIES, bookState, liquidationEstimate, normalizeCandles, minuteRidge, irregularOU, isotonic, relativeValueSurface,
  signalTargets, freezeDecision, scoreMarkout, summarizeForward } from "../lib/quant/signals.mjs";
import { normalizeProtocol, selectBalanced, digest, verifyAuditEntries, aggregateForwardRuns } from "../lib/quant/forward.mjs";

const raw={orderbook_fp:{yes_dollars:[[".4","100"]],no_dollars:[[".5","100"]]}};
test("forward protocols are bounded, balanced and reject malformed settings",()=>{
  assert.equal(normalizeProtocol().categories.length,5);
  assert.equal(normalizeProtocol().seconds,60);
  for(const input of [null,[],{categories:["travel","travel"]},{seconds:1},{contracts:1001},{contracts:true},{slippage:6}])assert.throws(()=>normalizeProtocol(input));
});
test("selection gives each category a quota before results and avoids expiring contracts",()=>{
  const categories=["crypto","weather","labor","inflation","travel"],now=Date.now();
  const reports=categories.map(category=>({category:{id:category},markets:[
    {ticker:category+"-LIVE",event_ticker:category,yes_bid:.4,yes_ask:.42,volume_24h:100,close_time:new Date(now+1000000).toISOString()},
    {ticker:category+"-EXPIRED",event_ticker:category,yes_bid:.4,yes_ask:.42,volume_24h:1e9,close_time:new Date(now+10000).toISOString()}
  ]}));
  const {selected}=selectBalanced(reports,normalizeProtocol(),now);
  assert.equal(selected.length,5);assert.equal(new Set(selected.map(row=>row.category)).size,5);
  assert.ok(selected.every(row=>row.market.ticker.endsWith("LIVE")));
});
test("minute bars use observed two-sided closes and exclude synthetic/unfinished bars",()=>{
  const candle=(ts,bid,ask)=>({end_period_ts:ts,yes_bid:{close_dollars:bid},yes_ask:{close_dollars:ask},volume_fp:"1"});
  const rows=normalizeCandles({candlesticks:[candle(60,".4",".5"),candle(120,null,null),candle(180,".4",".5")]},120);
  assert.equal(rows.length,1);assert.equal(rows[0].mid,.45);
});
test("nested ridge selection never uses the last chronological holdout to pick lambda",()=>{
  const rows=Array.from({length:330},(_,i)=>({ts:i*60,mid:.5+.04*Math.sin(i/10),bid:.49,ask:.51,spread:.02,volume:10+i%7}));
  const first=minuteRidge(rows),changed=minuteRidge(rows.map((row,i)=>i>rows.length-50 ? {...row,mid:row.mid+.04*Math.sin(i)} : row));
  assert.equal(first.available,true);assert.equal(first.lambda,changed.lambda);
  assert.ok(first.last_input_ts<=rows.at(-1).ts);
  assert.equal(minuteRidge(rows.slice(0,50)).available,false);
});
test("PAVA removes incompatible threshold ordering without normalizing an incomplete outcome set",()=>{
  assert.deepEqual(isotonic([.2,.8,.4],[1,1,1],false),[.5,.5,.4]);
  const surface=relativeValueSurface([
    {ticker:"A",event_ticker:"E",strike_type:"greater",floor_strike:1,yes_bid:.1,yes_ask:.3},
    {ticker:"B",event_ticker:"E",strike_type:"greater",floor_strike:2,yes_bid:.7,yes_ask:.9}
  ]);
  assert.ok(surface.get("A").target>=surface.get("B").target);
});
test("liquidation sells into bids and charges the exit fee, never the midpoint",()=>{
  const exit=liquidationEstimate(raw,"yes",10,2,.07);
  assert.equal(exit.vwap,.4);assert.equal(exit.gross_proceeds,4);assert.equal(exit.fee,.17);
  assert.equal(exit.net_proceeds,3.83);assert.equal(bookState(raw).mid,.45);
});
test("cost-aware policies abstain when forecast movement cannot pay the spread and both fees",()=>{
  assert.equal(freezeDecision(raw,{available:true,predicted_yes_mid:.46,role:"cost-filtered"}).action,"abstain");
  assert.equal(freezeDecision(raw,{available:true,predicted_yes_mid:.46,role:"diagnostic control"}).action,"paper-entry");
});
function leg(quantity=10) {
  const signal={id:"shadow-direction",name:"test",role:"diagnostic control",available:true,predicted_yes_mid:.46};
  return {ticker:"TEST",event_ticker:"EVENT",category:"crypto",frozen_at:"2026-01-01T00:00:00Z",
    features:{book_mid:.45},signals:[{...signal,decision:freezeDecision(raw,signal,{contracts:quantity,slippage:2,coefficient:.07})}]};
}
test("observed forward P&L includes entry spread, entry fees and exit fees",()=>{
  const mark=scoreMarkout(leg(),raw,"2026-01-01T00:01:00Z",{seconds:60,slippage:2,coefficient:.07});
  assert.ok(Math.abs(mark.signals[0].net_pnl-(-1.35))<1e-9);
  assert.equal(mark.signals[0].fully_liquidated,true);assert.equal(mark.on_time,true);
});
test("partial exits and late observations never become profitable completed trials",()=>{
  const partial={orderbook_fp:{yes_dollars:[[".6","3"]],no_dollars:[[".3","100"]]}};
  const mark=scoreMarkout(leg(),partial,"2026-01-01T00:01:00Z",{seconds:60,slippage:2,coefficient:.07});
  assert.equal(mark.signals[0].net_pnl,null);assert.equal(mark.signals[0].remaining_quantity,7);
  const late=scoreMarkout(leg(),raw,"2026-01-01T00:03:00Z",{seconds:60,slippage:2,coefficient:.07});
  assert.equal(late.on_time,false);
  const summary=summarizeForward([mark,late],2).find(row=>row.strategy==="shadow-direction");
  assert.equal(summary.closed,0);assert.equal(summary.net_pnl,null);assert.equal(summary.evidence,"profitability not demonstrated");
});
test("repeated contracts within one event cannot inflate independent event counts",()=>{
  const mark=scoreMarkout(leg(),raw,"2026-01-01T00:01:00Z",{seconds:60,slippage:2,coefficient:.07});
  const summary=summarizeForward(Array.from({length:40},()=>mark),40).find(row=>row.strategy==="shadow-direction");
  assert.equal(summary.independent_event_groups,1);assert.equal(summary.fee_adjusted_per_contract_interval,null);
});
test("price error and persistence benchmarks use exactly the same available forecast pairs",()=>{
  const mark=scoreMarkout(leg(),raw,"2026-01-01T00:01:00Z",{seconds:60,slippage:2,coefficient:.07});
  const summary=summarizeForward([mark],1).find(row=>row.strategy==="ridge-forward");
  assert.equal(summary.paired_forecasts,0);assert.equal(summary.persistence_mse,null);
});
test("frozen cohort hashes are canonical and any changed forecast invalidates the audit chain",()=>{
  assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));
  const row={type:"freeze",recorded_at:"2026-01-01",previous:null,content:{prediction:.6}};
  row.hash=digest(row);
  assert.equal(verifyAuditEntries([row]),row.hash);
  assert.throws(()=>verifyAuditEntries([{...row,content:{prediction:.9}}]));
});
test("Code Connect uses the exact requested React label and JSX highlighting",async()=>{
  const config=JSON.parse(await readFile(new URL("../figma.config.json",import.meta.url),"utf8"));
  assert.deepEqual(config.codeConnect,{include:["**/*.figma.ts"],label:"React",language:"jsx"});
});
test("all strategy candidates are declared before a future observation",()=>{
  const targets=signalTargets({raw,tape:[],category:"weather",forecast:{probability:.8,evidence:{tier:1}}});
  assert.equal(targets.signals.length,STRATEGIES.length);assert.ok(targets.signals.every(row=>row.specification));
});
test("irregular-time OU consumes actual gaps without manufacturing one-minute observations",()=>{
  const rows=Array.from({length:250},(_,i)=>({ts:i*180,mid:.5+.08*Math.sin(i/11)}));
  const result=irregularOU(rows,.55,60);
  assert.equal(result.available,true);assert.equal(result.n,249);assert.equal(result.mean_observation_gap_seconds,180);
  assert.ok(result.predicted_mid>0 && result.predicted_mid<1);
  const changed=irregularOU(rows.map((row,i)=>i>210 ? {...row,mid:.5+.2*Math.cos(i)} : row),.55,60);
  assert.equal(result.parameters.kappa,changed.parameters.kappa);
  assert.equal(irregularOU(rows.slice(0,30),.5).available,false);
});
test("old cohorts retain exactly their frozen strategy family when new candidates are introduced",()=>{
  const summary=summarizeForward([],0,[{id:"old",name:"Frozen old candidate",role:"cost-filtered"}]);
  assert.equal(summary.length,1);assert.equal(summary[0].strategy,"old");
});
test("multi-minute forecasts purge overlapping labels by timestamp rather than a single-row gap",()=>{
  const rows=Array.from({length:400},(_,i)=>({ts:i*60,mid:.5+.05*Math.sin(i/17),spread:.02,volume:20+i%5}));
  const model=minuteRidge(rows,900);
  assert.equal(model.horizon_seconds,900);
  assert.ok(model.evaluation.max_training_target<model.evaluation.first_test_origin);
});
test("aggregate evidence separates versions and corrects for every registered protocol family",()=>{
  const protocol=normalizeProtocol();
  const runs=[
    {frozen:{strategy_version:"old",protocol,strategies:[{id:"old",role:"cost-filtered"}],legs:[{}]},result:{markouts:[]}},
    {frozen:{strategy_version:"new",protocol,strategies:[{id:"a",role:"cost-filtered"},{id:"b",role:"cost-filtered"}],legs:[{}]},result:null}
  ];
  const groups=aggregateForwardRuns(runs);
  assert.equal(groups.length,2);assert.ok(groups.every(group=>group.multiple_testing_family_size===3));
  assert.equal(groups.find(group=>group.strategy_version==="old").summary.length,1);
  assert.equal(groups.find(group=>group.strategy_version==="new").pending_cohorts,1);
});
