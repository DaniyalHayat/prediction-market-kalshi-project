import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {BASE} from '../lib/live.mjs';
import {CATEGORIES} from '../lib/intelligence/catalog.mjs';

const {values}=parseArgs({options:{pages:{type:'string',default:'12'}}});
const maxPages=Number(values.pages);
if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100)throw new RangeError('Use --pages from 1 to 100 per market partition.');
const scanStarted=Date.now();
const routeBySeries=new Map([['KXNBAGAME','nba'],['KXNFLGAME','nfl'],['KXEPLGAME','epl'],
  ...CATEGORIES.flatMap(({id,series})=>series.map(ticker=>[ticker,id]))]);

async function scan(partition){
  let cursor='',pages=0,duplicates=0,unexpired=0;
  const tickers=new Set(),events=new Set(),series=new Set(),candidateRoutes=new Map();
  do{
    const query=new URLSearchParams({limit:'1000',status:'open',mve_filter:partition,max_created_ts:String(Math.floor(scanStarted/1000))});
    if(cursor)query.set('cursor',cursor);
    const response=await fetch(BASE+'/markets?'+query,{redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Kalshi '+partition+' catalog returned HTTP '+response.status);
    const page=await response.json();
    if(!Array.isArray(page.markets)||typeof page.cursor!=='string')throw new Error('Kalshi catalog response did not match the expected schema.');
    if(cursor&&page.cursor===cursor)throw new Error('Kalshi returned a non-advancing catalog cursor.');
    for(const market of page.markets){
      if(typeof market.ticker!=='string'||typeof market.event_ticker!=='string')throw new Error('Kalshi returned a market without an identity.');
      if(tickers.has(market.ticker)){duplicates++;continue;}
      tickers.add(market.ticker);
      if(!['active','open'].includes(market.status)||!(Date.parse(market.close_time)>scanStarted))continue;
      unexpired++;events.add(market.event_ticker);
      const seriesTicker=market.series_ticker||market.event_ticker.split('-')[0];
      series.add(seriesTicker);
      const route=partition==='only'?'unmapped_combination':routeBySeries.get(seriesTicker)||'unmapped_series';
      candidateRoutes.set(route,(candidateRoutes.get(route)||0)+1);
    }
    pages++;cursor=page.cursor;
    if(cursor&&pages<maxPages)await delay(350);
  }while(cursor&&pages<maxPages);
  return {pages,complete:!cursor,unique_markets:tickers.size,duplicate_markets:duplicates,
    active_unexpired_contracts:unexpired,active_events:events.size,active_series:series.size,
    possible_routes:Object.fromEntries([...candidateRoutes].sort(([a],[b])=>a.localeCompare(b)))};
}

const ordinary=await scan('exclude'),multivariate=await scan('only');
console.log(JSON.stringify({started_at:new Date(scanStarted).toISOString(),finished_at:new Date().toISOString(),
  ordinary,multivariate,scope:'Prediction contracts open at request time and created by the scan start. A continuing cursor indicates a lower bound. Series routing is not contract eligibility, independent source coverage, or a passing settlement backtest.'},null,2));
