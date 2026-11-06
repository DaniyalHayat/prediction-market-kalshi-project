import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {z} from 'zod';
import {marketDetails,book,number,validateTicker} from '../live.mjs';
import {workspaceResearch,contractHistory} from './router.mjs';
import {providerStatus} from './providers.mjs';
import {warehouseStatus} from './warehouse.mjs';
import {searchRetainedEvidence} from './semantic.mjs';
import {workspaceExecutionResearch,executionToolPacket} from './execution-service.mjs';
import {normalizeExecutionControls} from './execution-research.mjs';
import {contractEvidence} from './evidence.mjs';
import {parsePositionReview,reviewPaperPosition} from './position-review.mjs';

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
    forecast:value.forecast,decision,drivers:value.drivers,rules:value.rules,paper_scenarios:value.paper_scenarios,market_signal:value.market_signal,
    sources:(value.sources||[]).filter(s=>!s.url?.includes('api.spotify.com')),
    errors:value.errors,extensions:{sports:value.extensions?.sports,music:music?{scope:music.scope,comparability:music.comparability,
      forecast:music.forecast,persistence:music.persistence,source_updated:music.apple?.source_updated,scope_note:music.apple?.note}:undefined}};
}
export function boundPacket(value,maximum=14000){
  if(Buffer.byteLength(JSON.stringify(value))<=maximum)return value;
  if(Array.isArray(value.citations)){
    const citations=value.citations.filter(c=>typeof c.url==='string'&&c.url.length<=1200).slice(0,3).map(c=>({...c,title:String(c.title||'').slice(0,180),text:String(c.text||'').slice(0,650)}));
    const packet={ticker:value.ticker,status:citations.length?value.status:'empty',reason:citations.length?undefined:'The retained citation packet exceeded the display limit; use a narrower query.',retrieval:value.retrieval,citations,sources:citations.map(c=>({label:c.citation_id,url:c.url,retrieved_at:c.retrieved_at})),scope:'Retained public citations only; additional source chunks omitted to fit the context bound.'};
    if(Buffer.byteLength(JSON.stringify(packet))<=maximum)return packet;
  }
  const lean={ticker:value.ticker,title:value.title,as_of:value.as_of,summary:value.summary,opinion:value.opinion,
    account_balances_available:value.account_balances_available,units:value.units,forecast:value.forecast,decision:value.decision,
    paper_scenarios:value.paper_scenarios,market_signal:value.market_signal,evidence:value.evidence,sources:value.sources,
    scope:'Additional details omitted to keep the research packet bounded.'};
  if(Buffer.byteLength(JSON.stringify(lean))<=maximum)return lean;
  return {ticker:String(value.ticker||'').slice(0,140),reason:'The source packet exceeded the display bound. Ask for specific rules, prices or source status.'};
}
export function createResearchServer({tickerScope,modelScope='baseline',executionScope,positionScope,dependencies={}}={}) {
  const deps={marketDetails,book,workspaceResearch,contractHistory,warehouseStatus,providerStatus,searchRetainedEvidence,workspaceExecutionResearch,contractEvidence,...dependencies};
  const server=new McpServer({name:'predictir',version:'4.0.0'});
  if(tickerScope)validateTicker(tickerScope);
  if(!['baseline','validated','challenger'].includes(modelScope))throw new RangeError('Unknown research model');
  const executionControls=normalizeExecutionControls(executionScope);
  const ticker=z.string().min(1).max(140).regex(/^[A-Za-z0-9_.-]+$/);
  const check=value=>{validateTicker(value);if(tickerScope&&tickerScope!==value)throw new RangeError('This chat is scoped to the selected contract');};
  const output=value=>({content:[{type:'text',text:JSON.stringify(boundPacket(value))}]});
  if(positionScope){
    const position=parsePositionReview(positionScope);
    if(position.ticker!==tickerScope)throw new RangeError('Review is scoped to the selected position.');
    server.registerTool('review_paper_position',{description:'Compare a scoped paper position’s modeled hold value to net executable bids. Returns sourced risk context and does not place orders.',
      inputSchema:{ticker},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},async(input,{signal})=>{
      check(input.ticker);
      return output(await reviewPaperPosition(position,{signal,dependencies}));
    });
    return server;
  }
  const register=(name,description,inputSchema,handler)=>server.registerTool(name,{description,inputSchema,
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},async input=>{
      try{if(input.ticker)check(input.ticker);}
      catch(error){return {isError:true,...output({status:'unavailable',reason:error.message})};}
      try{return output(await handler(input));}
      catch{return {isError:true,...output({status:'unavailable',reason:'The selected public research source is temporarily unavailable.'})};}
    });
  register('get_contract','Read the selected public contract rules, exact outcome identity and current public order book. No account or order access.',{ticker},async({ticker})=>{
    const [detail,observed]=await Promise.all([deps.marketDetails(ticker),deps.book(ticker,1).catch(()=>null)]);
    const m=detail?.market,age=Date.now()-Date.parse(observed?.as_of);
    if(m?.ticker!==ticker)throw new Error('Mismatched market details');
    const depth=observed?.ticker===ticker&&age>=-5000&&age<=90000&&observed.metrics?.book_state!=='crossed'?observed:null;
    const levels=side=>(depth?.raw?.orderbook_fp?.[side]||[]).map(([price,quantity])=>({bid_price_usd_per_contract:number(price),quantity_contracts:number(quantity)}))
      .filter(row=>Number.isFinite(row.bid_price_usd_per_contract)&&row.bid_price_usd_per_contract>=0&&row.bid_price_usd_per_contract<=1&&Number.isFinite(row.quantity_contracts)&&row.quantity_contracts>0)
      .sort((a,b)=>b.bid_price_usd_per_contract-a.bid_price_usd_per_contract).slice(0,12);
    return {ticker,market:{ticker:m.ticker,event_ticker:m.event_ticker,title:m.title,yes_sub_title:m.yes_sub_title,status:m.status,
      result:m.result,close_time:m.close_time,expected_expiration_time:m.expected_expiration_time},
      rules:{primary:String(m.rules_primary||'').slice(0,5000),secondary:String(m.rules_secondary||'').slice(0,2000)},as_of:detail.as_of,
      quotes:{unit:'USD per contract with a $1 binary settlement payout',yes_ask_usd:depth?.metrics?.book_ask??null,
        no_ask_usd:Number.isFinite(depth?.metrics?.book_bid)?Math.round((1-depth.metrics.book_bid)*1e8)/1e8:null,
        costs_note:'Visible asks exclude entry fees, slippage and quantity-dependent depth. Quote percentages are not independent model probabilities.'},
      account_balances_available:false,book:{status:depth?'available':'unavailable',as_of:depth?.as_of,yes_bid_levels:levels('yes_dollars'),no_bid_levels:levels('no_dollars'),
        note:depth?'Displayed quantities are public bid liquidity in contracts. Buying YES uses opposite NO bids at 1 minus bid price, and conversely for buying NO.':
          'A fresh, matching order book was unavailable.'},
      sources:[{label:'Kalshi contract',url:detail.source_url,retrieved_at:detail.as_of},...(depth?[{label:'Kalshi order book',url:depth.source_url,retrieved_at:depth.as_of}]:[])]};
  });
  register('get_research','Read public research, paper scenarios, price history models and attributed reporting for the selected contract.',{ticker},async({ticker})=>{
    const research=await deps.workspaceResearch(ticker,{assistant:true,model:modelScope,
      ...(/^KXNBAGAME-/.test(ticker)?{refreshAvailability:true}:{})}),packet=publicResearch(research);
    if(research.market?.ticker!==ticker||(Object.keys(dependencies).length&&!dependencies.contractEvidence))return packet;
    const evidence=await deps.contractEvidence(research.market,{enabled:true,selectedTicker:ticker,redditEnabled:false,includeX:false,headlineMode:'official',
      sports:research.extensions?.sports,settlementSources:research.rules?.settlement_sources}).catch(()=>null);
    const matches=[...(evidence?.items||[]),...(evidence?.related_items||[])].filter(row=>row.url&&row.title).slice(0,3);
    const links=(evidence?.source_links||[]).filter(row=>row.url).slice(0,2);
    return {...packet,evidence:matches.map(row=>({title:String(row.title).slice(0,180),url:row.url,publisher:row.publisher,
      excerpt:String(row.excerpt||'').slice(0,300),match_scope:row.match_scope})),
      sources:[...links,...matches.map(row=>({label:row.publisher||'Attributed reporting',url:row.url})),...packet.sources].slice(0,8)};
  });
  register('get_price_history','Read observed exchange candle closes. Gaps are not filled and quote midpoints are labeled.',{ticker,hours:z.enum(['24','168']).default('24')},async({ticker,hours})=>{
    const value=await deps.contractHistory(ticker,Number(hours));
    const rows=value.rows.slice(-120).map(({time,value:price,volume,value_kind,midpoint})=>({time,value_kind,midpoint,price_usd_per_contract:price,volume_contracts:volume}));
    const history={...value,units:{price:'USD per contract',volume:'Contracts'},
      window_hours:Number(hours),available_observations:value.rows.length,
      sources:value.source_url?[{label:'Kalshi public price candles',url:value.source_url,retrieved_at:value.as_of}]:[]};
    const packet=sample=>({...history,rows:sample,sample_truncated:sample.length<value.rows.length});
    const full=packet(rows);
    return Buffer.byteLength(JSON.stringify(full))<=14000?full:packet(rows.slice(-48));
  });
  register('get_source_status','Read public provider availability and warehouse coverage counts. No credentials or private records.',{},async()=>({as_of:new Date().toISOString(),providers:deps.providerStatus(),warehouse:await deps.warehouseStatus()}));
  register('search_retained_evidence','Search only already retained public evidence for the selected ticker using lexical and real local semantic retrieval. Returns bounded source citations. Does not load news/social feeds, index private data, change probabilities or access journals. If empty, the user must explicitly Load contract news.',{ticker,query:z.string().min(3).max(300),limit:z.number().int().min(1).max(8).default(6)},async({ticker,query,limit})=>deps.searchRetainedEvidence(ticker,query,{limit}));
  register('analyze_execution_lab','Compare the selected contract execution schedule, continuous observed order flow, quote-arrival clustering and inventory-risk scenarios using the user-selected lab controls. Missing live sequences remain unavailable. The result cannot change the independent outcome forecast or access accounts. Parameter assumptions and failed validation gates must be preserved.',{ticker},async({ticker})=>executionToolPacket(await deps.workspaceExecutionResearch(ticker,{controls:executionControls,model:modelScope})));
  return server;
}
export async function localPositionReview(position,{signal,dependencies}={}){
  const input=parsePositionReview(position);
  const server=createResearchServer({tickerScope:input.ticker,modelScope:input.model,positionScope:input,dependencies});
  const client=new Client({name:'predictir-paper-review',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(serverTransport);
    await client.connect(clientTransport,{signal,timeout:1000});
    const result=await client.callTool({name:'review_paper_position',arguments:{ticker:input.ticker}},undefined,{signal,timeout:7000});
    if(result.isError)throw new Error('The position review could not complete.');
    const packet=JSON.parse(result.content?.find(part=>part.type==='text')?.text||'{}');
    if(packet.ticker!==input.ticker||!['HOLD','SELL','REVIEW','SETTLE'].includes(packet.action))throw new Error('The review result did not match this paper position.');
    return packet;
  }finally{await client.close();}
}

export async function handleMCP(req,res,body,options={}){
  if(req.method!=='POST'){res.writeHead(405,{'Content-Type':'application/json'});return res.end(JSON.stringify({jsonrpc:'2.0',error:{code:-32000,message:'Use Streamable HTTP POST'},id:null}));}
  const server=createResearchServer(options),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  const close=()=>{transport.close().catch(()=>{});server.close().catch(()=>{});};
  res.on('close',close);
  try{await server.connect(transport);await transport.handleRequest(req,res,body);}
  catch(error){close();if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',error:{code:-32603,message:'Research transport unavailable'},id:null}));}}
}
