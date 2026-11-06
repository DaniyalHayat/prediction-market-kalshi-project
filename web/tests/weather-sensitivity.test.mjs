import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORIES, distribution } from "../lib/intelligence/index.mjs";

const now=Date.parse("2026-11-06T13:00:00Z");
const day="2026-11-06";
const series="KXHIGHNY";
const category=CATEGORIES.find(({id})=>id==="weather");
const market={series,ticker:`${series}-26NOV06-B67.5`,strike_type:"between",floor_strike:67,cap_strike:68,
  rules_primary:"The Weather Company daily high temperature for Central Park"};
const source={series,name:"National Weather Service",updated_at:new Date(now).toISOString(),
  source_url:"https://api.weather.gov/gridpoints/OKX/34,45/forecast/hourly",
  rows:[13,14,15].map(hour=>({day,date:`${day}T${hour}:00:00Z`,value:68})),
  observation:{rows:[{day,date:`${day}T12:40:00Z`,value:69.08}]}};

test("preliminary weather observations cannot eliminate a different publisher's settlement outcome",()=>{
  const forecast=distribution(market,category,{sources:[source]},{},now);
  assert.equal(forecast.center,69.08);
  assert.equal(forecast.inputs.observed_max,69.08);
  assert.ok(forecast.interval[0]>0 && forecast.interval[0]<forecast.probability);
  assert.ok(forecast.probability<forecast.interval[1] && forecast.interval[1]<1);
  assert.ok(forecast.range_80[0]<forecast.center);
  assert.equal(forecast.validation,null);
});

test("a saturated weather proxy withholds the number and keeps the source",()=>{
  const forecast=distribution({...market,floor_strike:190,cap_strike:191},category,{sources:[source]},{},now);
  assert.equal(forecast.probability,null);
  assert.equal(forecast.interval,null);
  assert.match(forecast.reason,/cannot resolve this strike/);
  assert.equal(forecast.source_url,source.source_url);
});
