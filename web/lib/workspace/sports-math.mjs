import {clamp,mean,wilson} from '../intelligence/math.mjs';
const sigmoid=x=>1/(1+Math.exp(-clamp(x,-30,30)));
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const sparseDot=(row,v)=>row.index.reduce((s,j,k)=>s+v[j]*row.value[k],0);
function conjugateGradient(product,b,maximum=160) {
  const x=new Float64Array(b.length),r=Float64Array.from(b),p=Float64Array.from(b);let rr=dot(r,r);
  for(let step=0;step<maximum&&rr>1e-16;step++){
    const ap=product(p),denom=dot(p,ap);if(denom<=0)break;
    const a=rr/denom;for(let j=0;j<x.length;j++){x[j]+=a*p[j];r[j]-=a*ap[j];}
    const next=dot(r,r);if(next<1e-14)break;const beta=next/rr;
    for(let j=0;j<p.length;j++)p[j]=r[j]+beta*p[j];rr=next;
  }
  return x;
}
function fitSparse(rows,dimension,{poisson=false,ridge=6}={}) {
  const beta=new Float64Array(dimension),penalty=Float64Array.from({length:dimension},(_,i)=>i<2?.4:ridge);
  function state(value){
    const gradient=Float64Array.from(value,(v,i)=>-penalty[i]*v),curvature=[];
    let objective=-.5*value.reduce((s,v,i)=>s+penalty[i]*v*v,0);
    for(const row of rows){const eta=clamp(sparseDot(row,value),-12,12),mu=poisson?Math.exp(eta):sigmoid(eta);
      const difference=row.weight*(row.y-mu);curvature.push(row.weight*(poisson?mu:mu*(1-mu)));
      for(let k=0;k<row.index.length;k++)gradient[row.index[k]]+=row.value[k]*difference;
      objective+=row.weight*(poisson?row.y*eta-mu:row.y*Math.log(mu)+(1-row.y)*Math.log1p(-mu));
    }
    const product=v=>{const out=Float64Array.from(v,(x,i)=>penalty[i]*x);
      rows.forEach((row,i)=>{const scale=curvature[i]*sparseDot(row,v);row.index.forEach((j,k)=>out[j]+=scale*row.value[k]);});return out;};
    return {gradient,objective,product};
  }
  for(let iteration=0;iteration<24;iteration++){
    const current=state(beta),delta=conjugateGradient(current.product,current.gradient);let scale=1;
    while(scale>1/1024){const candidate=Float64Array.from(beta,(v,i)=>v+scale*delta[i]);if(state(candidate).objective>=current.objective){beta.set(candidate);break;}scale/=2;}
    if(scale*Math.sqrt(dot(delta,delta))<1e-7)break;
  }
  const precision=state(beta).product;
  return {beta,predict:row=>{const eta=sparseDot(row,beta),direction=new Float64Array(dimension);row.index.forEach((j,k)=>direction[j]=row.value[k]);
    const variance=Math.max(0,dot(direction,conjugateGradient(precision,direction)));return {eta,se:Math.sqrt(variance)};}};
}
function structure(games,soccer=false){
  if(!Array.isArray(games)||!games.length||games.some(g=>!g.home_id||!g.away_id||g.home_id===g.away_id||!Number.isFinite(Date.parse(g.played_at))||
    !Number.isInteger(g.home_score)||g.home_score<0||!Number.isInteger(g.away_score)||g.away_score<0))throw new RangeError('Completed dated games with distinct teams and integer scores are required');
  const teams=[...new Set(games.flatMap(g=>[g.home_id,g.away_id]))].sort(),index=new Map(teams.map((id,i)=>[id,i+2]));
  const latest=Math.max(...games.map(g=>Date.parse(g.played_at)));
  const weight=g=>Math.exp(-Math.LN2*(latest-Date.parse(g.played_at))/(180*86400000));
  const row=(home,away,atHome=true)=>soccer?{index:[0,1,index.get(home),index.get(away)+teams.length],value:[1,atHome?1:0,1,1]}:
    {index:[0,index.get(home),index.get(away)],value:[1,1,-1]};
  return {teams,index,row,dimension:soccer?2+2*teams.length:2+teams.length,weight};
}
export function fitBasketball(games) {
  const data=games.filter(g=>g.home_score!==g.away_score),s=structure(data);
  const fit=fitSparse(data.map(g=>({...s.row(g.home_id,g.away_id),weight:s.weight(g),y:g.home_score>g.away_score?1:0})),s.dimension);
  return {predict(home,away){if(!s.index.has(home)||!s.index.has(away))return null;
    const {eta,se}=fit.predict(s.row(home,away));return {home:sigmoid(eta),draw:0,away:1-sigmoid(eta),interval:[sigmoid(eta-1.96*se),sigmoid(eta+1.96*se)],
      interval_kind:'95% penalized Laplace parameter interval; excludes roster changes and model misspecification'};},teams:s.teams.length};
}
function poissonVector(lambda){const maximum=Math.ceil(lambda+12*Math.sqrt(lambda)+12),p=[Math.exp(-lambda)];for(let i=1;i<=maximum;i++)p.push(p[i-1]*lambda/i);return p;}
function goalOutcome(home,away){
  const h=poissonVector(home),a=poissonVector(away);let hw=0,draw=0,aw=0;
  for(let i=0;i<h.length;i++)for(let j=0;j<a.length;j++){const p=h[i]*a[j];if(i>j)hw+=p;else if(i===j)draw+=p;else aw+=p;}
  const total=hw+draw+aw;return {home:hw/total,draw:draw/total,away:aw/total,omitted_tail:Math.max(0,1-total)};
}
export function fitSoccer(games) {
  const s=structure(games,true),rows=games.flatMap(g=>[
    {...s.row(g.home_id,g.away_id,true),weight:s.weight(g),y:g.home_score},
    {...s.row(g.away_id,g.home_id,false),weight:s.weight(g),y:g.away_score}]);
  const fit=fitSparse(rows,s.dimension,{poisson:true,ridge:12});
  return {predict(home,away){if(!s.index.has(home)||!s.index.has(away))return null;
    const h=fit.predict(s.row(home,away,true)),a=fit.predict(s.row(away,home,false)),lh=Math.exp(clamp(h.eta,-5,3)),la=Math.exp(clamp(a.eta,-5,3));
    const result=goalOutcome(lh,la),scenarios=[];
    for(const hs of [-1,1])for(const as of [-1,1])scenarios.push(goalOutcome(Math.exp(clamp(h.eta+hs*1.96*h.se,-5,3)),Math.exp(clamp(a.eta+as*1.96*a.se,-5,3))));
    return {...result,expected_goals:[lh,la],ranges:Object.fromEntries(['home','draw','away'].map(side=>[side,[Math.min(result[side],...scenarios.map(p=>p[side])),Math.max(result[side],...scenarios.map(p=>p[side]))]])),
      interval_kind:'Parameter sensitivity range from penalized attack/defense rates; not a calibrated prediction interval'};
  },teams:s.teams.length};
}
export function evaluateSports(games,league) {
  const rows=[...games].sort((a,b)=>a.played_at.localeCompare(b.played_at)),boundary=rows[Math.floor(rows.length*.8)]?.played_at,
    train=rows.filter(g=>g.played_at<boundary),test=rows.filter(g=>g.played_at>=boundary);
  if(train.length<80||test.length<25)return {n:0,passed:false,reason:'At least 80 earlier games and 25 held-out games are required.'};
  const soccer=league!=='nba',model=soccer?fitSoccer(train):fitBasketball(train),home=mean(train.map(g=>g.home_score>g.away_score?1:0)),draw=mean(train.map(g=>g.home_score===g.away_score?1:0));
  const baseline=soccer?[home,draw,1-home-draw]:[home,1-home],errors=[],baseErrors=[],logs=[],weeks=new Map(),calibration=Array.from({length:5},()=>[]);let unmatched=0;
  for(const g of test){const p=model.predict(g.home_id,g.away_id);if(!p){unmatched++;continue;}const probabilities=soccer?[p.home,p.draw,p.away]:[p.home,p.away],winner=g.home_score>g.away_score?0:soccer?(g.home_score===g.away_score?1:2):1;
    const loss=probabilities.reduce((sum,v,i)=>sum+(v-(winner===i?1:0))**2,0)/2,base=baseline.reduce((sum,v,i)=>sum+(v-(winner===i?1:0))**2,0)/2;
    errors.push(loss);baseErrors.push(base);logs.push(-Math.log(Math.max(1e-9,probabilities[winner])));
    const week=Math.floor((Date.parse(g.played_at)+3*86400000)/(7*86400000));if(!weeks.has(week))weeks.set(week,[]);weeks.get(week).push(base-loss);
    calibration[Math.min(4,Math.floor(p.home*5))].push([p.home,winner===0?1:0]);
  }
  const brier=mean(errors),baselineBrier=mean(baseErrors),deltas=baseErrors.map((v,i)=>v-errors[i]),n=deltas.length,average=mean(deltas);
  const blocks=[...weeks.values()],replicates=[];let seed=71893;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  if(blocks.length>=2)for(let i=0;i<1000;i++){let sum=0,count=0;for(let j=0;j<blocks.length;j++){const block=blocks[Math.floor(random()*blocks.length)];sum+=block.reduce((s,v)=>s+v,0);count+=block.length;}replicates.push(sum/count);}
  replicates.sort((a,b)=>a-b);
  const skill=baselineBrier>0?1-brier/baselineBrier:null,lower=replicates.length?replicates[Math.floor(replicates.length*.025)]:null;
  return {n,brier,baseline_brier:baselineBrier,brier_skill:skill,log_loss:mean(logs),mean_loss_improvement:average,improvement_95_lower:lower,
    weekly_blocks:blocks.length,unmatched_games:unmatched,coverage:test.length?n/test.length:0,
    passed:n>=100&&blocks.length>=12&&n/test.length>=.95&&skill>0&&lower>0,train_end:train.at(-1)?.played_at,test_start:test[0]?.played_at,test_end:test.at(-1)?.played_at,
    calibration:calibration.filter(b=>b.length).map(b=>({n:b.length,predicted:mean(b.map(r=>r[0])),actual:mean(b.map(r=>r[1]))})),
    brier_definition:soccer?'Half the sum of squared home/draw/away outcome errors':'Binary home-win Brier score',
    protocol:'Chronological final 20% holdout with a frozen earlier-game fit and strictly separated timestamps. Paired loss uncertainty uses 1,000 seeded resamples of complete UTC-week blocks. Repeated-team dependence across weeks and regime changes remain unmodeled.'};
}
export function teamForm(games,id,cutoff=Date.now(),maximum=10){
  const recent=games.filter(g=>Date.parse(g.played_at)<cutoff&&(g.home_id===id||g.away_id===id)).sort((a,b)=>b.played_at.localeCompare(a.played_at)).slice(0,maximum);
  const results=recent.map(g=>{const own=g.home_id===id?g.home_score:g.away_score,other=g.home_id===id?g.away_score:g.home_score;return own>other?'W':own<other?'L':'D';});
  const wins=results.filter(r=>r==='W').length;return {games:results.length,wins,losses:results.filter(r=>r==='L').length,draws:results.filter(r=>r==='D').length,results,win_interval:wilson(wins,results.length)};
}
export function lowMinutesSplit(games,minutes,teamId,playerId,threshold=15){
  const byGame=new Map(minutes.filter(p=>p.team_id===teamId&&p.player_id===playerId&&Number.isFinite(p.minutes)).map(p=>[p.game_id,p.minutes]));
  const sample=games.filter(g=>byGame.has(g.id)&&(g.home_id===teamId||g.away_id===teamId));
  const group=low=>{const rows=sample.filter(g=>(byGame.get(g.id)<=threshold)===low),wins=rows.filter(g=>g.home_id===teamId?g.home_score>g.away_score:g.away_score>g.home_score).length;
    return {n:rows.length,wins,rate:rows.length?wins/rows.length:null,interval:wilson(wins,rows.length)};};
  return {threshold_minutes:threshold,low:group(true),regular:group(false),note:'Descriptive observed-minutes split. Missing boxscore rows are excluded. Minutes respond to game state and do not identify a causal injury effect.'};
}
