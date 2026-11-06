import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {GET,POST,PUT} from '../app/api/[...path]/route.js';
import {createMarketServer} from '../cloud/server.mjs';
import {headlineReplayGraphQL} from '../lib/workspace/headline-replay-graphql.mjs';
import {proxyBackend} from '../lib/workspace/proxy.mjs';

const path=['workspace','graphql'];
const url='https://predictir.dev/api/'+path.join('/');
const ticker='KXEXACT-TEST-YES';
const input={operationName:'HeadlineReplay',variables:{ticker,model:'challenger'}};
const asOf='2026-11-06T09:30:00.000Z';
const headline={title:'A report for the selected contract',url:'https://publisher.test/report',as_of:asOf,
  platform:'publisher_metadata',publisher:'Public publisher',match_scope:'matched',time_basis:'publisher_reported_publication',
  confidence:'moderate',excerpt:'Unused prose',private_payload:'never expose'};
const history={ticker,as_of:asOf,source_url:'https://exchange.test/history',rows:[
  {time:asOf,value:0.62,value_kind:'last_trade',midpoint:0.57,volume:48},
  {time:'2026-11-06T09:31:00Z',value:0.3,value_kind:'last_trade',midpoint:null},
  {time:'2026-11-06T09:32:00Z',value:0,value_kind:'quoted_midpoint'},
  {time:'invalid',value:0.5,value_kind:'quoted_midpoint'},
  {time:'2026-11-06T09:33:00Z',value:-0.5,value_kind:'quoted_midpoint'}
]};
const post=(value=input,headers={})=>new Request(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},
  body:typeof value==='string'?value:JSON.stringify(value)});

test('headline replay selects exact public DTOs and starts both source calls together',async()=>{
  const calls=[];
  let releaseEvidence;
  const result=await headlineReplayGraphQL(post(),{
    getEvidence:(key,options)=>{
      calls.push(['evidence',key,options]);
      return new Promise(resolve=>{releaseEvidence=resolve;});
    },
    getHistory:(key,hours)=>{
      calls.push(['history',key,hours]);
      releaseEvidence({ticker,as_of:asOf,items:[headline,{...headline,match_scope:'related'},
        {...headline,platform:'reddit'},{...headline,url:'https://username:password@publisher.test/credential'}]});
      return history;
    }
  });
  assert.equal(result.status,200);
  assert.equal(result.headers.get('cache-control'),'no-store');
  assert.deepEqual(calls,[['evidence',ticker,{model:'challenger',retain:false}],['history',ticker,24]]);
  const {data:{headlineReplay:replay}}=await result.json();
  const {excerpt,private_payload,...expectedHeadline}=headline;
  assert.deepEqual(replay,{ticker,model:'challenger',status:'ready',unavailable_sources:[],
    evidence:{ticker,as_of:asOf,items:[expectedHeadline]},history:{ticker,as_of:asOf,source_url:history.source_url,rows:[
      {time:asOf,value:0.57,midpoint:0.57,value_kind:'quoted_midpoint'},
      {time:'2026-11-06T09:32:00Z',value:0,midpoint:0,value_kind:'quoted_midpoint'}
    ]}});
});

test('a publisher failure or request deadline keeps a valid quote packet',async()=>{
  const read=async getEvidence=>{
    const response=await headlineReplayGraphQL(post(),{getEvidence,getHistory:()=>history,timeoutMs:40});
    assert.equal(response.status,200);
    return (await response.json()).data.headlineReplay;
  };
  const failed=await read(()=>({ticker,items:[],feeds:[{kind:'publisher',status:'unavailable'}]}));
  const mismatched=await read(()=>({ticker:'OTHER',items:[headline]}));
  const elapsed=performance.now();
  const timedOut=await read(()=>delay(400));
  assert.ok(performance.now()-elapsed<300);
  for(const result of [failed,mismatched,timedOut]){
    assert.equal(result.status,'partial');
    assert.deepEqual(result.unavailable_sources,['evidence']);
    assert.equal(result.evidence,null);
    assert.equal(result.history.rows.length,2);
  }
  const empty=await read(()=>({ticker,items:[],feeds:[{kind:'publisher',status:'empty'}]}));
  assert.equal(empty.status,'ready');
  assert.deepEqual(empty.evidence.items,[]);
  const unavailable=await headlineReplayGraphQL(post(),{getEvidence:()=>{throw new Error('private provider diagnostic');},getHistory:()=>null});
  const output=(await unavailable.json()).data.headlineReplay;
  assert.equal(output.status,'unavailable');
  assert.deepEqual(output.unavailable_sources,['evidence','history']);
});

test('only the bounded registered query and variables reach source calls',async()=>{
  const unexpected=()=>assert.fail('an invalid request reached a source');
  for(const [request,status] of [
    [new Request(url),405],[post(input,{'Content-Type':'application/jsonp'}),415],[post('a'.repeat(1025)),413],
    [post('{'),400],[post({...input,operationName:'InspectAll'}),400],
    [post({...input,query:'mutation { updateJournal }'}),400],
    [post({...input,variables:{...input.variables,ticker:'../secret'}}),400],
    [post({...input,variables:{...input.variables,model:'experimental'}}),400],
    [post({...input,variables:{...input.variables,account:'owner'}}),400]
  ]){
    const response=await headlineReplayGraphQL(request,{getEvidence:unexpected,getHistory:unexpected});
    assert.equal(response.status,status);
    assert.equal(typeof (await response.json()).errors[0].message,'string');
  }
});

test('the normal Next route and production-style API listener enforce the operation',async t=>{
  const context={privateRuntime:true,params:Promise.resolve({path})};
  const get=await GET(new Request(url),context);
  assert.equal(get.status,405);
  assert.equal(get.headers.get('allow'),'POST');
  assert.equal((await PUT(new Request(url,{method:'PUT'}),context)).status,405);
  const invalid={...input,query:'{ __schema { queryType { name } } }'};
  assert.equal((await POST(post(invalid),context)).status,400);
  const edgeSecret='test-headline-replay-shared-secret';
  const server=createMarketServer({production:true,edgeSecret,storageEnabled:()=>false,logger:()=>{}});
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const local='http://127.0.0.1:'+server.address().port+'/api/'+path.join('/');
  assert.equal((await fetch(local,{method:'POST'})).status,403);
  const request=body=>fetch(local,{method:'POST',headers:{'Content-Type':'application/json',
    'x-market-edge-secret':edgeSecret,'x-market-country':'US'},body});
  const response=await request(JSON.stringify(invalid));
  assert.equal(response.status,400);
  assert.match((await response.json()).errors[0].message,/registered HeadlineReplay/);
  assert.equal((await request('a'.repeat(1025))).status,413);
});

test('the frontend proxy forwards only the public operation with no account credentials',async t=>{
  const backend='https://predictir.internal.example.centralus.azurecontainerapps.io';
  const environment={MARKET_BACKEND_URL:backend,PREDICTIR_MODE:'live',APP_ORIGIN:'https://predictir.dev'};
  const previous=Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));
  Object.assign(process.env,environment);
  t.after(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const browser=(body=input,headers={})=>post(body,{'X-Forwarded-For':'203.0.113.42',...headers});
  const countryLookup=async ip=>{assert.equal(ip,'203.0.113.42');return 'US';};
  const fetched=await proxyBackend(browser(input,{Origin:'https://predictir.dev',Cookie:'private=1',Authorization:'Bearer private'}),path,{
    countryLookup,
    fetcher:async (location,options)=>{
      assert.equal(location.href,backend+'/api/'+path.join('/'));
      assert.equal(options.method,'POST');
      assert.deepEqual(JSON.parse(options.body),input);
      assert.equal(options.headers['x-market-country'],'US');
      assert.equal(options.headers.Cookie,undefined);
      assert.equal(options.headers.Authorization,undefined);
      return Response.json({data:{headlineReplay:{ticker}}});
    }
  });
  assert.equal(fetched.status,200);
  assert.equal(fetched.headers.get('cache-control'),'no-store');
  const unexpected=()=>assert.fail('an invalid request was forwarded');
  const guarded={countryLookup,fetcher:unexpected};
  assert.equal((await proxyBackend(browser(input,{Origin:'https://wrong.test'}),path,guarded)).status,403);
  assert.equal((await proxyBackend(browser(input,{'Content-Type':'text/plain'}),path,guarded)).status,415);
  assert.equal((await proxyBackend(browser('a'.repeat(1025)),path,guarded)).status,413);
  assert.equal((await proxyBackend(browser(),path,{...guarded,countryLookup:async()=> 'CN'})).status,403);
});
