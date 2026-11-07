import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {DAY,isoDay,monthNumber} from '../lib/intelligence/time.mjs';

const require=createRequire(import.meta.url);
const {webpack}=require('next/dist/compiled/webpack/webpack');
const root=fileURLToPath(new URL('../',import.meta.url));

test('research date helpers preserve UTC day and month-boundary behavior',()=>{
  assert.equal(DAY,86400000);
  assert.equal(isoDay('2026-11-07T23:30:00-05:00'),'2026-11-08');
  assert.equal(monthNumber('2027-01-01')-monthNumber('2026-12-01'),1);
});

test('quantitative scenario client graph builds for browsers without server source adapters',async()=>{
  const output=await mkdtemp(path.join(tmpdir(),'predictir-quant-browser-'));
  try{
    const stats=await new Promise((resolve,reject)=>{
      const compiler=webpack({
        mode:'production',target:['web','es2022'],context:root,
        entry:'./lib/workspace/quant-context.mjs',devtool:false,
        optimization:{minimize:false},
        output:{path:output,filename:'quant.cjs',library:{type:'commonjs2'}}
      });
      compiler.run((error,result)=>compiler.close(closeError=>error||closeError?reject(error||closeError):resolve(result)));
    });
    assert.equal(stats.hasErrors(),false,stats.toString({all:false,errors:true}));
    const moduleNames=stats.toJson({all:false,modules:true}).modules.map(module=>module.name).join('\n');
    assert.doesNotMatch(moduleNames,/intelligence[\\/]sources|node:crypto|parse5/);
    const module={exports:{}};
    vm.runInNewContext(await readFile(path.join(output,'quant.cjs'),'utf8'),{module,exports:module.exports});
    const result=module.exports.simulateScoreDiffusion({margin:5,remaining_seconds:60,drift_points_per_minute:0,volatility_points_per_sqrt_minute:2,simulations:100,seed:1});
    assert.equal(result.parameters.simulations,100);
    assert.ok(result.scenario_home_lead_probability>result.scenario_away_lead_probability);
  }finally{
    await rm(output,{recursive:true,force:true});
  }
});
