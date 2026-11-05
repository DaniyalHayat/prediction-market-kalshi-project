import {wilson} from '../intelligence/math.mjs';
import {normalCDF} from './nba-inplay-math.mjs';
import {optionalStoppingScenario} from './stopping-scenario.mjs';
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
function scoreDiffusionMoments({margin,remaining_seconds,drift_points_per_minute,volatility_points_per_sqrt_minute} = {}) {
  finite(margin,'Current score margin',-200,200);finite(remaining_seconds,'Remaining regulation seconds',0,2880);finite(drift_points_per_minute,'Score drift',-10,10);finite(volatility_points_per_sqrt_minute,'Score volatility',0,20);
  const minutes = remaining_seconds / 60;
  return {
    expected: margin + drift_points_per_minute * minutes,
    sd: volatility_points_per_sqrt_minute * Math.sqrt(minutes)
  };
}

export function analyticScoreDiffusion(parameters) {
  const {expected, sd} = scoreDiffusionMoments(parameters);
  const home = sd === 0 ? Number(expected > 0) : normalCDF(expected / sd);
  const tie = Number(sd === 0 && expected === 0);
  return {
    scenario_home_lead_probability: home,
    scenario_away_lead_probability: 1 - home - tie,
    scenario_tie_probability: tie,
    model_mean: expected,
    model_variance: sd ** 2
  };
}

export function simulateScoreDiffusion({margin,remaining_seconds,drift_points_per_minute,volatility_points_per_sqrt_minute,simulations=20000,seed=71893}={}){
  const {expected, sd} = scoreDiffusionMoments({margin,remaining_seconds,drift_points_per_minute,volatility_points_per_sqrt_minute});
  if(!Number.isInteger(simulations)||simulations<100||simulations>200000||!Number.isInteger(seed)||seed<0||seed>4294967295)throw new RangeError('Use 100–200,000 simulations and an unsigned integer seed');
  const normal=normalGenerator(seed),terminal=[];let home=0,away=0,tied=0,sum=0,squares=0;
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
  const oneSided=(variance,maximum)=>variance===0||drawdown>maximum?0:Math.exp(-drawdown*drawdown/(2*variance));
  let varianceBudget = 0, maximumLoss = 0, union = 0;
  for (let i = increment_bounds.length - 1; i >= 0; i--) {
    const bound = increment_bounds[i];
    varianceBudget += bound ** 2;
    maximumLoss += bound;
    union += oneSided(varianceBudget,maximumLoss);
  }
  return {...limitations,available:true,classification:'mathematical_bound_conditional_on_assumptions',horizon_steps:increment_bounds.length,drawdown,variance_proxy_budget:varianceBudget,
    maximum_loss_from_initial_upper_bound:Math.min(1,oneSided(varianceBudget,maximumLoss)),peak_to_trough_drawdown_upper_bound:Math.min(1,union),deterministic_maximum_loss:maximumLoss,
    formula:'Initial loss: exp(-a²/(2 Σ cᵢ²)). Peak-to-trough: min(1, Σⱼ exp(-a²/(2 Σᵢ>ⱼ cᵢ²))) over suffixes with enough total magnitude to reach a.',
    assumptions:['E[ΔSᵢ | past] = 0 at every step; the same information filtration applies.','|ΔSᵢ| ≤ cᵢ almost surely for each supplied deterministic bound.','The horizon, increment units and threshold refer to the same process.'],
    note:'Exponential-supermartingale maximal bound, with a union bound over each possible peak time for drawdown. No independence assumption is required, but conditional zero drift and bounded increments are essential. Fees, leverage, unbounded gaps and adaptive exposures can violate them. This is not an estimated loss probability, trading guarantee or permission to double stakes after losses.'};
}

const QUANT_DEFAULTS = {hmm: false, kalman: false, brownian_mc: false, optional_stopping: false};

export function normalizeQuantControls(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(QUANT_DEFAULTS, key) || typeof input[key] !== 'boolean')) {
    throw new RangeError('Use boolean values for the supported quantitative controls');
  }
  return {...QUANT_DEFAULTS, ...input};
}

function selectedContext(observations, source, controls) {
  if (!['supplied_scenario', 'observed'].includes(source)) throw new RangeError('Invalid context provenance');
  if (!Array.isArray(observations)) throw new RangeError('Context observations must be an array');

  const disabled = enabled => ({enabled, available: false, reason: enabled ? 'Dated numeric observations are required.' : 'Disabled'});
  if (!observations.length) {
    return {available: false, source, raw_score: null, selected_score: null, method: null,
      hmm: disabled(controls.hmm), kalman: disabled(controls.kalman), reason: 'Dated numeric observations are required.'};
  }

  const latest = contextRows(observations).at(-1);
  function evaluateFilter(enabled, filter) {
    if (!enabled) return disabled(false);
    try {
      const result = filter(observations);
      return {enabled: true, available: true, method: result.method, latest: result.latest};
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return {enabled: true, available: false, reason: error.message};
    }
  }
  const hmm = evaluateFilter(controls.hmm, hmmContext);
  const kalman = evaluateFilter(controls.kalman, kalmanContext);
  const h = hmm.latest?.filtered_context_score;
  const k = kalman.latest?.filtered_context_score;
  const both = h !== undefined && k !== undefined;
  return {
    available: true,
    source,
    observed_at: latest.observed_at,
    observations: observations.length,
    raw_score: latest.score,
    selected_score: both ? (h + k) / 2 : h ?? k ?? latest.score,
    method: both ? 'equal_weight_causal_filter_blend' : hmm.method ?? kalman.method ?? 'raw_score',
    hmm,
    kalman,
    note: 'Each filter processes the same observations through the selected time. Their fixed equal blend describes context on the supplied score scale.'
  };
}

export function evaluateQuantScenario({
  controls,
  context_observations = [],
  context_source = 'supplied_scenario',
  score = null,
  score_source = 'supplied_scenario',
  stopping = null
} = {}) {
  const c = normalizeQuantControls(controls);
  if (!['supplied_scenario', 'observed'].includes(score_source)) throw new RangeError('Invalid score provenance');
  const context = selectedContext(context_observations, context_source, c);
  let scoreResult = {available: false, source: score_source, baseline_probability: null, analytic_probability: null,
    selected_probability: null, monte_carlo: null, reason: 'A dated score margin, clock, drift and volatility are required.'};
  if (score) {
    if (score.baseline_probability !== undefined && score.baseline_probability !== null) {
      finite(score.baseline_probability,'Baseline probability',0,1);
    }
    const analytic = analyticScoreDiffusion(score);
    const simulations = score.simulations ?? 2000;
    if (!Number.isInteger(simulations) || simulations < 100 || simulations > 20000) {
      throw new RangeError('Use 100 to 20,000 scenario simulations');
    }
    const monteCarlo = c.brownian_mc ? simulateScoreDiffusion({...score, simulations}) : null;
    scoreResult = {
      available: true,
      source: score_source,
      baseline_probability: score.baseline_probability ?? null,
      analytic_probability: analytic.scenario_home_lead_probability,
      selected_probability: monteCarlo?.scenario_home_lead_probability ?? analytic.scenario_home_lead_probability,
      selected_method: monteCarlo ? 'seeded_Brownian_terminal_draws' : 'analytic_Gaussian_terminal_margin',
      analytic,
      monte_carlo: monteCarlo,
      note: 'This scenario measures a regulation lead under the supplied score dynamics. The pregame baseline is a separate prediction. Monte Carlo intervals measure sampling error.'
    };
  }

  const stop = stopping ? optionalStoppingScenario({...stopping, enabled: c.optional_stopping}) :
    {enabled: c.optional_stopping, available: false, reason: 'An explicit fair-price path, quantity and exit-cost scenario are required.'};
  let contextScore = context.raw_score;
  let probability = scoreResult.baseline_probability;
  let certainty = stop.baseline?.certainty_equivalent ?? null;
  const cumulative = [];
  const addStage = (stage, applied) => cumulative.push({stage, applied, context_score: contextScore,
    score_probability: probability, stopping_certainty_equivalent: certainty});
  addStage('baseline', context.available || probability !== null || certainty !== null);
  if (context.hmm.available) contextScore = context.hmm.latest.filtered_context_score;
  addStage('hmm', context.hmm.available);
  if (context.kalman.available) contextScore = context.selected_score;
  addStage('kalman', context.kalman.available);
  if (scoreResult.available) probability = scoreResult.analytic_probability;
  addStage('brownian_analytic', scoreResult.available);
  if (scoreResult.monte_carlo) probability = scoreResult.selected_probability;
  addStage('brownian_mc', Boolean(scoreResult.monte_carlo));
  if (stop.available && c.optional_stopping) certainty = stop.policy.certainty_equivalent;
  addStage('optional_stopping', stop.available && c.optional_stopping);

  return {...limitations, paper_only: true, controls: c, context, score: scoreResult, stopping: stop, cumulative,
    classification: 'conditional_quantitative_scenarios',
    note: 'Cumulative stages track three separate quantities: context score, regulation-lead probability and position utility. Each has its own inputs and evidence.'};
}
