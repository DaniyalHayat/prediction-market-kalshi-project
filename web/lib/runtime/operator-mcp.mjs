import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {buildOperatorReport} from './operator.mjs';
import {assessOperatorSre} from './operator-sre.mjs';

export function operatorReview(profile,{snapshot={},allowances={},now=Date.now()}={}){
  const runtime=buildOperatorReport(snapshot);
  const sre=assessOperatorSre({logs:snapshot.logs,requestThrottles:snapshot.telemetry?.request_throttles,allowances,now});
  const header={as_of:new Date(now).toISOString(),profile,changes_applied:false};
  if(profile==='runtime')return {...header,...runtime,throttles:sre.findings.filter(row=>row.kind==='throttle_cause')};
  if(profile==='sources')return {...header,
    providers:Object.fromEntries(Object.entries(runtime.percentiles.distributions).filter(([key])=>key.startsWith('provider:'))),
    proposals:runtime.proposals.filter(row=>row.dimension?.startsWith('provider:')),
    scope:'Measured provider requests from this backend process. No additional provider reads are triggered.'};
  if(profile==='allowances')return {...header,usage:sre.usage,usage_as_of:sre.usage_as_of,
    findings:sre.findings.filter(row=>row.kind==='allowance_pressure'),limitations:sre.limitations};
  throw new RangeError('Choose runtime, sources or allowances.');
}

export function createOperatorMCP({readSnapshot,readAllowances,now=Date.now}){
  const server=new McpServer({name:'predictir-operations',version:'1.0.0'});
  const profiles=[
    ['review_runtime','runtime','Review measured API latency, failures and stream throttles. Return evidence and proposed actions.'],
    ['review_sources','sources','Review measured source retrieval latency and failures without starting external data collection.'],
    ['review_allowances','allowances','Review stored application allowances and highlight pressure before changing budgets.']
  ];
  for(const [name,profile,description] of profiles)server.registerTool(name,{
    description,inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}
  },async()=>{
    const snapshot=profile==='allowances'?{}:await readSnapshot();
    const allowances=profile==='allowances'?await readAllowances():{};
    const value=operatorReview(profile,{snapshot,allowances,now:now()});
    return {content:[{type:'text',text:JSON.stringify(value)}]};
  });
  return server;
}

export async function handleOperatorMCP(req,res,body,dependencies){
  const server=createOperatorMCP(dependencies);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  const close=()=>{transport.close().catch(()=>{});server.close().catch(()=>{});};
  res.on('close',close);
  try{await server.connect(transport);await transport.handleRequest(req,res,body);}
  catch{
    close();
    if(!res.headersSent){res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({jsonrpc:'2.0',error:{code:-32603,message:'Operational review unavailable'},id:null}));}
  }
}
