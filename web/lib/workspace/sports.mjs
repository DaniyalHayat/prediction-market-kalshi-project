import {sourceJSON,boundedMap} from './providers.mjs';
import {publishDataset} from './warehouse.mjs';
import {fitBasketball,fitSoccer,evaluateSports,teamForm,lowMinutesSplit} from './sports-math.mjs';
import {eventDate} from '../intelligence/math.mjs';
import {fitNBAChallenger} from './nba-challenger.mjs';
import inplayParameters from './models/nba-inplay.json' with {type:'json'};
import {parseNBALiveScore,estimateNBAInPlay} from './nba-inplay-math.mjs';
import {nflResearch} from './nfl.mjs';
import {nbaAvailabilityFeedback} from './nba-availability-feedback.mjs';
const leagues={nba:{path:'basketball/nba',name:'NBA'},epl:{path:'soccer/eng.1',name:'Premier League'}};
const cache=new Map(),jobs=new Map();
const inplayPriors=new Map();
const availabilityCache=new Map(),availabilityJobs=new Map();
const base='https://site.api.espn.com/apis/site/v2/sports/';
const clean=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const score=value=>{const raw=value&&typeof value==='object'?value.value??value.displayValue:value;return ['string','number'].includes(typeof raw)&&raw!==''&&Number.isInteger(Number(raw))&&Number(raw)>=0?Number(raw):null;};
export function bookmakerComparison(odds,league) {
  const quote=odds?.[0],names=league==='nba'?['home','away']:['home','draw','away'];
  const implied=names.map(side=>{
    const raw=quote?.moneyline?.[side]?.close?.odds;
    if(typeof raw!=='string'||!/^[-+]?\d+$/.test(raw))return null;
    const american=Number(raw);if(Math.abs(american)<100||!Number.isFinite(american))return null;
    return american>0?100/(100+american):Math.abs(american)/(100+Math.abs(american));
  });
  if(implied.some(p=>p===null))return null;
  const sum=implied.reduce((s,p)=>s+p,0);
  return {provider:quote.provider?.displayName||quote.provider?.name||'Reported bookmaker',
    probabilities:Object.fromEntries(names.map((side,i)=>[side,implied[i]/sum])),overround:sum-1,
    note:'Reported bookmaker moneyline with proportional margin removal. Market-implied comparison, not an independent forecast or an executable quote. Quote time was not supplied.'};
}
export function parseGames(payload,league,now=Date.now()) {
  if(!Array.isArray(payload.events))throw new Error('Sports schedule schema is unavailable');
  return payload.events.flatMap(event=>{
    const competition=event.competitions?.[0],home=competition?.competitors?.find(t=>t.homeAway==='home'),away=competition?.competitors?.find(t=>t.homeAway==='away');
    const date=Date.parse(event.date),completed=competition?.status?.type?.completed===true||event.status?.type?.completed===true;
    const homeScore=score(home?.score),awayScore=score(away?.score);
    if(league==='epl'&&(event.league?.slug||payload.leagues?.[0]?.slug)!=='eng.1')return [];
    const seasonType=payload.season?.type??event.season?.type;
    if(league==='nba'&&seasonType!==2)return [];
    if(!home?.team?.id||!away?.team?.id||!Number.isFinite(date)||!/^\d+$/.test(event.id||''))return [];
    if(completed&&(date>now||homeScore===null||awayScore===null))return [];
    return [{id:event.id,league,played_at:new Date(date).toISOString(),home_id:String(home.team.id),away_id:String(away.team.id),
      home_name:home.team.displayName,away_name:away.team.displayName,home_score:completed?homeScore:null,away_score:completed?awayScore:null,completed,
      season_type:seasonType??null,bookmaker:bookmakerComparison(competition.odds,league)}];
  });
}
export function parseMinutes(payload) {
  const game=String(payload.header?.id||'');
  return (payload.boxscore?.players||[]).flatMap(team=>(team.statistics||[]).flatMap(stat=>{
    const index=(stat.names||[]).findIndex(s=>/^(minutes|min)$/i.test(s));if(index<0)return [];
    return (stat.athletes||[]).flatMap(row=>{const raw=row.stats?.[index];let minutes=null;
      if(row.didNotPlay===true)minutes=0;else if(typeof raw==='string'&&/^\d+(?::[0-5]\d)?$/.test(raw)){
        const [m,s='0']=raw.split(':');minutes=Number(m)+Number(s)/60;
      }
      return minutes===null||!row.athlete?.id?[]:[{game_id:game,team_id:String(team.team.id),player_id:String(row.athlete.id),name:row.athlete.displayName,minutes}];
    });
  }));
}
export function parsePlayerStats(payload){
  const minutes=new Map(parseMinutes(payload).map(row=>[row.team_id+'#'+row.player_id,row])),rows=[];
  for(const team of payload.boxscore?.players||[])for(const stat of team.statistics||[])for(const athlete of stat.athletes||[]){
    const row=minutes.get(String(team.team?.id)+'#'+String(athlete.athlete?.id));if(!row)continue;
    const numeric=name=>{const index=(stat.names||[]).findIndex(key=>String(key).toUpperCase()===name),value=athlete.stats?.[index];return typeof value==='string'&&/^\d+$/.test(value)?Number(value):null;};
    rows.push({...row,starter:athlete.starter===true,did_not_play:athlete.didNotPlay===true,position:athlete.athlete?.position?.abbreviation||null,
      points:numeric('PTS'),rebounds:numeric('REB'),assists:numeric('AST'),turnovers:numeric('TO'),steals:numeric('STL'),blocks:numeric('BLK')});
  }
  return [...new Map(rows.map(r=>[r.game_id+'#'+r.team_id+'#'+r.player_id,r])).values()];
}
export function playerEvidence(games,rows,teamId,{cutoff=Date.now(),maximumGames=5,threshold=15}={}){
  const completed=games.filter(g=>g.completed!==false&&Date.parse(g.played_at)<cutoff&&(g.home_id===teamId||g.away_id===teamId)).sort((a,b)=>b.played_at.localeCompare(a.played_at)),recentIds=new Set(completed.slice(0,maximumGames).map(g=>g.id));
  const players=[...new Set(rows.filter(r=>r.team_id===teamId&&recentIds.has(r.game_id)).map(r=>r.player_id))];
  return players.map(id=>{
    const all=rows.filter(r=>r.team_id===teamId&&r.player_id===id),recent=all.filter(r=>recentIds.has(r.game_id)),average=key=>{const values=recent.map(r=>r[key]).filter(Number.isFinite);return values.length?values.reduce((s,v)=>s+v,0)/values.length:null;},comparison=lowMinutesSplit(completed,rows,teamId,id,threshold);
    return {player_id:id,team_id:teamId,name:recent[0].name,position:recent[0].position||null,games_observed:recent.length,games_expected:recentIds.size,games_played:recent.filter(r=>!r.did_not_play&&r.minutes>0).length,
      averages:{minutes:average('minutes'),points:average('points'),rebounds:average('rebounds'),assists:average('assists'),turnovers:average('turnovers'),steals:average('steals'),blocks:average('blocks')},
      game_rows:recent.map(r=>({...r,played_at:completed.find(g=>g.id===r.game_id)?.played_at})),comparison,
      low_minutes_games:completed.filter(g=>all.some(r=>r.game_id===g.id&&r.minutes<=threshold)).map(g=>({game_id:g.id,played_at:g.played_at,minutes:all.find(r=>r.game_id===g.id).minutes,won:g.home_id===teamId?g.home_score>g.away_score:g.away_score>g.home_score,home_score:g.home_score,away_score:g.away_score})),
      note:'Last-five team-game window. Missing boxscore rows are excluded, not treated as zero. Boxscore DNP rows have zero observed minutes. Injury, rest, coaching and game-state causes are not identified by minutes.'};
  }).sort((a,b)=>(b.averages.minutes??-1)-(a.averages.minutes??-1));
}
export async function leagueData(league) {
  const cached=cache.get(league);if(cached&&cached.until>Date.now())return cached.value;
  if(jobs.has(league))return jobs.get(league);
  const job=(async()=>{
    const config=leagues[league];if(!config)throw new RangeError('Only NBA and Premier League match models are supported');
    const response=await sourceJSON('ESPN '+config.name,base+config.path+'/teams?limit=100',{ttl:86400});
    const teams=(response.data.sports?.[0]?.leagues?.[0]?.teams||[]).map(({team:t})=>({id:String(t.id),name:t.displayName,code:t.abbreviation,
      aliases:[t.displayName,t.name,t.location,t.shortDisplayName,t.abbreviation,t.nickname].filter(Boolean).map(clean)}));
    if(teams.length<15||teams.length>40)throw new Error('Team-catalog coverage is incomplete');
    const now=new Date(),year=league==='nba'?now.getUTCFullYear()+(now.getUTCMonth()>=6?1:0):now.getUTCFullYear()-(now.getUTCMonth()<6?1:0);
    const tasks=teams.flatMap(t=>[year-2,year-1,year].map(season=>({team:t.id,season}))),errors=[];
    const schedules=await boundedMap(tasks,3,async task=>{
      try {const result=await sourceJSON('ESPN '+config.name,base+config.path+'/teams/'+task.team+'/schedule?season='+task.season,{ttl:21600});
        return {rows:parseGames(result.data,league),source:{url:result.source_url,as_of:result.as_of,sha256:result.sha256}};
      }catch(error){errors.push({team:task.team,season:task.season,error:error.message});return null;}
    });
    const all=new Map();for(const value of schedules)for(const game of value?.rows||[])all.set(game.id,game);
    const games=[...all.values()].filter(g=>g.completed).sort((a,b)=>a.played_at.localeCompare(b.played_at));
    const nowMs=Date.now(),eligible=games.filter(g=>Date.parse(g.played_at)<nowMs),validation=evaluateSports(eligible,league);
    const model=eligible.length>=80?(league==='nba'?fitBasketball(eligible):fitSoccer(eligible)):null;
    const challenger=league==='nba'&&model?fitNBAChallenger(eligible):null;
    const sources=schedules.filter(Boolean).map(s=>s.source),as_of=new Date().toISOString(),sourceAsOf=sources.map(s=>s.as_of).sort()[0]||null;
    const persistence=await publishDataset('espn-'+league,{url:response.source_url,as_of},
      {dataset:'normalized completed schedules',sources,games},games,'sports').catch(()=>({persisted:false}));
    const value={league,teams,games,scheduled:[...all.values()].filter(g=>!g.completed),sources,as_of,source_as_of:sourceAsOf,model,challenger,validation,errors,persistence,
      coverage:{schedules_expected:tasks.length,schedules_returned:sources.length,completed_games:games.length,partial:errors.length>0}};
    cache.set(league,{until:Date.now()+21600000,value});return value;
  })();
  jobs.set(league,job);try{return await job;}finally{jobs.delete(league);}
}
function mentions(text,alias){return alias.length>=3&&(' '+text+' ').includes(' '+alias+' ');}
function scheduledDay(date,league){return new Intl.DateTimeFormat('en-CA',{timeZone:league==='nba'?'America/New_York':'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));}
export function sportsContractDate(market){
  const code=(market.event_ticker||market.ticker||'').match(/^KX(?:NBAGAME|EPLGAME)-(\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2})[A-Z0-9]*(?:-|$)/);
  return code?eventDate({event_ticker:'EVENT-'+code[1]}):null;
}
const equivalentCodes={nba:{GS:['GSW'],NO:['NOP'],NY:['NYK'],SA:['SAS'],UTAH:['UTA'],WSH:['WAS']},epl:{BHA:['BRI'],MNC:['MCI'],MAN:['MUN']}};
function tickerTeams(market,data){
  const match=/^KX(?:NBAGAME|EPLGAME)-\d{2}[A-Z]{3}\d{2}([A-Z]{4,8})-([A-Z]{2,4})$/.exec(market.ticker||'');
  if(!match)return null;
  const codes=team=>[team.code,...(equivalentCodes[data.league]?.[team.code]||[])].filter(value=>typeof value==='string'&&/^[A-Z]{2,4}$/.test(value));
  const pairs=data.teams.flatMap(a=>codes(a).flatMap(code=>match[1].startsWith(code)?
    data.teams.filter(b=>b.id!==a.id&&codes(b).includes(match[1].slice(code.length))).map(b=>[a,b]):[]));
  const unique=[...new Map(pairs.map(pair=>[pair.map(t=>t.id).sort().join('#'),pair])).values()];
  if(unique.length!==1)return null;
  const pair=unique[0],selected=pair.filter(team=>codes(team).includes(match[2]));
  return {teams:pair,outcome:match[2]==='TIE'||match[2]==='DRAW'?'draw':selected.length===1?selected[0].id:null};
}
function outcomeMatches(team,outcome){
  const full=clean(team.name).replace(/^la /,'los angeles ');
  const words=full.split(' '),initial=words.length>1?words.slice(0,-1).join(' ')+' '+words.at(-1)[0]:null;
  return team.aliases.some(alias=>mentions(outcome,alias))||outcome.length>=4&&full.startsWith(outcome+' ')||outcome===full||outcome===initial;
}
export function matchGame(market,data) {
  const date=sportsContractDate(market),text=clean(market.rules_primary+' '+market.title),outcome=clean(market.yes_sub_title||market.title.replace(/ wins$/i,''));
  if(!date)return {reason:'The contract has no unambiguous scheduled date.'};
  const identity=tickerTeams(market,data),teams=identity?.teams||data.teams.filter(t=>t.aliases.some(alias=>mentions(text,alias)));
  const ids=new Set(teams.map(t=>t.id));
  const matches=[...data.scheduled,...data.games].filter(g=>ids.has(g.home_id)&&ids.has(g.away_id)&&scheduledDay(g.played_at,data.league)===date);
  if(matches.length!==1)return {reason:'An exact two-team event and scheduled-date match was not established.'};
  const game=matches[0],draw=/^(tie|draw)( is the result)?$/.test(outcome),labels=teams.filter(t=>[game.home_id,game.away_id].includes(t.id)&&outcomeMatches(t,outcome));
  const team=labels.length===1?labels.filter(t=>!identity||identity.outcome===t.id):[];
  if(identity&&(draw?identity.outcome!=='draw':identity.outcome==='draw'))return {game,reason:'The ticker outcome and YES label do not match.'};
  if(!draw&&team.length!==1)return {game,reason:'The YES outcome could not be matched to exactly one team.'};
  if(draw&&data.league==='nba')return {game,reason:'A basketball draw is not supported.'};
  return {game,side:draw?'draw':team[0].id===game.home_id?'home':'away'};
}
async function availability(league,game,data) {
  const config=leagues[league],summary=await sourceJSON('ESPN '+config.name,base+config.path+'/summary?event='+game.id,{ttl:600});
  if(String(summary.data.header?.id||'')!==String(game.id))throw new Error('Availability fixture identity does not match.');
  const reported=(summary.data.injuries||[]).filter(t=>[game.home_id,game.away_id].includes(String(t.team?.id))).flatMap(t=>(t.injuries||[]).slice(0,8).map(i=>({
    name:i.athlete?.displayName||'Unnamed player',player_id:String(i.athlete?.id||''),team_id:String(t.team.id),status:i.status||'Not specified',
    detail:[i.details?.type,i.details?.detail].filter(Boolean).join(' · '),reported_return:i.details?.returnDate||null})));
  const cutoff=Math.min(Date.now(),Date.parse(game.played_at));
  const selected=reported.slice(0,4),history=[...new Map([game.home_id,game.away_id].flatMap(id=>data.games.filter(g=>Date.parse(g.played_at)<cutoff&&(g.home_id===id||g.away_id===id)).slice(selected.length?-12:-5)).map(g=>[g.id,g])).values()].sort((a,b)=>a.played_at.localeCompare(b.played_at));
  const boxes=league==='nba'?await boundedMap(history,3,async g=>{
    try{const response=await sourceJSON('ESPN boxscores',base+config.path+'/summary?event='+g.id,{ttl:604800});return {rows:parsePlayerStats(response.data),source:{kind:'player_boxscore',label:'ESPN completed-game player boxscore',url:response.source_url,retrieved_at:response.as_of,sha256:response.sha256}};}catch{return {rows:[]};}
  }):[];
  const minutes=boxes.flatMap(b=>b.rows),players=league==='nba'?[game.home_id,game.away_id].flatMap(id=>playerEvidence(data.games,minutes,id,{cutoff})):[];
  const sampleCutoff=Date.parse(history[0]?.played_at);
  const training=league==='nba'&&reported.some(row=>/^(out|suspended)$/i.test(row.status))&&Number.isFinite(sampleCutoff)?
    data.games.filter(g=>Date.parse(g.played_at)<sampleCutoff):[];
  const feedbackBaseline=training.length>=80?{...fitBasketball(training),trained_through:training.at(-1).played_at}:null;
  return {rows:reported.map(row=>({...row,comparison:selected.some(s=>s.player_id===row.player_id)?lowMinutesSplit(data.games,minutes,row.team_id,row.player_id):null})),
    feedbackGames:history,feedbackRows:minutes,feedbackBaseline,
    player_stats:players,boxscore_coverage:{requested:history.length,returned:boxes.filter(b=>b.source).length,player_rows:minutes.length},boxscore_sources:boxes.flatMap(b=>b.source?[b.source]:[]),
    lineup_scenarios:players.filter(p=>reported.some(r=>r.player_id===p.player_id)||players.filter(q=>q.team_id===p.team_id).slice(0,3).includes(p)).map(p=>({player_id:p.player_id,name:p.name,team_id:p.team_id,reported_status:reported.find(r=>r.player_id===p.player_id)?.status||'No status reported in this feed',threshold_minutes:p.comparison.threshold_minutes,low:p.comparison.low,regular:p.comparison.regular,observed_low_minutes_games:p.low_minutes_games,probability_adjustment:null,classification:'descriptive_scenario_evidence',limitation:p.comparison.note})),
    source:{kind:'reported_availability',label:'ESPN event availability',url:summary.source_url,retrieved_at:summary.as_of},
    note:'Availability comes from the matched event feed. Low-minutes comparisons are descriptive. Confirmed absences can contribute a separate risk scenario when enough comparable boxscores exist.'};
}
async function currentAvailability(league,game,data,{full,refresh}){
  const key=league+'#'+game.id+'#'+data.as_of,hit=availabilityCache.get(key);
  if(hit?.until>Date.now())return hit.value;
  if(!full&&!refresh)return null;
  let pending=availabilityJobs.get(key);
  if(!pending&&availabilityJobs.size<4){
    pending=availability(league,game,data).then(value=>{
      if(availabilityCache.size>=64)availabilityCache.delete(availabilityCache.keys().next().value);
      availabilityCache.set(key,{until:Math.min(Date.now()+600000,Date.parse(value.source.retrieved_at)+600000),value});
      return value;
    }).catch(()=>null).finally(()=>availabilityJobs.delete(key));
    availabilityJobs.set(key,pending);
  }
  if(!pending||full)return pending??null;
  let timer;
  try{return await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(resolve,3500,null);})]);}
  finally{clearTimeout(timer);}
}
async function nbaInPlay(game,data,side){
  const response=await sourceJSON('ESPN NBA live score',base+'basketball/nba/summary?event='+game.id,{ttl:5,maximumBytes:4000000});
  const observed=parseNBALiveScore(response.data,game,response.as_of),key=game.id+'#'+data.as_of;
  let prior=inplayPriors.get(key);
  if(!prior){
    const cutoff=Date.parse(game.played_at)-8*3600000,games=data.games.filter(g=>Date.parse(g.played_at)<cutoff);
    const fit=games.length>=80?fitBasketball(games).predict(game.home_id,game.away_id):null;
    if(fit)prior={probability:fit.home,interval:fit.interval,training_games:games.length,cutoff:new Date(cutoff).toISOString(),
      label:'Reconstructed independent prior; games starting within the previous eight hours are excluded.'};
    if(inplayPriors.size>=64)inplayPriors.delete(inplayPriors.keys().next().value);
    inplayPriors.set(key,prior||null);
  }
  const estimate=estimateNBAInPlay(observed,prior,inplayParameters),source={kind:'live_score',label:'ESPN NBA score and clock',url:response.source_url,retrieved_at:response.as_of,sha256:response.sha256};
  return {score:observed,source,forecast:estimate.available?{...estimate,inplay:true,
    probability:side==='home'?estimate.probability:1-estimate.probability,
    interval:side==='home'?estimate.interval:[1-estimate.interval[1],1-estimate.interval[0]],source_url:response.source_url,
    comparison:{baseline_probability:null,pregame_prior_probability:side==='home'?prior.probability:1-prior.probability}}:
    {...estimate,inplay:true,source_as_of:response.as_of,source_url:response.source_url,score:observed}};
}
export async function sportsResearch(market,{includeAvailability=true,refreshAvailability=false,...options}={}) {
  if (market.ticker.startsWith('KXNFLGAME-')) return nflResearch(market, options);
  const league=market.ticker.startsWith('KXNBAGAME-')?'nba':market.ticker.startsWith('KXEPLGAME-')?'epl':null;
  if(!league)return null;
  let data=await leagueData(league),match=matchGame(market,data);
  const date=sportsContractDate(market);
  if((!match.game||!match.game.bookmaker)&&date){
    const fixture=await sourceJSON('ESPN '+leagues[league].name,base+leagues[league].path+'/scoreboard?'+new URLSearchParams({dates:date.replaceAll('-',''),limit:'100'}),{ttl:900}).catch(()=>null);
    if(fixture){const scheduled=parseGames(fixture.data,league).filter(g=>!g.completed);
      data={...data,scheduled:[...new Map([...data.scheduled,...scheduled].map(g=>[g.id,g])).values()]};match=matchGame(market,data);
    }
  }
  const game=match.game;
  if(!game)return {league,reason:match.reason,teams:[],head_to_head:[],coverage:data.coverage,as_of:data.as_of};
  const cutoff=Math.min(Date.now(),Date.parse(game.played_at)),prior=data.games.filter(g=>Date.parse(g.played_at)<cutoff);
  const paired=prior.filter(g=>[game.home_id,game.away_id].includes(g.home_id)&&[game.home_id,game.away_id].includes(g.away_id)).slice(-5).reverse();
  const estimate=!game.completed&&Date.parse(game.played_at)>Date.now()?data.model?.predict(game.home_id,game.away_id):null;
  const p=match.side&&estimate?estimate[match.side]:null;
  const interval=p===null?null:league==='nba'?(match.side==='home'?estimate.interval:[1-estimate.interval[1],1-estimate.interval[0]]):estimate.ranges[match.side];
  const alternative=match.side&&data.challenger?.available?data.challenger.predict(game):null;
  const live=league==='nba'&&match.side&&!game.completed&&Date.parse(game.played_at)<=Date.now()?await nbaInPlay(game,data,match.side).catch(error=>({
    forecast:{available:false,experimental:true,inplay:true,max_source_age_seconds:30,reason:'Fresh in-play evidence was unavailable: '+error.message}})):null;
  const injuries=await currentAvailability(league,game,data,{full:includeAvailability,refresh:refreshAvailability&&league==='nba'&&p!==null});
  const availabilityFor=(probability,range)=>league==='nba'&&Number.isFinite(probability)&&injuries?.source?nbaAvailabilityFeedback({game,selection:match.side,
    forecast:{probability,interval:range},current:injuries,games:injuries.feedbackGames,playerRows:injuries.feedbackRows,baseline:injuries.feedbackBaseline}):null;
  const availability_feedback=availabilityFor(p,interval);
  const alternativeRange=alternative?(match.side==='home'?alternative.interval:[1-alternative.interval[1],1-alternative.interval[0]]):null;
  const references=[game.home_id,game.away_id].map(id=>data.sources.filter(s=>s.url.includes('/teams/'+id+'/schedule?')).sort((a,b)=>b.url.localeCompare(a.url))[0]).filter(Boolean);
  return {league,event:game,teams:[{id:game.home_id,name:game.home_name},{id:game.away_id,name:game.away_name}].map(team=>({...team,form:teamForm(prior,team.id,cutoff),form_last_five:teamForm(prior,team.id,cutoff,5),last_five_games:prior.filter(g=>g.home_id===team.id||g.away_id===team.id).slice(-5).reverse()})),head_to_head:paired,availability:includeAvailability?injuries?.rows||[]:[],availability_note:injuries?.note,
    player_stats:includeAvailability?injuries?.player_stats||[]:[],lineup_scenarios:includeAvailability?injuries?.lineup_scenarios||[]:[],boxscore_coverage:injuries?.boxscore_coverage||null,availability_feedback,
    coverage:data.coverage,as_of:data.as_of,reason:match.reason||null,bookmaker:game.bookmaker,
    live_score:live?.score||null,
    challenger:live?live.forecast:!data.challenger?null:alternative?{available:true,probability:alternative[match.side],
      interval:alternativeRange,interval_kind:alternative.interval_kind,availability_feedback:availabilityFor(alternative[match.side],alternativeRange),
      model_name:alternative.model_name,source_as_of:data.source_as_of,source_url:references[0]?.url,validation:data.challenger.validation,
      experimental:alternative.experimental,promotion_passed:data.challenger.promoted,eligible:data.challenger.promoted&&!data.coverage.partial&&!match.reason,
      promotion_reason:alternative.promotion_reason,trained_at:data.challenger.trained_at,calibration_residuals:alternative.calibration_residuals,
      calibration_weeks:alternative.calibration_weeks,constituents:alternative.constituents,
      comparison:{baseline_probability:p,baseline_holdout_brier:data.challenger.validation.baseline_brier,
        challenger_holdout_brier:data.challenger.validation.brier,relative_brier_improvement:data.challenger.validation.brier_skill,
        paired_improvement_95_lower:data.challenger.validation.improvement_95_lower}}:
      {available:false,reason:data.challenger.reason||'The challenger requires a uniquely mapped future NBA game.'},
    forecast:p===null?null:{probability:p,interval,interval_kind:estimate.interval_kind,source_as_of:data.source_as_of,source_url:references[0]?.url,validation:data.validation,
      model_name:league==='nba'?'Recency-weighted regularized Bradley–Terry':'Regularized independent Poisson attack/defense',
      eligible:data.validation.passed&&!data.coverage.partial&&!match.reason},
    model:{name:league==='nba'?'Recency-weighted Bradley–Terry':'Poisson attack/defense',validation:data.validation,input_sources:data.sources.length,training_history_games:data.games.length,
      limitation:'Historical team-strength baseline. A separately labeled availability scenario can widen the decision range. A positive holdout does not establish profitable trading.'},
    sources:[...references.map(s=>({kind:'sports_results',label:'ESPN '+leagues[league].name+' team schedule (part of '+data.sources.length+' source schedules)',url:s.url,retrieved_at:s.as_of,sha256:s.sha256})),...(injuries?.source?[injuries.source]:[]),...(includeAvailability?injuries?.boxscore_sources||[]:[]),...(live?.source?[live.source]:[])]};
}
