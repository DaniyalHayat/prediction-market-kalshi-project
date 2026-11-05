export function screenRefreshDelay(value){
  const rows=[...(value?.candidates||[]),...(value?.watchlist||[])];
  if(!rows.length&&value?.ticker)rows.push(value);
  return rows.some(row=>row.inplay||Number.isFinite(row.max_source_age_seconds)&&row.max_source_age_seconds<=60)?20000:60000;
}
export function screenFreshness(row,{now=Date.now(),checkedAt,error}={}){
  if(error||row?.refresh_error)return {current:false,reason:'Refresh failed. The previous screen is withheld until its evidence can be checked again.'};
  const quote=Date.parse(row?.quote_as_of||row?.as_of||checkedAt||'');
  if(!Number.isFinite(quote)||quote>now+5000)return {current:false,reason:'A usable matching quote observation time is unavailable.'};
  let expires=quote+90000;
  const close=Date.parse(row?.close_time||'');if(Number.isFinite(close))expires=Math.min(expires,close);
  if(Number.isFinite(row?.probability)||Number.isFinite(row?.probability_yes)){
    const source=Date.parse(row.source_as_of||''),maximum=Number.isFinite(row.max_source_age_seconds)?Math.min(86400,Math.max(10,row.max_source_age_seconds)):row.inplay?30:86400;
    if(!Number.isFinite(source)||source>now+5000)return {current:false,reason:'The independent forecast source time could not be verified.'};
    expires=Math.min(expires,source+maximum*1000);
  }
  return now>=expires?{current:false,expires_at:expires,reason:'The matching quote, forecast source or contract window has expired. Refresh before using this screen.'}:
    {current:true,expires_at:expires,reason:null};
}
export function displayedOpinion(row,now=Date.now()){
  const freshness=screenFreshness(row,{now});
  return freshness.current?row:{...row,side:'STALE',stale:true,probability:null,interval:null,supported_allocation:0,reason:freshness.reason};
}
export function researchScreenOpinion(value,now=Date.now()){
  if(!value?.opinion)return null;
  return displayedOpinion({...value.opinion,probability:value.forecast?.probability,interval:value.forecast?.interval,
    source_as_of:value.forecast?.source_as_of,max_source_age_seconds:value.forecast?.max_source_age_seconds,
    as_of:value.as_of,quote_as_of:value.quote_as_of||value.sources?.find(row=>row.kind==='order_book')?.retrieved_at,
    inplay:Boolean(value.forecast?.inplay),close_time:value.market?.close_time,refresh_error:Boolean(value.error)},now);
}
export function createVisibleRefresh(run,{visible,onError=()=>{}}){
  let stopped=false,active=null,resumePending=false;
  async function refresh(force=false){
    if(stopped||!visible())return;
    if(active){if(force)resumePending=true;return;}
    const controller=new AbortController();active=controller;
    try{await run(controller.signal,force);}
    catch(error){if(!controller.signal.aborted&&!stopped)onError(error);}
    finally{if(active===controller)active=null;if(resumePending&&!stopped&&visible()){resumePending=false;queueMicrotask(()=>refresh(true));}}
  }
  return {refresh,visibilityChanged(){if(!visible()){resumePending=false;active?.abort();}else refresh(true);},
    stop(){stopped=true;resumePending=false;active?.abort();}};
}
