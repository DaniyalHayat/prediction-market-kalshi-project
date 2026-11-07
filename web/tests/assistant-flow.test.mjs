import assert from 'node:assert/strict';
import test from 'node:test';
import {assistantResponse} from '../lib/workspace/assistant.mjs';
import {boundPacket} from '../lib/workspace/mcp.mjs';
import {assistantContext,assistantPayload} from '../ui/assistant-context.mjs';

test('automatic full analysis compares current model, reporting and exchange inputs across categories',async t=>{
  const saved={MARKET_BACKEND_URL:process.env.MARKET_BACKEND_URL,ASSISTANT_SERVICE_SECRET:process.env.ASSISTANT_SERVICE_SECRET};
  process.env.MARKET_BACKEND_URL='http://127.0.0.1:9876';
  process.env.ASSISTANT_SERVICE_SECRET='fixture-assistant-secret-'.repeat(3);
  t.after(()=>{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const as_of=new Date().toISOString();
  for(const ticker of ['KXNBAGAME-26NOV08LALDEN-LAL','KXEPLGAME-26NOV07LEETOT-TOT','KXTSAW-26NOV08-A2.35','KXHIGHNY-26NOV07-B67.5','KXBTC15M-26NOV072230-30']){
    const calls=[],source='https://www.example.com/'+ticker,launch=assistantContext('analysis',ticker,{detail:'full'});
    const body=assistantPayload(ticker,'validated',[{role:'user',content:launch.question}],launch);
    const request=new Request('https://predictir.dev/api/assistant',{method:'POST',
      headers:{Origin:'https://predictir.dev','Content-Type':'application/json'},body:JSON.stringify(body)});
    const response=await assistantResponse(request,{
      createClient:async()=>({close:async()=>{},callTool:async({name,arguments:args})=>{
        calls.push(name);assert.equal(args.ticker,ticker);
        const value=name==='get_contract'?{ticker,book:{as_of},quotes:{yes_ask_usd:.42,no_ask_usd:.60}}:
          {ticker,title:'Selected outcome '+ticker,as_of,opinion:{side:'PASS',reason:'Release validation remains incomplete.'},
            forecast:{probability:.6,interval:[.5,.7],source_as_of:as_of,model_name:'Research model'},
            evidence:[{title:'Dated source '+ticker,url:source,excerpt:'Fresh public observation',published_at:as_of,why_relevant:'Matches this settlement window.'}]};
        return {content:[{type:'text',text:JSON.stringify(value)}]};
      }}),
      generate:()=>{throw new Error('The automatic report uses verified tool output');},
      fetcher:()=>{throw new Error('The automatic report does not require a paid text call');},
    });
    const answer=await response.text();
    assert.equal(response.status,200);
    assert.match(answer,/current YES midpoint is 41.0%/);
    assert.match(answer,/independent model estimates 60.0% YES, 19.0 percentage points above/);
    assert.ok(answer.includes('Dated source '+ticker));
    assert.match(answer,/Matches this settlement window/);
    assert.deepEqual(calls,['get_research','get_contract']);
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
