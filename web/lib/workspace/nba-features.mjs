const day=86400000;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const NBA_FEATURES=['elo_logit','margin_ewma_difference','last10_winrate_difference','rest_day_difference','home_back_to_back','away_back_to_back','home_season_gap','away_season_gap','minimum_history','home_margin_ewma','away_margin_ewma'];
const fresh=()=>({elo:1500,margin:0,results:[],last:null,n:0});
export function createNBAFeatureState(){return new Map();}
export function nbaFeatures(state,game){
  const home=state.get(game.home_id)||fresh(),away=state.get(game.away_id)||fresh(),at=Date.parse(game.played_at);
  if(!Number.isFinite(at)||game.home_id===game.away_id)throw new RangeError('A dated game with distinct teams is required');
  const rest=t=>t.last===null?7:Math.max(0,(at-t.last)/day),hRest=rest(home),aRest=rest(away);
  const rate=t=>(t.results.reduce((s,v)=>s+v,0)+2)/(t.results.length+4);
  return [Math.LN10*(home.elo-away.elo+65)/400,(home.margin-away.margin)/15,rate(home)-rate(away),
    (Math.min(7,hRest)-Math.min(7,aRest))/7,hRest<=1.25?1:0,aRest<=1.25?1:0,hRest>60?1:0,aRest>60?1:0,
    Math.min(home.n,away.n,20)/20,home.margin/15,away.margin/15];
}
export function updateNBAFeatureState(state,game){
  const at=Date.parse(game.played_at),h=state.get(game.home_id)||fresh(),a=state.get(game.away_id)||fresh();
  if(!Number.isFinite(at)||!Number.isInteger(game.home_score)||!Number.isInteger(game.away_score)||game.home_score===game.away_score)throw new RangeError('A completed non-tied game is required');
  if((h.last!==null&&at<h.last)||(a.last!==null&&at<a.last))throw new RangeError('Feature updates must follow event chronology');
  const winner=game.home_score>game.away_score?1:0,p=1/(1+10**(-(h.elo-a.elo+65)/400)),change=24*(winner-p);
  h.elo+=change;a.elo-=change;
  const margin=clamp(game.home_score-game.away_score,-40,40);
  h.margin=.85*h.margin+.15*margin;a.margin=.85*a.margin-.15*margin;
  for(const [team,result] of [[h,winner],[a,1-winner]]){team.results.push(result);if(team.results.length>10)team.results.shift();team.last=at;team.n++;}
  state.set(game.home_id,h);state.set(game.away_id,a);
}
export function buildNBARows(games){
  const ordered=[...games].sort((a,b)=>a.played_at.localeCompare(b.played_at)||String(a.id).localeCompare(String(b.id))),state=createNBAFeatureState(),rows=[];
  if(new Set(ordered.map(g=>g.id)).size!==ordered.length)throw new RangeError('Duplicate game IDs are not allowed');
  for(let i=0;i<ordered.length;){let end=i+1;while(end<ordered.length&&ordered[end].played_at===ordered[i].played_at)end++;
    const group=ordered.slice(i,end);
    for(const g of group)rows.push({id:g.id,played_at:g.played_at,home_id:g.home_id,away_id:g.away_id,x:nbaFeatures(state,g),y:g.home_score>g.away_score?1:0});
    for(const g of group)updateNBAFeatureState(state,g);i=end;
  }
  return {rows,state};
}
