import test from 'node:test';
import assert from 'node:assert/strict';
import {marketBrief} from '../lib/intelligence/brief.mjs';
import {inferCategory,inferResearchFamily,selectSeries,WORKSPACE_CATEGORIES,workspaceMarkets} from '../lib/workspace/catalog.mjs';

const openTravelSeries=['KXTSAW','KXORDPAX','KXRDUVISITS','KXBOIPASSENGERS'];
const previousTravelSeries=['KXTSAD','KXTSA'];
const exchange='https://external-api.kalshi.com/trade-api/v2';

function travelMarket(series) {
  return {ticker:series+'-TEST-100',event_ticker:series+'-TEST',series_ticker:series,
    title:'Passenger traffic above the contract threshold?',status:'active',
    close_time:new Date(Date.now()+86400000).toISOString()};
}

test('Travel includes open weekly TSA and airport markets when daily series are empty',async()=>{
  const rows=[...previousTravelSeries,...openTravelSeries].map(ticker=>({
    ticker,title:ticker,category:'Economics',categories:[],volume:1,settlement_sources:[],
  }));
  const requested=[];
  const value=await workspaceMarkets('travel',{
    catalogGetter:async()=>({rows}),
    getter:async(path,params)=>{
      assert.equal(path,'/markets');
      assert.equal(params.status,'open');
      requested.push(params.series_ticker);
      return {source_url:exchange+path,as_of:new Date().toISOString(),data:{
        markets:openTravelSeries.includes(params.series_ticker)?[travelMarket(params.series_ticker)]:[],
      }};
    },
  });
  assert.deepEqual(requested.sort(),rows.map(row=>row.ticker).sort());
  assert.deepEqual(value.markets.map(row=>row.series).sort(),[...openTravelSeries].sort());
  assert.deepEqual(value.errors,[]);
  assert.equal(value.partial,false);
  for(const market of value.markets){
    assert.equal(market.category,'travel');
    assert.equal(inferCategory(market,rows),'travel');
  }
  for(const category of WORKSPACE_CATEGORIES.filter(row=>['weather','climate'].includes(row.id))){
    assert.deepEqual(selectSeries(category,rows),[]);
  }
});

test('Airport markets are never assigned the nationwide TSA research family',async()=>{
  let dailyCalls=0;
  for(const series of openTravelSeries.filter(series=>series!=='KXTSAW')){
    const market=travelMarket(series);
    const brief=await marketBrief(market.ticker,{},{
      marketDetails:async()=>({market,source_url:exchange+'/markets/'+market.ticker,as_of:new Date().toISOString()}),
      request:async()=>null,
      book:async()=>null,
      headlines:async()=>null,
      researchReport:async()=>{dailyCalls++;throw new Error('Unexpected model request');},
    });
    assert.equal(inferResearchFamily(market.ticker),null);
    assert.equal(brief.series,series);
    assert.equal(brief.forecast.probability,null);
    assert.equal(brief.status,'evidence_only');
    assert.equal(brief.decision.side,'insufficient_edge');
  }
  assert.equal(inferResearchFamily(travelMarket('KXTSAD').ticker),'travel');
  assert.equal(inferResearchFamily(travelMarket('KXTSAW').ticker),'travel');
  assert.equal(dailyCalls,0);
});
