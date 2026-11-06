import {buildSchema,execute,parse,validate} from 'graphql';
import {validateTicker} from '../live.mjs';
import {HEADLINE_REPLAY_MAX_BYTES,HEADLINE_REPLAY_TIMEOUT_MS,readProxyBody} from './proxy.mjs';
import {contractHistory,workspaceEvidence} from './router.mjs';

const schema=buildSchema(`
  enum ReplayModel { baseline validated challenger }
  enum ReplayStatus { ready partial unavailable }
  type Headline {
    title: String!
    publisher: String
    url: String!
    as_of: String!
    platform: String
    match_scope: String!
    time_basis: String
    confidence: String
  }
  type Evidence {
    ticker: String!
    as_of: String
    items: [Headline!]!
  }
  type Quote {
    time: String!
    value: Float!
    value_kind: String!
    midpoint: Float!
  }
  type History {
    ticker: String!
    as_of: String
    source_url: String
    rows: [Quote!]!
  }
  type HeadlineReplay {
    ticker: String!
    model: ReplayModel!
    status: ReplayStatus!
    unavailable_sources: [String!]!
    evidence: Evidence
    history: History
  }
  type Query {
    headlineReplay(ticker: String!, model: ReplayModel!): HeadlineReplay!
  }
`);
const operation='HeadlineReplay';
const document=parse(`
  query HeadlineReplay($ticker: String!, $model: ReplayModel!) {
    headlineReplay(ticker: $ticker, model: $model) {
      ticker model status unavailable_sources
      evidence { ticker as_of items { title publisher url as_of platform match_scope time_basis confidence } }
      history { ticker as_of source_url rows { time value value_kind midpoint } }
    }
  }
`);
if(validate(schema,document).length)throw new Error('Invalid persisted headline replay operation');

const text=(value,limit)=>typeof value==='string'&&value.length?value.slice(0,limit):null;
const time=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value))?value:null;
const price=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
function publicURL(value){
  if(typeof value!=='string'||value.length>1000)return null;
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;
  }catch{return null;}
}

function replayEvidence(value,ticker){
  if(value?.ticker!==ticker||!Array.isArray(value.items))return null;
  const items=value.items.slice(0,30).flatMap(row=>{
    if(row?.match_scope!=='matched'||['reddit','x'].includes(row.platform))return [];
    const url=publicURL(row.url),title=text(row.title,300),as_of=time(row.as_of);
    if(!url||!title||!as_of)return [];
    return [{title,url,as_of,publisher:text(row.publisher,120),platform:text(row.platform,40),
      match_scope:'matched',time_basis:text(row.time_basis,60),confidence:text(row.confidence,60)}];
  });
  const publisherChecked=value.feeds?.some(feed=>feed.kind==='publisher'&&['available','empty','live','partial'].includes(feed.status));
  return items.length||publisherChecked?{ticker,as_of:time(value.as_of),items}:null;
}

function replayHistory(value,ticker){
  if(value?.ticker!==ticker||!Array.isArray(value.rows))return null;
  const rows=value.rows.slice(-1500).flatMap(row=>{
    const observed=time(row?.time);
    const midpoint=price(row?.midpoint)?row.midpoint:row?.value_kind==='quoted_midpoint'&&price(row.value)?row.value:null;
    return observed&&midpoint!==null?[{time:observed,value:midpoint,midpoint,value_kind:'quoted_midpoint'}]:[];
  });
  return {ticker,as_of:time(value.as_of),source_url:publicURL(value.source_url),rows};
}

function readSource(load,signal){
  if(signal.aborted)return Promise.resolve(null);
  return new Promise(resolve=>{
    const finish=value=>{signal.removeEventListener('abort',abort);resolve(value);};
    const abort=()=>finish(null);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(load).then(finish,abort);
  });
}

async function headlineReplay({ticker,model},{getEvidence,getHistory,signal}){
  const [rawEvidence,rawHistory]=await Promise.all([
    readSource(()=>getEvidence(ticker,{model,retain:false}),signal),
    readSource(()=>getHistory(ticker,24),signal)
  ]);
  const evidence=replayEvidence(rawEvidence,ticker),history=replayHistory(rawHistory,ticker);
  const unavailable_sources=[...(!evidence?['evidence']:[]),...(!history?['history']:[])];
  const status=unavailable_sources.length===0?'ready':unavailable_sources.length===1?'partial':'unavailable';
  return {ticker,model,status,unavailable_sources,evidence,history};
}

const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const reject=(message,status)=>Response.json({errors:[{message}]},{status,headers});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export async function headlineReplayGraphQL(request,{getEvidence=workspaceEvidence,getHistory=contractHistory,timeoutMs=HEADLINE_REPLAY_TIMEOUT_MS}={}){
  if(request.method!=='POST')return reject('Use POST for the headline replay operation.',405);
  if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')return reject('Use application/json.',415);
  let body;
  try{body=JSON.parse(await readProxyBody(request,HEADLINE_REPLAY_MAX_BYTES));}
  catch(error){return reject(error.status===413?'Headline replay request is too large.':'Request must be valid JSON.',error.status===413?413:400);}
  if(!object(body)||Object.keys(body).length!==2||body.operationName!==operation||!object(body.variables)||
    Object.keys(body.variables).length!==2||!Object.hasOwn(body.variables,'ticker')||!Object.hasOwn(body.variables,'model'))
    return reject('Use the registered HeadlineReplay operation with ticker and model variables.',400);
  const {ticker,model}=body.variables;
  try{validateTicker(ticker);}catch{return reject('Choose a valid public contract ticker.',400);}
  if(!['baseline','validated','challenger'].includes(model))return reject('Choose a supported research model.',400);
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(timeoutMs)]);
  const result=await execute({schema,document,operationName:operation,variableValues:{ticker,model},
    rootValue:{headlineReplay:args=>headlineReplay(args,{getEvidence,getHistory,signal})}});
  if(result.errors?.length)return reject('Headline replay is temporarily unavailable.',503);
  return Response.json(result,{headers});
}
