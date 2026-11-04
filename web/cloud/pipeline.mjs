import {randomUUID} from 'node:crypto';
import {store} from '../lib/cloud/store.mjs';
import {settleDue} from '../lib/cloud/journal.mjs';
import {workspaceGET} from '../lib/workspace/router.mjs';
import {appleChart} from '../lib/workspace/music.mjs';
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
  const dispatch={catalog:input=>workspaceGET('workspace/markets',new URLSearchParams(input)),apple:()=>appleChart(),settlement:()=>settleDue(12),...handlers};
  try{
    if(!dispatch[job.kind])throw new Error('Unknown job kind');await dispatch[job.kind](job.input);
    const completed=await s.db.query("UPDATE market_lab.jobs SET state='complete',finished_at=now(),locked_until=NULL WHERE key=$1 AND owner=$2 AND state='running' AND locked_until>now() RETURNING key",[job.key,owner]);
    return {kind:job.kind,status:completed.rowCount?'complete':'lease_lost'};
  }catch(error){
    const changed=await s.db.query(`UPDATE market_lab.jobs SET state=CASE WHEN attempts>=4 THEN 'failed' ELSE 'pending' END,
      available_at=now()+least(3600,power(2,attempts)*60)*interval '1 second',locked_until=NULL,error_code=$3
      WHERE key=$1 AND owner=$2 AND state='running' AND locked_until>now() RETURNING state`,[job.key,owner,String(error.status||error.code||'SOURCE_UNAVAILABLE').slice(0,80)]);
    return {kind:job.kind,status:!changed.rowCount?'lease_lost':changed.rows[0].state==='failed'?'failed':'retry_scheduled'};
  }
}
export function startPipeline(){
  if(!process.env.DATABASE_URL||process.env.MARKET_PIPELINE_ENABLED!=='1')return ()=>{};
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{const s=store();await enqueuePipeline(s);const result=await runPipelineJob(s);if(result)console.log(JSON.stringify({event:'pipeline',...result}));}catch{console.log(JSON.stringify({event:'pipeline',status:'storage_unavailable'}));}finally{running=false;}};
  const timer=setInterval(tick,60000);timer.unref();tick();return ()=>clearInterval(timer);
}
