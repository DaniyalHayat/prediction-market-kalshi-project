import {wilson} from '../intelligence/math.mjs';
const finite=(value,label,minimum=-Infinity,maximum=Infinity)=>{if(!Number.isFinite(value)||value<minimum||value>maximum)throw new RangeError(label+' is outside its permitted range');return value;};
function contextRows(observations){
  if(!Array.isArray(observations)||!observations.length||observations.length>2000)throw new RangeError('One to 2,000 dated, explicitly supplied context scores are required');
  let previous=-Infinity;
  return observations.map(row=>{const time=Date.parse(row.observed_at);finite(row.score,'Context score',-1,1);if(!Number.isFinite(time)||time<=previous)throw new RangeError('Context observations require strictly increasing timestamps');previous=time;return {...row,time};});
}
const limitations={experimental:true,validation_status:'not_outcome_validated',affects_forecast:false,probability_adjustment:null};

export function kalmanContext(observations,{priorMean=0,priorVariance=1,processVariancePerHour=.1,observationVariance=.5}={}){
  const rows=contextRows(observations);finite(priorMean,'Prior mean',-1,1);finite(priorVariance,'Prior variance',0,100);finite(processVariancePerHour,'Hourly process variance',0,100);finite(observationVariance,'Observation variance',1e-9,100);
  let value=priorMean,variance=priorVariance,previous=rows[0].time;const states=[];
  for(const row of rows){
    const hours=(row.time-previous)/3600000,predictedVariance=variance+processVariancePerHour*hours,noise=finite(row.measurement_variance??observationVariance,'Measurement variance',1e-9,100),innovation=row.score-value,innovationVariance=predictedVariance+noise,gain=predictedVariance/innovationVariance;
    value+=gain*innovation;variance=(1-gain)**2*predictedVariance+gain**2*noise;previous=row.time;
    states.push({observed_at:row.observed_at,source_id:row.source_id||null,observed_score:row.score,filtered_context_score:value,posterior_variance:variance,kalman_gain:gain,innovation,standardized_innovation:innovation/Math.sqrt(innovationVariance),model_interval:[value-1.96*Math.sqrt(variance),value+1.96*Math.sqrt(variance)]});
  }
  return {...limitations,method:'scalar_random_walk_Kalman_filter',latest:states.at(-1),states,parameters:{priorMean,priorVariance,processVariancePerHour,observationVariance},
    units:'Unitless supplied context score; variance in score squared. Process variance scales with elapsed hours.',
    note:'Filters supplied numeric observations under a random-walk signal and independent Gaussian-noise assumption. Smoothing does not establish truth, remove bots or estimate a contract probability. Intervals are model-conditional state intervals, not empirical calibration. Repeated or syndicated sources can violate independent measurement errors.'};
}
export function hmmContext(observations,{means=[-.65,0,.65],emissionSD=.35,prior=[.2,.6,.2],transition=[[.85,.14,.01],[.1,.8,.1],[.01,.14,.85]]}={}){
  const rows=contextRows(observations);finite(emissionSD,'Emission standard deviation',.001,10);
  const distribution=(p,label)=>{if(!Array.isArray(p)||p.length!==3||p.some(x=>!Number.isFinite(x)||x<0||x>1)||Math.abs(p.reduce((s,x)=>s+x,0)-1)>1e-9)throw new RangeError(label+' requires three normalized probabilities');};
  distribution(prior,'HMM prior');if(!Array.isArray(means)||means.length!==3||means.some(x=>!Number.isFinite(x)||x< -1||x>1)||means.some((x,i)=>i>0&&x<=means[i-1]))throw new RangeError('HMM means require three increasing context scores');
  if(!Array.isArray(transition)||transition.length!==3)throw new RangeError('A three-state transition matrix is required');transition.forEach(row=>distribution(row,'HMM transition row'));
  const cadence=rows.length>1?rows[1].time-rows[0].time:null;if(rows.some((row,i)=>i>1&&Math.abs(row.time-rows[i-1].time-cadence)>1000))throw new RangeError('HMM context scores require a regular observation cadence; aggregate irregular posts first');
  let posterior=[...prior],logLikelihood=0;const states=[];
  rows.forEach((row,index)=>{
    const prediction=index?means.map((_,j)=>posterior.reduce((sum,p,i)=>sum+p*transition[i][j],0)):posterior;
    const logs=means.map((mean,j)=>prediction[j]===0?-Infinity:Math.log(prediction[j])-.5*((row.score-mean)/emissionSD)**2-Math.log(emissionSD*Math.sqrt(2*Math.PI))),maximum=Math.max(...logs),weights=logs.map(l=>Math.exp(l-maximum)),total=weights.reduce((s,x)=>s+x,0);
    posterior=weights.map(w=>w/total);logLikelihood+=maximum+Math.log(total);
    states.push({observed_at:row.observed_at,observed_score:row.score,state_posterior:{negative_context:posterior[0],neutral_context:posterior[1],positive_context:posterior[2]},filtered_context_score:posterior.reduce((sum,p,i)=>sum+p*means[i],0)});
  });
  return {...limitations,method:'three_state_Gaussian_HMM_forward_filter',latest:states.at(-1),states,log_likelihood:logLikelihood,parameters:{means,emissionSD,prior,transition,cadence_seconds:cadence===null?null:cadence/1000},
    note:'Illustrative, fixed-parameter latent context regimes; no supervised sentiment extraction or source-accuracy learning is performed. State posteriors refer to assumed negative/neutral/positive context, not the market outcome. Parameters need prospective held-out validation before any predictive use.'};
}
function normalGenerator(seed){
  let state=seed>>>0,spare=null;const uniform=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return (state+.5)/4294967296;};
  return ()=>{if(spare!==null){const value=spare;spare=null;return value;}const radius=Math.sqrt(-2*Math.log(uniform())),angle=2*Math.PI*uniform();spare=radius*Math.sin(angle);return radius*Math.cos(angle);};
}
export function simulateScoreDiffusion({margin,remaining_seconds,drift_points_per_minute,volatility_points_per_sqrt_minute,simulations=20000,seed=71893}={}){
  finite(margin,'Current score margin',-200,200);finite(remaining_seconds,'Remaining regulation seconds',0,2880);finite(drift_points_per_minute,'Score drift',-10,10);finite(volatility_points_per_sqrt_minute,'Score volatility',0,20);
  if(!Number.isInteger(simulations)||simulations<100||simulations>200000||!Number.isInteger(seed)||seed<0||seed>4294967295)throw new RangeError('Use 100–200,000 simulations and an unsigned integer seed');
  const minutes=remaining_seconds/60,expected=margin+drift_points_per_minute*minutes,sd=volatility_points_per_sqrt_minute*Math.sqrt(minutes),normal=normalGenerator(seed),terminal=[];let home=0,away=0,tied=0,sum=0,squares=0;
  for(let i=0;i<simulations;i++){const score=expected+sd*normal();terminal.push(score);sum+=score;squares+=score*score;if(score>0)home++;else if(score<0)away++;else tied++;}
  terminal.sort((a,b)=>a-b);const probability=home/simulations;
  return {...limitations,method:'seeded_Brownian_score_margin_scenario',classification:'conditional_simulation_not_live_forecast',parameters:{margin,remaining_seconds,drift_points_per_minute,volatility_points_per_sqrt_minute,simulations,seed},
    scenario_home_lead_probability:probability,scenario_away_lead_probability:away/simulations,scenario_tie_probability:tied/simulations,monte_carlo_interval:wilson(home,simulations),monte_carlo_standard_error:Math.sqrt(probability*(1-probability)/simulations),
    terminal_margin:{mean:sum/simulations,variance:Math.max(0,squares/simulations-(sum/simulations)**2),model_mean:expected,model_variance:sd*sd,quantiles:{p05:terminal[Math.floor((simulations-1)*.05)],p50:terminal[Math.floor((simulations-1)*.5)],p95:terminal[Math.floor((simulations-1)*.95)]}},
    note:'Exact terminal draws from an assumed continuous Brownian margin with fixed drift/volatility. The interval measures Monte Carlo sampling error only; it excludes model misspecification, discrete possessions, lineup effects, clock tactics and overtime. A terminal regulation lead is not the settled NBA game-win event. No parameters are fitted from news or this simulation.'};
}
export function martingaleDrawdownBounds({increment_bounds,drawdown,assumptionsAcknowledged=false}={}){
  if(!Array.isArray(increment_bounds)||!increment_bounds.length||increment_bounds.length>10000||increment_bounds.some(c=>!Number.isFinite(c)||c<0||c>1e9))throw new RangeError('One to 10,000 deterministic absolute increment bounds are required');
  finite(drawdown,'Positive drawdown threshold',Number.MIN_VALUE,1e12);
  if(!assumptionsAcknowledged)return {...limitations,available:false,reason:'A conditional zero-drift martingale with deterministic absolute increment bounds must be explicitly assumed; historical P&L does not establish these assumptions.'};
  const varianceBudget=increment_bounds.reduce((s,c)=>s+c*c,0),maximumLoss=increment_bounds.reduce((s,c)=>s+c,0),oneSided=v=>v===0||drawdown>maximumLoss?0:Math.exp(-drawdown*drawdown/(2*v));
  let tail=varianceBudget,union=0;
  for(const bound of increment_bounds){union+=oneSided(tail);tail=Math.max(0,tail-bound*bound);}
  return {...limitations,available:true,classification:'mathematical_bound_conditional_on_assumptions',horizon_steps:increment_bounds.length,drawdown,variance_proxy_budget:varianceBudget,
    maximum_loss_from_initial_upper_bound:Math.min(1,oneSided(varianceBudget)),peak_to_trough_drawdown_upper_bound:Math.min(1,union),deterministic_maximum_loss:maximumLoss,
    formula:'Initial loss: exp(-a²/(2 Σ cᵢ²)). Peak-to-trough: min(1, Σⱼ exp(-a²/(2 Σᵢ>ⱼ cᵢ²))). Thresholds beyond Σ cᵢ are impossible under these bounds.',
    assumptions:['E[ΔSᵢ | past] = 0 at every step; the same information filtration applies.','|ΔSᵢ| ≤ cᵢ almost surely for each supplied deterministic bound.','The horizon, increment units and threshold refer to the same process.'],
    note:'Exponential-supermartingale maximal bound, with a union bound over each possible peak time for drawdown. No independence assumption is required, but conditional zero drift and bounded increments are essential. Fees, leverage, unbounded gaps and adaptive exposures can violate them. This is not an estimated loss probability, trading guarantee or permission to double stakes after losses.'};
}
