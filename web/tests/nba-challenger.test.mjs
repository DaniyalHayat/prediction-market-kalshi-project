import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import artifact from '../lib/workspace/models/nba-challenger.json' with {type:'json'};
import {buildNBARows,nbaFeatures,NBA_FEATURES} from '../lib/workspace/nba-features.mjs';
import {scoreNBAArtifact,betaCalibrate,fitNBAChallenger,residualSensitivity} from '../lib/workspace/nba-challenger.mjs';
const capture=JSON.parse(gunzipSync(await readFile(new URL('../research-data/nba-completed-games-2026-11-04.json.gz',import.meta.url))).toString('utf8'));
const now=Date.parse(capture.captured_at);
const game=(id,date,home,away,h=110,a=100)=>({id,played_at:date,home_id:home,away_id:away,home_score:h,away_score:a});

test('lag features exclude the current label, future games and same-timestamp results',()=>{
  const games=[game('1','2026-01-01T00:00:00Z','a','b'),game('2','2026-01-02T00:00:00Z','b','c'),game('3','2026-01-02T00:00:00Z','a','d'),game('4','2026-01-03T00:00:00Z','a','b')];
  const first=buildNBARows(games),changed=structuredClone(games);changed[2].home_score=90;changed[3].away_score=150;
  const second=buildNBARows(changed);
  assert.deepEqual(first.rows.slice(0,3).map(r=>r.x),second.rows.slice(0,3).map(r=>r.x));
  assert.deepEqual(first.rows[1].x.slice(3,8),[-6/7,1,0,0,0]);
  const reordered=buildNBARows([games[0],games[2],games[1],games[3]]);
  assert.deepEqual(first.rows,reordered.rows);
  assert.throws(()=>buildNBARows([...games,games[0]]),/Duplicate/);
  assert.equal(nbaFeatures(first.state,game('next','2026-01-04T00:00:00Z','a','b')).length,NBA_FEATURES.length);
});
test('compiled JavaScript logistic, XGBoost and neural outputs agree with native Python inference',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/nba-ml-parity.json',import.meta.url),'utf8'));
  for(const row of fixture.rows)for(const[name,model]of Object.entries(artifact.models))
    assert.ok(Math.abs(scoreNBAArtifact(model,row.x)-row.predictions[name])<(name.startsWith('xgboost')?2e-7:1e-12),name);
  assert.throws(()=>scoreNBAArtifact(artifact.models.ridge_logistic,[NaN]),/Finite/);
});
test('audited public capture and chronological split dates match the fitted artifact',()=>{
  assert.equal(createHash('sha256').update(JSON.stringify(capture.games)).digest('hex'),artifact.games_sha256);
  assert.equal(capture.coverage.schedules_returned,capture.coverage.schedules_expected);
  assert.ok(artifact.validation.train_end<artifact.validation.test_start);
  assert.equal(artifact.validation.n,514);
  assert.equal(artifact.validation.passed,false);
  assert.ok(artifact.validation.brier_skill>.01);
  assert.ok(artifact.validation.improvement_95_lower<0);
});
test('challenger remains opt-in and fails closed on changed training data or a stale source capture',()=>{
  const fit=fitNBAChallenger(capture.games,{now});
  assert.equal(fit.available,true);assert.equal(fit.promoted,false);
  assert.equal(fitNBAChallenger([...capture.games].reverse(),{now}).available,true);
  const estimate=fit.predict(game('future',new Date(now+7*86400000).toISOString(),'8','20'));
  assert.ok(estimate.home>0&&estimate.home<1);assert.ok(Math.abs(estimate.home+estimate.away-1)<1e-12);
  assert.ok(estimate.interval[0]<=estimate.home&&estimate.interval[1]>=estimate.home);
  assert.equal(estimate.experimental,true);assert.ok(estimate.calibration_residuals>=30);
  assert.equal(fit.predict(game('past',new Date(now-1).toISOString(),'8','20')),null);
  assert.equal(fit.predict(game('new',new Date(now+1).toISOString(),'missing','20')),null);
  const changed=structuredClone(capture.games);changed[0].home_score++;
  assert.equal(fitNBAChallenger(changed,{now}).available,false);
  assert.equal(fitNBAChallenger(capture.games,{now:now+31*86400000}).available,false);
});
test('uncertainty comes from actual dated residuals and invalid residual arrays are rejected',()=>{
  const result=residualSensitivity(.5,artifact.residuals,.03);
  assert.ok(result.n>=30);assert.ok(result.weekly_blocks>1);assert.ok(result.interval[0]<=.47&&result.interval[1]>=.53);
  assert.match(result.scope,/not a guaranteed/);
  assert.throws(()=>residualSensitivity(.5,[{p:.5,y:1,error:0,played_at:'2026-01-01'}]),/auditable/);
  for(const p of [.001,.2,.5,.8,.999])assert.ok(Math.abs(betaCalibrate(p,[1,1,0])-p)<1e-12);
});
