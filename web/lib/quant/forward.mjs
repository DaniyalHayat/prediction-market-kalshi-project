import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request, book, marketDetails, trades, validateTicker, number } from "../live.mjs";
import { researchReport } from "../intelligence/index.mjs";
import { categoryById } from "../intelligence/catalog.mjs";
import { STRATEGY_VERSION, STRATEGIES, bookState, normalizeCandles, minuteRidge, irregularOU, relativeValueSurface, signalTargets, freezeDecision, scoreMarkout, summarizeForward } from "./signals.mjs";

export const BALANCED_UNIVERSE=["crypto","weather","labor","inflation","travel"];
const directory=join(tmpdir(),"kalshi-quant-forward-v2");
const state=globalThis[Symbol.for("kalshi.quant.forward.v2")] ||= {starting:null,candles:new Map(),nextStart:0};
state.checkpoints ||= new Map();
export const canonical=value=>JSON.stringify(value,(_,v)=>v && typeof v==="object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
export const digest=value=>createHash("sha256").update(canonical(value)).digest("hex");
class ForwardError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
export function normalizeProtocol(input={}) {
  if(!input || typeof input!=="object" || Array.isArray(input))throw new ForwardError("Protocol must be a JSON object");
  const categories=input.categories || BALANCED_UNIVERSE;
  if(!Array.isArray(categories) || !categories.length || categories.length>5 || new Set(categories).size!==categories.length)throw new ForwardError("Choose distinct supported categories");
  categories.forEach(categoryById);
  if(["seconds","per_category","contracts","slippage","coefficient"].some(key=>typeof input[key]==="boolean"))throw new ForwardError("Numerical protocol fields cannot be booleans");
  const protocol={categories:[...categories],seconds:Number(input.seconds ?? 60),per_category:Number(input.per_category ?? 1),
    contracts:Number(input.contracts ?? 10),slippage:Number(input.slippage ?? 2),coefficient:Number(input.coefficient ?? .07),min_edge:.005};
  if(![60,300,900].includes(protocol.seconds) || ![1,2].includes(protocol.per_category) ||
    !Number.isInteger(protocol.contracts) || protocol.contracts<1 || protocol.contracts>1000 ||
    !Number.isFinite(protocol.slippage) || protocol.slippage<0 || protocol.slippage>5 ||
    !Number.isFinite(protocol.coefficient) || protocol.coefficient<0 || protocol.coefficient>1)throw new ForwardError("Invalid frozen forward-test protocol");
  return protocol;
}
export function selectBalanced(reports,protocol,now=Date.now()) {
  const selected=[],exclusions=[];
  for(const id of protocol.categories) {
    const report=reports.find(row=>row.category.id===id);
    const rows=(report?.markets || []).filter(row=>{
      const bid=number(row.yes_bid),ask=number(row.yes_ask);
      return bid!==null && ask!==null && bid>=0 && ask<=1 && bid<=ask && ask-bid<=.12 &&
        (bid+ask)/2>.02 && (bid+ask)/2<.98 && Date.parse(row.close_time)>now+(protocol.seconds+60)*1000;
    }).sort((a,b)=>(b.volume_24h || 0)-(a.volume_24h || 0) || (a.yes_ask-a.yes_bid)-(b.yes_ask-b.yes_bid));
    const events=new Set(),choices=[];
    for(const row of rows)if(!events.has(row.event_ticker)){choices.push(row);events.add(row.event_ticker);if(choices.length===protocol.per_category)break;}
    // If one event is all that exists, retain an explicitly correlated second contract.
    if(choices.length<protocol.per_category)for(const row of rows)if(!choices.some(item=>item.ticker===row.ticker)){choices.push(row);if(choices.length===protocol.per_category)break;}
    selected.push(...choices.map(market=>({category:id,market})));
    if(choices.length<protocol.per_category)exclusions.push({category:id,reason:"Insufficient liquid, two-sided contracts beyond the frozen horizon",selected:choices.length});
  }
  return {selected,exclusions};
}
async function mapLimit(items,limit,callback) {
  const result=Array(items.length);let next=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){const index=next++;result[index]=await callback(items[index],index);}
  }));
  return result;
}
export async function marketCandles(category,ticker) {
  validateTicker(ticker);const config=categoryById(category),series=config.series.find(id=>ticker.startsWith(id+"-"));
  if(!series)throw new ForwardError("Ticker/category mismatch");
  const end=Math.floor(Date.now()/60000)*60-1,key=`${ticker}:${end}:24h`;
  if(state.candles.has(key))return state.candles.get(key);
  const promise=request(`/series/${series}/markets/${encodeURIComponent(ticker)}/candlesticks`,{
    start_ts:String(end-24*3600),end_ts:String(end),period_interval:"1",include_latest_before_start:"false"
  }).then(result=>({rows:normalizeCandles(result.data,end),as_of:result.as_of,source_url:result.source_url,sha256:result.sha256,cutoff_seconds:end}));
  state.candles.set(key,promise);
  while(state.candles.size>100)state.candles.delete(state.candles.keys().next().value);
  try{return await promise;}catch(error){state.candles.delete(key);throw error;}
}
async function archive(id,type,content,previous=null) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const entry={type,recorded_at:new Date().toISOString(),previous,content};
  entry.hash=digest(entry);
  const path=join(directory,`${id}.jsonl`);
  if(type==="freeze")await fs.writeFile(path,JSON.stringify(entry)+"\n",{flag:"wx",mode:0o600});
  else await fs.appendFile(path,JSON.stringify(entry)+"\n",{mode:0o600});
  return entry;
}
export async function readForward(id) {
  if(!/^[a-f0-9-]{36}$/.test(id))throw new ForwardError("Invalid cohort ID");
  const path=join(directory,`${id}.jsonl`);
  let text;
  try {
    const info=await fs.stat(path);
    if(info.size>4000000)throw new ForwardError("Cohort exceeds archive bound",503);
    text=await fs.readFile(path,"utf8");
  } catch(error) {
    if(error.code==="ENOENT")throw new ForwardError("Cohort is not available on this server instance. Import/export is local; no shared cloud store is configured.",404);
    throw error;
  }
  const entries=text.trim().split("\n").map(line=>JSON.parse(line));
  const previous=verifyAuditEntries(entries);
  const frozen=entries[0].content,result=entries.find(row=>row.type==="markout")?.content || null;
  return {id,status:result ? "completed" : "pending",frozen,result,server_time:new Date().toISOString(),
    audit_headers:entries.map(({content,...header})=>header),
    protocol_hash:digest({version:frozen.strategy_version,protocol:frozen.protocol}),
    audit:{entries:entries.length,freeze_hash:entries[0].hash,last_hash:previous,verified:true},
    storage:"Bounded, server-local hash-chained files; may be unavailable after deployment or on another instance. Export for durable independent review."};
}
export function verifyAuditEntries(entries) {
  if(!entries.length || entries[0].type!=="freeze" || entries.length>2 || entries.length===2 && entries[1].type!=="markout")throw new ForwardError("Invalid audit event sequence",409);
  let previous=null;
  for(const entry of entries) {
    const {hash,...payload}=entry;
    if(entry.previous!==previous || digest(payload)!==hash)throw new ForwardError("Audit-chain verification failed",409);
    previous=hash;
  }
  return previous;
}
export async function startForward(input={}) {
  const protocol=normalizeProtocol(input);
  if(state.starting)throw new ForwardError("A cohort is already freezing on this server; wait for it to finish",429);
  if(Date.now()<state.nextStart)throw new ForwardError("Cohort starts are limited to one per minute per server",429);
  state.starting=true;
  try {
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    if((await fs.readdir(directory)).filter(file=>file.endsWith(".jsonl")).length>=60)throw new ForwardError("Server-local archive is full. Export and rotate the local archive before starting another cohort.",503);
    const reportResults=await mapLimit(protocol.categories,2,async id=>{
      try{return {report:await researchReport(id)};}catch(error){return {error:{category:id,error:error.message}};}
    });
    const reports=reportResults.filter(row=>row.report).map(row=>row.report);
    const {selected,exclusions}=selectBalanced(reports,protocol);
    const surfaces=new Map(reports.map(report=>[report.category.id,relativeValueSurface(report.markets)]));
    const legs=await mapLimit(selected,2,async({category,market})=>{
      try {
        // History/tape/rules are fetched first. The entry book is fetched last so
        // no newer information can be smuggled into an older hypothetical entry.
        const [detail,candles,tape]=await Promise.all([
          marketDetails(market.ticker),marketCandles(category,market.ticker).catch(error=>({rows:[],error:error.message})),
          trades(market.ticker).catch(error=>({trades:[],error:error.message}))
        ]);
        const depth=await book(market.ticker,protocol.contracts),frozenAt=Date.now();
        if(frozenAt-Date.parse(depth.as_of)>5000)throw new Error("Entry book is too old to freeze");
        if(Date.parse(detail.market.close_time)<=frozenAt+(protocol.seconds+30)*1000)throw new Error("Contract closes too soon for the frozen horizon");
        const ridge=minuteRidge(candles.rows,protocol.seconds),ou=irregularOU(candles.rows,bookState(depth.raw).mid,protocol.seconds);
        const targets=signalTargets({raw:depth.raw,tape:tape.trades,ridge,ou,forecast:market,relative:surfaces.get(category)?.get(market.ticker),category,seconds:protocol.seconds});
        return {ticker:market.ticker,event_ticker:market.event_ticker,category,close_time:detail.market.close_time,title:market.title,
          frozen_at:new Date(frozenAt).toISOString(),due_at:new Date(frozenAt+protocol.seconds*1000).toISOString(),
          book_as_of:depth.as_of,book_source:depth.source_url,raw_entry_book:depth.raw,rules:detail.market.rules_primary,
          final_outcome_probability:market.probability ?? null,final_probability_band:market.interval || null,
          final_model_evidence:market.evidence,source_as_of:market.source_as_of,source_sha256:market.source_sha256,
          candle_provenance:{source_url:candles.source_url,as_of:candles.as_of,sha256:candles.sha256,cutoff_seconds:candles.cutoff_seconds,error:candles.error},
          candle_archive:candles.rows,
          ridge,ou,features:{book_mid:targets.book.mid,spread:targets.book.spread,...targets.features},
          signals:targets.signals.map(signal=>({...signal,decision:freezeDecision(depth.raw,signal,{
            contracts:protocol.contracts,slippage:protocol.slippage,coefficient:protocol.coefficient,minEdge:protocol.min_edge
          })})),tape_provenance:{as_of:tape.as_of,source_url:tape.source_url,error:tape.error}};
      } catch(error){return {ticker:market.ticker,category,error:error.message};}
    });
    const valid=legs.filter(leg=>!leg.error);
    if(!valid.length)throw new ForwardError("No valid entry snapshots could be frozen: "+legs.map(row=>row.error).join("; "),503);
    const id=randomUUID(),frozen={id,strategy_version:STRATEGY_VERSION,created_at:new Date().toISOString(),protocol,
      due_at:new Date(Math.max(...valid.map(leg=>Date.parse(leg.due_at)))).toISOString(),
      selection_policy:"Balanced per-category quota; liquidity ranking and event diversity fixed before any future prices. All predeclared strategies are reported, including abstentions and losses.",
      strategies:STRATEGIES,legs,exclusions:[...exclusions,...reportResults.filter(row=>row.error).map(row=>row.error)],
      source_archives:reports.map(report=>({category:report.category.id,report_as_of:report.as_of,quote_lineage:report.quote_lineage,
        sources:report.sources,model_weights:report.model_weights,evaluation:report.evaluation,coverage:report.coverage})),
      classification:"Prospectively frozen, marketable-book paper experiments. Real observations; hypothetical fills. A 60-second price markout does not validate final settlement odds."};
    await archive(id,"freeze",frozen);state.nextStart=Date.now()+60000;
    return await readForward(id);
  } finally{state.starting=null;}
}
export async function checkpointForward(id) {
  if(state.checkpoints.has(id))return state.checkpoints.get(id);
  const task=collectCheckpoint(id);state.checkpoints.set(id,task);
  try{return await task;}finally{state.checkpoints.delete(id);}
}
async function collectCheckpoint(id) {
  const before=await readForward(id);
  if(before.result)return before;
  if(Date.now()<Date.parse(before.frozen.due_at))throw new ForwardError(`Future prices not yet observable; checkpoint is due at ${before.frozen.due_at}`,409);
  const lockPath=join(directory,`${id}.lock`);
  let lock;
  try{lock=await fs.open(lockPath,"wx",0o600);}
  catch(error){
    if(error.code!=="EEXIST")throw error;
    // Another process on the same host may own the lock. Read its one result,
    // never collect a second, more favorable future snapshot.
    for(let attempt=0;attempt<40;attempt++){
      await new Promise(resolve=>setTimeout(resolve,250));
      const existing=await readForward(id);
      if(existing.result)return existing;
    }
    throw new ForwardError("Cohort checkpoint is still being collected; retry the same cohort",409);
  }
  try {
    const current=await readForward(id);
    if(current.result)return current;
    const valid=current.frozen.legs.filter(row=>!row.error);
    const markouts=await mapLimit(valid,2,async leg=>{
      try {
        const exit=await book(leg.ticker,current.frozen.protocol.contracts);
        const row=scoreMarkout(leg,exit.raw,exit.as_of,current.frozen.protocol);
        return {...row,exit_as_of:exit.as_of,exit_source:exit.source_url,raw_exit_book:exit.raw};
      }catch(error){return {ticker:leg.ticker,event_ticker:leg.event_ticker,category:leg.category,error:error.message};}
    });
    const result={recorded_at:new Date().toISOString(),markouts,summary:summarizeForward(markouts,valid.length,current.frozen.strategies),
      missing:markouts.filter(row=>row.error).length,late:markouts.filter(row=>!row.error && !row.on_time).length,
      classification:"Observed future-book markout with simulated marketable entry and liquidation. Entry/exit fees are assumptions; no order or actual fill was executed."};
    await archive(id,"markout",result,current.audit.last_hash);
    return await readForward(id);
  } finally {await lock.close();await fs.unlink(lockPath).catch(()=>{});}
}
export async function listForward() {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const names=(await fs.readdir(directory)).filter(name=>/^[a-f0-9-]{36}\.jsonl$/.test(name));
  const runs=[],compact=[];
  for(const name of names) {
    try {
      const value=await readForward(name.slice(0,-6));
      runs.push({id:value.id,status:value.status,created_at:value.frozen.created_at,due_at:value.frozen.due_at,
        categories:value.frozen.protocol.categories,legs:value.frozen.legs.filter(row=>!row.error).length,
        protocol_hash:value.protocol_hash,summary:value.result?.summary || null,audit:value.audit});
      compact.push({id:value.id,frozen:{strategy_version:value.frozen.strategy_version,protocol:value.frozen.protocol,
        strategies:value.frozen.strategies,created_at:value.frozen.created_at,legs:value.frozen.legs.map(leg=>({error:leg.error}))},
        result:value.result ? {markouts:value.result.markouts.map(({raw_exit_book,...mark})=>mark)} : null});
    }catch(error){runs.push({id:name.slice(0,-6),status:"integrity error",error:error.message});}
  }
  runs.sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  return {runs,aggregates:aggregateForwardRuns(compact),storage:"Server-local only; not a shared hosted database",as_of:new Date().toISOString()};
}
export function aggregateForwardRuns(runs) {
  const groups=new Map();
  for(const run of runs) {
    const key=digest({version:run.frozen.strategy_version,protocol:run.frozen.protocol});
    if(!groups.has(key))groups.set(key,{protocol_hash:key,strategy_version:run.frozen.strategy_version,
      protocol:run.frozen.protocol,strategies:run.frozen.strategies || STRATEGIES,cohorts:0,pending_cohorts:0,expected:0,markouts:[]});
    const group=groups.get(key);group.cohorts++;group.expected+=run.frozen.legs.filter(leg=>!leg.error).length;
    if(run.result)group.markouts.push(...run.result.markouts);
    else group.pending_cohorts++;
  }
  const familySize=[...groups.values()].reduce((sum,group)=>sum+group.strategies.length,0);
  return [...groups.values()].map(({markouts,expected,strategies,...group})=>({...group,registered_protocols:groups.size,multiple_testing_family_size:familySize,
    summary:summarizeForward(markouts,expected,strategies,familySize)}));
}
