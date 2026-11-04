import {sourceJSON,boundedMap} from './providers.mjs';
import {publishDataset} from './warehouse.mjs';
import {fitBasketball,fitSoccer,evaluateSports,teamForm,lowMinutesSplit} from './sports-math.mjs';
import {eventDate} from '../intelligence/math.mjs';
const leagues={nba:{path:'basketball/nba',name:'NBA'},epl:{path:'soccer/eng.1',name:'Premier League'}};
const cache=new Map(),jobs=new Map();
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
export async function leagueData(league) {
  const cached=cache.get(league);if(cached&&cached.until>Date.now())return cached.value;
  if(jobs.has(league))return jobs.get(league);
  const job=(async()=>{
    const config=leagues[league];if(!config)throw new RangeError('Only NBA and Premier League match models are supported');
    const response=await sourceJSON('ESPN '+config.name,base+config.path+'/teams?limit=100',{ttl:86400});
    const teams=(response.data.sports?.[0]?.leagues?.[0]?.teams||[]).map(({team:t})=>({id:String(t.id),name:t.displayName,
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
    const sources=schedules.filter(Boolean).map(s=>s.source),as_of=new Date().toISOString(),sourceAsOf=sources.map(s=>s.as_of).sort()[0]||null;
    const persistence=await publishDataset('espn-'+league,{url:response.source_url,as_of},
      {dataset:'normalized completed schedules',sources,games},games,'sports').catch(()=>({persisted:false}));
    const value={league,teams,games,scheduled:[...all.values()].filter(g=>!g.completed),sources,as_of,source_as_of:sourceAsOf,model,validation,errors,persistence,
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
export function matchGame(market,data) {
  const date=sportsContractDate(market),text=clean(market.rules_primary+' '+market.title),outcome=clean(market.yes_sub_title||market.title.replace(/ wins$/i,''));
  if(!date)return {reason:'The contract has no unambiguous scheduled date.'};
  const teams=data.teams.filter(t=>t.aliases.some(alias=>mentions(text,alias)));
  const ids=new Set(teams.map(t=>t.id));
  const matches=[...data.scheduled,...data.games].filter(g=>ids.has(g.home_id)&&ids.has(g.away_id)&&scheduledDay(g.played_at,data.league)===date);
  if(matches.length!==1)return {reason:'An exact two-team event and scheduled-date match was not established.'};
  const game=matches[0],draw=/^(tie|draw)( is the result)?$/.test(outcome),team=teams.filter(t=>[game.home_id,game.away_id].includes(t.id)&&t.aliases.some(a=>mentions(outcome,a)));
  if(!draw&&team.length!==1)return {game,reason:'The YES outcome could not be matched to exactly one team.'};
  if(draw&&data.league==='nba')return {game,reason:'A basketball draw is not supported.'};
  return {game,side:draw?'draw':team[0].id===game.home_id?'home':'away'};
}
async function availability(league,game,data) {
  const config=leagues[league],summary=await sourceJSON('ESPN '+config.name,base+config.path+'/summary?event='+game.id,{ttl:600});
  const reported=(summary.data.injuries||[]).filter(t=>[game.home_id,game.away_id].includes(String(t.team?.id))).flatMap(t=>(t.injuries||[]).slice(0,8).map(i=>({
    name:i.athlete?.displayName||'Unnamed player',player_id:String(i.athlete?.id||''),team_id:String(t.team.id),status:i.status||'Not specified',
    detail:[i.details?.type,i.details?.detail].filter(Boolean).join(' · '),reported_return:i.details?.returnDate||null})));
  const cutoff=Math.min(Date.now(),Date.parse(game.played_at));
  const selected=reported.slice(0,4),history=data.games.filter(g=>Date.parse(g.played_at)<cutoff&&([game.home_id,game.away_id].includes(g.home_id)||[game.home_id,game.away_id].includes(g.away_id))).slice(-24);
  const boxes=league==='nba'&&selected.length?await boundedMap(history,3,async g=>{
    try{return parseMinutes((await sourceJSON('ESPN boxscores',base+config.path+'/summary?event='+g.id,{ttl:604800})).data);}catch{return [];}
  }):[];
  const minutes=boxes.flat();
  return {rows:reported.map(row=>({...row,comparison:selected.some(s=>s.player_id===row.player_id)?lowMinutesSplit(data.games,minutes,row.team_id,row.player_id):null})),
    source:{kind:'reported_availability',label:'ESPN event availability',url:summary.source_url,retrieved_at:summary.as_of},
    note:'Reported availability is a current feed snapshot, not a time-stamped historical injury archive. Low-minutes comparisons use actual boxscores, exclude missing players, and do not alter the matchup model.'};
}
export async function sportsResearch(market,{includeAvailability=true}={}) {
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
  const injuries=includeAvailability?await availability(league,game,data).catch(error=>({rows:[],note:'Availability was not returned: '+error.message})):null;
  const references=[game.home_id,game.away_id].map(id=>data.sources.filter(s=>s.url.includes('/teams/'+id+'/schedule?')).sort((a,b)=>b.url.localeCompare(a.url))[0]).filter(Boolean);
  return {league,event:game,teams:[{id:game.home_id,name:game.home_name,form:teamForm(prior,game.home_id,cutoff)},
    {id:game.away_id,name:game.away_name,form:teamForm(prior,game.away_id,cutoff)}],head_to_head:paired,availability:injuries?.rows||[],availability_note:injuries?.note,
    coverage:data.coverage,as_of:data.as_of,reason:match.reason||null,bookmaker:game.bookmaker,
    forecast:p===null?null:{probability:p,interval,interval_kind:estimate.interval_kind,source_as_of:data.source_as_of,source_url:references[0]?.url,validation:data.validation,
      model_name:league==='nba'?'Recency-weighted regularized Bradley–Terry':'Regularized independent Poisson attack/defense',
      eligible:data.validation.passed&&!data.coverage.partial&&!match.reason},
    model:{name:league==='nba'?'Recency-weighted Bradley–Terry':'Poisson attack/defense',validation:data.validation,input_sources:data.sources.length,training_history_games:data.games.length,
      limitation:'Historical team-strength model; no lineup, injury, betting-odds or opinion-poll adjustment. A positive holdout does not establish profitable trading.'},
    sources:[...references.map(s=>({kind:'sports_results',label:'ESPN '+leagues[league].name+' team schedule (part of '+data.sources.length+' source schedules)',url:s.url,retrieved_at:s.as_of,sha256:s.sha256})),...(injuries?.source?[injuries.source]:[])]};
}
