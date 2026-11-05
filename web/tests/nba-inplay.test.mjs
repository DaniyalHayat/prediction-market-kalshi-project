import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import parameters from '../lib/workspace/models/nba-inplay.json' with {type:'json'};
import {normalCDF,inverseNormal,conditionalNBAProbability,parseNBALiveScore,parseNBAQuarterReplay,estimateNBAInPlay} from '../lib/workspace/nba-inplay-math.mjs';
const now=Date.parse('2026-11-05T00:14:11.485Z'),game={id:'401909922',home_id:'8',away_id:'20'};
const prior={probability:.647350939814146,interval:[.473786011444941,.7891455186686365]};
const score={available:true,home_score:3,away_score:0,state:'in',completed:false,period:1,clock_seconds:683,observed_at:new Date(now).toISOString(),freshness_note:'Retrieval timestamp only.'};

test('conditional diffusion preserves the pregame prior and responds monotonically to observed lead',()=>{
  assert.ok(Math.abs(normalCDF(0)-.5)<1e-7);assert.ok(Math.abs(inverseNormal(.975)-1.959964)<1e-5);
  for(const p of [.05,.25,.5,.75,.95])assert.ok(Math.abs(conditionalNBAProbability(0,1,p,parameters.sigma)-p)<1e-7);
  const low=conditionalNBAProbability(-5,.5,.6,parameters.sigma),tie=conditionalNBAProbability(0,.5,.6,parameters.sigma),high=conditionalNBAProbability(5,.5,.6,parameters.sigma);
  assert.ok(low<tie&&tie<high);
  assert.ok(Math.abs(conditionalNBAProbability(5,.5,.6,parameters.sigma)+conditionalNBAProbability(-5,.5,.4,parameters.sigma)-1)<1e-7);
  assert.throws(()=>conditionalNBAProbability(1,0,.6,parameters.sigma),/remaining/);
});
test('live score parser preserves actual zero scores and rejects wrong teams, events and missing scores',()=>{
  const payload={header:{league:{slug:'nba'},competitions:[{id:game.id,status:{period:1,clock:683,displayClock:'11:23',type:{state:'in',completed:false}},
    competitors:[{id:'8',homeAway:'home',score:'3'},{id:'20',homeAway:'away',score:'0'}]}]}};
  const parsed=parseNBALiveScore(payload,game,new Date(now).toISOString());assert.equal(parsed.home_score,3);assert.equal(parsed.away_score,0);assert.equal(parsed.clock_seconds,683);
  const missing=structuredClone(payload);delete missing.header.competitions[0].competitors[1].score;
  assert.equal(parseNBALiveScore(missing,game,new Date(now).toISOString()).away_score,null);
  missing.header.competitions[0].competitors[1].score=false;
  assert.equal(parseNBALiveScore(missing,game,new Date(now).toISOString()).away_score,null);
  assert.equal(parseNBALiveScore(payload,{...game,away_id:'wrong'},new Date(now).toISOString()).available,false);
  assert.equal(parseNBALiveScore(payload,{...game,id:'wrong'},new Date(now).toISOString()).available,false);
});
test('in-play research requires fresh regulation score/clock and never claims recommendation approval',()=>{
  const result=estimateNBAInPlay(score,prior,parameters,now);
  assert.equal(result.available,true);assert.equal(result.max_source_age_seconds,30);assert.equal(result.eligible,false);assert.equal(result.experimental,true);
  assert.equal(result.remaining_regulation_seconds,2843);assert.ok(result.interval[0]<=result.probability&&result.interval[1]>=result.probability);
  assert.match(result.assumptions.join(' '),/Possession.*fouling.*lineup.*overtime/i);
  for(const changed of [{observed_at:new Date(now-31000).toISOString()},{observed_at:new Date(now+10000).toISOString()},
    {period:5,clock_seconds:299},{period:4,clock_seconds:0},{period:4,clock_seconds:3},{home_score:null},{away_score:null},{home_score:undefined},{away_score:false},
    {clock_seconds:null},{clock_seconds:721},{state:'pre'},{state:'post',completed:true}])assert.equal(estimateNBAInPlay({...score,...changed},prior,parameters,now).available,false,JSON.stringify(changed));
  assert.equal(estimateNBAInPlay(score,{probability:0,interval:[0,.5]},parameters,now).available,false);
});
test('real replay archives keep calibration/test games disjoint and reconcile period totals',async()=>{
  const replay=JSON.parse(gunzipSync(await readFile(new URL('../research-data/nba-quarter-replay-2026-11-04.json.gz',import.meta.url))).toString('utf8'));
  const calibration=replay.games.filter(g=>g.split==='calibration'),testGames=replay.games.filter(g=>g.split==='test');
  assert.equal(calibration.length,40);assert.equal(testGames.length,20);assert.equal(new Set(replay.games.map(g=>g.game_id)).size,60);
  assert.ok(calibration.every(g=>g.played_at<testGames[0].played_at));
  for(const row of replay.games){
    assert.equal(row.home_period_scores.reduce((s,v)=>s+v,0),row.home_score);assert.equal(row.away_period_scores.reduce((s,v)=>s+v,0),row.away_score);
    assert.ok(row.prior_cutoff<row.played_at);assert.match(row.source.sha256,/^[a-f0-9]{64}$/);
    assert.ok(row.source.url.endsWith('event='+row.game_id));
  }
  assert.equal(parameters.calibration_games,40);assert.equal(parameters.calibration_states,120);assert.equal(parameters.validation.heldout_games,20);
  assert.equal(parameters.validation.passed,false);assert.equal(parameters.calibration_errors.length,120);
  assert.ok(parameters.calibration_errors.every(r=>Number.isFinite(r.normalized_margin_error)));
});
test('historical quarter parser rejects incomplete totals instead of fabricating period states',()=>{
  const historical={...game,home_score:100,away_score:90};
  const payload={header:{league:{slug:'nba'},competitions:[{id:game.id,status:{type:{state:'post',completed:true}},competitors:[
    {id:'8',homeAway:'home',score:'100',linescores:[20,30,20,30].map(displayValue=>({displayValue}))},
    {id:'20',homeAway:'away',score:'90',linescores:[20,20,20,30].map(displayValue=>({displayValue}))}]}]}};
  assert.equal(parseNBAQuarterReplay(payload,historical).home_period_scores.length,4);
  payload.header.competitions[0].competitors[0].linescores[0].displayValue=21;
  assert.equal(parseNBAQuarterReplay(payload,historical),null);
});
