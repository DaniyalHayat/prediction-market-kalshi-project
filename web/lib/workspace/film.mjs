import {evidenceEntities,evidenceTopic,safePublicURL} from './source-ranking.mjs';
const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function filmResearch(market,{observations=[],criticWeight=.775,now=Date.now()}={}){
  if(evidenceTopic(market)!=='film')return null;
  if(!Number.isFinite(criticWeight)||criticWeight<.75||criticWeight>.8)throw new RangeError('The requested critic preference must be between 75% and 80%');
  const entities=evidenceEntities(market),accepted=[],rejected=[];
  for(const row of observations.slice(0,100)){
    const date=Date.parse(row.measured_at),url=safePublicURL(row.source_url),identity=entities.some(e=>normalize(e)===normalize(row.film)),kind=['critic_score','audience_score','demand_index','box_office'].includes(row.kind),score=Number.isFinite(row.value)&&row.value>=0&&(row.kind==='box_office'||row.value<=100);
    if(!identity||!kind||!score||!url||!Number.isFinite(date)||date>now||now-date>7*86400000||!row.metric||!row.publisher||(row.kind==='critic_score'&&(!Number.isInteger(row.sample_size)||row.sample_size<1))){rejected.push({kind:row.kind||null,reason:'Missing identity, date, unit, sample size or provenance; observation withheld.'});continue;}
    accepted.push({...row,source_url:url,measured_at:new Date(date).toISOString()});
  }
  const latest=kind=>accepted.filter(row=>row.kind===kind).sort((a,b)=>b.measured_at.localeCompare(a.measured_at))[0]||null,critics=latest('critic_score'),audience=latest('audience_score'),demand=latest('demand_index'),gross=latest('box_office');
  const compatible=critics&&demand&&critics.territory===demand.territory&&Math.abs(Date.parse(critics.measured_at)-Date.parse(demand.measured_at))<=86400000&&demand.metric==='demand_percentile_0_100';
  const composite=weight=>compatible?weight*critics.value+(1-weight)*demand.value:null;
  return {status:accepted.length?'observations_available':'context_only',entities,critic_weight:criticWeight,weight_basis:'User preference for an experimental display index; not an empirically calibrated predictor.',critics,audience,demand,box_office:gross,
    preference_index:{value:composite(criticWeight),unit:'0–100 preference index',probability:null,affects_forecast:false,
      sensitivity:[.75,.775,.8].map(weight=>({critic_weight:weight,value:composite(weight)})),
      reason:compatible?'Combines a critic-positive percentage and a contemporaneous same-territory demand percentile using the requested preference. These are different constructs and the result has no measured trading accuracy.':'Requires dated, exact-film critic observations and a same-territory demand percentile within 24 hours. Missing inputs are not imputed or silently reweighted.'},
    observations:accepted,rejected,questions:['Does the contract settle on a critic score, ticket sales, opening-weekend gross or an award?','How many critics have reported, and has the review embargo lifted?','Do presales, screen count and competition refer to the exact release territory and weekend?'],
    source_links:[{label:'Rotten Tomatoes score definitions',url:'https://www.rottentomatoes.com/about'},{label:'Rotten Tomatoes critic criteria',url:'https://www.rottentomatoes.com/critics/criteria'},{label:'Variety film reporting',url:'https://variety.com/v/film/'},{label:'The Hollywood Reporter film reporting',url:'https://www.hollywoodreporter.com/c/movies/'}],
    note:'Critic scores measure positive-review share, not ticket demand or probability of a box-office threshold. Audience scores, popularity, presales and realized gross remain separate observations. No critic or demand score is fabricated from headlines.'};
}
