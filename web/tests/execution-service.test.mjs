import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {workspaceExecutionResearch,parseExecutionRequest,executionToolPacket} from '../lib/workspace/execution-service.mjs';
import {createResearchServer,boundPacket} from '../lib/workspace/mcp.mjs';
import {parseAssistantInput,assistantResponse,explainExecutionMath} from '../lib/workspace/assistant.mjs';
import {POST} from '../app/api/[...path]/route.js';

const now=Date.parse('2026-11-05T03:00:00Z'),ticker='LAB-FIXTURE',iso=new Date(now).toISOString();
function fixtures(){
  return {now:()=>now,book:async()=>({ticker,as_of:iso,source_url:'https://example.org/public-book',raw:{orderbook_fp:{yes_dollars:[['.4','100']],no_dollars:[['.58','100']]}}}),marketFees:async()=>({coefficient:.07}),
    workspaceResearch:async(t,options)=>{assert.equal(t,ticker);assert.equal(options.fast,true);return {ticker,market:{ticker,title:'Fixture outcome',category:'culture'},forecast:{probability:.7,interval:[.6,.8],source_as_of:iso,eligible:true,evidence:{tier:2},validation:{passed:true}},sources:[]};},feed:{observations:t=>{assert.equal(t,ticker);return [];}}};
}

test('execution request validation is shared with assistant controls and rejects unknown inputs without coercion',()=>{
  const parsed=parseExecutionRequest({ticker,model:'validated',controls:{side:'no',steps:60}});assert.equal(parsed.model,'baseline');assert.equal(parsed.controls.side,'no');
  assert.throws(()=>parseExecutionRequest({ticker,controls:{risk_aversion:'1'}}),RangeError);
  assert.throws(()=>parseExecutionRequest({ticker,controls:{hidden_probability:.9}}),RangeError);
  assert.throws(()=>parseExecutionRequest({ticker,book_history:[]}),RangeError);
  const assistant=parseAssistantInput({ticker,messages:[{role:'user',content:'Explain the execution lab.'}],execution_controls:{contracts:33,order_flow:false}});
  assert.equal(assistant.executionControls.contracts,33);assert.equal(assistant.executionControls.order_flow,false);
  assert.throws(()=>parseAssistantInput({ticker,messages:[{role:'user',content:'test'}],execution_controls:{steps:1000000}}),RangeError);
});

test('execution service uses the exact current contract, preserves the independent estimate and withholds missing live features',async()=>{
  const result=await workspaceExecutionResearch(ticker,{controls:{inventory:10,steps:60}},fixtures());
  assert.equal(result.forecast.probability,.7);assert.equal(result.independent_forecast_unchanged,true);assert.equal(result.account_balances_available,false);
  assert.equal(result.live_history.status,'collecting');assert.equal(result.order_flow.applied,false);assert.equal(result.arrival_model.applied,false);
  assert.equal(result.immediate_execution.slippage_cents,2);assert.equal(result.immediate_execution.side,'yes');assert.equal(result.paper_only,true);
  assert.notEqual(result.inventory_quotes.reservation_price,result.market_state.mid);
  const packet=boundPacket(executionToolPacket(result));assert.equal(packet.version,'execution-research-v1');assert.equal(packet.schedule.rows.length,24);assert.equal(packet.schedule.rows_total,60);assert.equal(packet.schedule.benchmark_twap.rows,undefined);assert.ok(Buffer.byteLength(JSON.stringify(packet))<=14000);
  const disabled=await workspaceExecutionResearch(ticker,{controls:{enabled:false,inventory:10}},fixtures());assert.equal(disabled.inventory_quotes.applied,false);assert.equal(disabled.schedule.method,'equal_quantity_TWAP');
  const bad=fixtures();bad.book=async()=>({...await fixtures().book(),ticker:'OTHER'});await assert.rejects(workspaceExecutionResearch(ticker,{},bad),/do not match/);
});

test('stale stream observations cannot drive quote-flow fitting while ordinary cost analysis remains available',async()=>{
  const dependencies=fixtures();dependencies.feed.observations=()=>[{received_at:new Date(now-90001).toISOString(),time_seconds:now/1000,sequence:1,generation:'old',bid_price:.4,ask_price:.42,bid_size:100,ask_size:100}];
  const result=await workspaceExecutionResearch(ticker,{},dependencies);assert.equal(result.live_history.observations,0);assert.equal(result.data_quality.received_events,0);assert.equal(result.immediate_execution.complete,true);
});

test('an unsupported or unavailable fee schedule remains an explicit assumption and withholds a released exit decision',async()=>{
  const dependencies=fixtures();dependencies.marketFees=async()=>({coefficient:null,fee_type:'unsupported'});
  const result=await workspaceExecutionResearch(ticker,{},dependencies);
  assert.equal(result.fee_schedule.status,'assumed_default');assert.equal(result.immediate_execution.fee_coefficient,.07);assert.equal(result.settlement.decision,'REVIEW');assert.match(result.assumptions.fees,/not a verified fee quote/);assert.equal(result.independent_forecast_unchanged,true);
});

test('fresh but unaligned flow cannot change a different REST book; atomic native snapshots use their matching sequence',async()=>{
  const dependencies=fixtures(),row={received_at:iso,time_seconds:now/1000,sequence:1,generation:'current',bid_price:.1,ask_price:.12,bid_size:10,ask_size:12,exchange_sequence:35};
  dependencies.feed.observations=()=>[row];
  const mismatch=await workspaceExecutionResearch(ticker,{},dependencies);assert.equal(mismatch.live_history.status,'unaligned');assert.equal(mismatch.data_quality.received_events,0);assert.equal(mismatch.order_flow.applied,false);
  dependencies.feed.researchSnapshot=()=>({connected:true,observed_until_seconds:now/1000,rows:[row],book:{ticker,sequence:35,as_of:iso,raw:{orderbook_fp:{yes_dollars:[['.1','10']],no_dollars:[['.88','12']]}}}});
  const native=await workspaceExecutionResearch(ticker,{},dependencies);assert.equal(native.live_history.book_source,'aligned_native_stream');assert.equal(native.market_state.bid,.1);assert.equal(native.data_quality.received_events,1);
  dependencies.feed.researchSnapshot=()=>({rows:[row],book:{ticker,sequence:34,as_of:iso,raw:{orderbook_fp:{yes_dollars:[['.1','10']],no_dollars:[['.88','12']]}}}});
  const wrongSequence=await workspaceExecutionResearch(ticker,{},dependencies);assert.equal(wrongSequence.live_history.status,'unaligned');assert.equal(wrongSequence.market_state.bid,.4);
});

test('sixth MCP tool uses trusted lab scope and rejects another ticker without making a market read',async t=>{
  let seen;
  const server=createResearchServer({tickerScope:ticker,executionScope:{contracts:17,inventory_skew:false},dependencies:{workspaceExecutionResearch:async(ticker,options)=>{seen={ticker,...options};return {ticker,version:'execution-research-v1',controls:options.controls,paper_only:true};}}}),client=new Client({name:'execution-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);t.after(()=>Promise.all([client.close(),server.close()]));
  const result=await client.callTool({name:'analyze_execution_lab',arguments:{ticker}});assert.equal(result.isError,undefined);assert.equal(seen.controls.contracts,17);assert.equal(seen.controls.inventory_skew,false);
  seen=null;const blocked=await client.callTool({name:'analyze_execution_lab',arguments:{ticker:'OTHER'}});assert.equal(blocked.isError,true);assert.equal(seen,null);
});

test('execution assistant readback uses current trusted controls and actual tool figures without a generation charge',async t=>{
  const previous={backend:process.env.MARKET_BACKEND_URL,secret:process.env.ASSISTANT_SERVICE_SECRET};process.env.MARKET_BACKEND_URL='http://127.0.0.1:9999';process.env.ASSISTANT_SERVICE_SECRET='nonsecret-execution-fixture-'.repeat(3);
  t.after(()=>{for(const [key,value] of [['MARKET_BACKEND_URL',previous.backend],['ASSISTANT_SERVICE_SECRET',previous.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const current=Date.now(),dependencies=fixtures();dependencies.now=()=>current;dependencies.book=async()=>({...await fixtures().book(),as_of:new Date(current).toISOString()});
  let settlement,closed=false,scope;
  const client={listTools:async()=>({tools:[{name:'analyze_execution_lab',description:'Execution research',inputSchema:{type:'object',properties:{ticker:{type:'string'}},required:['ticker']}}]}),callTool:async()=>({content:[{type:'text',text:JSON.stringify(await workspaceExecutionResearch(ticker,{controls:scope},dependencies))}]}),close:async()=>{closed=true;}};
  const result=await assistantResponse(new Request('https://predictir.dev/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker,execution_controls:{contracts:33,inventory_skew:false},messages:[{role:'user',content:'Explain the execution lab with my selected settings.'}]})}),{
    createClient:async(t,m,c)=>{assert.equal(t,ticker);scope=c;return client;},generate:()=>assert.fail('Deterministic readback must not invoke a language model'),
    fetcher:async(url,options)=>{if(new URL(url).pathname.endsWith('/settle'))settlement=JSON.parse(options.body);return {reservation_id:'fixture-reservation'};}
  });
  assert.equal(result.status,200);assert.equal(result.headers.get('x-research-model'),'deterministic-execution-readback');
  const text=await result.text();assert.match(text,/33 hypothetical YES contracts/);assert.match(text,/independent outcome forecast is unchanged/);assert.equal(scope.inventory_skew,false);assert.equal(settlement.billed_milliusd,0);assert.equal(closed,true);
  assert.match(explainExecutionMath({ticker:'OTHER'},ticker),/unavailable/);
});

test('local execution endpoint bounds and rejects malformed requests before any market work',async t=>{
  const previous=process.env.MARKET_BACKEND_URL;process.env.MARKET_BACKEND_URL='';t.after(()=>{if(previous===undefined)delete process.env.MARKET_BACKEND_URL;else process.env.MARKET_BACKEND_URL=previous;});
  const context={params:Promise.resolve({path:['workspace','execution-research']})};
  const malformed=await POST(new Request('http://localhost/api/workspace/execution-research',{method:'POST',headers:{'Content-Type':'application/json'},body:'PRIVATE_SENTINEL'}),context);
  assert.equal(malformed.status,400);assert.ok(!(await malformed.text()).includes('PRIVATE_SENTINEL'));
  const invalid=await POST(new Request('http://localhost/api/workspace/execution-research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker,controls:{steps:10000000}})}),context);assert.equal(invalid.status,400);
  const oversized=await POST(new Request('http://localhost/api/workspace/execution-research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(8100)})}),context);assert.equal(oversized.status,413);
});
