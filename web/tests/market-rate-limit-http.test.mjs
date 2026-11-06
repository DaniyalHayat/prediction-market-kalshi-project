import test from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '../app/api/[...path]/route.js';

test('the public market API preserves a Kalshi 429 and Retry-After',async t=>{
  const fetcher=t.mock.method(globalThis,'fetch',async()=>Response.json({error:'PRIVATE_UPSTREAM_BODY'},{
    status:429,headers:{'Retry-After':'90'},
  }));
  const response=await GET(new Request('http://localhost/api/market?ticker=TEST-RATE-LIMIT'),{
    privateRuntime:true,params:Promise.resolve({path:['market']}),
  });
  assert.equal(response.status,429);
  assert.equal(response.headers.get('retry-after'),'90');
  assert.doesNotMatch((await response.json()).error,/PRIVATE_UPSTREAM_BODY/);
  assert.equal(fetcher.mock.callCount(),1);
});
