import {request, normalizeMarket, validateTicker} from '../live.mjs';
import {recordProviderStatus} from './providers.mjs';
import {cloudEnabled,store} from '../cloud/store.mjs';
import {retainMarketHistory} from './warehouse.mjs';

export const WORKSPACE_CATEGORIES = [
  {id:'sports',name:'Sports',sourceCategories:['Sports'],preferred:['KXNBAGAME','KXNFLGAME','KXEPLGAME','KXUCLGAME']},
  {id:'macro',name:'Economy',preferred:['KXCPI','KXU3','KXFEDDECISION']},
  {id:'crypto',name:'Crypto',preferred:['KXBTC15M','KXBTC','KXETH']},
  {id:'travel',name:'Travel',preferred:['KXTSAD','KXTSA','KXTSAW','KXORDPAX','KXRDUVISITS','KXBOIPASSENGERS']},
  {id:'weather',name:'Weather',preferred:['KXHIGHNY','KXHIGHCHI','KXHIGHMIA','KXHIGHLAX']},
  {id:'science',name:'Tech & science',sourceCategories:['Science and Technology'],preferred:['KXLLM1','KXTOPMODEL','KXSPACEXCOUNT']},
  {id:'climate',name:'Climate',sourceCategories:['Climate and Weather'],preferred:['KXHURRICANE','KXRAINNYC']},
  {id:'culture',name:'Culture',sourceCategories:['Culture','Entertainment'],preferred:['KXRANKLIST1SONG','KXRT','KXNETFLIXRANKSHOW']}
];
const seriesCache=new Map();
export async function seriesCatalog(id='sports') {
  const category=WORKSPACE_CATEGORIES.find(c=>c.id===id);
  if(!category)throw new RangeError('Choose a supported market category');
  const cached=seriesCache.get(id);
  if(cached&&Date.now()-cached.at<3600000)return cached.value;
  const settled=await Promise.allSettled(category.sourceCategories?category.sourceCategories.map(name=>request('/series',{category:name,include_volume:'true'})):
    category.preferred.map(ticker=>request('/series/'+ticker)));
  const results=settled.filter(r=>r.status==='fulfilled').map(r=>r.value),errors=settled.filter(r=>r.status==='rejected').map(r=>String(r.reason.message).slice(0,200));
  if(!results.length)throw new Error(errors[0]||'The exchange series catalog is unavailable');
  const unique=new Map();
  for(const result of results)for(const row of result.data.series instanceof Array?result.data.series:[result.data.series])if(row?.ticker)unique.set(row.ticker,row);
  const rows=[...unique.values()].map(row=>({ticker:row.ticker,title:row.title,category:row.category,
    categories:Array.isArray(row.categories)?row.categories:[],tags:Array.isArray(row.tags)?row.tags:[],volume:Number(row.volume_fp||row.volume||0),
    settlement_sources:row.settlement_sources||[],frequency:row.frequency}));
  const value={as_of:new Date().toISOString(),source_url:results[0]?.source_url,rows,errors};
  seriesCache.set(id,{at:Date.now(),value});return value;
}
export async function workspaceCatalog() {
  return {as_of:new Date().toISOString(),categories:WORKSPACE_CATEGORIES.map(category=>({...category,
    series_count:seriesCache.get(category.id)?.value.rows.length??null}))};
}
export function selectSeries(category,catalog,maximum=8) {
  const matches=catalog.filter(row=>category.preferred.includes(row.ticker)||(category.sourceCategories||[]).some(c=>row.category===c||row.categories.includes(c)));
  const climate=row=>!/^KX(?:HIGH|LOW)/.test(row.ticker)&&!/hourly.*temperature/i.test(row.title);
  const rows=category.id==='climate'?matches.filter(climate):matches;
  return rows.sort((a,b)=>{
    const pa=category.preferred.indexOf(a.ticker),pb=category.preferred.indexOf(b.ticker);
    return (pa<0?999:pa)-(pb<0?999:pb)||b.volume-a.volume||a.ticker.localeCompare(b.ticker);
  }).slice(0,maximum);
}
export async function workspaceMarkets(id,{maximumSeries=8,getter=request,catalogGetter=seriesCatalog}={}) {
  const category=WORKSPACE_CATEGORIES.find(row=>row.id===id);
  if(!category)throw new RangeError('Choose a supported market category');
  if(!Number.isInteger(maximumSeries)||maximumSeries<1||maximumSeries>12)throw new RangeError('Choose 1–12 source series');
  const catalog=await catalogGetter(id),selected=selectSeries(category,catalog.rows,maximumSeries);
  const results=[];
  for(let at=0;at<selected.length;at+=3)results.push(...await Promise.all(selected.slice(at,at+3).map(async series=>{
    try { const response=await getter('/markets',{series_ticker:series.ticker,status:'open',limit:'200'});
      return {series,response}; } catch(error) {return {series,error:error.message};}
  })));
  const byTicker=new Map(),coverage=[],errors=(catalog.errors||[]).map(error=>({source:'Series catalog',error}));
  for(const result of results) {
    if(result.error) {errors.push({series:result.series.ticker,error:result.error});continue;}
    const rows=result.response.data.markets||[];
    coverage.push({series:result.series.ticker,records:rows.length,truncated:Boolean(result.response.data.cursor),as_of:result.response.as_of});
    for(const market of rows) {
      if(!market.ticker||!Number.isFinite(Date.parse(market.close_time))||Date.parse(market.close_time)<=Date.now()||!['open','active'].includes(market.status))continue;
      const row={...normalizeMarket(market,category.name,result.series.ticker,result.response.source_url),
        yes_sub_title:market.yes_sub_title||market.subtitle||'',status:market.status,
        category:id,settlement_sources:result.series.settlement_sources};
      byTicker.set(row.ticker,row);
    }
  }
  if(!coverage.length)throw new Error(errors[0]?.error||'No catalog sources are currently available');
  recordProviderStatus('Kalshi public exchange',{status:errors.length?'partial':'available',as_of:new Date().toISOString(),detail:'Bounded category catalog; exact contract coverage is shown separately.'});
  return {category:id,markets:[...byTicker.values()].sort((a,b)=>(b.volume_24h||0)-(a.volume_24h||0)),
    as_of:new Date().toISOString(),coverage,errors,partial:errors.length>0||coverage.some(c=>c.truncated),
    scope:`Up to ${maximumSeries} source series, selected by named coverage and historical series volume; not the complete exchange`};
}

export function createCategorySnapshots({load=workspaceMarkets,storage=()=>cloudEnabled()?store():null,retain,now=Date.now}={}) {
  const entries=new Map(),pending=new Map(),retryAt=new Map();
  const freshFor=45000,retainFor=15*60000;
  function response(value,stale){
    return {...value,stale,markets:value.markets.filter(row=>Date.parse(row.close_time)>now())};
  }
  async function refresh(category,key,backend){
    if(pending.has(category))return pending.get(category);
    const task=(async()=>{
      try{
        const value=await load(category);
        // Keep better coverage through a transient failed source, with its original observation time.
        const prior=entries.get(category);
        if(value.errors?.length&&prior&&now()-Date.parse(prior.as_of)<retainFor&&
          prior.coverage?.length>value.coverage?.length){
          retryAt.set(category,now()+15000);
          return response(prior,true);
        }
        entries.set(category,value);
        if(backend?.save)void backend.save({pk:key,sk:'value',value,expires_epoch:Math.ceil((now()+retainFor)/1000)},true).catch(()=>{});
        if(retain)void retain(value).catch(()=>{});
        return response(value,false);
      }catch(error){
        retryAt.set(category,now()+Math.max(5000,Math.min(60000,(error.retry_after_seconds||0)*1000)));
        throw error;
      }
    })();
    pending.set(category,task);
    try{return await task;}finally{pending.delete(category);}
  }
  return async function categorySnapshot(category){
    if(!WORKSPACE_CATEGORIES.some(row=>row.id===category))throw new RangeError('Choose a supported market category');
    const backend=storage(),key='workspace-category#'+category;
    let value=entries.get(category);
    if(!value&&backend?.save){
      const persisted=await backend.get(key).catch(()=>null);
      value=entries.get(category)||persisted?.value;
      if(value)entries.set(category,value);
    }
    const age=value?now()-Date.parse(value.as_of):Infinity;
    const usable=value&&(!value.markets.length||value.markets.some(row=>Date.parse(row.close_time)>now()));
    if(usable&&age<freshFor)return response(value,false);
    if(usable&&age<retainFor){
      if((retryAt.get(category)||0)<=now())void refresh(category,key,backend).catch(()=>{});
      return response(value,true);
    }
    return refresh(category,key,backend);
  };
}

export const categorySnapshot=createCategorySnapshots({retain:retainMarketHistory});
export function inferCategory(market,series=[]) {
  const row=series.find(s=>market.ticker.startsWith(s.ticker+'-'));
  return WORKSPACE_CATEGORIES.find(c=>c.preferred.some(t=>market.ticker.startsWith(t+'-')))?.id ||
    WORKSPACE_CATEGORIES.find(c=>(c.sourceCategories||[]).includes(row?.category))?.id || 'other';
}
export function inferResearchFamily(ticker) {
  validateTicker(ticker);
  for(const [family,prefixes] of Object.entries({travel:['KXTSA','KXTSAD'],weather:['KXHIGHNY','KXHIGHCHI','KXHIGHMIA'],
    inflation:['KXCPI'],labor:['KXU3'],crypto:['KXBTC','KXETH']}))if(prefixes.some(p=>ticker.startsWith(p+'-')))return family;
  return null;
}
