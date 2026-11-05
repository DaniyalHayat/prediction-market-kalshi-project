const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/https?:\/\/\S+/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
const words=value=>normalize(value).split(' ').filter(w=>w.length>2&&!new Set(['will','which','what','this','that','with','from','have','game','wins','team','their','they','than','over','under','more','most','number','first','song','artist']).has(w));
export const SOURCE_CATALOG=Object.freeze([
  {id:'nba-official',name:'NBA official reports',tier:'primary',domain:'official.nba.com',topics:['nba'],identity_url:'https://official.nba.com/nba-injury-report-2026-27-season',checked_at:'2026-11-05',role:'League participation reports; check the dated report and updates.'},
  {id:'espn',name:'ESPN',tier:'reported',domain:'espn.com',topics:['nba','epl'],identity_url:'https://www.espn.com/',checked_at:'2026-11-05',role:'Sports schedules, boxscores and attributed reporting.'},
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
  return /^KXNBAGAME-/i.test(text)||/\bNBA\b/i.test(text)?'nba':/^KXEPLGAME-/i.test(text)||/premier league/i.test(text)?'epl':/spotify|billboard|apple music|top song|top artist/i.test(text)?'music':/film|movie|rotten tomatoes|box office|oscar/i.test(text)?'film':'other';
}
export function evidenceEntities(market,{sports}={}){
  const values=(sports?.teams||[]).map(t=>t.name).filter(Boolean);
  if(values.length)return [...new Set(values)];
  for(const key of ['Artist','Movie','Film','Song','Team'])if(typeof market?.custom_strike?.[key]==='string')values.push(market.custom_strike[key]);
  if(typeof market?.yes_sub_title==='string'&&!/^(yes|no|tie|draw|over|under|other)$/i.test(market.yes_sub_title.trim()))values.push(market.yes_sub_title);
  return [...new Set(values.map(v=>v.trim()).filter(v=>words(v).length))].slice(0,4);
}
export function safePublicURL(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function interpretation(text,topic){
  if(/\b(out|ruled out|questionable|doubtful|injury|injured|starting|lineup|minutes)\b/.test(text)&&['nba','epl'].includes(topic))return {claim_type:'availability_report',impact:'A confirmed absence or minutes restriction can change rotations and opponent matchups. Match the player, game date and official participation report; these words alone do not quantify an effect on YES.'};
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
  for(const item of (items||[]).slice(0,200)){
    const title=String(item.title||item.excerpt||'').slice(0,500),excerpt=String(item.excerpt||item.description||'').slice(0,900),text=normalize(title+' '+excerpt),url=safePublicURL(item.url),asof=item.as_of||item.published_at||item.created_at,date=Date.parse(asof);
    if(!url||!title||!Number.isFinite(date)||date>now+300000||now-date>7*86400000||explicitlyHistorical(title,url,now)||/\b(guaranteed|lock of the day|parlay|my prediction|unpopular opinion|giveaway)\b/.test(text))continue;
    const matched=entities.filter(entity=>{const parts=words(entity),tokens=text.split(' '),nickname=parts.at(-1),teamName=(sports?.teams||[]).some(t=>t.name===entity),distinctNickname=teamName&&nickname?.length>=5&&!['united','city','athletic','albion','forest','palace'].includes(nickname);return parts.length>0&&(parts.every(w=>tokens.includes(w))||distinctNickname&&tokens.includes(nickname));});
    if(!matched.length)continue;
    const fixturePage=/\b(game details|game summary|match report|box ?score|live score|game preview|game recap|highlights)\b/.test(normalize(title));
    if(['nba','epl'].includes(topic)&&fixturePage&&(sports?.teams||[]).length===2&&sports.teams.some(team=>!matched.includes(team.name)))continue;
    const identityURL=new URL(safePublicURL(item.publisher_url)||url),postURL=new URL(url),source=SOURCE_CATALOG.find(s=>s.handle&&item.platform==='x'&&postURL.hostname==='x.com'&&postURL.pathname.split('/')[1]?.toLowerCase()===s.handle.toLowerCase()&&s.handle.toLowerCase()===String(item.author||'').toLowerCase()||s.domain&&(identityURL.hostname===s.domain||identityURL.hostname.endsWith('.'+s.domain)));
    const tier=item.platform==='reddit'?'community_context':source?.tier||'unverified_context';
    const specificity=/\b(out|ruled out|questionable|doubtful|injury|injured|starting|lineup|minutes|confirmed|postponed|cancelled|review|presales|tickets|opening|gross|streams|chart)\b/.test(text);
    const reputation={primary:1,reported:.8,specialist_context:.55,community_context:.2,unverified_context:.35}[tier]??.35;
    const relevance=Math.min(1,matched.length/Math.min(2,entities.length)),freshness=Math.exp(-(now-date)/(36*3600000)),score=Math.round(100*(.4*relevance+.25*reputation+.2*freshness+.15*Number(specificity)));
    const key=normalize(title).replace(/\b(espn|reuters|associated press|variety|the hollywood reporter)\b/g,'').trim();if(seen.has(key))continue;seen.add(key);
    ranked.push({...item,id:item.id||url,title,url,excerpt,publisher:source?.name||item.publisher||item.source||'Unverified source',source_tier:tier,as_of:new Date(date).toISOString(),score,...interpretation(text,topic),
      confidence:tier==='primary'?'primary_source':tier==='reported'?'attributed_report':'unverified_context',metrics:item.metrics||{},
      why_relevant:'Names '+matched.join(' and ')+'. '+(specificity?'Contains a possible availability, schedule, review, demand or chart update.':'Provides topic context for the selected outcome.'),
      limitations:[...(item.limitations||[]),...(item.platform==='reddit'?['Community votes and heuristics do not prove authenticity or factual accuracy.']:[]),'Editorial relevance rank; not a probability, accuracy score or estimate of price impact.'],topic,matched_entities:matched});
  }
  ranked.sort((a,b)=>b.score-a.score||b.as_of.localeCompare(a.as_of));
  const counts=new Map(),diverse=[],overflow=[];
  for(const row of ranked){const n=counts.get(row.publisher)||0;if(n>=2)overflow.push(row);else{diverse.push(row);counts.set(row.publisher,n+1);}}
  return [...diverse,...overflow].slice(0,Math.max(1,Math.min(30,maximum)));
}
