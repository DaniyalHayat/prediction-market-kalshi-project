import { number, validQuote } from "../live.mjs";
import { clamp, mean, median, quantile, executionEstimate } from "../intelligence/math.mjs";

export const STRATEGY_VERSION="forward-2.1.0";
export const STRATEGIES=[
  {id:"ridge-forward",name:"Purged ridge return forecast",role:"cost-filtered"},
  {id:"irregular-ou",name:"Irregular-time liquidity reversion",role:"cost-filtered"},
  {id:"queue-pressure",name:"Queue / signed-flow pressure",role:"cost-filtered"},
  {id:"source-reversion",name:"External-source dislocation",role:"cost-filtered"},
  {id:"ladder-relative-value",name:"Shape-constrained relative value",role:"cost-filtered"},
  {id:"robust-ensemble",name:"Robust signal ensemble",role:"cost-filtered"},
  {id:"shadow-direction",name:"Unfiltered directional control",role:"diagnostic control"}
];
export function bookState(raw) {
  const fp=raw?.orderbook_fp;
  if(!fp || typeof fp!=="object")throw new Error("Fixed-point book unavailable");
  function side(key) {
    const map=new Map();
    if(!Array.isArray(fp[key] || []))throw new Error("Invalid book side");
    for(const row of fp[key] || []) {
      if(!Array.isArray(row) || row.length!==2)throw new Error("Invalid level");
      const p=number(row[0]),q=number(row[1]);
      if(p===null || q===null || p<0 || p>1 || q<0)throw new Error("Invalid book level");
      if(q>0)map.set(p,(map.get(p)||0)+q);
    }
    return [...map].sort((a,b)=>b[0]-a[0]);
  }
  const yes=side("yes_dollars"),no=side("no_dollars"),bid=yes[0]?.[0] ?? null,ask=no.length ? 1-no[0][0] : null;
  if(bid!==null && ask!==null && bid>ask+1e-10)throw new Error("Crossed book");
  const twoSided=validQuote(bid,ask),bidDepth=yes.slice(0,5).reduce((s,[,q])=>s+q,0),askDepth=no.slice(0,5).reduce((s,[,q])=>s+q,0);
  return {yes,no,bid,ask,mid:twoSided ? (bid+ask)/2 : null,spread:twoSided ? ask-bid : null,
    imbalance:bidDepth+askDepth ? (bidDepth-askDepth)/(bidDepth+askDepth) : 0,
    microprice:twoSided ? (ask*yes[0][1]+bid*no[0][1])/(yes[0][1]+no[0][1]) : null,bid_depth:bidDepth,ask_depth:askDepth};
}
export function liquidationEstimate(raw,side,quantity,slippage=2,coefficient=.07) {
  if(!["yes","no"].includes(side) || !Number.isFinite(quantity) || quantity<=0 || quantity>1e6 ||
    !Number.isFinite(slippage) || slippage<0 || slippage>100 || !Number.isFinite(coefficient) || coefficient<0 || coefficient>1)throw new RangeError("Invalid liquidation inputs");
  const state=bookState(raw),levels=state[side],best=levels[0]?.[0] ?? null;
  let filled=0,proceeds=0,fee=0;
  const fills=[];
  for(const [price,depth] of levels) {
    if(price<best-slippage/100-1e-10)break;
    const take=Math.min(quantity-filled,depth);
    if(take<=0)break;
    const levelFee=Math.max(0,Math.ceil((coefficient*take*price*(1-price)-1e-10)*100)/100);
    filled+=take;proceeds+=take*price;fee+=levelFee;fills.push({price,quantity:take,estimated_fee:levelFee});
  }
  return {requested:quantity,filled,unfilled:Math.max(0,quantity-filled),gross_proceeds:proceeds,fee,net_proceeds:proceeds-fee,
    vwap:filled ? proceeds/filled : null,fills};
}
export function normalizeCandles(payload,cutoffSeconds) {
  const rows=new Map();
  const close=object=>{
    const dollars=number(object?.close_dollars);
    return dollars!==null ? dollars : number(object?.close)===null ? null : Number(object.close)/100;
  };
  for(const row of payload?.candlesticks || []) {
    const ts=number(row.end_period_ts),bid=close(row.yes_bid),ask=close(row.yes_ask);
    if(ts===null || ts>cutoffSeconds || !validQuote(bid,ask) || ask-bid>.25)continue;
    rows.set(ts,{ts,bid,ask,mid:(bid+ask)/2,spread:ask-bid,volume:number(row.volume_fp ?? row.volume) ?? 0});
  }
  return [...rows.values()].sort((a,b)=>a.ts-b.ts);
}
function features(rows,index) {
  if(index<10)return null;
  const window=rows.slice(index-10,index+1);
  if(window.some((row,i)=>i && row.ts-window[i-1].ts!==60))return null;
  const returns=window.slice(1).map((row,i)=>row.mid-window[i].mid),last=rows[index];
  return [returns.at(-1),mean(returns.slice(-3)),mean(returns),Math.sqrt(mean(returns.map(v=>v*v))),last.spread,Math.log1p(Math.max(0,last.volume))];
}
function solve(matrix,target) {
  const n=target.length,a=matrix.map((row,i)=>[...row,target[i]]);
  for(let col=0;col<n;col++) {
    let pivot=col;
    for(let row=col+1;row<n;row++)if(Math.abs(a[row][col])>Math.abs(a[pivot][col]))pivot=row;
    [a[col],a[pivot]]=[a[pivot],a[col]];
    if(Math.abs(a[col][col])<1e-12)throw new Error("Singular regression");
    const divisor=a[col][col];
    for(let j=col;j<=n;j++)a[col][j]/=divisor;
    for(let row=0;row<n;row++)if(row!==col) {
      const factor=a[row][col];
      for(let j=col;j<=n;j++)a[row][j]-=factor*a[col][j];
    }
  }
  return a.map(row=>row[n]);
}
function fitRidge(samples,lambda) {
  const dimensions=samples[0].x.length,center=Array.from({length:dimensions},(_,i)=>mean(samples.map(s=>s.x[i])));
  const scale=center.map((m,i)=>Math.max(1e-8,Math.sqrt(mean(samples.map(s=>(s.x[i]-m)**2)))));
  const ybar=mean(samples.map(s=>s.y)),matrix=Array.from({length:dimensions},()=>Array(dimensions).fill(0)),target=Array(dimensions).fill(0);
  for(const sample of samples) {
    const x=sample.x.map((v,i)=>(v-center[i])/scale[i]);
    for(let i=0;i<dimensions;i++){target[i]+=x[i]*(sample.y-ybar);for(let j=0;j<dimensions;j++)matrix[i][j]+=x[i]*x[j];}
  }
  for(let i=0;i<dimensions;i++)matrix[i][i]+=lambda;
  const coefficients=solve(matrix,target);
  const predict=x=>ybar+x.reduce((sum,v,i)=>sum+(v-center[i])/scale[i]*coefficients[i],0);
  return {center,scale,coefficients,intercept:ybar,predict};
}
const mse=(samples,predict)=>mean(samples.map(row=>(row.y-predict(row.x))**2));
export function minuteRidge(rows,horizonSeconds=60) {
  if(![60,300,900].includes(horizonSeconds))throw new RangeError("Unsupported ridge forecast horizon");
  const steps=horizonSeconds/60;
  const samples=[];
  for(let i=10;i<rows.length-steps;i++) {
    const x=features(rows,i);
    if(x && rows[i+steps].ts-rows[i].ts===horizonSeconds)samples.push({x,y:rows[i+steps].mid-rows[i].mid,origin:rows[i].ts,target:rows[i+steps].ts});
  }
  const latest=features(rows,rows.length-1);
  if(samples.length<120 || !latest)return {available:false,n:samples.length,reason:"At least 120 consecutive, valid one-minute training pairs are required. Missing bars are not synthesized."};
  const fitEnd=Math.floor(samples.length*.5),validationEnd=Math.floor(samples.length*.75);
  // Purge by actual label time, including multi-minute overlapping targets.
  const fit=samples.slice(0,fitEnd).filter(row=>row.target<samples[fitEnd].origin);
  const validation=samples.slice(fitEnd,validationEnd).filter(row=>row.target<samples[validationEnd].origin),test=samples.slice(validationEnd);
  const trials=[1,10,100].map(lambda=>{const model=fitRidge(fit,lambda);return {lambda,mse:mse(validation,model.predict)};}).sort((a,b)=>a.mse-b.mse);
  const beforeTest=samples.slice(0,validationEnd).filter(row=>row.target<samples[validationEnd].origin);
  const lambda=trials[0].lambda,heldoutModel=fitRidge(beforeTest,lambda);
  const modelMse=mse(test,heldoutModel.predict),baselineMse=mean(test.map(row=>row.y*row.y)),skill=baselineMse>0 ? 1-modelMse/baselineMse : null;
  const final=fitRidge(samples,lambda),rawDelta=clamp(final.predict(latest),-.08,.08);
  return {available:true,n:samples.length,horizon_seconds:horizonSeconds,lambda,raw_delta:rawDelta,delta:skill!==null && skill>0 ? rawDelta : 0,
    evaluation:{n:test.length,rmse:Math.sqrt(modelMse),persistence_rmse:Math.sqrt(baselineMse),rmse_skill:skill,
      max_training_target:beforeTest.at(-1).target,first_test_origin:test[0].origin,
      split:"chronological 50/25/25 purged by target time; lambda selected before untouched holdout"},
    parameters:{feature_names:["last_return","mean_3_returns","mean_10_returns","realized_vol_10","spread","log_volume"],
      center:final.center,scale:final.scale,coefficients:final.coefficients,intercept:final.intercept},
    last_input_ts:rows.at(-1).ts,latest_features:latest};
}
const logit=p=>Math.log(clamp(p,.001,.999)/(1-clamp(p,.001,.999)));
const logistic=z=>1/(1+Math.exp(-clamp(z,-40,40)));
function ouFit(transitions,kappa) {
  let numerator=0,denominator=0;
  for(const row of transitions) {
    const a=Math.exp(-kappa*row.dt),g=kappa ? -Math.expm1(-2*kappa*row.dt)/(2*kappa) : row.dt;
    numerator+=(1-a)*(row.y-a*row.x)/g;denominator+=(1-a)**2/g;
  }
  const mu=kappa && denominator ? clamp(numerator/denominator,-6,6) : 0;
  const sigma2=Math.max(1e-9,mean(transitions.map(row=>{
    const a=Math.exp(-kappa*row.dt),g=kappa ? -Math.expm1(-2*kappa*row.dt)/(2*kappa) : row.dt;
    return (row.y-a*row.x-(1-a)*mu)**2/g;
  })));
  return {kappa,mu,sigma2};
}
function ouNll(transitions,model) {
  return mean(transitions.map(row=>{
    const a=Math.exp(-model.kappa*row.dt),g=model.kappa ? -Math.expm1(-2*model.kappa*row.dt)/(2*model.kappa) : row.dt;
    const expected=a*row.x+(1-a)*model.mu,v=Math.max(1e-10,model.sigma2*g);
    return .5*(Math.log(2*Math.PI*v)+(row.y-expected)**2/v);
  }));
}
export function irregularOU(rows,currentMid,seconds=60) {
  const transitions=[];
  for(let i=1;i<rows.length;i++) {
    const dt=rows[i].ts-rows[i-1].ts;
    if(dt>0 && dt<=3600 && rows[i].mid>0 && rows[i].mid<1 && rows[i-1].mid>0 && rows[i-1].mid<1)
      transitions.push({x:logit(rows[i-1].mid),y:logit(rows[i].mid),dt,origin:rows[i-1].ts,target:rows[i].ts});
  }
  if(transitions.length<80 || !Number.isFinite(currentMid) || currentMid<=0 || currentMid>=1)
    return {available:false,n:transitions.length,reason:"At least 80 observed irregular quote transitions are required; missing minutes are never filled."};
  const fitEnd=Math.floor(transitions.length*.5),validationEnd=Math.floor(transitions.length*.75);
  const training=transitions.slice(0,fitEnd-1),validation=transitions.slice(fitEnd,validationEnd-1),test=transitions.slice(validationEnd);
  const options=[0,1/7200,1/3600,1/1800,1/600,1/120];
  const selected=options.map(kappa=>({kappa,nll:ouNll(validation,ouFit(training,kappa))})).sort((a,b)=>a.nll-b.nll)[0];
  const beforeTest=transitions.slice(0,validationEnd-1);
  const testModel=ouFit(beforeTest,selected.kappa),baseline=ouFit(beforeTest,0);
  const nll=ouNll(test,testModel),baselineNll=ouNll(test,baseline),gain=baselineNll-nll;
  const model=ouFit(transitions,selected.kappa),a=Math.exp(-model.kappa*seconds);
  const location=a*logit(currentMid)+(1-a)*model.mu;
  const variance=model.sigma2*(model.kappa ? -Math.expm1(-2*model.kappa*seconds)/(2*model.kappa) : seconds);
  const sd=Math.sqrt(Math.max(0,variance));
  // Deterministic Simpson quadrature for a logistic-normal conditional mean,
  // not random synthetic prices or a simulated profitable track record.
  let expected=0;
  for(let i=0;i<=48;i++) {
    const z=-6+i*.25,weight=i===0 || i===48 ? 1 : i%2 ? 4 : 2;
    expected+=weight*logistic(location+sd*z)*Math.exp(-z*z/2)/Math.sqrt(2*Math.PI);
  }
  expected*=.25/3;
  const rawDelta=clamp(expected-currentMid,-.08,.08);
  return {available:true,n:transitions.length,parameters:model,raw_delta:rawDelta,delta:gain>0 ? rawDelta : 0,
    predicted_mid:expected,range_80:[logistic(location-1.281551566*sd),logistic(location+1.281551566*sd)],
    evaluation:{n:test.length,negative_log_likelihood:nll,persistence_nll:baselineNll,heldout_nll_gain:gain,
      split:"chronological, purged 50/25/25; reversion rate chosen only on the inner validation partition",
      horizon:"next actually observed quote at its true time gap, not a fabricated one-minute historical return"},
    last_input_ts:rows.at(-1).ts,mean_observation_gap_seconds:mean(transitions.map(row=>row.dt)),
    caveat:"An OU prior fitted to irregular historical quote times is not evidence of a profitable 60-second trading strategy. The future cohort supplies that separate test."};
}
export function isotonic(values,weights=values.map(()=>1),increasing=true) {
  const blocks=[];
  values.forEach((value,index)=>{
    if(!Number.isFinite(value) || !Number.isFinite(weights[index]) || weights[index]<=0)throw new RangeError("Invalid isotonic input");
    blocks.push({from:index,to:index,weight:weights[index],sum:value*weights[index]});
    while(blocks.length>1) {
      const b=blocks.at(-1),a=blocks.at(-2);
      if((a.sum/a.weight-b.sum/b.weight)*(increasing ? 1 : -1)<=0)break;
      blocks.splice(-2,2,{from:a.from,to:b.to,weight:a.weight+b.weight,sum:a.sum+b.sum});
    }
  });
  const result=Array(values.length);
  for(const block of blocks)for(let i=block.from;i<=block.to;i++)result[i]=clamp(block.sum/block.weight);
  return result;
}
export function relativeValueSurface(markets) {
  const groups=new Map(),out=new Map();
  for(const row of markets) {
    const bid=number(row.yes_bid ?? row.yes_bid_dollars),ask=number(row.yes_ask ?? row.yes_ask_dollars);
    if(!validQuote(bid,ask) || !["greater","greater_or_equal","less","less_or_equal"].includes(row.strike_type))continue;
    const strike=number(row.strike_type.startsWith("greater") ? row.floor_strike : row.cap_strike);
    if(strike===null)continue;
    const key=`${row.event_ticker}:${row.strike_type}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({ticker:row.ticker,strike,mid:(bid+ask)/2,spread:ask-bid});
  }
  for(const rows of groups.values()) {
    rows.sort((a,b)=>a.strike-b.strike);
    if(rows.length<2)continue;
    const input=rows.map(r=>r.mid),weights=rows.map(r=>Math.min(10000,1/(r.spread*r.spread+.0001)));
    const first=markets.find(r=>r.ticker===rows[0].ticker);
    const projected=isotonic(input,weights,first.strike_type.startsWith("less"));
    rows.forEach((row,index)=>out.set(row.ticker,{target:projected[index],gap:projected[index]-row.mid,n:rows.length,
      method:"Weighted PAVA on same-event, same-operator threshold probabilities; not an executable arbitrage"}));
  }
  return out;
}
export function signalTargets({raw,tape=[],ridge,ou,forecast,relative,category,seconds=60}) {
  const b=bookState(raw);
  if(b.mid===null)throw new Error("Two-sided depth required for forward price forecasting");
  const yes=tape.filter(t=>t.taker_side==="yes").reduce((s,t)=>s+Math.max(0,number(t.count_fp ?? t.count) || 0),0);
  const no=tape.filter(t=>t.taker_side==="no").reduce((s,t)=>s+Math.max(0,number(t.count_fp ?? t.count) || 0),0);
  const flow=yes+no ? (yes-no)/(yes+no) : 0;
  const pressure=clamp(.5*(b.microprice-b.mid)+.15*b.spread*b.imbalance+.1*b.spread*flow,-.05,.05);
  const halfLife={crypto:600,weather:7200,labor:86400,inflation:86400,travel:43200}[category];
  const sourceEligible=Number.isFinite(forecast?.probability) && forecast?.evidence?.tier>0;
  const reversion=sourceEligible ? (forecast.probability-b.mid)*(1-Math.exp(-Math.log(2)*seconds/halfLife)) : null;
  const relativeDelta=relative ? .25*(relative.target-b.mid) : null;
  const deltas=[ridge?.available ? ridge.delta : null,ou?.available ? ou.delta : null,pressure,reversion,relativeDelta].filter(Number.isFinite);
  const ensemble=median(deltas) ?? 0;
  const byId={"ridge-forward":ridge?.available ? ridge.delta : null,"irregular-ou":ou?.available ? ou.delta : null,"queue-pressure":pressure,"source-reversion":reversion,
    "ladder-relative-value":relativeDelta,"robust-ensemble":ensemble,"shadow-direction":pressure};
  return {book:b,features:{depth_imbalance:b.imbalance,microprice:b.microprice,flow_imbalance:flow,
    source_half_life_seconds:halfLife,relative_projection:relative || null},
    signals:STRATEGIES.map(strategy=>({...strategy,available:Number.isFinite(byId[strategy.id]),
      delta:Number.isFinite(byId[strategy.id]) ? byId[strategy.id] : null,
      predicted_yes_mid:Number.isFinite(byId[strategy.id]) ? clamp(b.mid+byId[strategy.id],.001,.999) : null,
      specification:strategy.id==="ridge-forward" ? "Horizon-specific nested chronological ridge; overlapping targets purged; poor historical holdout skill falls back to persistence." :
        strategy.id==="irregular-ou" ? "Irregular-time logit OU likelihood, purged nested validation and logistic-normal integration; poor holdout likelihood falls back to persistence." :
        strategy.id==="shadow-direction" ? "Deliberately unfiltered small directional control. Not a recommendation or a profitable strategy claim." :
        "Frozen exploratory coefficients, not coefficients fitted to this future markout."}))};
}
export function freezeDecision(raw,signal,{contracts=10,slippage=2,coefficient=.07,minEdge=.005}={}) {
  const b=bookState(raw);
  if(!signal.available || b.mid===null)return {action:"unavailable",reason:"Signal or two-sided book unavailable"};
  if(Math.abs(signal.predicted_yes_mid-b.mid)<.0001)return {action:"abstain",reason:"No material forecast movement"};
  const side=signal.predicted_yes_mid>b.mid ? "yes" : "no",entry=executionEstimate(raw,side,contracts,slippage,coefficient);
  if(!entry.filled)return {action:"abstain",reason:"No eligible entry depth"};
  const targetBid=clamp(side==="yes" ? signal.predicted_yes_mid-b.spread/2 : 1-signal.predicted_yes_mid-b.spread/2);
  const exitFee=Math.ceil(Math.max(0,coefficient*entry.filled*targetBid*(1-targetBid)-1e-10)*100)/100;
  const estimatedRoundTrip=targetBid*entry.filled-exitFee-entry.all_in;
  const control=signal.role==="diagnostic control";
  if(!control && estimatedRoundTrip/entry.filled<=minEdge)return {action:"abstain",reason:"Forecast does not cover entry spread, both fees and the frozen edge buffer",estimated_round_trip:estimatedRoundTrip,side};
  return {action:"paper-entry",side,entry,estimated_round_trip:estimatedRoundTrip,control,
    classification:"Hypothetical marketable entry at a recorded book snapshot; no actual fill or order"};
}
export function scoreMarkout(leg,exitRaw,exitTime,parameters) {
  const b=bookState(exitRaw),elapsed=(Date.parse(exitTime)-Date.parse(leg.frozen_at))/1000;
  const onTime=elapsed>=parameters.seconds && elapsed<=parameters.seconds+30;
  return {ticker:leg.ticker,event_ticker:leg.event_ticker,category:leg.category,elapsed_seconds:elapsed,on_time:onTime,
    entry_mid:leg.features.book_mid,exit_mid:b.mid,
    signals:leg.signals.map(signal=>{
      const observed=b.mid===null ? null : b.mid-leg.features.book_mid;
      const predicted=signal.predicted_yes_mid===null ? null : signal.predicted_yes_mid-leg.features.book_mid;
      const base={strategy:signal.id,name:signal.name,role:signal.role,action:signal.decision.action,
        predicted_yes_mid:signal.predicted_yes_mid,observed_yes_mid:b.mid,
        squared_error:predicted!==null && observed!==null ? (predicted-observed)**2 : null,
        persistence_squared_error:observed!==null ? observed*observed : null,
        direction_correct:predicted!==null && observed!==null && Math.abs(observed)>=.005 ? Math.sign(predicted)===Math.sign(observed) : null,
        net_pnl:null,gross_pnl:null,fully_liquidated:false};
      if(signal.decision.action!=="paper-entry")return base;
      const entry=signal.decision.entry,exit=liquidationEstimate(exitRaw,signal.decision.side,entry.filled,parameters.slippage,parameters.coefficient);
      const complete=exit.unfilled<1e-8,allocated=entry.all_in*(exit.filled/entry.filled);
      return {...base,side:signal.decision.side,quantity:entry.filled,entry_cost:entry.all_in,entry_fees:entry.fee,exit,
        fully_liquidated:complete,net_pnl:complete ? exit.net_proceeds-entry.all_in : null,
        gross_pnl:complete ? exit.gross_proceeds-entry.cost : null,
        partial_realized_pnl:exit.filled ? exit.net_proceeds-allocated : null,
        remaining_quantity:exit.unfilled,fees_paid:entry.fee+exit.fee};
    })};
}
function randomGenerator(seed=137) {
  return ()=>{seed|=0;seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};
}
export function summarizeForward(markouts,expectedLegs,strategies=STRATEGIES,familySize=strategies.length) {
  return strategies.map(strategy=>{
    const all=markouts.flatMap(mark=>mark.error ? [] : mark.signals.filter(s=>s.strategy===strategy.id).map(s=>({...s,event:mark.event_ticker,category:mark.category,on_time:mark.on_time})));
    const eligible=all.filter(row=>row.on_time),closed=eligible.filter(row=>row.fully_liquidated && Number.isFinite(row.net_pnl));
    const paired=eligible.filter(row=>Number.isFinite(row.squared_error) && Number.isFinite(row.persistence_squared_error));
    const attempts=eligible.filter(row=>row.action==="paper-entry"),grouped=new Map();
    for(const row of closed){if(!grouped.has(row.event))grouped.set(row.event,[]);grouped.get(row.event).push(row.net_pnl/row.quantity);}
    const eventMeans=[...grouped.values()].map(values=>mean(values)),rng=randomGenerator(),samples=[];
    if(eventMeans.length>=2)for(let i=0;i<1500;i++)samples.push(mean(Array.from({length:eventMeans.length},()=>eventMeans[Math.floor(rng()*eventMeans.length)])));
    // Familywise Bonferroni correction across every predeclared strategy, not whichever happened to win.
    const alpha=.05/Math.max(strategies.length,familySize),interval=samples.length ? [quantile(samples,alpha/2),quantile(samples,1-alpha/2)] : null;
    const fullCoverage=all.length===expectedLegs && eligible.length===expectedLegs && closed.length===attempts.length;
    return {strategy:strategy.id,name:strategy.name,role:strategy.role,observed_legs:all.length,expected_legs:expectedLegs,
      abstentions:eligible.filter(row=>row.action==="abstain").length,unavailable:eligible.filter(row=>row.action==="unavailable").length,
      entries:attempts.length,closed:closed.length,incomplete_exits:attempts.length-closed.length,
      net_pnl:closed.length ? closed.reduce((sum,row)=>sum+row.net_pnl,0) : null,
      gross_pnl:closed.length ? closed.reduce((sum,row)=>sum+row.gross_pnl,0) : null,
      fees:closed.reduce((sum,row)=>sum+row.fees_paid,0),
      paired_forecasts:paired.length,mean_squared_error:mean(paired.map(row=>row.squared_error)),
      persistence_mse:mean(paired.map(row=>row.persistence_squared_error)),
      directional_trials:eligible.filter(row=>row.direction_correct!==null).length,
      direction_accuracy:mean(eligible.filter(row=>row.direction_correct!==null).map(row=>Number(row.direction_correct))),
      independent_event_groups:eventMeans.length,fee_adjusted_per_contract_interval:interval,multiple_testing_family_size:Math.max(strategies.length,familySize),
      evidence:eventMeans.length>=30 && interval?.[0]>0 && alpha/2>=1/1501 && fullCoverage && strategy.role!=="diagnostic control"
        ? "positive forward paper evidence under the frozen cost assumptions; not actual executed profitability"
        : "profitability not demonstrated",
      categories:[...new Set(all.map(row=>row.category))],
      caveat:"Same underlying events can remain correlated. This interval is an event bootstrap of recorded quote markouts, not simulated prices or a proof of profitable actual fills."};
  });
}
