import {createHash} from 'node:crypto';
import artifact from './models/nba-challenger.json' with {type:'json'};
import {buildNBARows,nbaFeatures,NBA_FEATURES} from './nba-features.mjs';
import {fitBasketball} from './sports-math.mjs';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sigmoid=x=>1/(1+Math.exp(-clamp(x,-35,35)));
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
export function scoreNBAArtifact(model,x,scaler=artifact.scaler){
  if(!Array.isArray(x)||x.length!==NBA_FEATURES.length||x.some(v=>!Number.isFinite(v)))throw new RangeError('Finite NBA lag features are required');
  const z=x.map((v,i)=>(v-scaler.mean[i])/scaler.scale[i]);
  if(model.kind==='logistic')return sigmoid(dot(z,model.coefficients)+model.intercept);
  if(model.kind==='neural'){
    let value=z;
    for(let k=0;k<model.weights.length;k++){const next=model.biases[k].map((b,j)=>b+value.reduce((s,v,i)=>s+v*model.weights[k][i][j],0));
      value=k===model.weights.length-1?next:next.map(v=>Math.max(0,v));}
    return sigmoid(value[0]);
  }
  if(model.kind==='xgboost'){
    const values=z.map(Math.fround);
    const traverse=tree=>{let node=tree;while(!Object.hasOwn(node,'leaf')){const index=Number(node.split.replace(/^f/,'')),id=values[index]<Math.fround(node.split_condition)?node.yes:node.no;
        node=node.children.find(child=>child.nodeid===id);if(!node)throw new Error('Invalid compiled tree');}return node.leaf;};
    return sigmoid(Math.log(model.base_score/(1-model.base_score))+model.trees.reduce((s,t)=>s+traverse(t),0));
  }
  throw new RangeError('Unknown NBA challenger model');
}
export function betaCalibrate(p,beta){
  const q=clamp(p,1e-7,1-1e-7);return sigmoid(beta[0]*Math.log(q)-beta[1]*Math.log1p(-q)+beta[2]);
}
export function residualSensitivity(p,residuals,disagreement=0){
  if(!Number.isFinite(p)||p<0||p>1||!Array.isArray(residuals)||residuals.some(r=>!Number.isFinite(r.p)||![0,1].includes(r.y)||!Number.isFinite(Date.parse(r.played_at))||Math.abs(r.error-(r.y-r.p))>1e-9))throw new RangeError('Dated, auditable calibration residuals are required');
  const local=residuals.filter(r=>Math.abs(r.p-p)<=.15),rows=local.length>=30?local:residuals;
  if(rows.length<30)return {interval:[0,1],n:rows.length,weekly_blocks:0,scope:'Too few calibration residuals; full range retained.'};
  const weeks=new Map();for(const row of rows){const key=Math.floor((Date.parse(row.played_at)+3*86400000)/(7*86400000));
    if(!weeks.has(key))weeks.set(key,[]);weeks.get(key).push(row.error);}
  const blocks=[...weeks.values()].map(values=>({sum:values.reduce((s,v)=>s+v,0),n:values.length})),values=[];let seed=88217;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<1000;i++){let sum=0,n=0;for(let j=0;j<blocks.length;j++){const block=blocks[Math.floor(random()*blocks.length)];sum+=block.sum;n+=block.n;}values.push(sum/n);}
  values.sort((a,b)=>a-b);const margin=clamp(disagreement,0,1);
  return {interval:[clamp(Math.min(p,p+values[25])-margin,0,1),clamp(Math.max(p,p+values[974])+margin,0,1)],n:rows.length,weekly_blocks:blocks.length,
    scope:'95% whole-week calibration-residual sensitivity plus constituent disagreement; not a guaranteed event-probability interval.'};
}
export function fitNBAChallenger(games,{model=artifact,now=Date.now()}={}){
  const ordered=[...games].sort((a,b)=>a.played_at.localeCompare(b.played_at)||String(a.id).localeCompare(String(b.id))),prior=ordered.filter(g=>g.played_at<model.validation.train_end);
  const digest=createHash('sha256').update(JSON.stringify(prior.map(g=>[g.id,g.played_at,g.home_id,g.away_id,g.home_score,g.away_score]))).digest('hex');
  if(digest!==model.baseline_training_sha256)return {available:false,reason:'Historical inputs differ from the audited training capture; retrain before using the challenger.'};
  if(JSON.stringify(model.feature_names)!==JSON.stringify(NBA_FEATURES))return {available:false,reason:'The challenger feature schema differs from its training artifact.'};
  if(!Number.isFinite(Date.parse(model.source_captured_at))||now-Date.parse(model.source_captured_at)>30*86400000||Date.parse(model.source_captured_at)>now+60000)return {available:false,reason:'The challenger capture is outside its 30-day review window; refresh and re-evaluate.'};
  const baseline=fitBasketball(prior),{state}=buildNBARows(ordered),intervals=new Map(),matchups=new Map();
  return {available:true,validation:model.validation,promoted:model.promoted,trained_at:model.trained_at,
    predict(game){
      if(Date.parse(game.played_at)<=now)return null;
      const matchup=game.home_id+'#'+game.away_id;
      let base=matchups.get(matchup);if(!base){base=baseline.predict(game.home_id,game.away_id);if(!base)return null;matchups.set(matchup,base);}
      const x=nbaFeatures(state,game),selection=model.selected,raw=selection.model==='bradley_terry'?base.home:scoreNBAArtifact(model.models[selection.model],x,model.scaler);
      const blend=(1-selection.weight)*base.home+selection.weight*raw,p=betaCalibrate(blend,selection.beta),key=p+'#'+Math.abs(raw-base.home);
      let sensitivity=intervals.get(key);if(!sensitivity){sensitivity=residualSensitivity(p,model.residuals,.5*Math.abs(raw-base.home));intervals.set(key,sensitivity);}
      const interval=[Math.min(p,sensitivity.interval[0]),Math.max(p,sensitivity.interval[1])];
      return {home:p,draw:0,away:1-p,interval,interval_kind:sensitivity.scope,calibration_residuals:sensitivity.n,calibration_weeks:sensitivity.weekly_blocks,
        constituents:{bradley_terry:base.home,lag_classifier:raw,classifier_weight:selection.weight},
        model_name:'Chronology-gated beta-calibrated team-strength/lag ensemble',experimental:!model.promoted,
        promotion_reason:model.promoted?'The predefined held-out release checks passed.':'Point Brier improvement exceeded 1%, but its paired weekly confidence interval includes no improvement; retained as an experimental comparison.'};
    }};
}
