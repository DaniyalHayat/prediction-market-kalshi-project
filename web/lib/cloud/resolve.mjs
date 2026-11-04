import {validateTicker,marketDetails,request} from '../live.mjs';
export function parseMarketInput(value) {
  if(typeof value!=='string'||value.length>500)throw new RangeError('Paste a Kalshi market URL or exact ticker');
  let text=value.trim();
  if(/^https?:/i.test(text)) {
    const url=new URL(text);
    if(url.protocol!=='https:'||!['kalshi.com','www.kalshi.com'].includes(url.hostname)||!url.pathname.startsWith('/markets/'))throw new RangeError('Use an official Kalshi market URL');
    text=url.pathname.split('/').filter(Boolean).at(-1);
  }
  return validateTicker(text.toUpperCase());
}
export async function resolveContracts(value) {
  const ticker=parseMarketInput(value);
  let markets=[];
  try{markets=[(await marketDetails(ticker)).market];}
  catch(error){if(error.upstream_status!==404)throw error;
    markets=(await request('/markets',{event_ticker:ticker,limit:'200'})).data.markets||[];}
  return {contracts:markets.map(m=>({ticker:m.ticker,event_ticker:m.event_ticker,title:m.title,
    subtitle:m.yes_sub_title||m.subtitle||m.ticker,status:m.status,close_time:m.close_time})),partial:markets.length>=200};
}
export async function marketFees(ticker) {
  const {market}=await marketDetails(validateTicker(ticker));
  const event=await request('/events/'+validateTicker(market.event_ticker));
  const series=event.data.event?.series_ticker;
  if(!series)throw new Error('The exact series for this event is unavailable');
  const result=await request('/series/'+validateTicker(series)),metadata=result.data.series;
  const multiplier=metadata?.fee_multiplier;
  const quadratic=['quadratic','quadratic_with_maker_fees'].includes(metadata?.fee_type);
  return {series,fee_type:metadata?.fee_type??null,multiplier:typeof multiplier==='number'?multiplier:null,
    coefficient:quadratic&&typeof multiplier==='number'&&Number.isFinite(multiplier)&&multiplier>=0 ? .07*multiplier : null,
    as_of:result.as_of,source_url:result.source_url,
    scope:'Series metadata and the published general taker formula; individual-market exceptions and per-fill rounding still require inspection.'};
}
