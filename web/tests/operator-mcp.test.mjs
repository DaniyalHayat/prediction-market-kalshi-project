import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createOperatorMCP,operatorReview} from '../lib/runtime/operator-mcp.mjs';
import {createMarketServer} from '../cloud/server.mjs';

test('private operator tools run the selected review without unrelated source or quota reads',async()=>{
  let snapshots=0,allowanceReads=0;
  const now=Date.parse('2026-11-07T07:00:00Z');
  const server=createOperatorMCP({now:()=>now,
    readSnapshot:async()=>{snapshots++;return {telemetry:{distributions:{
      'request:/api/book':{count:120,window_count:120,p95_ms:100,p99_ms:700,errors:2},
      'provider:espn':{count:150,window_count:150,p95_ms:90,p99_ms:800,errors:3}},
      request_throttles:{'/api/stream':{throttle_stream_capacity:12}}},logs:[]};},
    readAllowances:async()=>{allowanceReads++;return {as_of:new Date(now).toISOString(),allowances:[
      {resource:'assistant_milliusd',used:900,limit:1000}]};}});
  const client=new Client({name:'operator-test',version:'1'});
  const [left,right]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(left);await client.connect(right);
    assert.deepEqual((await client.listTools()).tools.map(row=>row.name),['review_runtime','review_sources','review_allowances']);
    const read=async name=>JSON.parse((await client.callTool({name,arguments:{}})).content[0].text);
    const sources=await read('review_sources');
    assert.deepEqual(Object.keys(sources.providers),['provider:espn']);
    assert.equal(sources.changes_applied,false);
    assert.equal(allowanceReads,0);
    const runtime=await read('review_runtime');
    assert.equal(runtime.throttles[0].reason,'throttle_stream_capacity');
    const allowances=await read('review_allowances');
    assert.equal(allowances.usage[0].percent,90);
    assert.equal(allowanceReads,1);
    assert.equal(snapshots,2);
    assert.throws(()=>operatorReview('execute'),RangeError);
  }finally{await client.close();await server.close();}
});

test('hosted operational MCP requires service authentication and rejects arbitrary tools',async()=>{
  const secret='fixture-operations-service-'.repeat(3);
  const server=createMarketServer({production:true,serviceSecret:secret,storageEnabled:()=>false,logger:()=>{}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/internal/operator-mcp';
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  const body={jsonrpc:'2.0',id:1,method:'tools/list',params:{}};
  try{
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(body)})).status,401);
    const authorized={...headers,Authorization:'Bearer '+secret};
    const response=await fetch(url,{method:'POST',headers:authorized,body:JSON.stringify(body)});
    assert.equal(response.status,200);
    assert.equal((await response.json()).result.tools.length,3);
    const run=await fetch(url,{method:'POST',headers:authorized,
      body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'review_runtime',arguments:{}}})});
    const packet=JSON.parse((await run.json()).result.content[0].text);
    assert.equal(packet.profile,'runtime');
    assert.equal(packet.changes_applied,false);
    assert.ok(!JSON.stringify(packet).includes(secret));
    const invalid=await fetch(url,{method:'POST',headers:authorized,
      body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'execute_sql',arguments:{}}})});
    const rejected=await invalid.json();
    assert.equal(rejected.result?.isError,true);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
