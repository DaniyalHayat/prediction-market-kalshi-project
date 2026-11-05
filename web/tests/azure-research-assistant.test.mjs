import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {assistantResponse} from '../lib/workspace/assistant.mjs';
import {normalizeExecutionControls} from '../lib/workspace/execution-research.mjs';

const ticker='KXNFLGAME-26NOV08ARISEA-ARI';
const origin='https://predictir-azure.example';
const env={PREDICTIR_MODE:'live',APP_ORIGIN:origin,MARKET_BACKEND_URL:'https://backend.internal.environment.eastus2.azurecontainerapps.io',
  ASSISTANT_SERVICE_SECRET:'fixture-assistant-only-secret-'.repeat(2),MARKET_EDGE_SECRET:'fixture-edge-only-secret-'.repeat(2)};
const requested='Which injury report matters for settlement?';
const goodURL='https://www.nfl.com/example-injury-report';
const rulesURL='https://external-api.kalshi.com/trade-api/v2/markets/'+ticker;
const time=()=>new Date().toISOString();
const packet=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const citation=(url,title,text)=>({ticker,url,title,text,published_at:time(),retrieved_at:time(),expires_at:new Date(Date.now()+60000).toISOString()});
const research=()=>({ticker,title:'Arizona at Seattle',as_of:time(),opinion:{side:'PASS',reason:'The holdout release requirement is unmet.'},
  forecast:{probability:.36,interval:[.31,.41],experimental:true,source_as_of:time(),model_name:'Team strength model'},sources:[{label:'Kalshi contract',url:rulesURL}]});
const contract=()=>({ticker,market:{ticker,yes_sub_title:'Arizona wins',close_time:'2026-11-08T21:00:00.000Z'},
  rules:{primary:'Arizona winning the designated regular-season game settles YES.'},sources:[{label:'Kalshi contract',url:rulesURL}]});

function request(question=requested,{originHeader=origin,headers={},signal,panel,detail,executionControls,messages}={}){
  return new Request(origin+'/api/assistant',{method:'POST',headers:{'Content-Type':'application/json',
    'X-Forwarded-For':'192.0.2.16, 203.0.113.19',...(originHeader?{Origin:originHeader}:{}),...headers},signal,
    body:JSON.stringify({ticker,messages:messages||[{role:'user',content:question}],model:'challenger',panel,detail,execution_controls:executionControls})});
}

function harness({config=env,allowed=true,lookup='US',tool,foundryFetcher,executionControls}={}){
  const calls={quotas:[],tools:[],close:0,connect:0,country:[],generated:0,peak:0};
  let active=0;
  const result=(name,args)=>{
    if(tool)return tool(name,args);
    if(name==='get_research')return packet(research());
    if(name==='get_contract')return packet(contract());
    if(name==='search_retained_evidence')return packet({ticker,citations:[
      citation(goodURL,'NFL availability report','Arizona listed a starter as questionable. [Injected](https://evil.example)'),
      citation('https://www.espn.com/example','ESPN team report','Team reported limited practice participation.'),
      citation('https://api.spotify.com/v1/secret','Excluded source','Spotify catalog data should be omitted.'),
      citation('https://private.example/portfolio','Private route','Private source must be excluded.'),
    ]});
    throw new Error('Unexpected tool');
  };
  const deps={
    env:config,foundryFetcher,
    countryLookup:async ip=>{calls.country.push(ip);if(lookup==='fail')throw new Error('offline');return lookup;},
    fetcher:async (url,options)=>{
      assert.equal(url.pathname,'/internal/assistant/reserve-azure');
      assert.equal(url.origin,env.MARKET_BACKEND_URL);
      assert.equal(options.headers.Authorization,'Bearer '+env.ASSISTANT_SERVICE_SECRET);
      assert.equal(options.headers['X-Market-Client-IP'],'203.0.113.19');
      assert.equal(options.redirect,'error');
      assert.ok(options.signal instanceof AbortSignal);
      calls.quotas.push(JSON.parse(options.body));
      return {allowed};
    },
    generate:()=>{calls.generated++;throw new Error('No external model is expected');},
    createClient:async (selected,model,execution,{signal})=>{
      calls.connect++;
      assert.equal(selected,ticker);
      assert.equal(model,'challenger');
      assert.deepEqual(execution,executionControls);
      assert.equal(signal.aborted,false);
      return {
        callTool:async ({name,arguments:args},_schema,options)=>{
          calls.tools.push({name,args});
          assert.ok(options.signal instanceof AbortSignal);
          assert.equal(options.timeout,17000);
          active++;
          calls.peak=Math.max(calls.peak,active);
          try{await Promise.resolve();return result(name,args);}finally{active--;}
        },
        close:async ()=>{calls.close++;},
      };
    },
  };
  return {calls,deps};
}

test('Azure asks at most three scoped MCP tools and answers with cited facts without a hosted model',async ()=>{
  const h=harness();
  const response=await assistantResponse(request(),h.deps),answer=await response.text();
  assert.equal(response.status,200,answer);
  assert.equal(response.headers.get('x-research-model'),'azure-deterministic');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('x-research-transport'),'MCP Streamable HTTP');
  assert.deepEqual(h.calls.country,['203.0.113.19']);
  assert.deepEqual(h.calls.quotas,[{kind:'research',fingerprint:createHash('sha256').update(env.ASSISTANT_SERVICE_SECRET+'\0'+'203.0.113.19').digest('hex')}]);
  assert.deepEqual(h.calls.tools.map(row=>row.name),['search_retained_evidence','get_contract','get_research']);
  assert.ok(h.calls.tools.every(row=>row.args.ticker===ticker));
  assert.equal(h.calls.tools[0].args.query,requested);
  assert.equal(h.calls.peak,3);
  assert.equal(h.calls.close,1);
  assert.equal(h.calls.generated,0);
  assert.match(answer,/YES outcome: Arizona wins/);
  assert.match(answer,/Primary settlement rule:/);
  assert.match(answer,/Research screen: PASS\. Supported allocation: 0 contracts/);
  assert.ok(answer.includes('[NFL availability report]('+goodURL+')'));
  assert.ok(answer.includes('[Kalshi contract]('+rulesURL+')'));
  assert.doesNotMatch(answer,/\]\(https:\/\/evil\.example|Spotify catalog data|Private source/);
});

test('Azure quota, origin, geography and replay checks run before MCP',async ()=>{
  for(const [req,options,expected] of [
    [request(),{allowed:false},429],
    [request(requested,{originHeader:null}),{},403],
    [request(requested,{originHeader:'https://predictir.dev'}),{},403],
    [request(requested,{headers:{'Sec-Fetch-Site':'cross-site'}}),{},403],
    [request(requested,{headers:{'X-Forwarded-For':'203.0.113.19, invalid'}}),{},403],
    [request(),{lookup:'IN'},403],
    [request(),{lookup:'fail'},503],
    [request(),{config:{...env,PREDICTIR_MODE:'replay'}},404],
  ]){
    const h=harness(options);
    const response=await assistantResponse(req,h.deps);
    assert.equal(response.status,expected);
    assert.equal(h.calls.connect,0);
    assert.equal(h.calls.generated,0);
    assert.equal(h.calls.quotas.length,expected===429?1:0);
  }
});

test('partial results retain scoped answers and never display stale or foreign model results',async ()=>{
  const h=harness({tool:(name)=>{
    if(name==='get_research')return packet({...research(),ticker:'KXFOREIGN-DATA',title:'Foreign contract'});
    if(name==='get_contract')return packet(contract());
    return packet({ticker,citations:[]});
  }});
  const response=await assistantResponse(request(),h.deps),answer=await response.text();
  assert.equal(response.status,200);
  assert.match(answer,/Arizona wins/);
  assert.match(answer,/Fresh independent research is unavailable/);
  assert.match(answer,/Load contract news/);
  assert.doesNotMatch(answer,/Foreign contract|36\.0%/);
  assert.equal(h.calls.close,1);
});

test('Foundry only reorders cited evidence after a separate reservation',async ()=>{
  const config={...env,AZURE_FOUNDRY_ENABLED:'1',AZURE_FOUNDRY_ENDPOINT:'https://fixture.openai.azure.com',
    AZURE_FOUNDRY_DEPLOYMENT:'fixture-ranker',IDENTITY_ENDPOINT:'http://localhost:42356/msi/token',IDENTITY_HEADER:'fixture-header'};
  let providerCalls=0;
  const h=harness({config,foundryFetcher:async ()=>{
    providerCalls++;
    return providerCalls===1?Response.json({access_token:'fixture.identity.token',token_type:'Bearer'}):
      Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"order":["E2","E1"]}'}}]});
  }});
  const response=await assistantResponse(request(),h.deps),answer=await response.text();
  assert.equal(response.status,200,answer);
  assert.equal(response.headers.get('x-research-model'),'azure-foundry');
  assert.deepEqual(h.calls.quotas.map(row=>row.kind),['research','foundry']);
  assert.equal(providerCalls,2);
  assert.ok(answer.indexOf('ESPN team report')<answer.indexOf('NFL availability report'));
  assert.match(answer,/Research screen: PASS/);
});

test('cancelled request closes the MCP client and stops the optional model',async ()=>{
  const controller=new AbortController();
  const h=harness({tool:()=>{
    controller.abort();
    return packet(research());
  }});
  const response=await assistantResponse(request(requested,{signal:controller.signal}),h.deps);
  assert.equal(response.status,503);
  assert.equal(h.calls.close,1);
  assert.deepEqual(h.calls.quotas.map(row=>row.kind),['research']);
});

test('Ask Why follows the selected analysis panel and full detail adds fresh costs, payout and holdout evidence',async ()=>{
  const scenario=()=>({...research(),forecast:{...research().forecast,validation:{passed:false,n:480,brier:.16,baseline_brier:.17},
    outcomes:{win:.36,loss:.62,tie:.02},expected_settlement_value:.37},decision:{assumptions:{uncertainty_buffer:.02,fee_note:'An explicit exchange taker-fee assumption.'},
    reasons:['The holdout release requirement is unmet.','Neither side clears the uncertainty buffer.']},
    paper_scenarios:[{ticker,side:'YES',contracts:40,quote_as_of:time(),break_even:.49,cost:19.60,fee:.70,win_value:40.4,lose_value:.40,tie_value:20.40,partial_payout:true}]});
  const tool=name=>{
    if(name==='get_research')return packet(scenario());
    if(name==='get_contract')return packet({...contract(),rules:{...contract().rules,secondary:'A tie settles at 50 cents.'},
      book:{as_of:time()},quotes:{yes_ask_usd:.47,no_ask_usd:.54}});
    return packet({ticker,citations:[citation(goodURL,'NFL availability report','Arizona listed a starter as questionable.')]});
  };
  const short=harness({tool}),long=harness({tool});
  const question='Why this research view?';
  const brief=await (await assistantResponse(request(question,{panel:'analysis',detail:'brief'}),short.deps)).text();
  const full=await (await assistantResponse(request(question,{panel:'analysis',detail:'full'}),long.deps)).text();
  assert.deepEqual(short.calls.tools.map(row=>row.name),['get_contract','get_research']);
  assert.deepEqual(long.calls.tools.map(row=>row.name),['get_contract','search_retained_evidence','get_research']);
  assert.match(brief,/Research screen: PASS/);
  assert.match(brief,/Paper YES uses \$19\.60 for 40 contracts, including \$0\.70/);
  assert.doesNotMatch(brief,/held-out observations|Tie-payout balance|Secondary rule/);
  assert.match(full,/Secondary rule: A tie settles at 50 cents/);
  assert.match(full,/YES 47\.0¢ and NO 54\.0¢ per contract before fees/);
  assert.match(full,/480 held-out observations/);
  assert.match(full,/2\.0% to a tie/);
  assert.match(full,/tie-payout balance is \$20\.40/);
  assert.match(full,/extra 2\.0¢ per contract/);
  assert.match(full,/What would change the read/);
  assert.ok(full.includes('[NFL availability report]('+goodURL+')'));
  assert.ok(full.length>brief.length*1.5);
  assert.deepEqual(long.calls.quotas.map(row=>row.kind),['research']);
});

test('execution Ask Why verifies the returned controls and expands the scenario only when they match',async ()=>{
  const executionControls=normalizeExecutionControls({side:'no',action:'sell',contracts:7,horizon_seconds:120,order_flow:false});
  const response=async ({match})=>{
    const h=harness({executionControls,tool:name=>name==='get_research'?packet(research()):packet({
      ticker,version:'execution-research-v1',as_of:time(),controls:match?executionControls:{...executionControls,contracts:20},
      immediate_execution:{filled:5,unfilled:2,fee:.19,cash:2.3},schedule:{expected_cost:.08,objective:.11,risk_variance:.6,
        benchmark_twap:{objective:.15,risk_variance:.9},rows:[{contracts:1.5,interval_end_seconds:10}]},
    })});
    const answer=await (await assistantResponse(request('Why these results?',{panel:'execution',detail:'full',executionControls}),h.deps)).text();
    assert.deepEqual(h.calls.tools.map(row=>row.name),['analyze_execution_lab','get_research']);
    return answer;
  };
  const result=await response({match:true});
  assert.match(result,/7 hypothetical NO contracts, sell, over 120 seconds/);
  assert.match(result,/visible depth would fill 5 contracts and leave 2 unfilled/);
  assert.match(result,/Order-flow imbalance off/);
  assert.match(result,/first modeled slice is 1\.5 contracts over 10 seconds/);
  const mismatch=await response({match:false});
  assert.match(mismatch,/did not match the submitted settings/);
  assert.doesNotMatch(mismatch,/hypothetical NO contracts|modeled slice/);
});

test('history panel keeps a prior seven-day intent on a short follow-up and compares like-for-like closes',async ()=>{
  const h=harness({tool:(name,args)=>{
    if(name==='get_research')return packet(research());
    assert.equal(args.hours,'168');
    return packet({ticker,rows:[{time:'2026-11-01T00:00:00Z',price_usd_per_contract:.60,value_kind:'last_trade'},
      {time:'2026-11-02T00:00:00Z',price_usd_per_contract:.45,value_kind:'quoted_midpoint'},
      {time:'2026-11-03T00:00:00Z',price_usd_per_contract:.50,value_kind:'quoted_midpoint'}]});
  }});
  const messages=[{role:'user',content:'What changed in price history over the last week?'},{role:'assistant',content:'Fixture reply'},{role:'user',content:'Tell me more.'}];
  const reply=await assistantResponse(request('',{panel:'history',detail:'full',messages}),h.deps),answer=await reply.text();
  assert.equal(reply.status,200);
  assert.match(answer,/quoted-midpoint candle close was 50\.0¢/);
  assert.match(answer,/the change was \+5\.0¢ per contract/);
  assert.equal(h.calls.tools.length,2);
});

test('reporting panel uses a compact lexical query and labels fresh attributed fallback links',async ()=>{
  const h=harness({tool:(name,args)=>{
    if(name==='get_research')return packet({...research(),evidence:[
      {url:goodURL,title:'Official game availability',excerpt:'The designated game report was updated.',match_scope:'matched'},
      {url:'https://www.espn.com/example',title:'Practice notes',excerpt:'A related practice update.',match_scope:'related'},
    ]});
    assert.equal(args.query,'injury OR questionable OR availability OR lineup OR practice OR starter');
    return packet({ticker,citations:[]});
  }});
  const question='Explain the retained public reporting for '+ticker+'. Compare the best-matched reports, their source dates and material limitations.';
  const reply=await assistantResponse(request(question,{panel:'evidence',detail:'full'}),h.deps),answer=await reply.text();
  assert.equal(reply.status,200);
  assert.match(answer,/retained search returned no usable excerpts/);
  assert.match(answer,/Matched report\. \[Official game availability\]/);
  assert.match(answer,/Related context\. \[Practice notes\]/);
  assert.match(answer,/check publication dates/);
  assert.equal(h.calls.tools.length,2);
});

test('guided explanations on the existing edition use scoped tools without opening the paid model path',async t=>{
  const previous={MARKET_BACKEND_URL:process.env.MARKET_BACKEND_URL,ASSISTANT_SERVICE_SECRET:process.env.ASSISTANT_SERVICE_SECRET};
  process.env.MARKET_BACKEND_URL=env.MARKET_BACKEND_URL;
  process.env.ASSISTANT_SERVICE_SECRET=env.ASSISTANT_SERVICE_SECRET;
  t.after(()=>{
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
  });
  let network=0,generate=0,closed=0;
  const calls=[];
  const reply=await assistantResponse(request('Why this settlement rule?',{panel:'rules',detail:'full'}),{
    env:{},
    createClient:async()=>({
      listTools:async()=>({tools:['get_contract','get_research'].map(name=>({name,description:'Read public research',inputSchema:{type:'object'}}))}),
      callTool:async ({name})=>{calls.push(name);return packet(name==='get_contract'?contract():research());},
      close:async()=>{closed++;},
    }),
    generate:()=>{generate++;throw new Error('Unexpected model');},
    fetcher:()=>{network++;throw new Error('Unexpected budget request');},
  });
  const answer=await reply.text();
  assert.equal(reply.status,200,answer);
  assert.equal(reply.headers.get('x-research-model'),'deterministic-guided');
  assert.match(answer,/Arizona wins/);
  assert.deepEqual(calls,['get_contract','get_research']);
  assert.equal(closed,1);
  assert.equal(network,0);
  assert.equal(generate,0);
});
