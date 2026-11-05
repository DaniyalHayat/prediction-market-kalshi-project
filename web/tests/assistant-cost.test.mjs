import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantChargeUnits,assistantResponse,reserveAssistant,explainResearchMath} from '../lib/workspace/assistant.mjs';

test('numeric explanations preserve fractional fills, currency units, ranges and source freshness',()=>{
  const now=Date.now(),ticker='TEST-TICKER',packet={ticker,as_of:new Date(now).toISOString(),forecast:{probability:.6,interval:[.4,.8],experimental:true,source_as_of:new Date(now).toISOString(),max_source_age_seconds:30},opinion:{side:'PASS'},
    decision:{candidates:[{side:'yes',execution:{requested_contracts:1,filled_contracts:.5,unfilled_contracts:.5,available_contracts_within_slippage:1234.5,entry_notional_usd:.2,estimated_entry_fee_usd:.01,all_in_entry_usd:.21,all_in_usd_per_filled_contract:.42}}]}};
  const text=explainResearchMath(packet,ticker,now);assert.match(text,/60\.0%.*40\.0% to 80\.0%/);assert.match(text,/0\.5 of 1 requested contracts/);assert.match(text,/all-in cost \$0\.21/);
  assert.match(text,/contract: \$0\.42/);assert.match(text,/1,234\.5 contracts/);assert.ok(!text.includes('$1234'));assert.match(text,/only the filled portion/);assert.match(text,/Supported allocation: 0/);
  assert.match(explainResearchMath(packet,'WRONG',now),/matching research packet/);assert.match(explainResearchMath(packet,ticker,now+31000),/fresh independent probability range is unavailable/);
});

test('the built-in numeric explanation uses MCP and zero language-model calls or token charges',async t=>{
  const previous={backend:process.env.MARKET_BACKEND_URL,secret:process.env.ASSISTANT_SERVICE_SECRET};process.env.MARKET_BACKEND_URL='https://backend.example';process.env.ASSISTANT_SERVICE_SECRET='fixture-service-secret-which-is-not-a-real-key';
  t.after(()=>{for(const [name,value] of [['MARKET_BACKEND_URL',previous.backend],['ASSISTANT_SERVICE_SECRET',previous.secret]])if(value===undefined)delete process.env[name];else process.env[name]=value;});
  const calls=[],ticker='TEST-TICKER';let reads=0,closed=false;
  const packet={ticker,as_of:new Date().toISOString(),forecast:{probability:.6,interval:[.4,.8],source_as_of:new Date().toISOString()},sources:[{url:'https://example.com/public-evidence'}]};
  const response=await assistantResponse(new Request('https://predictir.dev/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker,messages:[{role:'user',content:'Explain the probability range and costs.'}]})}),{
    createClient:async()=>({listTools:async()=>({tools:[{name:'get_research',description:'Read scoped research',inputSchema:{type:'object',properties:{ticker:{type:'string'}},required:['ticker']}}]}),callTool:async()=>{reads++;return {content:[{type:'text',text:JSON.stringify(packet)}]};},close:async()=>{closed=true;}}),
    fetcher:async(url,options)=>{calls.push({path:url.pathname,body:JSON.parse(options.body)});return {reservation_id:'numeric-fixture'};},generate:()=>{throw new Error('A numerical readback must not invoke an LLM');}});
  assert.match(await response.text(),/Model P\(YES\): 60\.0%/);assert.equal(response.headers.get('X-Research-Model'),'deterministic-research-readback');assert.equal(reads,1);assert.equal(closed,true);
  assert.equal(calls[1].path,'/internal/assistant/settle');assert.equal(calls[1].body.billed_milliusd,0);
});
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
