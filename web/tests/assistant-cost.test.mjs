import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantChargeUnits,assistantResponse,reserveAssistant} from '../lib/workspace/assistant.mjs';
test('assistant token settlement is conservatively rounded and unknown usage retains the reservation',()=>{
  assert.equal(assistantChargeUnits({inputTokens:1000,outputTokens:1000,totalTokens:2500}),1);
  assert.equal(assistantChargeUnits({inputTokens:0,outputTokens:0,totalTokens:0}),0);
  assert.equal(assistantChargeUnits({inputTokens:500000,outputTokens:500000,totalTokens:1000000}),25);
  assert.equal(assistantChargeUnits({inputTokens:undefined,outputTokens:10}),null);
  assert.equal(assistantChargeUnits({inputTokens:-1,outputTokens:10}),null);
});
test('Postgres-backed assistant reservation uses its atomic budget interface',async()=>{
  let args;const result=await reserveAssistant('a'.repeat(64),{monthlyDollars:3,storage:{reserveAssistantBudget:async(...values)=>{args=values;return {reservation_id:'reservation-fixture'};}}});
  assert.equal(result.reservation_id,'reservation-fixture');assert.equal(args[1].monthlyUnits,3000);assert.equal(args[1].reservedUnits,25);
});
test('assistant settles only a completed metered stream and preserves the chosen research mode',async t=>{
  const previous={backend:process.env.MARKET_BACKEND_URL,secret:process.env.ASSISTANT_SERVICE_SECRET};
  process.env.MARKET_BACKEND_URL='https://backend.example';process.env.ASSISTANT_SERVICE_SECRET='fixture-service-secret-which-is-not-a-real-key';
  t.after(()=>{for(const [name,value] of [['MARKET_BACKEND_URL',previous.backend],['ASSISTANT_SERVICE_SECRET',previous.secret]])if(value===undefined)delete process.env[name];else process.env[name]=value;});
  const calls=[];let mode;
  const request=()=>new Request('https://predictir.dev/api/assistant',{method:'POST',headers:{Origin:'https://predictir.dev','Content-Type':'application/json'},body:JSON.stringify({ticker:'TEST-TICKER',model:'challenger',messages:[{role:'user',content:'Explain.'}]})});
  const dependencies={createClient:async(ticker,value)=>{mode=value;return {listTools:async()=>({tools:[]}),close:async()=>{}};},
    fetcher:async(url,options)=>{calls.push({path:url.pathname,body:JSON.parse(options.body)});return {reservation_id:'fixture-reservation'};},
    generate:()=>({fullStream:(async function*(){yield {type:'text-delta',text:'Experimental explanation.'};yield {type:'finish',totalUsage:{inputTokens:1000,outputTokens:1000,totalTokens:2000}};})()})};
  assert.match(await(await assistantResponse(request(),dependencies)).text(),/Experimental/);assert.equal(mode,'challenger');assert.equal(calls.length,2);
  assert.equal(calls[1].path,'/internal/assistant/settle');assert.equal(calls[1].body.billed_milliusd,1);
  calls.length=0;
  await(await assistantResponse(request(),{...dependencies,generate:()=>({fullStream:(async function*(){yield {type:'error',error:new Error('private provider fixture')};})()})})).text();
  assert.equal(calls.length,1);
});
