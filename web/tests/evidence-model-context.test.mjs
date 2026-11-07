import assert from 'node:assert/strict';
import test from 'node:test';
import {evidenceModelContext} from '../lib/workspace/evidence-model-context.mjs';
import {workspaceEvidence} from '../lib/workspace/router.mjs';

test('news context binds reports to the selected model without inventing a numeric probability change',()=>{
  const evidence={ticker:'SELECTED',as_of:'2026-11-07T12:00:00Z',items:[{title:'The selected outcome update',url:'https://example.org/update',publisher:'Primary publisher',match_scope:'matched',as_of:'2026-11-07T11:00:00Z',impact:'An input may need a refresh.'}],related_items:[{title:'Related report',url:'https://example.org/context',match_scope:'related'}]};
  const context=evidenceModelContext(evidence,{forecast:{probability:.61,interval:[.52,.69],model_name:'Independent model',source_as_of:'2026-11-07T10:00:00Z'}});
  assert.equal(context.current_probability,.61);
  assert.equal(context.baseline_probability,.61);
  assert.equal(context.probability_adjustment,null);
  assert.equal(context.matched_reports,1);assert.equal(context.related_reports,1);
  assert.equal(context.update_role,'assumption_review');
  assert.equal(context.updates[0].published_at,'2026-11-07T11:00:00Z');
  const missing=evidenceModelContext({ticker:'OTHER',items:[],related_items:[]},null);
  assert.equal(missing.current_probability,null);assert.equal(missing.status,'coverage_gap');
});

test('verified structured feedback carries the actual probability and decision-range change',()=>{
  const context=evidenceModelContext({ticker:'SELECTED',items:[]},{forecast:{
    probability:.56,interval:[.42,.70],model_name:'Team model',availability_feedback:{
      status:'available',baseline_probability:.60,decision_interval:[.42,.70]
    }
  }});
  assert.equal(context.update_role,'verified_model_input');
  assert.ok(Math.abs(context.probability_adjustment+.04)<1e-12);
  assert.deepEqual(context.decision_interval,[.42,.70]);
});

test('cold evidence retrieval requests model context for non-NBA products and reuses the same contract packet',async()=>{
  const ticker='KXEPLGAME-26NOV07AB-ABC',market={ticker,title:'A wins'},packet={market};
  let forecasts=0;
  const value=await workspaceEvidence(ticker,{retain:false},{
    marketDetails:async()=>packet,request:async()=>({data:{series:{}}}),
    contractEvidence:async()=>({ticker,items:[{title:'Fixture lineup report',url:'https://example.org/lineup'}],related_items:[]}),
    workspaceResearch:async(t,options)=>{
      forecasts++;assert.equal(t,ticker);assert.equal(options.marketPacket,packet);assert.equal(options.refreshAvailability,false);
      return {forecast:{probability:.54,model_name:'Dated goal model'}};
    }
  });
  assert.equal(forecasts,1);assert.equal(value.model_context.current_probability,.54);
});
