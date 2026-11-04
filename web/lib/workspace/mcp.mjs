import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';
import {marketDetails,book,validateTicker} from '../live.mjs';
import {workspaceResearch,contractHistory} from './router.mjs';
import {providerStatus} from './providers.mjs';
import {warehouseStatus} from './warehouse.mjs';

export function publicResearch(value){
  const music=value.extensions?.music;
  return {ticker:value.ticker,title:value.title,as_of:value.as_of,status:value.status,summary:value.summary,opinion:value.opinion,
    forecast:value.forecast,decision:value.decision,drivers:value.drivers,rules:value.rules,sources:(value.sources||[]).filter(s=>!s.url?.includes('api.spotify.com')),
    errors:value.errors,extensions:{sports:value.extensions?.sports,music:music?{scope:music.scope,comparability:music.comparability,
      forecast:music.forecast,persistence:music.persistence,source_updated:music.apple?.source_updated,scope_note:music.apple?.note}:undefined}};
}
export function boundPacket(value,maximum=14000){
  if(Buffer.byteLength(JSON.stringify(value))<=maximum)return value;
  const lean={ticker:value.ticker,title:value.title,as_of:value.as_of,summary:value.summary,opinion:value.opinion,
    forecast:value.forecast,decision:value.decision,sources:value.sources,scope:'Additional details omitted to keep the research packet bounded.'};
  if(Buffer.byteLength(JSON.stringify(lean))<=maximum)return lean;
  return {ticker:String(value.ticker||'').slice(0,140),reason:'The source packet exceeded the display bound. Ask for specific rules, prices or source status.'};
}
export function createResearchServer({tickerScope,dependencies={}}={}) {
  const deps={marketDetails,book,workspaceResearch,contractHistory,warehouseStatus,providerStatus,...dependencies};
  const server=new McpServer({name:'kalshi-market-lab',version:'4.0.0'});
  if(tickerScope)validateTicker(tickerScope);
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
    return {ticker,market:{ticker:m.ticker,event_ticker:m.event_ticker,title:m.title,yes_sub_title:m.yes_sub_title,status:m.status,
      result:m.result,close_time:m.close_time,expected_expiration_time:m.expected_expiration_time},
      rules:{primary:String(m.rules_primary||'').slice(0,5000),secondary:String(m.rules_secondary||'').slice(0,2000)},as_of:detail.as_of,book:{as_of:depth.as_of,metrics:depth.metrics,
      raw:{orderbook_fp:Object.fromEntries(Object.entries(depth.raw.orderbook_fp).filter(([side,rows])=>['yes_dollars','no_dollars'].includes(side)&&Array.isArray(rows)).map(([side,rows])=>[side,rows.slice(0,12)]))}},
      sources:[{label:'Kalshi contract',url:detail.source_url,retrieved_at:detail.as_of},{label:'Kalshi order book',url:depth.source_url,retrieved_at:depth.as_of}]};
  });
  register('get_research','Read deterministic public research, uncertainty, validation, cost screen and evidence gaps for the selected contract. Does not contain Spotify catalog content or private journals.',{ticker},async({ticker})=>publicResearch(await deps.workspaceResearch(ticker,{assistant:true})));
  register('get_price_history','Read observed exchange candle closes. Gaps are not filled and quote midpoints are labeled.',{ticker,hours:z.enum(['24','168']).default('24')},async({ticker,hours})=>{
    const value=await deps.contractHistory(ticker,Number(hours));return {...value,rows:value.rows.slice(-120)};
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
