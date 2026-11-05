import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisibleRefresh,displayedOpinion,researchScreenOpinion,screenFreshness,screenRefreshDelay} from '../ui/screen-freshness.mjs';
const now=Date.parse('2026-11-04T20:00:00Z'),iso=offset=>new Date(now+offset).toISOString();
const opinion={ticker:'KXNBA-TEST',side:'YES',probability:.6,interval:[.5,.7],as_of:iso(-1000),source_as_of:iso(-5000)};
test('a fresh response cannot refresh an expired live forecast or executable quote',()=>{
  assert.equal(screenFreshness(opinion,{now}).current,true);
  assert.equal(screenFreshness({...opinion,inplay:true,max_source_age_seconds:30,source_as_of:iso(-31000),as_of:iso(0)},{now}).current,false);
  assert.equal(screenFreshness({...opinion,quote_as_of:iso(-91000),as_of:iso(0)},{now}).current,false);
  assert.equal(screenFreshness({...opinion,close_time:iso(-1)},{now}).current,false);
});
test('missing or future source timestamps and refresh failures withhold the former verdict',()=>{
  for(const row of [{...opinion,source_as_of:null},{...opinion,source_as_of:iso(6000)},{...opinion,quote_as_of:iso(6000)},{...opinion,refresh_error:true}]){
    const value=displayedOpinion(row,now);assert.equal(value.side,'STALE');assert.equal(value.probability,null);assert.equal(value.supported_allocation,0);
  }
  assert.equal(screenFreshness(opinion,{now,error:'Request failed'}).current,false);
  assert.equal(displayedOpinion(opinion,now),opinion);
});
test('pregame and mixed live screens use bounded refresh cadence independently of visibility changes',()=>{
  assert.equal(screenRefreshDelay(opinion),60000);
  assert.equal(screenRefreshDelay({...opinion,inplay:true}),20000);
  assert.equal(screenRefreshDelay({candidates:[opinion],watchlist:[{max_source_age_seconds:30}]}),20000);
  assert.equal(screenRefreshDelay({candidates:[opinion],watchlist:[]}),60000);
  const pass={ticker:'UNMAPPED',side:'PASS',probability:null,as_of:iso(0)};assert.equal(screenFreshness(pass,{now}).current,true);
  assert.equal(displayedOpinion(pass,now+91000).side,'STALE');
});
test('visible refresh never overlaps, aborts when hidden and resumes once after the aborted run settles',async()=>{
  let visible=false;const signals=[],finishers=[];
  const refresh=createVisibleRefresh(async signal=>{signals.push(signal);await new Promise(resolve=>finishers.push(resolve));},{visible:()=>visible});
  await refresh.refresh();assert.equal(signals.length,0);
  visible=true;const first=refresh.refresh();await refresh.refresh();assert.equal(signals.length,1);
  visible=false;refresh.visibilityChanged();assert.equal(signals[0].aborted,true);
  visible=true;refresh.visibilityChanged();refresh.visibilityChanged();assert.equal(signals.length,1);
  finishers[0]();await first;await Promise.resolve();assert.equal(signals.length,2);
  refresh.stop();assert.equal(signals[1].aborted,true);finishers[1]();await Promise.resolve();
  await refresh.refresh(true);assert.equal(signals.length,2);
});
test('a failed refresh releases its running guard and reports the error',async()=>{
  let calls=0;const errors=[],refresh=createVisibleRefresh(async()=>{calls++;throw new Error('source unavailable');},{visible:()=>true,onError:error=>errors.push(error.message)});
  await refresh.refresh();await refresh.refresh();assert.equal(calls,2);assert.deepEqual(errors,['source unavailable','source unavailable']);refresh.stop();
});
test('the selected-contract wrapper cannot bypass source, quote or failed-refresh expiry',()=>{
  const value={opinion:{side:'YES',reason:'Previous candidate'},as_of:iso(0),forecast:{probability:.7,interval:[.5,.8],source_as_of:iso(-1000),inplay:true,max_source_age_seconds:30},market:{close_time:iso(60000)}};
  assert.equal(researchScreenOpinion(value,now).side,'YES');
  const oldSource=researchScreenOpinion({...value,forecast:{...value.forecast,source_as_of:iso(-31000)}},now);assert.equal(oldSource.side,'STALE');assert.equal(oldSource.probability,null);assert.equal(oldSource.interval,null);
  assert.equal(researchScreenOpinion({...value,sources:[{kind:'order_book',retrieved_at:iso(-91000)}]},now).side,'STALE');
  assert.equal(researchScreenOpinion({...value,error:'Refresh failed'},now).side,'STALE');
  assert.equal(researchScreenOpinion({...value,forecast:{...value.forecast,max_source_age_seconds:10,source_as_of:iso(-11000)}},now).side,'STALE');
});
