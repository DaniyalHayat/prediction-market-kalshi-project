import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {marketDetails,book,validateTicker} from '../live.mjs';
import {workspaceResearch,contractHistory} from './router.mjs';
import {providerStatus} from './providers.mjs';
import {warehouseStatus} from './warehouse.mjs';

export function publicResearch(value){
  const music=value.extensions?.music;
  const decision=value.decision?{...value.decision,candidates:value.decision.candidates?.map(candidate=>{
    const {execution:e,probability,lower_probability,expected_edge,conservative_edge,...rest}=candidate;
    const normalized={...rest,side_win_probability_fraction:probability,side_probability_lower_fraction:lower_probability,
      expected_edge_usd_per_filled_contract:expected_edge,conservative_edge_usd_per_filled_contract:conservative_edge};
    if(!e)return normalized;
    return {...normalized,execution:{side:e.side,requested_contracts:e.requested,filled_contracts:e.filled,unfilled_contracts:e.unfilled,
      available_contracts_within_slippage:e.available,entry_notional_usd:e.cost,estimated_entry_fee_usd:e.fee,all_in_entry_usd:e.all_in,
      vwap_usd_per_contract:e.vwap,all_in_usd_per_filled_contract:e.breakeven,actual_slippage_cents_per_contract:e.slippage_cents,
      units_note:'Contract quantities are not dollars, cash available or account balances. This tool has no account access.'}};
  })}:undefined;
  return {ticker:value.ticker,title:value.title,as_of:value.as_of,status:value.status,summary:value.summary,opinion:value.opinion,
    account_balances_available:false,units:{forecast_probability:'P(YES), 0 to 1; multiply by 100 for percent',candidate_probability:'Win probability of the candidate side, 0 to 1',price:'USD per $1 binary payout contract',quantity:'Number of contracts, never an account balance'},
    forecast:value.forecast,decision,drivers:value.drivers,rules:value.rules,sources:(value.sources||[]).filter(s=>!s.url?.includes('api.spotify.com')),
    errors:value.errors,extensions:{sports:value.extensions?.sports,music:music?{scope:music.scope,comparability:music.comparability,
      forecast:music.forecast,persistence:music.persistence,source_updated:music.apple?.source_updated,scope_note:music.apple?.note}:undefined}};
}
export function boundPacket(value,maximum=14000){
  if(Buffer.byteLength(JSON.stringify(value))<=maximum)return value;
  const lean={ticker:value.ticker,title:value.title,as_of:value.as_of,summary:value.summary,opinion:value.opinion,
    account_balances_available:value.account_balances_available,units:value.units,forecast:value.forecast,decision:value.decision,sources:value.sources,scope:'Additional details omitted to keep the research packet bounded.'};
  if(Buffer.byteLength(JSON.stringify(lean))<=maximum)return lean;
  return {ticker:String(value.ticker||'').slice(0,140),reason:'The source packet exceeded the display bound. Ask for specific rules, prices or source status.'};
}
export function createResearchServer({tickerScope,modelScope='baseline',dependencies={}}={}) {
  const deps={marketDetails,book,workspaceResearch,contractHistory,warehouseStatus,providerStatus,...dependencies};
  const server=new McpServer({name:'kalshi-market-lab',version:'4.0.0'});
  if(tickerScope)validateTicker(tickerScope);
  if(!['baseline','validated','challenger'].includes(modelScope))throw new RangeError('Unknown research model');
  const ticker=z.string().min(1).max(140).regex(/^[A-Za-z0-9_.-]+$/);
  const check=value=>{validateTicker(value);if(tickerScope&&tickerScope!==value)throw new RangeError('This chat is scoped to the selected contract');};
  const output=value=>({content:[{type:'text',text:JSON.stringify(boundPacket(value))}]});
  const register=(name,description,inputSchema,handler)=>server.registerTool(name,{description,inputSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},async input=>{
      try{if(input.ticker)check(input.ticker);return output(await handler(input));}
      catch(error){return {isError:true,content:[{type:'text',text:JSON.stringify({status:'unavailable',reason:error.message})}]};}
    });
  register('get_contract','Read the selected public contract rules, exact outcome identity and current public order book. No account or order access.',{ticker},async({ticker})=>{
    const [detail,depth]=await Promise.all([deps.marketDetails(ticker),deps.book(ticker,1)]);
    const m=detail.market;
    const levels=side=>(depth.raw?.orderbook_fp?.[side]||[]).map(([price,quantity])=>({bid_price_usd_per_contract:Number(price),quantity_contracts:Number(quantity)}))
      .filter(row=>Number.isFinite(row.bid_price_usd_per_contract)&&row.bid_price_usd_per_contract>=0&&row.bid_price_usd_per_contract<=1&&Number.isFinite(row.quantity_contracts)&&row.quantity_contracts>0)
      .sort((a,b)=>b.bid_price_usd_per_contract-a.bid_price_usd_per_contract).slice(0,12);
    return {ticker,market:{ticker:m.ticker,event_ticker:m.event_ticker,title:m.title,yes_sub_title:m.yes_sub_title,status:m.status,
      result:m.result,close_time:m.close_time,expected_expiration_time:m.expected_expiration_time},
      rules:{primary:String(m.rules_primary||'').slice(0,5000),secondary:String(m.rules_secondary||'').slice(0,2000)},as_of:detail.as_of,
      quotes:{unit:'USD per contract with a $1 binary settlement payout',yes_ask_usd:depth.metrics?.book_ask??null,
        no_ask_usd:Number.isFinite(depth.metrics?.book_bid)?Math.round((1-depth.metrics.book_bid)*1e8)/1e8:null,
        costs_note:'Visible asks exclude entry fees, slippage and quantity-dependent depth. Quote percentages are not independent model probabilities.'},
      account_balances_available:false,book:{as_of:depth.as_of,yes_bid_levels:levels('yes_dollars'),no_bid_levels:levels('no_dollars'),
        note:'Displayed quantities are public bid liquidity in contracts. Buying YES uses opposite NO bids at 1 minus bid price, and conversely for buying NO.'},
      sources:[{label:'Kalshi contract',url:detail.source_url,retrieved_at:detail.as_of},{label:'Kalshi order book',url:depth.source_url,retrieved_at:depth.as_of}]};
  });
  register('get_research','Read deterministic public research, uncertainty, validation, cost screen and evidence gaps for the selected contract. Does not contain Spotify catalog content or private journals.',{ticker},async({ticker})=>publicResearch(await deps.workspaceResearch(ticker,{assistant:true,model:modelScope})));
  register('get_price_history','Read observed exchange candle closes. Gaps are not filled and quote midpoints are labeled.',{ticker,hours:z.enum(['24','168']).default('24')},async({ticker,hours})=>{
    const value=await deps.contractHistory(ticker,Number(hours));return {...value,units:{price:'USD per contract',volume:'Contracts'},rows:value.rows.slice(-120).map(({value:price,volume,...row})=>({...row,price_usd_per_contract:price,volume_contracts:volume}))};
  });
  register('get_source_status','Read public provider availability and warehouse coverage counts. No credentials or private records.',{},async()=>({as_of:new Date().toISOString(),providers:deps.providerStatus(),warehouse:await deps.warehouseStatus()}));
  return server;
}
export async function handleMCP(req,res,body,options={}){
  if(req.method!=='POST'){res.writeHead(405,{'Content-Type':'application/json'});return res.end(JSON.stringify({jsonrpc:'2.0',error:{code:-32000,message:'Use Streamable HTTP POST'},id:null}));}
  const server=createResearchServer(options),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  const close=()=>{transport.close().catch(()=>{});server.close().catch(()=>{});};
  res.on('close',close);
  try{await server.connect(transport);await transport.handleRequest(req,res,body);}
  catch(error){close();if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',error:{code:-32603,message:'Research transport unavailable'},id:null}));}}
}
