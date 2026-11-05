const average=rows=>rows.length?rows.reduce((sum,value)=>sum+value,0)/rows.length:0;
const quantile=(rows,p)=>{if(!rows.length)return null;const sorted=[...rows].sort((a,b)=>a-b),index=(sorted.length-1)*p,lower=Math.floor(index);return sorted[lower]+(sorted[Math.ceil(index)]-sorted[lower])*(index-lower);};
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const finite=value=>typeof value==='number'&&Number.isFinite(value);

export function contiguousBookHistory(input=[]){
  if(!Array.isArray(input)||input.length>2048)throw new RangeError('Supply at most 2,048 event-resolved book observations');
  let rows=[],previous=null;const gaps=[];
  for(const row of input){
    const valid=row&&['time_seconds','bid_price','bid_size','ask_price','ask_size'].every(key=>finite(row[key]))&&row.time_seconds>=0&&row.bid_price>=0&&row.ask_price<=1&&row.bid_price<=row.ask_price&&row.bid_size>0&&row.ask_size>0&&row.bid_size<=1e12&&row.ask_size<=1e12&&Number.isSafeInteger(row.sequence)&&row.sequence>=0&&['string','number'].includes(typeof row.generation);
    if(!valid){rows=[];previous=null;gaps.push('An invalid or empty/crossed book event reset the history.');continue;}
    if(previous&&(row.generation!==previous.generation||row.sequence!==previous.sequence+1||row.time_seconds<previous.time_seconds)){
      rows=[];gaps.push(row.generation!==previous.generation?'A snapshot/reconnect started a new book generation.':row.sequence!==previous.sequence+1?'A missing or reordered ticker-local event reset the history.':'A receive timestamp moved backward and reset the history.');
    }
    const current={...row,mid:(row.bid_price+row.ask_price)/2,depth:(row.bid_size+row.ask_size)/2};
    if(rows.length){const p=rows.at(-1);current.ofi=(current.bid_price>=p.bid_price?current.bid_size:0)-(current.bid_price<=p.bid_price?p.bid_size:0)-(current.ask_price<=p.ask_price?current.ask_size:0)+(current.ask_price>=p.ask_price?p.ask_size:0);}
    else current.ofi=null;
    current.imbalance=(row.bid_size-row.ask_size)/(row.bid_size+row.ask_size);rows.push(current);previous=current;
  }
  return {rows:rows.slice(-1024),gaps:[...new Set(gaps)],received:input.length,retained:Math.min(rows.length,1024),timestamp_ties:rows.reduce((sum,row,i)=>sum+Number(i>0&&row.time_seconds===rows[i-1].time_seconds),0),event_kind:'observed_nonconflated_best_queue_updates'};
}

function solveRidge(rows,penalty=1){
  const means=[0,1].map(j=>average(rows.map(row=>row.x[j]))),scales=[0,1].map(j=>Math.max(1e-9,Math.sqrt(average(rows.map(row=>(row.x[j]-means[j])**2))))),center=average(rows.map(row=>row.y));
  let a=penalty,b=0,d=penalty,u=0,v=0;
  for(const row of rows){const x=(row.x[0]-means[0])/scales[0],z=(row.x[1]-means[1])/scales[1],y=row.y-center;a+=x*x;b+=x*z;d+=z*z;u+=x*y;v+=z*y;}
  const determinant=a*d-b*b,weights=[(d*u-b*v)/determinant,(a*v-b*u)/determinant];
  return {means,scales,weights,center,penalty,predict:x=>center+weights.reduce((sum,weight,j)=>sum+weight*(x[j]-means[j])/scales[j],0)};
}

function bootstrapMeanInterval(values,{seed=91873,replicates=300,block=5}={}){
  let state=seed>>>0;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;},samples=[];
  for(let repeat=0;repeat<replicates;repeat++){
    let sum=0,taken=0;while(taken<values.length){const start=Math.floor(random()*values.length);for(let offset=0;offset<block&&taken<values.length;offset++,taken++)sum+=values[(start+offset)%values.length];}samples.push(sum/values.length);
  }
  return [quantile(samples,.025),quantile(samples,.975)];
}

export function fitOrderFlowChallenger(history,{enabled=true}={}){
  const rows=Array.isArray(history)?contiguousBookHistory(history).rows:history.rows;
  const ofi=rows.reduce((sum,row)=>sum+(row.ofi||0),0),depth=average(rows.map(row=>row.depth));
  const base={method:'chronological_two_feature_ridge_next_quote_challenger',experimental:true,affects_settlement_probability:false,enabled,applied:false,available:false,prediction_next_mid_change:null,applied_next_mid_change:0,validation_status:'insufficient_history',transitions:Math.max(0,rows.length-1),ofi,normalized_imbalance:depth>0?ofi/depth:null,
    note:'Predicts the next observed quote midpoint change from prior event-resolved OFI/depth and queue imbalance. It does not estimate the event settlement probability, a fixed-time return or an executable fill.'};
  if(!enabled)return {...base,validation_status:'disabled',reason:'The order-flow challenger is disabled.'};
  const examples=[];
  for(let i=1;i<rows.length-1;i++)examples.push({x:[rows[i].ofi/rows[i].depth,rows[i].imbalance],y:rows[i+1].mid-rows[i].mid,time:rows[i].time_seconds,target_time:rows[i+1].time_seconds});
  if(examples.length<150)return {...base,reason:'At least 152 contiguous book events are required for fit, calibration and an untouched 30-event holdout.',events:rows.length};
  const fitEnd=Math.floor(examples.length*.6),calibrationEnd=Math.floor(examples.length*.8),fit=examples.slice(0,fitEnd),calibration=examples.slice(fitEnd,calibrationEnd),holdout=examples.slice(calibrationEnd),model=solveRidge(fit),errors=calibration.map(row=>row.y-model.predict(row.x)),bounds=[quantile(errors,.1),quantile(errors,.9)];
  const evaluated=holdout.map(row=>{const predicted=model.predict(row.x);return {...row,predicted,error:row.y-predicted};}),mse=average(evaluated.map(row=>row.error**2)),baseline=average(evaluated.map(row=>row.y**2)),improvements=evaluated.map(row=>row.y**2-row.error**2),interval=bootstrapMeanInterval(improvements),coverage=average(evaluated.map(row=>Number(row.error>=bounds[0]&&row.error<=bounds[1]))),passed=baseline>0&&interval[0]>0&&coverage>=.7;
  const latest=rows.at(-1),raw=model.predict([latest.ofi/latest.depth,latest.imbalance]),prediction=clamp(raw,-latest.mid,1-latest.mid),applied=enabled&&passed;
  return {...base,available:true,applied,validation_status:passed?'local_quote_holdout_passed':'not_promoted',reason:!enabled?'The order-flow challenger is disabled.':passed?'The local next-quote challenger passed its current chronological holdout gate.':'The local challenger did not establish a positive held-out error reduction with adequate interval coverage.',prediction_next_mid_change:prediction,applied_next_mid_change:applied?prediction:0,
    prediction_interval:[clamp(prediction+bounds[0],-latest.mid,1-latest.mid),clamp(prediction+bounds[1],-latest.mid,1-latest.mid)],parameters:{feature_means:model.means,feature_scales:model.scales,weights:model.weights,intercept:model.center,ridge_penalty:model.penalty},
    evaluation:{fit_n:fit.length,calibration_n:calibration.length,holdout_n:holdout.length,mse,zero_change_baseline_mse:baseline,relative_mse_skill:baseline>0?1-mse/baseline:null,paired_mse_improvement_interval_95:interval,interval_80_coverage:coverage,passed,bootstrap:{method:'seeded_circular_moving_block',replicates:300,block:5,seed:91873},split:{fit_end_time:fit.at(-1).target_time,calibration_start_time:calibration[0].time,calibration_end_time:calibration.at(-1).target_time,holdout_start_time:holdout[0].time}},
    limitations:['A short rolling quote sample is not a prospective profitability test.','Repeated testing and overlapping rolling windows weaken a nominal confidence interval.','Published snapshots cannot reveal hidden orders, exact queue position or cancellation intent.']};
}

export function exponentialHawkesLikelihood(times,{mu,alpha,beta,start=0,end=times.at(-1),history=[]}={}){
  if(!Array.isArray(times)||times.length>2048||!Array.isArray(history)||history.length>2048||![mu,alpha,beta,start,end].every(finite)||mu<=0||alpha<0||beta<=0||alpha/beta>=1||end<=start||times.some((time,i)=>!finite(time)||time<=start||time>end||(i&&time<=times[i-1]))||history.some((time,i)=>!finite(time)||time>start||(i&&time<=history[i-1])))throw new RangeError('Invalid stationary exponential Hawkes observation window');
  let memory=history.reduce((sum,time)=>sum+Math.exp(-beta*(start-time)),0),previous=start,logIntensity=0,integral=mu*(end-start)+alpha*memory*(-Math.expm1(-beta*(end-start)))/beta;const intensities=[];
  for(const time of times){memory*=Math.exp(-beta*(time-previous));const intensity=mu+alpha*memory;logIntensity+=Math.log(intensity);intensities.push(intensity);memory+=1;integral+=alpha*(-Math.expm1(-beta*(end-time)))/beta;previous=time;}
  memory*=Math.exp(-beta*(end-previous));
  return {log_likelihood:logIntensity-integral,log_intensity:logIntensity,compensator:integral,intensity_at_end:mu+alpha*memory,intensities};
}

function fitHawkes(times,end){
  const rate=times.length/end;let best={mu:rate,alpha:0,beta:rate,log_likelihood:times.length*Math.log(rate)-rate*end};
  for(const scale of [.05,.15,.5,1,3,10,30]){
    const beta=Math.max(1e-9,rate*scale),memories=[];let memory=0,previous=0;for(const time of times){memory*=Math.exp(-beta*(time-previous));memories.push(memory);memory++;previous=time;}
    const integral=times.reduce((sum,time)=>sum+(-Math.expm1(-beta*(end-time)))/beta,0);
    for(const branch of [.15,.5,.85]){
      let mu=Math.max(rate*(1-branch),1e-9),alpha=branch*beta;
      for(let iteration=0;iteration<30;iteration++){
        let baseline=0,excited=0;for(const memory of memories){const lambda=mu+alpha*memory;baseline+=mu/lambda;excited+=alpha*memory/lambda;}
        mu=Math.max(1e-9,baseline/end);alpha=clamp(excited/Math.max(integral,1e-12),0,beta*.95);
      }
      const likelihood=exponentialHawkesLikelihood(times,{mu,alpha,beta,start:0,end}).log_likelihood;if(likelihood>best.log_likelihood)best={mu,alpha,beta,log_likelihood:likelihood};
    }
  }
  return best;
}

export function quoteArrivalResearch(history,{enabled=true,observation_end_seconds}={}){
  const rows=Array.isArray(history)?contiguousBookHistory(history).rows:history.rows,base={method:'stationary_exponential_Hawkes_quote_arrivals',event_kind:'quote_updates_not_trades_or_news',enabled,available:false,applied:false,risk_multiplier:1,validation_status:'insufficient_history'};
  if(observation_end_seconds!==undefined&&(!finite(observation_end_seconds)||(rows.length&&observation_end_seconds<rows.at(-1).time_seconds)))throw new RangeError('The observed arrival window cannot end before its last event');
  if(!enabled)return {...base,validation_status:'disabled',reason:'Arrival clustering is disabled.'};
  if(rows.length<120)return {...base,reason:'At least 120 contiguous quote updates are required to compare arrival clustering with a Poisson baseline.'};
  if(rows.some((row,i)=>i>0&&row.time_seconds<=rows[i-1].time_seconds))return {...base,validation_status:'tied_receive_timestamps',reason:'Some quote updates share a receive timestamp. Hawkes fitting is withheld rather than inventing event times; ordered OFI remains available.'};
  const origin=rows[0].time_seconds,times=rows.slice(1).map(row=>row.time_seconds-origin),split=Math.floor(times.length*.7),training=times.slice(0,split),test=times.slice(split),cutoff=training.at(-1),end=(observation_end_seconds??rows.at(-1).time_seconds)-origin,fit=fitHawkes(training,cutoff),rate=training.length/cutoff,heldout=exponentialHawkesLikelihood(test,{...fit,start:cutoff,end,history:training}),poissonLog=test.length*Math.log(rate)-rate*(end-cutoff),trainingGain=2*(fit.log_likelihood-(training.length*Math.log(rate)-rate*cutoff))-4,holdoutGain=heldout.log_likelihood-poissonLog,passed=trainingGain>0&&holdoutGain>0,ratio=heldout.intensity_at_end/rate,applied=enabled&&passed;
  return {...base,available:true,applied,validation_status:passed?'arrival_holdout_passed':'not_promoted',reason:!enabled?'Arrival clustering is disabled.':passed?'The quote-arrival model improves the current held-out likelihood over Poisson.':'Clustering did not pass the current chronological Poisson comparison.',parameters:{mu_per_second:fit.mu,alpha_per_second:fit.alpha,beta_per_second:fit.beta,branching_ratio:fit.alpha/fit.beta},branching_ratio:fit.alpha/fit.beta,intensity:heldout.intensity_at_end,intensity_per_second:heldout.intensity_at_end,intensity_reference:observation_end_seconds===undefined?'last_observed_quote_event':'end_of_observed_connected_window',observed_idle_seconds:end-times.at(-1),poisson_rate_per_second:rate,intensity_ratio:ratio,risk_multiplier:applied?Math.sqrt(clamp(ratio,.5,3)):1,
    evaluation:{fit_n:training.length,holdout_n:test.length,training_end_time:cutoff,holdout_first_time:test[0],holdout_end_time:end,fit_aic_advantage_over_poisson:trainingGain,holdout_log_likelihood_gain:holdoutGain,holdout_gain_per_event:holdoutGain/test.length,passed},
    note:'The bounded square-root intensity multiplier is an explicit execution-risk scenario assumption, not a fitted relationship between quote arrivals and future price volatility. This model measures activity clustering, not direction, toxicity or settlement probability. Both likelihoods condition on the same past; fit/calibration is local and rolling.'};
}
