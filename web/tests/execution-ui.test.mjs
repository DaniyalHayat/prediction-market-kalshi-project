import test from 'node:test';
import assert from 'node:assert/strict';
import {EXECUTION_DEFAULTS,EXECUTION_FEATURES,executionControls,executionFingerprint,requestExecution} from '../ui/execution-state.mjs';
import {CONTRACT_TABS,moveContractTab} from '../ui/contract-tabs.mjs';

test('execution requests preserve every selected model toggle and numeric assumption without sending unrelated client data',async()=>{
  const controls={...EXECUTION_DEFAULTS,side:'no',action:'sell',contracts:'31',horizon_seconds:'600',risk_aversion:'0',inventory:'-10',order_flow:false,arrival_clustering:false,private_balance:999999};
  const controller=new AbortController();let request;
  const result=await requestExecution('KXTEST-NO',controls,{signal:controller.signal,model:'challenger',transport:async(path,options)=>{request={path,...options};return {ticker:'KXTEST-NO',schedule:{expected_cost:0}};}});
  assert.equal(result.schedule.expected_cost,0);assert.equal(request.path,'/api/workspace/execution-research');assert.equal(request.method,'POST');assert.equal(request.signal,controller.signal);
  const body=JSON.parse(request.body);assert.equal(body.ticker,'KXTEST-NO');assert.equal(body.model,'challenger');assert.equal(body.controls.side,'no');assert.equal(body.controls.action,'sell');assert.equal(body.controls.contracts,31);assert.equal(body.controls.risk_aversion,0);assert.equal(body.controls.inventory,-10);
  assert.equal(body.controls.order_flow,false);assert.equal(body.controls.arrival_clustering,false);assert.equal(body.controls.private_balance,undefined);
  for(const feature of EXECUTION_FEATURES)assert.equal(typeof body.controls[feature.key],'boolean');
});

test('an execution response from another contract is rejected and incomplete controls never become zero assumptions',async()=>{
  await assert.rejects(requestExecution('KX-A',EXECUTION_DEFAULTS,{transport:async()=>({ticker:'KX-B'})}),/different contract/);
  assert.throws(()=>executionControls({...EXECUTION_DEFAULTS,volatility:''}),/Complete every/);
  assert.throws(()=>executionControls({...EXECUTION_DEFAULTS,temporary_impact:'Infinity'}),/finite/);
  assert.throws(()=>executionControls({...EXECUTION_DEFAULTS,risk_aversion:false}),/finite/);
  assert.throws(()=>executionControls({...EXECUTION_DEFAULTS,order_flow:'false'}),/valid model/);
  assert.throws(()=>executionControls({...EXECUTION_DEFAULTS,side:'YES<script>'}),/valid side/);
});

test('every meaningful execution edit invalidates the prior scenario fingerprint',()=>{
  const before=executionFingerprint(EXECUTION_DEFAULTS);
  for(const feature of EXECUTION_FEATURES)assert.notEqual(executionFingerprint({...EXECUTION_DEFAULTS,[feature.key]:false}),before);
  for(const [key,value] of Object.entries({enabled:false,side:'no',action:'sell',contracts:21,horizon_seconds:600,steps:10,risk_aversion:.01,temporary_impact:.001,volatility:.03,inventory:1}))assert.notEqual(executionFingerprint({...EXECUTION_DEFAULTS,[key]:value}),before);
  assert.equal(executionFingerprint({...EXECUTION_DEFAULTS,contracts:'20'}),before);
});

test('all five contract tabs remain reachable by keyboard in both directions, including wraparound',()=>{
  assert.equal(CONTRACT_TABS.length,5);const ids=CONTRACT_TABS.map(([id])=>id);assert.ok(ids.includes('execution'));
  let selected=ids[0];const forward=[];for(let i=0;i<ids.length;i++){forward.push(selected);selected=moveContractTab(selected,'ArrowRight');}assert.deepEqual(forward,ids);assert.equal(selected,ids[0]);
  const backward=[];for(let i=0;i<ids.length;i++){selected=moveContractTab(selected,'ArrowLeft');backward.push(selected);}assert.deepEqual(backward,[...ids].reverse());
  assert.equal(moveContractTab('execution','Home'),ids[0]);assert.equal(moveContractTab('execution','End'),ids.at(-1));assert.equal(moveContractTab('execution','Enter'),null);
});
