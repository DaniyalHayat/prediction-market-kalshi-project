import test from "node:test";
import assert from "node:assert/strict";
import { normalCdf, marketBounds, empiricalProbability, gaussianProbability, eventDate, timeSeriesModel, cryptoModel, executionEstimate, quarterKelly, coherenceChecks } from "../lib/intelligence/math.mjs";
import { parseTsa, parseFred, parseCandles, localDay, sourceText } from "../lib/intelligence/sources.mjs";
import { modelEvidence } from "../lib/intelligence/index.mjs";
import "../public/dashboard/research.js";
import "../public/dashboard/intelligence.js";

test("normal CDF and empirical probabilities obey numerical boundaries",()=>{
  assert.ok(Math.abs(normalCdf(0)-.5)<1e-7);
  assert.equal(normalCdf(Infinity),1);assert.equal(normalCdf(-Infinity),0);
  const p=empiricalProbability(10,[-2,-1,0,1,2],{lower:10,upper:Infinity},2);
  assert.equal(p.probability,3.5/6);assert.equal(p.n,5);assert.equal(p.effective_n,2);
  assert.ok(p.interval[0]<=p.probability && p.interval[1]>=p.probability);
});
test("published one-decimal releases and integer weather bins use the correct continuity correction",()=>{
  assert.deepEqual(marketBounds({strike_type:"greater",floor_strike:.3},.1),{lower:.35,upper:Infinity,description:"greater than 0.3"});
  assert.deepEqual(marketBounds({strike_type:"greater_or_equal",floor_strike:.3},.1),{lower:.25,upper:Infinity,description:"at least 0.3"});
  assert.deepEqual(marketBounds({strike_type:"between",floor_strike:75,cap_strike:76},1),{lower:74.5,upper:76.5,description:"75 to 76"});
  assert.equal(marketBounds({strike_type:"greater",floor_strike:null}),null);
  assert.equal(marketBounds({strike_type:"between",floor_strike:2,cap_strike:1}),null);
  assert.equal(marketBounds({strike_type:"functional"}),null);
});
test("daily, monthly and hourly event tickers identify observation dates, not release dates",()=>{
  assert.equal(eventDate({event_ticker:"KXTSAD-26OCT27"}),"2026-10-27");
  assert.equal(eventDate({event_ticker:"KXCPI-26OCT"}),"2026-10-01");
  assert.equal(eventDate({event_ticker:"KXBTC-26OCT2801"}),"2026-10-28");
  assert.equal(eventDate({event_ticker:"UNSUPPORTED"}),null);
  assert.equal(eventDate({event_ticker:"KXTSAD-26FEB30"}),null);
});
test("TSA parsing only accepts real table date/value pairs and never fills missing dates",()=>{
  const html="<table><tr><th>Date</th><th>Numbers</th></tr><tr><td>10/1/2025</td><td>2,345,678</td></tr><tr><td>10/3/2025</td><td>2,222,222</td></tr><tr><td>2/30/2025</td><td>1,111,111</td></tr></table>";
  assert.deepEqual(parseTsa(html,Date.parse("2025-10-04")),[{date:"2025-10-01",value:2345678},{date:"2025-10-03",value:2222222}]);
});
test("FRED parser preserves missing months and zero observations without interpolation",()=>{
  assert.deepEqual(parseFred("observation_date,UNRATE\n2025-01-01,4.2\n2025-02-01,\n2025-03-01,0\n","UNRATE"),[{date:"2025-01-01",value:4.2},{date:"2025-03-01",value:0}]);
  assert.throws(()=>parseFred("HTML error page","UNRATE"));
});
test("Coinbase parser excludes incomplete candles and deduplicates timestamps",()=>{
  const rows=parseCandles([[0,1,2,1,1.5,10],[0,1,2,1,1.6,10],[3600,1,2,1,1.7,10]],7200000-1);
  assert.equal(rows.length,1);assert.equal(rows[0].value,1.6);assert.equal(rows[0].date,"1970-01-01T01:00:00.000Z");
});
test("NWS dates use the contract station timezone rather than UTC",()=>{
  assert.equal(localDay("2026-10-28T04:30:00Z","America/Chicago"),"2026-10-27");
  assert.equal(localDay("2026-10-28T04:30:00Z","America/New_York"),"2026-10-28");
});
function dailyRows(count=330) {
  return Array.from({length:count},(_,i)=>({date:new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10),value:2e6+[0,4e5,-2e5,-1e5,1e5,3e5,5e5][i%7]+i*200+Math.sin(i*.3)*20000}));
}
test("forecast weights and error calibration never train on the held-out partition",()=>{
  const rows=dailyRows(),original=timeSeriesModel(rows);
  const altered=rows.map((row,i)=>i>=rows.length-50 ? {...row,value:row.value+1e6} : row);
  const changed=timeSeriesModel(altered);
  assert.deepEqual(changed.weights,original.weights);
  assert.deepEqual(changed.errors,original.errors);
  assert.equal(original.training_n,120);assert.equal(original.calibration_n,60);assert.equal(original.evaluation.n,60);
  const tomorrow=new Date(Date.parse(rows.at(-1).date)+86400000).toISOString().slice(0,10);
  assert.ok(original.forecast(tomorrow).center>0);
  assert.equal(original.forecast(new Date(Date.parse(rows.at(-1).date)+8*86400000).toISOString().slice(0,10)),null);
});
test("missing exact weekday lags cause a withheld forecast instead of fabricated history",()=>{
  const rows=dailyRows(),tomorrow=new Date(Date.parse(rows.at(-1).date)+86400000).toISOString().slice(0,10);
  const missing=new Date(Date.parse(tomorrow)-7*86400000).toISOString().slice(0,10);
  assert.equal(timeSeriesModel(rows.filter(row=>row.date!==missing)).forecast(tomorrow),null);
});
test("monthly models reject multi-month extrapolation",()=>{
  const rows=Array.from({length:240},(_,i)=>({date:new Date(Date.UTC(2000, i,1)).toISOString().slice(0,10),value:4+.4*Math.sin(i*.12)+.05*Math.sin(i)}));
  const model=timeSeriesModel(rows,"monthly");
  assert.ok(model.forecast("2020-01-01"));
  assert.equal(model.forecast("2020-02-01"),null);
});
test("crypto volatility uses completed price observations and refuses unsupported horizons",()=>{
  const rows=Array.from({length:200},(_,i)=>({date:new Date(i*3600000).toISOString(),value:80000*Math.exp(.005*Math.sin(i))}));
  const model=cryptoModel(rows,80000,24);
  const p=model.estimate({lower:80000,upper:Infinity});
  assert.ok(p.probability>0 && p.probability<1);
  assert.ok(p.interval[0]<=p.probability && p.interval[1]>=p.probability);
  assert.equal(cryptoModel(rows,80000,73),null);
  assert.equal(cryptoModel(rows,80000,-1),null);
});
test("server execution estimates match the independently tested browser simulator",()=>{
  const raw={orderbook_fp:{yes_dollars:[[".35","40"]],no_dollars:[[".6","10"],[".6","5"],[".59","20"],[".5","100"]]}};
  for(const side of ["yes","no"]) {
    const server=executionEstimate(raw,side,50,2,.07),client=globalThis.KalshiResearch.simulate(raw,side,50);
    assert.equal(server.filled,client.filled);
    for(const [key,clientKey] of [["cost","cost"],["fee","fee"],["all_in","allIn"],["breakeven","breakeven"]])assert.ok(Math.abs(server[key]-client[clientKey])<1e-9,key);
  }
  assert.throws(()=>executionEstimate({orderbook_fp:{yes_dollars:[[".8","1"]],no_dollars:[[".6","1"]]}},"yes"));
  assert.throws(()=>executionEstimate(raw,"yes",1.5));
});
test("quarter-Kelly cannot size a negative edge or an invalid contract cost",()=>{
  assert.equal(quarterKelly(.4,.5),0);
  assert.equal(quarterKelly(.6,1),0);
  assert.ok(Math.abs(quarterKelly(.6,.5)-.05)<1e-10);
});
test("nested threshold checks require the same event and account for estimated fees",()=>{
  const low={ticker:"LOW",event_ticker:"EVENT",strike_type:"greater",floor_strike:1,yes_ask_dollars:".4",yes_bid_dollars:".39"};
  const high={ticker:"HIGH",event_ticker:"EVENT",strike_type:"greater",floor_strike:2,yes_ask_dollars:".7",yes_bid_dollars:".65"};
  const findings=coherenceChecks([low,high]);
  assert.equal(findings.length,1);assert.equal(findings[0].long_yes,"LOW");assert.equal(findings[0].long_no,"HIGH");
  assert.equal(coherenceChecks([low,{...high,event_ticker:"OTHER"}]).length,0);
  assert.equal(coherenceChecks([low,{...high,yes_bid_dollars:".3"}]).length,0);
});
test("research source fetching rejects arbitrary hosts before any network access",async()=>{
  let called=false;
  await assert.rejects(sourceText("https://example.com/secret",1000,()=>{called=true;}),RangeError);
  assert.equal(called,false);
});
test("large claimed probability gaps cannot bypass failed forecast-validation gates",()=>{
  assert.equal(modelEvidence({probability:.99,validation:{rmse_skill:-.1,interval_80_coverage:.9,n:60}}).tier,0);
  assert.equal(modelEvidence({probability:.99,validation:{rmse_skill:.2,interval_80_coverage:.56,n:60}}).tier,0);
  assert.equal(modelEvidence({probability:.6,validation:{rmse_skill:.1,interval_80_coverage:.8,n:60}}).tier,2);
  assert.equal(modelEvidence({probability:.6}).tier,1);
  assert.equal(modelEvidence({probability:NaN}).tier,0);
  assert.equal(modelEvidence({probability:null}).tier,0);
});
test("journal scoring uses paired first forecasts and cannot turn absent quotes into zero-probability benchmarks",()=>{
  const records=[
    {ticker:"A",recorded_at:"2026-01-01",outcome:1,probability:.7,market_probability:.5},
    {ticker:"A",recorded_at:"2026-01-02",outcome:1,probability:.99,market_probability:.5},
    {ticker:"B",recorded_at:"2026-01-01",outcome:0,probability:.2,market_probability:null}
  ];
  const scores=globalThis.KalshiIntelligence.paperScores(records);
  assert.equal(scores.resolved,2);assert.equal(scores.paired,1);
  assert.ok(Math.abs(scores.model_brier-.09)<1e-10);assert.equal(scores.market_brier,.25);
});
