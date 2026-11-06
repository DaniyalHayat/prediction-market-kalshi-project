import {recordProviderStatus,sourceJSON} from './providers.mjs';
import {publicXFeed,redditEvidence} from './social.mjs';
import {SOURCE_CATALOG,evidenceTopic,evidenceEntities,evidenceSearchTerms,rankEvidence,safePublicURL} from './source-ranking.mjs';
import {filmResearch} from './film.mjs';
import {alternativeMusicSources} from './music-alternatives.mjs';
import {nflContractIdentity} from './nfl-source.mjs';
import {fetchContractHeadlines,fetchPreviewHeadlines,sportsNewsContext} from '../intelligence/brief.mjs';

const sportFeeds={nfl:['football/nfl','NFL'],nba:['basketball/nba','NBA'],epl:['soccer/eng.1','Premier League']};
const cleanText=(value,limit=350)=>String(value||'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,limit);
export async function sportsNews(topic,{get=sourceJSON,sports}={}){
  const feed=sportFeeds[topic];
  if(!feed)return {status:'not_applicable',articles:[]};
  const [path,label]=feed,name='ESPN '+label+' news';
  const teams=topic==='nfl'?[...new Set((sports?.teams||[]).map(team=>String(team.espn_team_id??team.id)).filter(id=>/^\d{1,4}$/.test(id)))].sort().slice(0,2):[];
  const requests=(teams.length?teams:[null]).map(async team=>{
    const params=new URLSearchParams({limit:team?'12':'20'});
    if(team)params.set('team',team);
    const response=await get(name,'https://site.api.espn.com/apis/site/v2/sports/'+path+'/news?'+params,{ttl:900,maximumBytes:300000,timeoutMs:4500});
    if(!Array.isArray(response.data?.articles))throw new Error('Unrecognized ESPN article listing');
    const articles=response.data.articles.slice(0,20).flatMap(row=>{
      const url=safePublicURL(row.links?.web?.href),date=Date.parse(row.published),title=cleanText(row.headline,500);
      if(!url||!/(^|\.)espn\.com$/.test(new URL(url).hostname)||!title||!Number.isFinite(date)||row.premium===true)return [];
      return [{id:String(row.id||url),title,excerpt:cleanText(row.description,700),url,publisher:'ESPN',as_of:new Date(date).toISOString(),platform:'publisher_metadata',limitations:['ESPN headline and description. Open the article for the full report.']}];
    });
    return {articles,as_of:response.as_of,source_url:response.source_url};
  });
  const results=(await Promise.allSettled(requests)).flatMap(row=>row.status==='fulfilled'?[row.value]:[]);
  const articles=[...new Map(results.flatMap(row=>row.articles).map(row=>[row.id,row])).values()];
  const status=!results.length?'unavailable':results.length<requests.length?'partial':articles.length?'available':'empty';
  const reason=results.length<requests.length?'One or more ESPN news lists could not be loaded.':'Publisher headlines and descriptions filtered for this contract.';
  const as_of=results.map(row=>row.as_of).filter(Boolean).sort().at(-1);
  recordProviderStatus(name,{status,as_of,detail:reason});
  return {status,articles,as_of,source_url:results[0]?.source_url,reason};
}

export function evidenceSourceLinks(market,{sports,topic=evidenceTopic(market),settlementSources=[],film}={}){
  const links=[],seen=new Set();
  function add(label,value,detail,kind='official'){
    const url=safePublicURL(value);
    if(!url||seen.has(url))return;
    seen.add(url);
    links.push({label:cleanText(label,120)||new URL(url).hostname,url,detail,kind,status:'reference'});
  }
  for(const row of (Array.isArray(settlementSources)?settlementSources:[]).slice(0,6))add(row.name||row.label,row.url,'Listed in the exchange series rules. Check the exact date, territory and units.');
  if(topic==='nfl'){
    const game=sports?.event?.nfl_game_url;
    add('NFL Game Center',game,'Exact matchup, kickoff and official game status.');
    const match=/^https:\/\/www\.nfl\.com\/games\/[a-z0-9-]+-(20\d{2})-(reg|post|pre)-(\d{1,2})\/?$/.exec(game||'');
    if(match)add('NFL weekly injury report','https://www.nfl.com/injuries/league/'+match[1]+'/'+match[2]+match[3],'Find both teams and compare practice participation with official game status.');
    if(/^\d{6,12}$/.test(sports?.event?.id||''))add('ESPN Gamecast','https://www.espn.com/nfl/game/_/gameId/'+sports.event.id,'Check venue, recent team form and game-day updates.','publisher');
  }
  const ticker=market?.ticker||'';
  const references=[
    [/^KXTSAD?(?:-|$)/,'TSA checkpoint travel numbers','https://www.tsa.gov/travel/passenger-volumes','Match the reported passenger count to the exact calendar day.'],
    [/^KXCPI/,'BLS CPI release schedule','https://www.bls.gov/schedule/news_release/cpi.htm','Check release date and monthly versus annual change.'],
    [/^KXU3/,'BLS employment release schedule','https://www.bls.gov/schedule/news_release/empsit.htm','Check the U-3 unemployment rate and observation month.'],
    [/^KXFED/,'FOMC meeting calendar and statements','https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm','Read the statement for the meeting named in the contract.'],
    [/^KXHURRICANE/,'National Hurricane Center','https://www.nhc.noaa.gov/','Match storm name, basin and advisory time to the rules.'],
    [/^KX(?:HIGH|LOW|RAIN)/,'National Weather Service local climate data','https://www.weather.gov/wrh/climate','Choose the settlement station and local observation date.'],
    [/^KXSPACEX/,'SpaceX launch manifest','https://www.spacex.com/launches/','Separate completed launches from scheduled launches.'],
    [/^KX(?:LLM1|TOPMODEL)/,'Arena leaderboards','https://arena.ai/leaderboard','Match the leaderboard task, model name and snapshot time in the rules.'],
    [/^KXNETFLIX/,'Netflix Top 10','https://www.netflix.com/tudum/top10','Choose the right country, title type and reporting week.']
  ];
  for(const [pattern,label,url,detail] of references)if(pattern.test(ticker))add(label,url,detail);
  if(topic==='music'){
    const rules=market.rules_primary||'';
    if(/spotify/i.test(rules))add('Spotify Charts','https://charts.spotify.com/','Compare the specified chart, territory, date and artist or song.');
    if(/billboard/i.test(rules))add('Billboard charts','https://www.billboard.com/charts/','Match the exact named chart and chart week.');
  }
  for(const row of (film?.source_links||[]).slice(0,2))add(row.label,row.url,'Check the published scoring definition and the exact release.');
  return links.slice(0,8);
}
function summaries(market,items,related,{sports,topic,music,film,sourceLinks}){
  const reporting=[...items,...related].filter(item=>!['reddit','x'].includes(item.platform)),lead=reporting[0];
  const leadExcerpt=lead?.excerpt&&lead.excerpt!==lead.title?lead.excerpt:null;
  const summary=lead?(leadExcerpt||lead.title).replace(/[.!?]+$/,'')+'. Reported by '+lead.publisher+'. '+lead.impact:
    sourceLinks.length?'Start with '+sourceLinks[0].label+'. '+sourceLinks[0].detail:'The selected outcome has no fresh matched report. Use the contract rules to identify the exact event and publisher.';
  const sections=[];
  if(lead)sections.push({heading:'What changed',text:summary,url:lead.url});
  if(lead?.impact)sections.push({heading:'Why it matters',text:lead.impact});
  if(lead?.match_scope==='related')sections.push({heading:'How closely this fits the contract',text:lead.why_relevant+' Treat this report as a lead to verify before connecting it to the exact outcome.',url:lead.url});
  const compared=new Set(lead?[lead.publisher]:[]);
  for(const item of reporting.slice(1)){
    if(compared.has(item.publisher))continue;
    compared.add(item.publisher);
    sections.push({heading:'Cross-check with '+item.publisher,text:(item.excerpt||item.title).replace(/[.!?]+$/,'')+'. '+item.impact,url:item.url});
    if(compared.size>=3)break;
  }
  const form=(sports?.teams||[]).flatMap(team=>{
    const last=team.form_last_five;
    if(!Number.isInteger(last?.games)||last.games<1||!Number.isInteger(last.wins))return [];
    return [team.name+' won '+last.wins+' of its last '+last.games+' recorded games.'];
  });
  if(form.length)sections.push({heading:'Recent results',text:form.join(' ')+' Recent form is a short sample and may already be reflected in the team ratings.'});
  if(sports?.lineup_scenarios?.length)sections.push({heading:'Lineup comparisons',text:`Boxscores cover ${sports.boxscore_coverage?.returned||0} of ${sports.boxscore_coverage?.requested||0} requested games. Compare minutes, opponent and sample size before drawing a lineup conclusion.`});
  if(topic==='music')sections.push({heading:'Chart and territory',text:music?.status==='available'?`${music.scope}, dated ${music.measurement_date}, with ${music.matched_tracks?.length||0} exact selected-entity matches. ${music.settlement_note}`:'Check the specific artist or song, territory and reporting window. Apple song rank and Spotify artist catalog entries measure different things.'});
  if(film)sections.push({heading:'Reviews and demand',text:film.note});
  const cutoff=Date.parse(market.close_time);
  if(Number.isFinite(cutoff))sections.push({heading:'The trading clock',text:'Trading is scheduled to close at '+new Date(cutoff).toISOString().replace('T',' ').slice(0,16)+' UTC. Check the settlement rules for the separate measurement time and what happens if the official source is delayed.'});
  if(sourceLinks.length)sections.push({heading:'What to check next',text:sourceLinks[0].detail,url:sourceLinks[0].url});
  if(market.rules_primary)sections.push({heading:'Settlement check',text:cleanText(market.rules_primary,700)});
  const count=items.length+related.length;
  sections.push({heading:'What the sources cover',text:`${items.length} matched and ${related.length} related ${count===1?'item':'items'}. Reporting can point to facts worth checking. Forecasts use verified structured observations and the model’s own inputs.`});
  const longRead=sections.map(row=>row.heading+'\n'+row.text).join('\n\n');
  return {summary,long_read:longRead,news_summary:summary,news_long_read:longRead,news_sections:sections};
}
export async function contractEvidence(market,{enabled=false,selectedTicker,redditEnabled=false,includeX=false,headlineMode='standard',news,sports,music,settlementSources,filmObservations=[],criticWeight=.775}={},dependencies={}){
  if(!enabled||selectedTicker!==market?.ticker)return {ticker:market?.ticker,status:'not_queried',items:[],summary:'Load evidence for the exact selected contract to request public sources.',long_read:'',news_summary:'',news_long_read:'',feeds:[],source_catalog:SOURCE_CATALOG};
  const topic=evidenceTopic(market),getNews=dependencies.sportsNews||sportsNews,getX=dependencies.publicXFeed||publicXFeed,getReddit=dependencies.redditEvidence||redditEvidence;
  const nfl=topic==='nfl'?nflContractIdentity(market):null;
  const teamNames=nfl?.team_names||sportsNewsContext(market)?.teams;
  const context=!sports?.teams?.length&&teamNames?.length?{...sports,teams:teamNames.map(name=>({name}))}:sports;
  const entities=evidenceEntities(market,{sports:context});
  const [publisher,x,reddit,alternative,headlines,references]=await Promise.all([
    getNews(topic,{sports:context}).catch(()=>({status:'unavailable',articles:[]})),includeX?getX({topic,entities:evidenceSearchTerms(market,{sports:context}),enabled:true}).catch(()=>({status:'unavailable',posts:[]})):Promise.resolve({status:'opt_in',posts:[],reason:'Enable X to check curated public accounts.'}),
    redditEnabled?getReddit(market,{enabled:true,selectedTicker,sports:context}).catch(()=>({status:'unavailable',posts:[]})):Promise.resolve({status:'opt_in',posts:[],reason:'Enable Reddit to check public discussion for this contract.'}),
    topic==='music'&&headlineMode!=='official'?(music?.alternatives?Promise.resolve(music.alternatives):(dependencies.alternativeMusicSources||alternativeMusicSources)(market,{artist:market.custom_strike?.Artist||(/\bartist\b/i.test(market.title||'')?entities[0]:null),song:/\bsong\b/i.test(market.title||'')?entities[0]:null}).catch(()=>({status:'unavailable'}))):Promise.resolve(null),
    news?.provider?news:headlineMode==='official'&&!sportFeeds[topic]?
      (dependencies.fetchPreviewHeadlines||fetchPreviewHeadlines)(market).catch(()=>({status:'unavailable',articles:[]})):
      headlineMode==='full'?(dependencies.fetchContractHeadlines||fetchContractHeadlines)(market).catch(()=>({status:'unavailable',articles:[]})):news,
    settlementSources
  ]);
  const normalized=(headlines?.articles||[]).map(row=>({...row,platform:'publisher_metadata',publisher:row.publisher||row.domain||'Unverified source',as_of:row.as_of||row.published_at||row.publishedAt||row.seen_at,excerpt:row.description||row.excerpt||'',time_basis:row.published_at||row.publishedAt?'publisher_reported_publication':'provider_first_seen',limitations:['Open the publisher for the full article.',...(!row.published_at&&!row.publishedAt?['The timestamp is when the index first saw the item.']:[])]}));
  const now=dependencies.now?.()??Date.now();
  const ranked=rankEvidence([...(publisher.articles||[]),...normalized,...(x.posts||[]),...(reddit.posts||[])],market,{sports:context,now});
  const items=ranked.filter(row=>row.match_scope==='matched'),related_items=ranked.filter(row=>row.match_scope==='related');
  const film=filmResearch(market,{observations:filmObservations,criticWeight,now});
  const source_links=evidenceSourceLinks(market,{sports:context,topic,settlementSources:references,film});
  const feeds=[...(headlines?.provider?[{name:headlines.provider,status:headlines.status,as_of:headlines.retrieved_at,kind:'publisher',reason:headlines.error||headlines.reason}]:[]),
    ...(publisher.status!=='not_applicable'?[{name:'ESPN '+(sportFeeds[topic]?.[1]||'')+' news',status:publisher.status,reason:publisher.reason,as_of:publisher.as_of,kind:'publisher'}]:[]),
    {name:'X',kind:'x',status:x.status,reason:x.reason,as_of:x.as_of,scope:x.scope,query:x.query,coverage:x.coverage},
    {name:'Reddit',kind:'reddit',status:reddit.status,reason:reddit.reason,as_of:reddit.as_of,rejected:reddit.rejected,examined:reddit.examined,search_url:reddit.search_url},
    ...(alternative?[{name:'Kworb chart data',kind:'data',status:alternative.status,reason:alternative.reason,as_of:alternative.measurement_date}]:[])];
  const value={ticker:market.ticker,status:items.length?'available':related_items.length||source_links.length?'context_available':'no_matched_items',as_of:new Date(now).toISOString(),items,related_items,source_links,feeds,film,music_alternatives:alternative,
    source_catalog:SOURCE_CATALOG.filter(s=>s.topics.includes(topic)),ranking_method:{classification:'editorial_heuristic',weights:{entity_relevance:.4,source_tier:.25,recency:.2,specific_update_terms:.15},horizon_multiplier:{long_horizon_asset_story_for_same_day_contract:.55},publisher_diversity:'First two per publisher promoted; remaining items follow.',accuracy_validated:false},
    experimental_sensitivity:{status:'not_calibrated',affects_forecast:false,probability_adjustment:null,reason:'A headline or social post supplies no numeric adjustment by itself. The research model evaluates verified observations separately.'}};
  return {...value,...summaries(market,items,related_items,{sports:context,film,topic,music:alternative,sourceLinks:source_links})};
}
