import assert from 'node:assert/strict';
import test from 'node:test';
import {azureResearchAnswer,azureToolArguments} from '../lib/workspace/azure-research.mjs';
import {boundPacket} from '../lib/workspace/mcp.mjs';

test('automatic analysis includes current reporting and compares model and exchange figures across categories',async()=>{
  const now=Date.now(),as_of=new Date(now).toISOString();
  for(const ticker of ['KXNBAGAME-26NOV08LALDEN-LAL','KXEPLGAME-26NOV07LEETOT-TOT','KXTSAW-26NOV08-A2.35','KXHIGHNY-26NOV07-B67.5','KXBTC15M-26NOV072230-30']){
    assert.deepEqual(azureToolArguments('get_research',ticker,'Explain the research view','analysis'),{ticker,include_reporting:true});
    const packets=new Map([
      ['get_contract',{ticker,market:{ticker},book:{as_of},quotes:{yes_ask_usd:.42,no_ask_usd:.60}}],
      ['get_research',{ticker,title:'Selected outcome',as_of,forecast:{probability:.6,interval:[.5,.7],source_as_of:as_of},
        opinion:{side:'PASS',reason:'The estimated range has not cleared the release check.'},evidence:[{
          title:'Dated source for '+ticker,url:'https://www.example.com/'+ticker,excerpt:'Current source observation '+ticker,
          published_at:as_of,match_scope:'matched',why_relevant:'Matches the selected observation window.'}]}],
    ]);
    const {answer}=await azureResearchAnswer({question:'Explain the research view',ticker,panel:'analysis',detail:'full',
      tools:['get_contract','get_research'],packets,explain:{math:()=>''},now});
    assert.match(answer,/observed YES midpoint is 41.0%/);
    assert.match(answer,/independent model estimates 60.0% YES, 19.0 percentage points above/);
    assert.ok(answer.includes('Dated source for '+ticker));
    assert.ok(answer.includes('Current source observation '+ticker));
    assert.match(answer,/Matches the selected observation window/);
    assert.match(answer,/Research screen: PASS/);
  }
});

test('large diagnostics preserve current probability and dated reporting inside MCP bounds',()=>{
  const ticker='KXTEST-ALPHA',as_of=new Date().toISOString();
  const value=boundPacket({ticker,title:'Selected contract',as_of,summary:'Research result',
    forecast:{probability:.61,interval:[.5,.72],source_as_of:as_of,model_name:'Research model',inputs:{diagnostics:'x'.repeat(40000)}},
    evidence:[{title:'Matched source',url:'https://example.com/source',published_at:as_of,excerpt:'Observed fact'}],
    sources:[{label:'Matched source',url:'https://example.com/source'}]});
  assert.ok(Buffer.byteLength(JSON.stringify(value))<=14000);
  assert.equal(value.forecast.probability,.61);
  assert.equal(value.evidence[0].title,'Matched source');
  assert.equal(value.forecast.inputs,undefined);
});
