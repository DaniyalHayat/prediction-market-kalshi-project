import test from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '../app/api/[...path]/route.js';
import {marketFees,resolveContracts} from '../lib/cloud/resolve.mjs';
import {request} from '../lib/live.mjs';

const ticker='TEST-NOT-FOUND';
const message='The selected contract was not found in the current Kalshi market catalog.';

function get(route,value=ticker){
  return GET(new Request('http://localhost/api/'+route+'?ticker='+value),{
    privateRuntime:true,params:Promise.resolve({path:route.split('/')}),
  });
}

test('missing market and candle data return 404 from exact-contract routes',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/series/TEST'))return Response.json({series:{ticker:'TEST'}});
    assert.match(path,new RegExp('/'+ticker+'(?:/candlesticks)?$'));
    return Response.json({error:'PRIVATE_UPSTREAM_BODY'},{status:404});
  });
  for(const route of ['market','workspace/context','workspace/research','workspace/evidence','workspace/history','brief']){
    const response=await get(route);
    assert.equal(response.status,404,route);
    assert.equal((await response.json()).error,message);
  }
  await assert.rejects(marketFees(ticker),{status:404,upstream_status:404,message});
});

test('event lookup still falls back from a missing exact market, and list failures stay generic',async t=>{
  const event='TEST-EVENT',contracts=[{ticker:event+'-YES',event_ticker:event,title:'Fixture contract'}];
  t.mock.method(globalThis,'fetch',async url=>{
    const parsed=new URL(url);
    if(parsed.searchParams.get('event_ticker')===event)return Response.json({markets:contracts});
    return Response.json({error:'not found'},{status:404});
  });
  const resolved=await resolveContracts(event);
  assert.equal(resolved.contracts[0]?.ticker,contracts[0].ticker);
  await assert.rejects(request('/markets/trades',{ticker}),error=>error.upstream_status===404&&error.status===undefined);
});

test('timeouts and upstream 500s stay unavailable, while the provider preserves 429 metadata',async t=>{
  const fetcher=t.mock.method(globalThis,'fetch',async()=>{
    throw new DOMException('The operation timed out','TimeoutError');
  });
  assert.equal((await get('market','TEST-TIMEOUT')).status,503);
  fetcher.mock.mockImplementation(async()=>Response.json({error:'outage'},{status:500}));
  const outage=await get('market','TEST-OUTAGE');
  assert.equal(outage.status,503);
  assert.match((await outage.json()).error,/HTTP 500/);
  fetcher.mock.mockImplementation(async()=>Response.json({error:'limited'},{status:429,headers:{'Retry-After':'90'}}));
  await assert.rejects(request('/markets/TEST-THROTTLE'),{
    upstream_status:429,retry_after_seconds:90,
  });
});
