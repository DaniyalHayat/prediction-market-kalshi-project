const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function normalCDF(x){
  const z=Math.abs(x),t=1/(1+.2316419*z),density=Math.exp(-z*z/2)/Math.sqrt(2*Math.PI),tail=density*t*(.31938153+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
  return x>=0?1-tail:tail;
}
export function inverseNormal(p){
  if(!Number.isFinite(p)||p<=0||p>=1)throw new RangeError('An interior probability is required');
  let lo=-9,hi=9;for(let i=0;i<64;i++){const mid=(lo+hi)/2;if(normalCDF(mid)<p)lo=mid;else hi=mid;}return (lo+hi)/2;
}
const integer=value=>{const raw=typeof value==='object'&&value!==null?value.value??value.displayValue:value;return ['number','string'].includes(typeof raw)&&raw!==''&&Number.isInteger(Number(raw))&&Number(raw)>=0&&Number(raw)<=500?Number(raw):null;};
export function parseNBALiveScore(payload,game,asOf){
  const header=payload.header,competition=header?.competitions?.find(c=>String(c.id)===String(game.id));
  if(header?.league?.slug!=='nba'||!competition)return {available:false,reason:'Live score identity or NBA league could not be verified.'};
  const home=competition.competitors?.find(c=>c.homeAway==='home'),away=competition.competitors?.find(c=>c.homeAway==='away');
  if(String(home?.team?.id||home?.id)!==game.home_id||String(away?.team?.id||away?.id)!==game.away_id)return {available:false,reason:'Live score teams do not match the selected event.'};
  const status=competition.status||{},period=Number(status.period),clock=typeof status.displayClock==='string'?status.displayClock:null;
  const matched=clock?.match(/^(\d{1,2}):([0-5]\d(?:\.\d{1,3})?)$/),secondsOnly=clock?.match(/^([0-5]?\d(?:\.\d{1,3})?)$/);
  const displaySeconds=matched?Number(matched[1])*60+Number(matched[2]):secondsOnly?Number(secondsOnly[1]):null;
  const numericSeconds=typeof status.clock==='number'&&Number.isFinite(status.clock)?status.clock:null;
  const clockSeconds=displaySeconds!==null&&numericSeconds!==null&&Math.abs(displaySeconds-numericSeconds)>1?null:displaySeconds??numericSeconds;
  return {available:true,event_id:String(game.id),home_id:game.home_id,away_id:game.away_id,home_score:integer(home.score),away_score:integer(away.score),
    state:status.type?.state||null,completed:status.type?.completed===true,period:Number.isInteger(period)?period:null,clock_seconds:clockSeconds,
    display_clock:clock,observed_at:asOf,provider_updated_at:competition.lastUpdated||null,
    freshness_note:'Retrieval freshness is checked. ESPN does not always supply a timestamp for the score/clock update itself.'};
}
export function parseNBAQuarterReplay(payload,game){
  const live=parseNBALiveScore(payload,game,new Date().toISOString());
  if(!live.available||!live.completed||live.home_score!==game.home_score||live.away_score!==game.away_score)return null;
  const competition=payload.header.competitions.find(c=>String(c.id)===String(game.id)),teams=competition.competitors;
  const quarter=side=>(teams.find(c=>c.homeAway===side)?.linescores||[]).map(integer),h=quarter('home'),a=quarter('away');
  if(h.length<4||a.length!==h.length||h.some(x=>x===null)||a.some(x=>x===null)||h.reduce((s,x)=>s+x,0)!==game.home_score||a.reduce((s,x)=>s+x,0)!==game.away_score)return null;
  return {game_id:game.id,played_at:game.played_at,home_id:game.home_id,away_id:game.away_id,home_score:game.home_score,away_score:game.away_score,
    home_period_scores:h,away_period_scores:a,overtime_periods:Math.max(0,h.length-4)};
}
export function conditionalNBAProbability(lead,remainingFraction,pregameProbability,sigma){
  if(!Number.isFinite(lead)||!Number.isFinite(remainingFraction)||remainingFraction<=0||remainingFraction>1||!Number.isFinite(sigma)||sigma<=0)throw new RangeError('A valid score difference, remaining regulation fraction and empirical scale are required');
  const drift=sigma*inverseNormal(pregameProbability),z=(lead+drift*remainingFraction)/(sigma*Math.sqrt(remainingFraction));
  return clamp(normalCDF(z),1e-6,1-1e-6);
}
export function estimateNBAInPlay(score,pregame,parameters,now=Date.now()){
  const fail=reason=>({available:false,reason,experimental:true,max_source_age_seconds:30});
  if(!score?.available)return fail(score?.reason||'A verified live score was not returned.');
  if(score.completed||score.state==='post')return fail('The game is final; this in-play model does not issue a new entry estimate after completion.');
  if(score.state!=='in')return fail('The provider has not confirmed an in-progress game with a usable clock.');
  const age=(now-Date.parse(score.observed_at))/1000;
  if(!Number.isFinite(age)||age< -5||age>30)return fail('The score source must have been retrieved within 30 seconds.');
  if(!Number.isInteger(score.period)||score.period<1||score.period>4)return fail('This experimental model covers regulation only; overtime is withheld.');
  if(!Number.isFinite(score.clock_seconds)||score.clock_seconds<0||score.clock_seconds>720||![score.home_score,score.away_score].every(v=>Number.isInteger(v)&&v>=0&&v<=500))return fail('A valid period, clock and both scores are required.');
  const remaining=(4-score.period)*720+score.clock_seconds;
  if(remaining<=Math.max(5,age))return fail('The remaining regulation boundary is too close relative to retrieval age; final/extra-time uncertainty is withheld.');
  if(!Number.isFinite(pregame?.probability)||pregame.probability<=0||pregame.probability>=1||!Array.isArray(pregame.interval)||pregame.interval.length!==2||pregame.interval.some(v=>!Number.isFinite(v)||v<=0||v>=1)||pregame.interval[0]>pregame.probability||pregame.interval[1]<pregame.probability||
    !Number.isFinite(parameters?.sigma)||!Array.isArray(parameters.sigma_interval)||parameters.sigma_interval.length!==2||parameters.sigma_interval.some(v=>!Number.isFinite(v)||v<=0)||
    parameters.sigma_interval[0]>parameters.sigma||parameters.sigma_interval[1]<parameters.sigma||parameters.calibration_games<30)return fail('An independent pregame prior and audited margin-error scale are required.');
  const r=remaining/2880,lead=score.home_score-score.away_score,p=conditionalNBAProbability(lead,r,pregame.probability,parameters.sigma),scenarios=[];
  const remainingBounds=[Math.max(1,remaining-Math.max(0,age))/2880,r];
  for(const prior of pregame.interval)for(const sigma of parameters.sigma_interval)for(const fraction of remainingBounds)scenarios.push(conditionalNBAProbability(lead,fraction,prior,sigma));
  return {available:true,probability:p,interval:[Math.min(p,...scenarios),Math.max(p,...scenarios)],experimental:true,eligible:false,promotion_passed:false,
    model_name:'Score-clock conditional diffusion (experimental)',interval_kind:'Parameter sensitivity over independent pregame prior, game-block scale uncertainty and retrieval-age clock advance; not a calibrated in-play probability interval.',
    max_source_age_seconds:30,source_as_of:score.observed_at,score,remaining_regulation_seconds:remaining,pregame_prior:pregame,
    empirical_scale:{sigma:parameters.sigma,sigma_interval:parameters.sigma_interval,calibration_games:parameters.calibration_games,calibration_states:parameters.calibration_states},
    validation:parameters.validation,promotion_reason:'A functioning score-clock research model. The bounded historical quarter replay is not sufficient for production recommendation approval.',
    assumptions:['Gaussian independent score increments with constant drift/variance are approximations.','Possession, intentional fouling, lineup changes and overtime transitions are not modeled.',score.freshness_note]};
}
