import {FED_CALENDAR,permittedPublicPage} from './public-pages.mjs';
import {recordProviderStatus,sourceJSON} from './providers.mjs';
import {localDay} from '../intelligence/sources.mjs';

const NHC='https://www.nhc.noaa.gov';
const HN='https://hn.algolia.com/api/v1/search';
const DAY=86400000;
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthPattern=MONTHS.map(m=>m.length===3?m:m.slice(0,3)+'(?:'+m.slice(3)+')?').join('|');
const calendarMonth=new RegExp('^(?:'+monthPattern+')$','i');
const datePattern=new RegExp('\\b(?:'+monthPattern+')\\s+\\d{1,2},\\s+20\\d{2}\\b','gi');

const clean=value=>String(value||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,' ')
  .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,entity=>{
    const named={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};
    if(named[entity.toLowerCase()])return named[entity.toLowerCase()];
    const hex=entity[2]?.toLowerCase()==='x',n=Number.parseInt(entity.slice(hex?3:2,-1),hex?16:10);
    return Number.isInteger(n)&&n>31&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):' ';
  }).replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();

function isoDate(year,month,day){
  const n=MONTHS.findIndex(m=>m.toLowerCase().startsWith(month.toLowerCase()));
  if(n<0||!Number.isInteger(day)||day<1||day>31)return null;
  const out=year+'-'+String(n+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
  const date=new Date(out);return Number.isFinite(+date)&&date.toISOString().startsWith(out)?out:null;
}
function dates(text){
  return [...String(text||'').matchAll(datePattern)].flatMap(([value])=>{
    const [month,day,year]=value.replace(',','').split(/\s+/);const iso=isoDate(year,month,Number(day));return iso?[iso]:[];
  });
}

export function parseFedCalendar(html){
  const headings=[...html.matchAll(/<h4\b[^>]*>\s*(?:<a\b[^>]*>\s*)?(20\d{2})\s+FOMC Meetings\b[^<]*(?:<\/a>)?\s*<\/h4>/gi)];
  if(!headings.length)throw new Error('Unrecognized Federal Reserve calendar');
  const rows=[];
  for(const [i,heading] of headings.entries()){
    const section=html.slice(heading.index+heading[0].length,headings[i+1]?.index??html.length);
    for(const row of section.matchAll(/class="[^"]*fomc-meeting__month[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]{0,220}?class="[^"]*fomc-meeting__date[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)){
      const months=clean(row[1]).split('/').map(m=>m.trim()),days=/^(\d{1,2})(?:[-–](\d{1,2}))?\*?$/.exec(clean(row[2]));
      if(!days||months.length>2||months.some(m=>!calendarMonth.test(m)))continue;
      const start=isoDate(heading[1],months[0],Number(days[1])),end=isoDate(heading[1],months.at(-1),Number(days[2]||days[1]));
      if(start&&end&&end>=start&&Date.parse(end)-Date.parse(start)<=2*DAY)rows.push({start,end});
    }
  }
  if(!rows.length)throw new Error('No verified Federal Reserve calendar rows');
  return rows;
}

function federalScope(market){
  if(!/^KXFED(?:DECISION)?-/.test(market?.ticker||'')||!/\bFederal Reserve\b/i.test(market.rules_primary||''))return null;
  const target=dates(market.rules_primary),close=Date.parse(market.close_time);
  return target.length===1&&Number.isFinite(close)&&localDay(close,'America/New_York')===target[0]?target[0]:null;
}

const BASINS={Atlantic:'at','Eastern Pacific':'ep','Central Pacific':'cp'};
const NHC_CHANNELS={at:'NHC Atlantic',ep:'NHC Eastern North Pacific',cp:'CPHC Central North Pacific'};
function hurricaneScope(market){
  if(!/^KXHURRICANE-/.test(market?.ticker||''))return null;
  const rules=market.rules_primary||'',basin=Object.keys(BASINS).filter(name=>new RegExp('\\b'+name+'\\b','i').test(rules));
  const window=dates(rules);
  if(basin.length!==1||window.length!==2||window[0]>=window[1]||!/\bNational Weather Service\b/i.test(rules))return null;
  return {basin:basin[0],code:BASINS[basin[0]],start:window[0],end:window[1]};
}

function itemField(block,tag){
  return new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'\\s*>','i').exec(block)?.[1]||'';
}

export function parseHurricaneFeed(xml,scope,now){
  if(/<!DOCTYPE|<!ENTITY/i.test(xml)||!/<rss\b/i.test(xml)||!/<\/rss\s*>/i.test(xml))throw new Error('Unrecognized NHC RSS');
  const channel=/<channel\b[^>]*>([\s\S]*?)(?:<item\b|<\/channel\s*>)/i.exec(xml)?.[1];
  if(!channel||clean(itemField(channel,'title'))!==NHC_CHANNELS[scope.code])throw new Error('Unexpected NHC basin');
  const rows=[],seen=new Set();
  for(const [,item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)){
    const title=clean(itemField(item,'title')),rawDate=clean(itemField(item,'pubDate')),date=Date.parse(rawDate);
    if(!/\b(?:outlook|advisory|hurricane|tropical (?:storm|depression)|cyclone)\b/i.test(title)||/there are no tropical cyclones/i.test(title)||
      !Number.isFinite(date)||date>now||now-date>3*DAY)continue;
    const day=new Date(date).toISOString().slice(0,10);
    if(day<scope.start||day>scope.end)continue;
    let url;
    try{url=new URL(clean(itemField(item,'link')));}catch{continue;}
    if(url.origin!==NHC||url.username||url.password||seen.has(url.href))continue;
    seen.add(url.href);
    const published=new Date(date).toISOString();
    rows.push({id:url.href,title,excerpt:clean(itemField(item,'description')).slice(0,560),url:url.href,
      publisher:'National Hurricane Center',confidence:'primary_source',platform:'official_observation',
      as_of:published,published_at:published,time_basis:'publisher_reported_publication',
      limitations:['Basin bulletin for this contract’s observation window. It does not establish the season’s settlement count.']});
    if(rows.length>=6)break;
  }
  return rows;
}

export async function collectOfficialEvidence(market,{now=Date.now(),get=permittedPublicPage}={}){
  const meeting=federalScope(market),scope=hurricaneScope(market);
  if(!meeting&&!scope)return {status:'not_applicable',rows:[]};
  const name=meeting?'Federal Reserve meeting calendar':'National Hurricane Center basin advisories',url=meeting?FED_CALENDAR:NHC+'/index-'+scope.code+'.xml';
  let result;
  try{
    const page=await get(name,url,{ttl:meeting?3600:600,maximumBytes:meeting?600000:140000,timeoutMs:2500});
    if(page.status!=='available')result={status:page.status,rows:[],reason:page.reason};
    else{
      const calendar=meeting?parseFedCalendar(page.data.text).find(row=>row.end===meeting):null;
      const rows=meeting?(calendar?[{id:'fomc-'+meeting,title:'Federal Reserve FOMC meeting ending '+meeting,
        excerpt:'The official calendar lists '+(calendar.start===meeting?meeting:calendar.start+' through '+meeting)+' for this meeting.',
        url:FED_CALENDAR,publisher:'Federal Reserve',confidence:'primary_source',platform:'official_observation',as_of:page.as_of,
        time_basis:'retrieved_at',limitations:['Schedule only. It does not identify the rate decision or its probability.']}]:[]):parseHurricaneFeed(page.data.text,scope,now);
      result={status:rows.length?'available':'empty',as_of:page.as_of,
        rows:rows.map(row=>({...row,retrieved_at:page.as_of,source_sha256:page.sha256})),
        reason:rows.length?(meeting?'Matched the decision day in the official calendar.':'Current official notices for the selected basin and contract window.'):
          'The public source returned no current observation matching the selected contract.'};
    }
  }catch{result={status:'unavailable',rows:[],reason:'The public source or its expected response structure could not be verified.'};}
  recordProviderStatus(name,{status:result.status,as_of:result.as_of,detail:result.reason});
  return {...result,name,source_url:url};
}

const phrase=value=>String(value||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim();
function leaderboardEntity(market){
  const org=market?.ticker?.startsWith('KXLLM1-'),model=market?.ticker?.startsWith('KXTOPMODEL-');
  if(!org&&!model)return null;
  const entity=market.custom_strike?.[org?'Organization':'Model'],rules=market.rules_primary||'';
  if(typeof entity!=='string'||entity.length>80||!phrase(entity)||!/^[\w .()&'+/-]+$/.test(entity))return null;
  const official=/^If (.+?) (?:has the top-ranked LLM|is the top-ranked AI model) on\b/i.exec(rules)?.[1];
  return official&&phrase(official)===phrase(entity)?entity:null;
}

export async function collectCommunityContext(market,{now=Date.now(),get=sourceJSON}={}){
  const name='Hacker News technology discussion',entity=leaderboardEntity(market);
  if(!entity)return {name,status:'not_applicable',rows:[],reason:'The credential-free discussion source covers named AI leaderboard contracts only.'};
  const minimumDate=Math.floor((Math.floor(now/DAY)*DAY-7*DAY)/1000);
  const query=new URLSearchParams({query:entity,tags:'story',hitsPerPage:'20',numericFilters:'created_at_i>'+minimumDate+',points>=5,num_comments>=2',restrictSearchableAttributes:'title'});
  try{
    const {data,as_of}=await get(name,HN+'?'+query,{ttl:1800,maximumBytes:100000,timeoutMs:4000});
    if(!Array.isArray(data?.hits))throw new Error('Unrecognized HN search schema');
    const seen=new Set(),headlines=new Set(),rows=[];
    for(const row of data.hits.slice(0,20)){
      const title=clean(row.title).slice(0,300),titleKey=phrase(title),date=Date.parse(row.created_at);
      const topic=/\b(?:benchmarks?|leaderboards?|evals?|rankings?)\b/i.test(title)||
        /\b(?:releases?|released|launches?|launched|introduces?|introduced|announces?|announced)\b/i.test(title)&&/\bmodels?\b/i.test(title);
      if(typeof row.objectID!=='string'||!/^\d{1,14}$/.test(row.objectID)||seen.has(row.objectID)||date>now||!(date>=now-7*DAY)||
        !Number.isSafeInteger(row.points)||row.points<5||!Number.isSafeInteger(row.num_comments)||row.num_comments<2||
        !(' '+titleKey+' ').includes(' '+phrase(entity)+' ')||headlines.has(titleKey)||!topic)continue;
      const url='https://news.ycombinator.com/item?id='+row.objectID;
      seen.add(row.objectID);headlines.add(titleKey);rows.push({id:'hn-'+row.objectID,title,url,platform:'hacker_news',publisher:'Hacker News',
        as_of:new Date(date).toISOString(),excerpt:row.points+' points · '+row.num_comments+' comments',
        limitations:['Community discussion. Engagement does not verify accuracy or leaderboard standing.']});
      if(rows.length>=5)break;
    }
    return {name,status:rows.length?'available':'empty',rows,as_of,reason:'Public technology discussion scoped to the exact named entity. Source is Hacker News.'};
  }catch{return {name,status:'unavailable',rows:[],reason:'The public technology discussion index could not be verified.'};}
}
