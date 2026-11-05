export function researchRefreshDelay(value){return value?.forecast?.max_source_age_seconds<=60?20000:60000;}
export function mergeResearchRefresh(previous,next){
  if(!previous||previous.ticker!==next?.ticker||previous.view_model!==next.view_model)return next;
  const extensions={...previous.extensions,...next.extensions};
  if(next.extensions?.sports)extensions.sports={...next.extensions.sports,availability:previous.extensions?.sports?.availability||[],
    availability_note:previous.extensions?.sports?.availability_note};
  const sources=[...new Map([...(previous.sources||[]),...(next.sources||[])].filter(row=>row?.url).map(row=>[row.url,row])).values()];
  return {...next,news:next.news?.status==='not_queried'?previous.news:next.news,extensions,sources};
}
