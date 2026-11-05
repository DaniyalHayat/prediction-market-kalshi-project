import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {reconcileRailway} from '../tools/reconcile_railway.mjs';
const spec=JSON.parse(await readFile(new URL('../infra/railway-service.json',import.meta.url),'utf8'));
function fixture(){
  const actual={serviceId:spec.serviceId,environmentId:spec.environmentId,rootDirectory:spec.rootDirectory,source:{repo:spec.repository},service:{projectId:spec.projectId},watchPatterns:[],restartPolicyMaxRetries:10},mutations=[];
  return {actual,mutations,run:async args=>{if(args[1].startsWith('query'))return {data:{serviceInstance:structuredClone(actual)}};const {input}=JSON.parse(args[3]);mutations.push(input);Object.assign(actual,input);return {data:{serviceInstanceUpdate:true}};}};
}
test('Railway settings preview has no writes and apply changes only the two reviewed fields once',async()=>{
  const f=fixture(),preview=await reconcileRailway({spec,run:f.run});assert.equal(preview.mode,'preview');assert.deepEqual(preview.changes,{watchPatterns:['/web/**'],restartPolicyMaxRetries:3});assert.equal(f.mutations.length,0);
  const applied=await reconcileRailway({spec,run:f.run,apply:true});assert.equal(applied.verified,true);assert.deepEqual(f.mutations,[preview.changes]);
  assert.deepEqual((await reconcileRailway({spec,run:f.run,apply:true})).changes,{});assert.equal(f.mutations.length,1);
});
test('Railway settings refuse a different existing project before writing and verify applied state',async()=>{
  const f=fixture();f.actual.service.projectId='00000000-0000-4000-8000-000000000000';await assert.rejects(reconcileRailway({spec,run:f.run,apply:true}),/does not match/);assert.equal(f.mutations.length,0);
  const g=fixture();await assert.rejects(reconcileRailway({spec,apply:true,run:async args=>args[1].startsWith('query')?g.run(args):{data:{serviceInstanceUpdate:true}}}),/after apply/);
});
