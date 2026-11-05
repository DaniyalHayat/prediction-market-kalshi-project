const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/https?:\/\/\S+/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
const stopWords=new Set(['will','would','which','what','this','that','with','from','have','game','wins','team','their','they','than','over','under','more','most','number','first','song','artist','before','after','above','below','does','yes','no']);
const words=value=>normalize(value).split(' ').filter(w=>w.length>2&&!stopWords.has(w)&&!/^\d+$/.test(w));
const sportsTopics=new Set(['nfl','nba','epl']);
const specificUpdate=/\b(out|ruled out|questionable|doubtful|injury|injured|starting|lineup|minutes|confirmed|postponed|cancelled|review|presales|tickets|opening|gross|streams|chart|trade|starter|quarterback|practice|reps)\b/;
const titleNoise=new Set(['best','there','end','hit','finish','reach','close','last','win','hold','today','tomorrow','week','month','year','date','time','next','total','price','points','contract','degrees','january','february','march','april','may','june','july','august','september','october','november','december','jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec']);
export function topicWords(value){return [...new Set(words(value).filter(word=>!titleNoise.has(word)))];}
export function evidenceTopicGroups(market){
  const ticker=market?.ticker||'',rules=[market?.rules_primary,market?.title].join(' ');
  if(/^KXCPI/.test(ticker))return [['consumer price index','CPI'],['inflation']];
  if(/^KXU3/.test(ticker))return [['unemployment','jobless rate'],['jobs report','BLS','U.S.']];
  if(/^KXFED/.test(ticker))return [['Federal Reserve','FOMC'],['rate decision','interest rates']];
  if(/^KX(?:LLM1|TOPMODEL)/.test(ticker))return [['AI leaderboard','Arena leaderboard','LMArena'],['model','LLM']];
  if(/^KXHURRICANE/.test(ticker)){
    const basin=rules.match(/\b(?:Eastern Pacific|Central Pacific|Atlantic)\b/i)?.[0];
    if(basin)return [[basin],['hurricane','hurricanes']];
  }
  return [];
}
export const SOURCE_CATALOG=Object.freeze([
  {id:'nba-official',name:'NBA official reports',tier:'primary',domain:'official.nba.com',topics:['nba'],identity_url:'https://official.nba.com/nba-injury-report-2026-27-season',checked_at:'2026-11-05',role:'League participation reports; check the dated report and updates.'},
  {id:'nfl',name:'NFL',handle:'NFL',tier:'primary',domain:'nfl.com',topics:['nfl'],identity_url:'https://www.nfl.com/',checked_at:'2026-11-05',role:'Official fixtures, league injury reports and game records.'},
  {id:'nfl-network',name:'NFL Network',handle:'nflnetwork',tier:'reported',topics:['nfl'],identity_url:'https://www.nfl.com/network/',checked_at:'2026-11-05',role:'Attributed NFL Network reporting.'},
  {id:'espn',name:'ESPN',tier:'reported',domain:'espn.com',topics:['nfl','nba','epl'],identity_url:'https://www.espn.com/',checked_at:'2026-11-05',role:'Sports schedules, boxscores and attributed reporting.'},
  {id:'shams',name:'Shams Charania',handle:'ShamsCharania',tier:'reported',topics:['nba'],identity_url:'https://us.espnpressroom.com/bios/shams-charania/',checked_at:'2026-11-05',role:'ESPN Senior NBA Insider. Reported availability needs confirmation with an official dated report.'},
  {id:'romano',name:'Fabrizio Romano',handle:'FabrizioRomano',tier:'reported',topics:['epl'],identity_url:'https://www.paramountpressexpress.com/cbs-sports/shows/soccer/talent/?view=fabrizio-romano-2',checked_at:'2026-11-05',role:'CBS Sports soccer insider. Transfer reports are not a match forecast.'},
  {id:'nba',name:'NBA',handle:'NBA',tier:'primary',topics:['nba'],identity_url:'https://www.nba.com/',checked_at:'2026-11-05',role:'League announcements and official game context.'},
  {id:'premier-league',name:'Premier League',handle:'premierleague',tier:'primary',topics:['epl'],identity_url:'https://www.premierleague.com/',checked_at:'2026-11-05',role:'League announcements and official fixture context.'},
  {id:'variety',name:'Variety',handle:'Variety',domain:'variety.com',tier:'reported',topics:['film'],identity_url:'https://variety.com/',checked_at:'2026-11-05',role:'Film industry reporting; review sentiment and ticket demand are different measurements.'},
  {id:'thr',name:'The Hollywood Reporter',handle:'THR',domain:'hollywoodreporter.com',tier:'reported',topics:['film'],identity_url:'https://www.hollywoodreporter.com/',checked_at:'2026-11-05',role:'Film reviews and industry reporting; no certified predictive accuracy assigned.'},
  {id:'charts',name:'Talk of the Charts',handle:'talkofthecharts',tier:'specialist_context',topics:['music'],identity_url:'https://x.com/talkofthecharts',checked_at:'2026-11-05',role:'Third-party chart commentary; verify against the contract settlement publisher.'},
  {id:'spotify-data',name:'Spotify Daily Data',handle:'spotify_data',tier:'specialist_context',topics:['music'],identity_url:'https://x.com/spotify_data',checked_at:'2026-11-05',role:'Third-party chart commentary; not an official Spotify settlement feed.'}
].map(row=>Object.freeze({...row,accuracy_status:'not_outcome_validated',accuracy_note:'Identity and topic scope are documented. No dated, held-out accuracy record has been established.'})));
export function evidenceTopic(market){
  const text=[market?.ticker,market?.title,market?.rules_primary].join(' ');
  return /^KXNFLGAME-/i.test(text)||/\bNFL\b/i.test(text)?'nfl':/^KXNBAGAME-/i.test(text)||/\bNBA\b/i.test(text)?'nba':/^KXEPLGAME-/i.test(text)||/premier league/i.test(text)?'epl':/spotify|billboard|apple music|top song|top artist/i.test(text)?'music':/film|movie|rotten tomatoes|box office|oscar/i.test(text)?'film':'other';
}
export function evidenceEntities(market,{sports}={}){
  const values=(sports?.teams||[]).map(t=>t.name).filter(Boolean);
  if(values.length)return [...new Set(values)];
  for(const key of ['Artist','Movie','Film','Song','Team'])if(typeof market?.custom_strike?.[key]==='string')values.push(market.custom_strike[key]);
  if(typeof market?.yes_sub_title==='string'&&!/^(yes|no|tie|draw|over|under|other|both|neither|none of the above)$/i.test(market.yes_sub_title.trim()))values.push(market.yes_sub_title);
  return [...new Set(values.map(v=>v.trim()).filter(v=>v.length<=90&&topicWords(v).length))].slice(0,4);
}
export function evidenceSearchTerms(market,{sports}={}){
  const entities=evidenceEntities(market,{sports}),teams=sports?.teams||[],names=[...entities];
  for(const team of teams){const parts=words(team.name),nickname=parts.at(-1);if(nickname?.length>=5&&!['united','city','athletic','albion','forest','palace'].includes(nickname))names.push(nickname);}
  names.push(...(sports?.availability||[]).map(row=>row.name).filter(Boolean).slice(0,2));
  return [...new Set(names)].slice(0,8);
}
export function safePublicURL(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function interpretation(text,topic){
  if(topic==='nfl'&&/\b(qb|quarterback)\b/.test(text)&&specificUpdate.test(text))return {claim_type:'availability_report',impact:'A change at quarterback can alter pass depth, sack exposure and play calling. Check who takes first-team reps and who is confirmed at kickoff. A team-strength model cannot isolate this change from the headline.'};
  if(/\b(out|ruled out|questionable|doubtful|injury|injured|starting|lineup|minutes)\b/.test(text)&&sportsTopics.has(topic))return {claim_type:'availability_report',impact:'Check the player, expected role and official game status. A confirmed absence can change the lineup and matchup.'};
  if(/\b(postponed|cancelled|canceled|rescheduled)\b/.test(text))return {claim_type:'schedule_report',impact:'A schedule change can affect cancellation or rescheduling rules. Verify the official event notice and the exact contract settlement treatment before interpreting any price.'};
  if(topic==='film'&&/\b(review|reviews|critics|tomatometer)\b/.test(text))return {claim_type:'critic_context',impact:'Review coverage can inform critical reception. Verify the review count, embargo date and score definition; positive-review share does not directly measure ticket sales or the probability of a box-office threshold.'};
  if(topic==='film'&&/\b(presales|tickets|opening|gross|screens)\b/.test(text))return {claim_type:'demand_context',impact:'Reported presales, screens or gross can inform demand only when the release territory, currency and weekend match the contract. Separate forecasts from realized box-office receipts.'};
  if(topic==='music'&&/\b(streams|streaming|chart|billboard|spotify)\b/.test(text))return {claim_type:'chart_context',impact:'Chart reporting can inform momentum. Match artist versus song, platform, territory and daily versus weekly measurement; cross-chart ranks do not establish the settlement result.'};
  return {claim_type:'context',impact:'Context only; no direct settlement measurement identified. Review the dated source and whether the claim applies to the selected event.'};
}
export function explicitlyHistorical(title,url,now){
  const dates=[...String(title).matchAll(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+(?:19|20)\d{2}\b/gi)].map(match=>Date.parse(match[0]));
  const path=new URL(url).pathname,dated=path.match(/\/(20\d{2})[/-](0[1-9]|1[0-2])[/-]([0-2]\d|3[01])(?:\/|$)/);if(dated)dates.push(Date.parse(dated.slice(1).join('-')));
  return dates.some(date=>Number.isFinite(date)&&now-date>7*86400000);
}
export function rankEvidence(items,market,{sports,now=Date.now(),maximum=20}={}){
  const roster=[...(sports?.availability||[]),...(sports?.teams||[]).flatMap(t=>(sports?.player_stats||[]).filter(p=>p.team_id===t.id).slice(0,3))].map(p=>p.name).filter(Boolean);
  const entities=[...new Set([...evidenceEntities(market,{sports}),...roster])].slice(0,14),topic=evidenceTopic(market),seen=new Set(),ranked=[];
  const titleTerms=topicWords(market?.title).slice(0,6),topicGroups=evidenceTopicGroups(market);
  for(const item of (items||[]).slice(0,200)){
    const title=String(item.title||item.excerpt||'').slice(0,500),excerpt=String(item.excerpt||item.description||'').slice(0,900),text=normalize(title+' '+excerpt),url=safePublicURL(item.url),asof=item.as_of||item.published_at||item.created_at,date=Date.parse(asof);
    if(!url||!title||!Number.isFinite(date)||date>now+300000||now-date>7*86400000||explicitlyHistorical(title,url,now)||/\b(guaranteed|lock of the day|parlay|my prediction|unpopular opinion|giveaway|promo code|bonus bets|free bets|survivor pool|fantasy football|betting odds)\b/.test(text))continue;
    const tokens=new Set(text.split(' '));
    const matched=entities.filter(entity=>{const parts=words(entity),nickname=parts.at(-1),teamName=(sports?.teams||[]).some(t=>t.name===entity),distinctNickname=teamName&&nickname?.length>=5&&!['united','city','athletic','albion','forest','palace'].includes(nickname);return parts.length>0&&(parts.every(w=>tokens.has(w))||distinctNickname&&tokens.has(nickname));});
    const groupTerms=topicGroups.map(group=>group.find(term=>(' '+text+' ').includes(' '+normalize(term)+' '))).filter(Boolean);
    const relatedTerms=!matched.length&&!sportsTopics.has(topic)&&!['reddit','x'].includes(item.platform)?
      topicGroups.length?(groupTerms.length===topicGroups.length?groupTerms:[]):titleTerms.filter(term=>tokens.has(term)):[];
    if(!matched.length&&relatedTerms.length<2)continue;
    const fixturePage=/\b(game details|game summary|match report|box ?score|live score|game preview|game recap|highlights)\b/.test(normalize(title));
    if(sportsTopics.has(topic)&&fixturePage&&(sports?.teams||[]).length===2&&sports.teams.some(team=>!matched.includes(team.name)))continue;
    const identityURL=new URL(safePublicURL(item.publisher_url)||url),postURL=new URL(url),source=SOURCE_CATALOG.find(s=>s.handle&&item.platform==='x'&&postURL.hostname==='x.com'&&postURL.pathname.split('/')[1]?.toLowerCase()===s.handle.toLowerCase()&&s.handle.toLowerCase()===String(item.author||'').toLowerCase()||s.domain&&(identityURL.hostname===s.domain||identityURL.hostname.endsWith('.'+s.domain)));
    const tier=item.platform==='reddit'?'community_context':source?.tier||'unverified_context';
    const specificity=specificUpdate.test(text);
    const reputation={primary:1,reported:.8,specialist_context:.55,community_context:.2,unverified_context:.35}[tier]??.35;
    const relevance=matched.length?Math.min(1,matched.length/Math.min(2,entities.length)):Math.min(.5,relatedTerms.length/Math.max(1,topicGroups.length||titleTerms.length)),freshness=Math.exp(-(now-date)/(36*3600000)),score=Math.round(100*(.4*relevance+.25*reputation+.2*freshness+.15*Number(specificity)));
    const key=normalize(title).replace(/\b(espn|reuters|associated press|variety|the hollywood reporter)\b/g,'').trim();if(seen.has(key))continue;seen.add(key);
    const teamMatches=(sports?.teams||[]).filter(team=>matched.includes(team.name)).length;
    const match_scope=!matched.length||topicGroups.length&&groupTerms.length<topicGroups.length||sportsTopics.has(topic)&&sports?.teams?.length===2&&teamMatches!==2?'related':'matched';
    ranked.push({...item,id:item.id||url,title,url,excerpt,publisher:source?.name||item.publisher||item.source||'Unverified source',source_tier:tier,as_of:new Date(date).toISOString(),score,match_scope,...interpretation(text,topic),
      confidence:tier==='primary'?'primary_source':tier==='reported'?'attributed_report':'unverified_context',metrics:item.metrics||{},
      why_relevant:relatedTerms.length?'Shares the terms '+relatedTerms.join(', ')+'. Verify the subject, date and measurement before using it.':'Names '+matched.join(' and ')+'. '+(match_scope==='related'?(sportsTopics.has(topic)?'This is a team or player update. Check the exact game before applying it.':'This is an entity mention. Check whether it covers the specific contract measurement.'):specificity?'Includes a specific update to review.':'Provides context for the selected outcome.'),
      limitations:[...(item.limitations||[]),...(item.platform==='reddit'?['Community votes and heuristics do not prove authenticity or factual accuracy.']:[]),'Editorial relevance rank; not a probability, accuracy score or estimate of price impact.'],topic,matched_entities:matched});
  }
  ranked.sort((a,b)=>b.score-a.score||b.as_of.localeCompare(a.as_of));
  const counts=new Map(),diverse=[],overflow=[];
  for(const row of ranked){const n=counts.get(row.publisher)||0;if(n>=2)overflow.push(row);else{diverse.push(row);counts.set(row.publisher,n+1);}}
  return [...diverse,...overflow].slice(0,Math.max(1,Math.min(30,maximum)));
}
