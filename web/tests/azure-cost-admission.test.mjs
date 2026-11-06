import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import {createMarketServer} from '../cloud/server.mjs';

const edgeSecret='cost-admission-fixture-'.repeat(3);
const trustedHeaders={
  'x-market-edge-secret':edgeSecret,
  'x-market-country':'US',
  'x-market-client-ip':'198.51.100.74',
};
const evidence='/api/workspace/evidence?ticker=KX-FIXTURE';
const graphql='/api/workspace/graphql';
const execution='/api/workspace/execution-research?ticker=KX-FIXTURE';
const recommendations='/api/workspace/recommendations';

async function listen(t,{azure=true}={}){
  const prior=process.env.PREDICTIR_MODE;
  if(azure)process.env.PREDICTIR_MODE='live';
  else delete process.env.PREDICTIR_MODE;
  t.after(()=>{if(prior===undefined)delete process.env.PREDICTIR_MODE;else process.env.PREDICTIR_MODE=prior;});
  const charges=[],handled=[];
  let clock=Date.parse('2026-11-06T11:00:14.150Z');
  const route=request=>{
    handled.push([request.method,new URL(request.url).pathname]);
    return Response.json({ok:true});
  };
  const server=createMarketServer({
    production:true,edgeSecret,now:()=>clock,logger:()=>{},feed:{status:'fixture'},
    storageEnabled:()=>true,storage:()=>({consume:async(key,allowance,weight)=>{
      assert.match(key,/^work#\d{4}-\d\d-\d\d$/);
      assert.equal(allowance,6000);
      charges.push(weight);
      return true;
    }}),getRoute:route,postRoute:route,
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const address='http://127.0.0.1:'+server.address().port;
  const send=async(path,{method='GET',headers=trustedHeaders,body}={})=>{
    const response=await fetch(address+path,{
      method,headers:body===undefined?headers:{...headers,'Content-Type':'application/json'},body,
    });
    await response.arrayBuffer();
    return response;
  };
  return {charges,handled,send,advance:ms=>{clock+=ms;}};
}

test('Azure expensive reads share one verified client budget and stop before body or durable work',async t=>{
  const {send,charges,handled,advance}=await listen(t);
  assert.equal((await send(evidence,{headers:{...trustedHeaders,'x-market-edge-secret':'invalid'}})).status,403);
  assert.equal((await send(evidence,{headers:{...trustedHeaders,'x-market-country':'RU'}})).status,403);
  assert.deepEqual(charges,[]);
  for(let loop=0;loop<3;loop++){
    for(const path of [evidence,graphql,execution,recommendations]){
      assert.equal((await send(path,path===graphql?{method:'POST',body:'{}'}:{})).status,200);
    }
  }
  assert.deepEqual(charges,[6,6,5,12,6,6,5,12,6,6,5,12]);
  assert.equal(handled.length,12);
  for(const [path,options] of [
    [evidence,{}],[graphql,{method:'POST',body:'x'.repeat(30_000)}],[execution,{}],[recommendations,{}],
  ]){
    const limited=await send(path,options);
    assert.equal(limited.status,429);
    assert.equal(limited.headers.get('Retry-After'),'46');
  }
  assert.equal(handled.length,12);
  assert.equal(charges.length,12);

  assert.equal((await send(evidence+'&preview=1')).status,200);
  assert.equal((await send('/api/workspace/catalog')).status,200);
  assert.equal((await send('/api/health',{headers:{}})).status,200);
  assert.deepEqual(charges.slice(12),[1,1]);
  assert.equal((await send(evidence,{headers:{...trustedHeaders,'x-market-client-ip':'198.51.100.75'}})).status,200);
  advance(45_850);
  assert.equal((await send(evidence)).status,200);
  assert.deepEqual(charges.slice(12),[1,1,6,6]);
});

test('non-Azure evidence keeps the existing request and durable limits',async t=>{
  const {send,charges,handled}=await listen(t,{azure:false});
  for(let i=0;i<13;i++)assert.equal((await send(evidence)).status,200);
  assert.equal(handled.length,13);
  assert.deepEqual(charges,Array(13).fill(1));
});
