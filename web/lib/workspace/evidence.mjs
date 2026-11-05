import {sourceJSON} from './providers.mjs';
import {publicXFeed,redditEvidence} from './social.mjs';
import {SOURCE_CATALOG,evidenceTopic,evidenceEntities,evidenceSearchTerms,rankEvidence,safePublicURL} from './source-ranking.mjs';
import {filmResearch} from './film.mjs';
import {alternativeMusicSources} from './music-alternatives.mjs';

export async function sportsNews(topic,{get=sourceJSON}={}){
  const path=topic==='nba'?'basketball/nba':topic==='epl'?'soccer/eng.1':null;if(!path)return {status:'not_queried',articles:[]};
  try{
    const response=await get('ESPN '+(topic==='nba'?'NBA':'Premier League')+' news','https://site.api.espn.com/apis/site/v2/sports/'+path+'/news?limit=20',{ttl:900,maximumBytes:300000});
    const articles=(response.data.articles||[]).slice(0,20).flatMap(row=>{
      const url=safePublicURL(row.links?.web?.href),date=Date.parse(row.published);if(!url||!row.headline||!Number.isFinite(date)||row.premium===true)return [];
      return [{id:String(row.id||url),title:row.headline,excerpt:String(row.description||'').slice(0,700),url,publisher:'ESPN',as_of:new Date(date).toISOString(),platform:'publisher_metadata',limitations:['Publisher headline and description only. The full article has not been retrieved.']}];
    });return {status:'available',articles,as_of:response.as_of,source_url:response.source_url};
  }catch{return {status:'unavailable',articles:[],reason:'Additional public ESPN news metadata was unavailable.'};}
}
function summaries(market,items,{sports,film,feeds,topic,music}){
  const publishers=new Set(items.map(i=>i.publisher)),lead=items[0],subject=market.yes_sub_title||market.title||market.ticker;
  const summary=lead?`${items.length} relevant source item${items.length===1?'':'s'} from ${publishers.size} publisher${publishers.size===1?'':'s'} matched ${subject}. First to review: ${lead.publisher}, ${lead.title}. ${lead.impact}`:`No fresh source item passed the selected outcome’s entity, date and quality filters. This is a coverage gap, not evidence that nothing happened.`;
  const newsSummary=lead?`${lead.publisher}: ${lead.title}. ${items.length>1?'Compare with '+items.slice(1,3).map(i=>i.publisher).join(' and ')+'. ':''}Headlines, descriptions and public posts provide context; no price-impact estimate is established.`:summary;
  const sections=[`Selected contract: ${market.title||market.ticker}. YES outcome: ${subject}. ${market.rules_primary?'Settlement rule excerpt: '+String(market.rules_primary).slice(0,700):'Read the current contract rules before interpreting any source.'}`,
    `Coverage: ${items.length} relevant items from ${publishers.size} publishers. The ranking uses exact entity matches, editorial source tiers, recency and specific update terms. It is a review order, not a measured source-accuracy record. Repeated titles are removed; publisher diversity is promoted, but separate outlets can repeat one underlying report.`];
  if(sports?.teams?.length)sections.push(sports.teams.map(t=>`${t.name}: ${t.form_last_five?.wins??t.form?.wins??0} wins in ${t.form_last_five?.games??t.form?.games??0} observed recent games${t.form_last_five?.results?.length?' ('+t.form_last_five.results.join(' ')+')':''}.`).join(' ')+` The last ${sports.head_to_head?.length||0} observed head-to-head games are available separately. These small samples overlap team-strength history and are not independent predictive signals.`);
  if(sports?.lineup_scenarios?.length)sections.push(`Actual boxscore evidence covers ${sports.boxscore_coverage?.returned||0} of ${sports.boxscore_coverage?.requested||0} requested games. Low-minute and regular-minute splits include reported sample counts and dated game rows. Minutes can fall because of injury, coaching, foul trouble or a lopsided score, so an observed win-rate difference does not identify the causal effect of an absence. No lineup opinion changes the model probability.`);
  if(topic==='music')sections.push(music?.status==='available'?`Additional measured context: ${music.scope}, dated ${music.measurement_date}, with ${music.tracks?.length||0} reported song rows. ${music.matched_tracks?.length||0} exact selected-entity matches. ${music.settlement_note}`:'Catalog availability and settlement coverage are different checks. Spotify artist references and Apple song ranks do not supply daily US artist-stream totals or Billboard outcomes. No proxy is substituted for the settlement publisher.');
  if(film)sections.push(`Film analysis uses ${(film.critic_weight*100).toFixed(1)}% critic weighting as the user’s preference for an experimental display index. ${film.preference_index.reason} ${film.note}`);
  const itemRead=items.slice(0,8).map((i,n)=>`${n+1}. ${i.publisher}, ${i.as_of.slice(0,10)}: ${i.title}\n${i.excerpt||'No additional description supplied.'}\nRelevance: ${i.why_relevant}\nImplication: ${i.impact}\nVerify: ${i.limitations.join(' ')}\nSource: ${i.url}`).join('\n\n');
  sections.push(`Source access: ${feeds.map(f=>f.name+' '+f.status+(f.reason?' ('+f.reason+')':'')).join('; ')}. Public access blocks and rate limits are respected. Missing coverage is reported explicitly.`);
  const x=feeds.find(feed=>feed.name==='X');if(x?.scope==='selected_entities')sections.push(`X retrieval targets the selected names within curated public accounts, excluding replies and reposts. It reads at most one ten-post page per shared 30-minute refresh.${x.coverage?.truncated?' More matching posts were available; this page is incomplete.':''} A source identity is not a validated accuracy record.`);
  sections.push('Forecast treatment: this evidence panel does not alter probability, trade side or allocation. A prospective dated source/outcome archive and held-out evaluation are required before testing predictive claims.');
  return {summary,long_read:sections.join('\n\n')+(itemRead?'\n\nSource-by-source review\n\n'+itemRead:''),news_summary:newsSummary,news_long_read:itemRead||summary};
}
export async function contractEvidence(market,{enabled=false,selectedTicker,redditEnabled=false,includeX=true,news,sports,music,filmObservations=[],criticWeight=.775}={},dependencies={}){
  if(!enabled||selectedTicker!==market?.ticker)return {ticker:market?.ticker,status:'not_queried',items:[],summary:'Load evidence for the exact selected contract to request public sources.',long_read:'',news_summary:'',news_long_read:'',feeds:[],source_catalog:SOURCE_CATALOG};
  const topic=evidenceTopic(market),getNews=dependencies.sportsNews||sportsNews,getX=dependencies.publicXFeed||publicXFeed,getReddit=dependencies.redditEvidence||redditEvidence;
  const entities=evidenceEntities(market,{sports});
  const [publisher,x,reddit,alternative]=await Promise.all([
    getNews(topic).catch(()=>({status:'unavailable',articles:[]})),includeX?getX({topic,entities:evidenceSearchTerms(market,{sports}),enabled:true}).catch(()=>({status:'unavailable',posts:[]})):Promise.resolve({status:'not_queried',posts:[]}),
    getReddit(market,{enabled:redditEnabled,selectedTicker,sports}).catch(()=>({status:'unavailable',posts:[]})),
    topic==='music'?(music?.alternatives?Promise.resolve(music.alternatives):(dependencies.alternativeMusicSources||alternativeMusicSources)(market,{artist:market.custom_strike?.Artist||(/\bartist\b/i.test(market.title||'')?entities[0]:null),song:/\bsong\b/i.test(market.title||'')?entities[0]:null}).catch(()=>({status:'unavailable'}))):Promise.resolve(null)
  ]);
  const normalized=(news?.articles||[]).map(row=>({...row,publisher:row.publisher||row.domain||'Unverified source',as_of:row.as_of||row.published_at||row.publishedAt||row.seen_at,excerpt:row.description||row.excerpt||'',time_basis:row.published_at||row.publishedAt?'publisher_reported_publication':'provider_first_seen',limitations:['Headline metadata only; full publisher article has not been read.',...(!row.published_at&&!row.publishedAt?['Timestamp is provider first-seen metadata, not verified article publication time.']:[])]}));
  const items=rankEvidence([...normalized,...(publisher.articles||[]),...(x.posts||[]),...(reddit.posts||[])],market,{sports,now:dependencies.now?.()||Date.now()}),film=filmResearch(market,{observations:filmObservations,criticWeight});
  const feeds=[{name:news?.provider||'Existing news metadata',status:news?.status||'not_queried'},{name:'ESPN news',status:publisher.status,reason:publisher.reason},{name:'X',status:x.status,reason:x.reason,scope:x.scope,query:x.query,coverage:x.coverage},{name:'Reddit',status:reddit.status,reason:reddit.reason,rejected:reddit.rejected,examined:reddit.examined,search_url:reddit.search_url},...(alternative?[{name:'Kworb secondary Spotify chart',status:alternative.status,reason:alternative.reason}]:[])];
  const value={ticker:market.ticker,status:items.length?'available':'no_matched_items',as_of:new Date().toISOString(),items,feeds,film,music_alternatives:alternative,
    source_catalog:SOURCE_CATALOG.filter(s=>s.topics.includes(topic)),ranking_method:{classification:'editorial_heuristic',weights:{entity_relevance:.4,source_tier:.25,recency:.2,specific_update_terms:.15},publisher_diversity:'First two per publisher promoted; remaining items follow.',accuracy_validated:false},
    experimental_sensitivity:{status:'not_calibrated',affects_forecast:false,probability_adjustment:null,reason:'News and social opinions remain inspectable context. No held-out source-to-outcome evaluation supports a probability adjustment.'}};
  return {...value,...summaries(market,items,{sports,film,feeds,topic,music:alternative})};
}
