import {randomUUID} from 'node:crypto';
import {store} from '../lib/cloud/store.mjs';
import {settleDue} from '../lib/cloud/journal.mjs';
import {workspaceMarkets} from '../lib/workspace/catalog.mjs';
import {retainMarketHistory} from '../lib/workspace/warehouse.mjs';
import {appleChart} from '../lib/workspace/music.mjs';
import {structuredLog} from '../lib/runtime-observability.mjs';
import {sourceFailureDetails} from '../lib/workspace/providers.mjs';
export async function enqueuePipeline(s=store(),now=Date.now()){
  const hour=Math.floor(now/3600000),quarter=Math.floor(now/900000);
  const jobs=[...['sports','macro','crypto','travel','weather','science','climate','culture'].map(category=>({key:`catalog#${category}#${hour}`,kind:'catalog',input:{category}})),
    {key:'apple#'+hour,kind:'apple',input:{}},{key:'settlement#'+quarter,kind:'settlement',input:{}}];
  for(const job of jobs)await s.db.query('INSERT INTO market_lab.jobs(key,kind,input) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[job.key,job.kind,job.input]);
}
export async function runPipelineJob(s=store(),handlers={}){
  const owner=randomUUID(),claimed=await s.db.query(`WITH candidate AS (
    SELECT key FROM market_lab.jobs WHERE available_at<=now() AND attempts<4 AND
      (state='pending' OR(state='running' AND locked_until<now())) ORDER BY available_at,key FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE market_lab.jobs j SET state='running',owner=$1,locked_until=now()+interval '5 minutes',attempts=attempts+1
    FROM candidate c WHERE j.key=c.key RETURNING j.*`,[owner]);
  const job=claimed.rows[0];if(!job)return null;
  const dispatch={catalog:async input=>retainMarketHistory(await workspaceMarkets(input.category)),apple:()=>appleChart(),settlement:()=>settleDue(12),...handlers};
  try{
    if(!dispatch[job.kind])throw new Error('Unknown job kind');await dispatch[job.kind](job.input);
    const completed=await s.db.query("UPDATE market_lab.jobs SET state='complete',finished_at=now(),locked_until=NULL WHERE key=$1 AND owner=$2 AND state='running' AND locked_until>now() RETURNING key",[job.key,owner]);
    return {kind:job.kind,status:completed.rowCount?'complete':'lease_lost'};
  }catch(error){
    const failure=sourceFailureDetails(error);
    const changed=await s.db.query(`UPDATE market_lab.jobs SET state=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,
      available_at=now()+least(3600,power(2,attempts)*60)*interval '1 second',locked_until=NULL,error_code=$3
      WHERE key=$1 AND owner=$2 AND state='running' AND locked_until>now() RETURNING state`,[job.key,owner,failure.error_code]);
    return {kind:job.kind,status:!changed.rowCount?'lease_lost':changed.rows[0].state==='failed'?'failed':'retry_scheduled',...(changed.rowCount?{...failure,attempts:job.attempts}:{})};
  }
}
export function startPipeline(){
  if(!process.env.DATABASE_URL||process.env.MARKET_PIPELINE_ENABLED!=='1')return ()=>{};
  let running=false,stopped=false,processed=0,closeListener,reconnect;const drainWaiters=[];
  const tick=async()=>{
    if(running||stopped)return;running=true;processed=0;
    try{
      const s=store();await enqueuePipeline(s);
      for(;processed<4&&!stopped;processed++){const result=await runPipelineJob(s);if(!result)break;structuredLog('pipeline.job',{kind:result.kind,result:result.status,error_code:result.error_code,status:result.upstream_status,attempts:result.attempts});}
    }catch{structuredLog('pipeline.error',{error_code:'STORAGE_UNAVAILABLE'});}
    finally{running=false;for(const resolve of drainWaiters.splice(0))resolve();if(processed===4&&!stopped)setImmediate(tick);}
  };
  const attach=async()=>{
    if(stopped)return;
    try{
      const close=await store().listenJobs(tick,()=>{if(!stopped){reconnect=setTimeout(attach,5000);reconnect.unref();}});
      if(stopped)await close();else closeListener=close;
    }catch{if(!stopped){reconnect=setTimeout(attach,5000);reconnect.unref();}}
  };
  const timer=setInterval(tick,60000);timer.unref();tick();attach();
  return async()=>{stopped=true;clearInterval(timer);clearTimeout(reconnect);await closeListener?.();if(running)await new Promise(resolve=>drainWaiters.push(resolve));};
}
