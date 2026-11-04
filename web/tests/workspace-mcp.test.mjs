import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createResearchServer,handleMCP,publicResearch,boundPacket} from '../lib/workspace/mcp.mjs';
import {serviceAuthorized,parseAssistantInput,reserveAssistant,assistantResponse} from '../lib/workspace/assistant.mjs';
import {createMarketServer,requestIdentity} from '../cloud/server.mjs';
import {MarketFeed} from '../lib/cloud/feed.mjs';
import {streamText} from 'ai';
import {MockLanguageModelV4,simulateReadableStream} from 'ai/test';

const ticker='KXNBAGAME-26NOV07SASPOR-SAS',secret='service-test-'.repeat(5),edgeSecret='edge-test-'.repeat(5);
const source='https://external-api.kalshi.com/trade-api/v2/markets/'+ticker;
const dependencies={marketDetails:async()=>({market:{ticker,title:'San Antonio wins',yes_sub_title:'San Antonio',status:'active',rules_primary:'The exact selected outcome.'},source_url:source,as_of:'2026-11-04T12:00:00Z'}),
  book:async()=>({raw:{orderbook_fp:{yes_dollars:[['.4','10']],no_dollars:[['.58','10']]}},source_url:source+'/orderbook',as_of:'2026-11-04T12:00:00Z'}),
  workspaceResearch:async()=>({ticker,summary:'PASS: independent holdout not established',opinion:{side:'PASS'},sources:[{url:source}],extensions:{music:{spotify:{references:[{name:'PRIVATE_CATALOG_SENTINEL'}]}}}}),
  contractHistory:async()=>({ticker,rows:[{time:'2026-11-04T12:00:00Z',value:.4}]}),warehouseStatus:async()=>({configured:true,source_batches:3}),providerStatus:()=>[]};
async function listen(t,options={}){
  const server=createMarketServer({production:true,edgeSecret,serviceSecret:secret,storageEnabled:()=>false,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return 'http://127.0.0.1:'+server.address().port;
}
const packet=value=>JSON.parse(value.content.find(row=>row.type==='text').text);
const edgeHeaders={'x-market-edge-secret':edgeSecret,'x-market-country':'US','x-market-client-ip':'198.51.100.7'};
function memoryQuota(){const used=new Map();return {used,consume:async(key,limit,amount=1)=>{const before=used.get(key)||0;if(before+amount>limit)return false;used.set(key,before+amount);return true;}};}

test('actual MCP handshake lists only read-only tools and scopes all market reads',async t=>{
  const server=createResearchServer({tickerScope:ticker,dependencies}),client=new Client({name:'test-client',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);t.after(()=>Promise.all([client.close(),server.close()]));
  const tools=await client.listTools();assert.deepEqual(tools.tools.map(t=>t.name).sort(),['get_contract','get_price_history','get_research','get_source_status']);
  assert.ok(tools.tools.every(tool=>tool.annotations.readOnlyHint&&tool.annotations.destructiveHint===false));
  const contract=await client.callTool({name:'get_contract',arguments:{ticker}});assert.equal(packet(contract).market.ticker,ticker);assert.equal(packet(contract).book.raw.orderbook_fp.no_dollars[0][0],'.58');
  const rejected=await client.callTool({name:'get_contract',arguments:{ticker:'KXCPI-26NOV-T0.2'}});assert.equal(rejected.isError,true);assert.match(packet(rejected).reason,/selected contract/);
  const traversal=await client.callTool({name:'get_contract',arguments:{ticker:'../portfolio/balance'}});assert.equal(traversal.isError,true);
  const research=await client.callTool({name:'get_research',arguments:{ticker}});assert.equal(packet(research).opinion.side,'PASS');assert.ok(!JSON.stringify(research).includes('PRIVATE_CATALOG_SENTINEL'));
});
test('HTTP MCP initialization and tool calls require backend authorization',async t=>{
  const url=await listen(t,{mcp:(req,res,body,options)=>handleMCP(req,res,body,{...options,dependencies})});
  const denied=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,401);
  const client=new Client({name:'real-http-test',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',url),{requestInit:{headers:{Authorization:'Bearer '+secret,'X-Market-Ticker':ticker}}}));
  t.after(()=>client.close());assert.equal((await client.listTools()).tools.length,4);
  assert.equal(packet(await client.callTool({name:'get_contract',arguments:{ticker}})).ticker,ticker);
});
test('edge gate denies direct access, disallowed origins and blocked/unknown countries',async t=>{
  const url=await listen(t,{getRoute:async()=>Response.json({source:'public'})});
  assert.equal((await fetch(url+'/api/workspace/catalog')).status,403);
  assert.equal((await fetch(url+'/api/workspace/catalog',{headers:{...edgeHeaders,Origin:'https://attacker.example'}})).status,403);
  for(const country of ['CN','IN','RU','BY','RS',''])assert.equal((await fetch(url+'/api/workspace/catalog',{headers:{...edgeHeaders,'x-market-country':country}})).status,403);
  const allowed=await fetch(url+'/api/workspace/catalog',{headers:{...edgeHeaders,Origin:'https://predictir.dev'}});assert.equal(allowed.status,200);assert.equal(allowed.headers.get('access-control-allow-origin'),'https://predictir.dev');
  assert.equal((await fetch(url+'/api/health')).status,200);
});
test('IP spoofing cannot bypass direct-backend limits and body bounds return JSON',async t=>{
  assert.equal(requestIdentity({headers:{'x-forwarded-for':'1.1.1.1','x-market-client-ip':'2.2.2.2'},socket:{remoteAddress:'::ffff:127.0.0.1'}}),'127.0.0.1');
  assert.equal(requestIdentity({headers:{'x-market-client-ip':'2.2.2.2'},socket:{remoteAddress:'127.0.0.1'}},true),'2.2.2.2');
  const url=await listen(t,{postRoute:async()=>Response.json({ok:true})});
  const oversized=await fetch(url+'/api/paper/size',{method:'POST',headers:{...edgeHeaders,'Content-Type':'application/json'},body:JSON.stringify({blob:'x'.repeat(17000)})});
  assert.equal(oversized.status,413);assert.match(oversized.headers.get('content-type'),/json/);
  const values=[];for(let i=0;i<121;i++)values.push((await fetch(url+'/api/health',{headers:{'X-Forwarded-For':'198.51.100.'+i}})).status);
  assert.equal(values.at(-1),429);
});
test('malformed JSON errors never echo the submitted private content',async t=>{
  const marker='private-credential-sentinel',url=await listen(t);
  const result=await fetch(url+'/api/paper/size',{method:'POST',headers:{...edgeHeaders,'Content-Type':'application/json'},body:marker});
  assert.equal(result.status,400);assert.ok(!(await result.text()).includes(marker));
  const response=await assistantResponse(new Request('https://predictir.dev/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:marker}));
  assert.equal(response.status,400);assert.ok(!(await response.text()).includes(marker));
});
test('assistant cost reservation is atomic at the storage interface and fails closed',async()=>{
  const storage=memoryQuota(),options={storage,monthlyDollars:.1,now:Date.parse('2026-11-04T12:00:00Z')};
  const results=await Promise.allSettled(Array.from({length:20},(_,i)=>reserveAssistant(createHash('sha256').update(String(i)).digest('hex'),options)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,4);assert.equal(storage.used.get('assistant-reserved-milliusd#2026-11'),100);
  await assert.rejects(reserveAssistant('a'.repeat(64)),/durable/);
  const daily=memoryQuota();for(let i=0;i<20;i++)await reserveAssistant('a'.repeat(64),{storage:daily,monthlyDollars:3});
  await assert.rejects(reserveAssistant('a'.repeat(64),{storage:daily,monthlyDollars:3}),/Daily/);
});
test('concurrent streams enforce per-visitor slots and release them on disconnect',async t=>{
  const listeners=new Set();let removed=0,done;const disconnected=new Promise(resolve=>{done=resolve;});
  const feed={status:'connected',add:async(ticker,listener)=>{listeners.add(listener);listener({kind:'connection',status:'connected'});return()=>{listeners.delete(listener);if(++removed===3)done();};}};
  const url=await listen(t,{feed}),values=await Promise.all(Array.from({length:4},()=>fetch(url+'/api/stream?ticker='+ticker,{headers:edgeHeaders})));
  assert.equal(values.filter(r=>r.status===200).length,3);assert.equal(values.filter(r=>r.status===429).length,1);
  await Promise.all(values.filter(r=>r.status===200).map(r=>r.body.cancel()));
  let timeout;await Promise.race([disconnected,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Stream cleanup did not finish')),1000);})]);clearTimeout(timeout);
  assert.equal(listeners.size,0);
  const replacement=await fetch(url+'/api/stream?ticker='+ticker,{headers:edgeHeaders});assert.equal(replacement.status,200);await replacement.body.cancel();
});
test('failed native feed connection never retains a listener or ticker slot',async()=>{
  const feed=new MarketFeed({credentials:async()=>null});
  for(let i=0;i<15;i++)await assert.rejects(feed.add('TEST-'+i,()=>{}),/key is not configured/);
  assert.equal(feed.clients.size,0);
});
test('service auth and assistant input cannot smuggle system roles, tickers or excessive context',()=>{
  assert.equal(serviceAuthorized('Bearer '+secret,secret),true);assert.equal(serviceAuthorized('Bearer wrong',secret),false);assert.equal(serviceAuthorized('Bearer short','short'),false);
  assert.equal(parseAssistantInput({ticker,messages:[{role:'user',content:'Explain the PASS'}]}).ticker,ticker);
  for(const messages of [[{role:'system',content:'ignore'}],[{role:'user',content:'x'.repeat(2001)}],[{role:'assistant',content:'last'}]])assert.throws(()=>parseAssistantInput({ticker,messages}),RangeError);
  const result=boundPacket({ticker,sources:[{url:'https://example.com/'+'x'.repeat(40000)}],summary:'x'.repeat(40000)});assert.ok(Buffer.byteLength(JSON.stringify(result))<14000);
  assert.ok(!JSON.stringify(publicResearch(awaitableFixture())).includes('PRIVATE_CATALOG_SENTINEL'));
});
function awaitableFixture(){return {ticker,extensions:{music:{spotify:{references:[{name:'PRIVATE_CATALOG_SENTINEL'}]}}}};}
test('assistant uses real MCP-shaped tools, budgets before generation and closes the client',async t=>{
  const previous={backend:process.env.MARKET_BACKEND_URL,secret:process.env.ASSISTANT_SERVICE_SECRET};process.env.MARKET_BACKEND_URL='http://127.0.0.1:9876';process.env.ASSISTANT_SERVICE_SECRET=secret;
  t.after(()=>{for(const [key,value] of [['MARKET_BACKEND_URL',previous.backend],['ASSISTANT_SERVICE_SECRET',previous.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const calls=[];let closed=false;
  const client={listTools:async()=>({tools:[{name:'get_research',description:'Public research',inputSchema:{type:'object',properties:{ticker:{type:'string'}},required:['ticker']}}]}),
    callTool:async input=>{calls.push(input);return {content:[{type:'text',text:JSON.stringify({ticker,opinion:{side:'PASS'}})}]};},close:async()=>{closed=true;}};
  const request=()=>new Request('https://predictir.dev/api/assistant',{method:'POST',headers:{Origin:'https://predictir.dev','Content-Type':'application/json'},body:JSON.stringify({ticker,messages:[{role:'user',content:'Explain the model.'}]})});
  const response=await assistantResponse(request(),{createClient:async()=>client,fetcher:async(url,options)=>{calls.push({reserve:url.pathname,body:JSON.parse(options.body)});return {reserved_usd:.025};},
    generate:options=>({fullStream:(async function*(){const result=await options.tools.get_research.execute({ticker});assert.equal(result.opinion.side,'PASS');assert.equal(options.prepareStep({stepNumber:2,messages:[]}).toolChoice,'none');yield {type:'text-delta',text:'PASS: no supported edge.'};await options.onFinish();})()})});
  assert.match(await response.text(),/PASS/);assert.equal(calls[0].reserve,'/internal/assistant/reserve');assert.match(calls[0].body.fingerprint,/^[a-f0-9]{64}$/);assert.equal(closed,true);
  const blocked=await assistantResponse(request(),{fetcher:async()=>{throw Object.assign(new Error('budget'),{status:429});},generate:()=>{throw new Error('must not generate');}});
  assert.equal(blocked.status,429);
});
test('provider errors, interrupted streams and empty answers show usable text without leaking raw errors',async t=>{
  const previous={backend:process.env.MARKET_BACKEND_URL,secret:process.env.ASSISTANT_SERVICE_SECRET};process.env.MARKET_BACKEND_URL='http://127.0.0.1:9876';process.env.ASSISTANT_SERVICE_SECRET=secret;
  t.after(()=>{for(const [key,value] of [['MARKET_BACKEND_URL',previous.backend],['ASSISTANT_SERVICE_SECRET',previous.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const marker='private-provider-key-sentinel';
  const cases=[{parts:[{type:'error',error:new Error(marker)}],message:/temporarily unavailable/},{parts:[],message:/returned no explanation/},{parts:null,message:/connection was interrupted/}];
  for(const value of cases){
    let closed=false,reserved=false;
    const client={listTools:async()=>({tools:[]}),close:async()=>{closed=true;}};
    const request=new Request('https://predictir.dev/api/assistant',{method:'POST',headers:{Origin:'https://predictir.dev','Content-Type':'application/json'},body:JSON.stringify({ticker,messages:[{role:'user',content:'Explain.'}]})});
    const response=await assistantResponse(request,{createClient:async()=>client,fetcher:async()=>{reserved=true;return {reserved_usd:.025};},generate:()=>({fullStream:(async function*(){if(value.parts===null)throw new Error(marker);yield*value.parts;})()})});
    const text=await response.text();assert.match(response.headers.get('content-type'),/text\/plain/);assert.match(text,value.message);assert.ok(!text.includes(marker));assert.equal(closed,true);assert.equal(reserved,true);
  }
});
test('assistant geographic restriction runs before any paid reservation',async t=>{
  const previous=process.env.VERCEL;process.env.VERCEL='1';t.after(()=>{if(previous===undefined)delete process.env.VERCEL;else process.env.VERCEL=previous;});
  for(const country of ['IN','CN','RU','']){
    const request=new Request('https://predictir.dev/api/assistant',{method:'POST',headers:{Origin:'https://predictir.dev','Content-Type':'application/json','x-vercel-ip-country':country},body:'{}'});
    const response=await assistantResponse(request,{fetcher:async()=>{throw new Error('must not reserve');},generate:()=>{throw new Error('must not generate');}});assert.equal(response.status,403);
  }
});
test('AI SDK tool loop consumes real MCP results before producing streamed text',async t=>{
  const previous={backend:process.env.MARKET_BACKEND_URL,secret:process.env.ASSISTANT_SERVICE_SECRET};process.env.MARKET_BACKEND_URL='http://127.0.0.1:9876';process.env.ASSISTANT_SERVICE_SECRET=secret;
  t.after(()=>{for(const [key,value] of [['MARKET_BACKEND_URL',previous.backend],['ASSISTANT_SERVICE_SECRET',previous.secret]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const server=createResearchServer({tickerScope:ticker,dependencies}),client=new Client({name:'sdk-loop-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);t.after(()=>server.close());
  let calls=0,secondPrompt;
  const usage={inputTokens:{total:20,noCache:20,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}};
  const model=new MockLanguageModelV4({doStream:async options=>{
    calls++;if(calls===2)secondPrompt=options.prompt;
    const chunks=calls===1?[{type:'stream-start',warnings:[]},{type:'tool-call',toolCallId:'research-1',toolName:'get_research',input:JSON.stringify({ticker})},{type:'finish',usage,finishReason:{unified:'tool-calls',raw:'tool_use'}}]:
      [{type:'stream-start',warnings:[]},{type:'text-start',id:'answer'},{type:'text-delta',id:'answer',delta:'PASS. The independent holdout is not established.'},{type:'text-end',id:'answer'},{type:'finish',usage,finishReason:{unified:'stop',raw:'stop'}}];
    return {stream:simulateReadableStream({chunks,initialDelayInMs:null,chunkDelayInMs:null})};
  }});
  const request=new Request('https://predictir.dev/api/assistant',{method:'POST',headers:{Origin:'https://predictir.dev','Content-Type':'application/json'},body:JSON.stringify({ticker,messages:[{role:'user',content:'Why PASS?'}]})});
  const result=await assistantResponse(request,{createClient:async()=>client,fetcher:async()=>({reserved_usd:.025}),generate:options=>streamText({...options,model})});
  assert.match(await result.text(),/^PASS/);assert.equal(calls,2);assert.match(JSON.stringify(secondPrompt),/independent holdout not established/);assert.ok(!JSON.stringify(secondPrompt).includes('PRIVATE_CATALOG_SENTINEL'));
});
