import { DAY, isoDay, monthNumber } from "./sources.mjs";

export const MODEL_VERSION = "independent-v1.0";
export const clamp = (value,lower=0,upper=1) => Math.max(lower,Math.min(upper,value));
export const mean = values => values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null;
export const variance = values => values.length > 1 ? mean(values.map(value=>(value-mean(values))**2)) : 0;
export function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b), position=clamp(p)*(sorted.length-1), lower=Math.floor(position);
  return sorted[lower]+(sorted[Math.ceil(position)]-sorted[lower])*(position-lower);
}
export const median = values => quantile(values,.5);
export function normalCdf(z) {
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  const sign = z < 0 ? -1 : 1, x = Math.abs(z)/Math.sqrt(2), t=1/(1+.3275911*x);
  const erf = 1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x);
  return clamp(.5*(1+sign*erf));
}
export function wilson(successes, n, z=1.96) {
  if (!n) return [0,1];
  const p=clamp(successes/n), denominator=1+z*z/n;
  const center=(p+z*z/(2*n))/denominator, half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/denominator;
  return [clamp(center-half),clamp(center+half)];
}
export function marketBounds(market, precision=0) {
  const number = value => value === null || value === undefined || value === "" || ["boolean","object"].includes(typeof value) ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  const floor=number(market.floor_strike), cap=number(market.cap_strike), half=precision/2;
  switch (market.strike_type) {
    case "greater": return floor === null ? null : {lower:floor+half,upper:Infinity,description:`greater than ${floor}`};
    case "greater_or_equal": return floor === null ? null : {lower:floor-half,upper:Infinity,description:`at least ${floor}`};
    case "less": return cap === null ? null : {lower:-Infinity,upper:cap-half,description:`less than ${cap}`};
    case "less_or_equal": return cap === null ? null : {lower:-Infinity,upper:cap+half,description:`at most ${cap}`};
    case "between": return floor === null || cap === null || floor > cap ? null : {lower:floor-half,upper:cap+half,description:`${floor} to ${cap}`};
    default: return null;
  }
}
export function empiricalProbability(center, errors, bounds, block=1) {
  if (!errors.length || !bounds) return null;
  const wins = errors.filter(error=>center+error>=bounds.lower && center+error<bounds.upper).length;
  const probability=(wins+.5)/(errors.length+1), effective=Math.max(1,Math.floor(errors.length/block));
  const interval=wilson(probability*effective,effective);
  return {probability,interval,n:errors.length,effective_n:effective,interval_kind:"95% Wilson sampling interval; model misspecification is not included"};
}
export function gaussianProbability(center, sigma, bounds, minObserved=-Infinity) {
  if (!bounds || !Number.isFinite(center) || !Number.isFinite(sigma) || sigma<=0) return null;
  const cdf = x => x <= minObserved ? 0 : normalCdf((x-center)/sigma);
  return clamp(cdf(bounds.upper)-cdf(bounds.lower));
}
const nextMonth = date => {
  const index=monthNumber(date)+1;
  return `${Math.floor(index/12)}-${String(index%12+1).padStart(2,"0")}-01`;
};
export function eventDate(market) {
  const code=(market.event_ticker || market.ticker || "").match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})?(?:\d{2})?(?:-|$)/);
  if (!code) return null;
  const month=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(code[2])+1;
  const value=`20${code[1]}-${String(month).padStart(2,"0")}-${code[3] || "01"}`;
  return Number.isFinite(Date.parse(value)) && isoDay(value)===value ? value : null;
}

function dailyCandidates(rows, target) {
  const byDate=new Map(rows.map(row=>[row.date,row.value]));
  const lags=[1,2,3,4].map(week=>byDate.get(isoDay(Date.parse(target)-7*week*DAY)));
  if (lags.some(value=>!Number.isFinite(value))) return null;
  const slopes=[];
  for (let i=0;i<lags.length;i++) for(let j=i+1;j<lags.length;j++) slopes.push((lags[i]-lags[j])/(j-i));
  const trend=median(slopes), center=mean(lags);
  return [lags[0],.4*lags[0]+.3*lags[1]+.2*lags[2]+.1*lags[3],Math.max(0,center+clamp(trend,-center*.08,center*.08)*1.25)];
}
function monthlyCandidates(rows, target) {
  const last=rows.at(-1);
  if (!last || nextMonth(last.date)!==target || rows.length < 36) return null;
  const differences=rows.flatMap((row,index)=>{
    const previous=rows[index-1];
    return previous && monthNumber(row.date)-monthNumber(previous.date)===1 ? [{date:row.date,value:row.value-previous.value}] : [];
  }).slice(-60);
  if (differences.length < 24) return null;
  const pairs=differences.slice(1).flatMap((row,index)=>monthNumber(row.date)-monthNumber(differences[index].date)===1 ? [[differences[index].value,row.value]] : []);
  const xbar=mean(pairs.map(pair=>pair[0])), ybar=mean(pairs.map(pair=>pair[1]));
  const xx=pairs.reduce((sum,[x])=>sum+(x-xbar)**2,0);
  const xy=pairs.reduce((sum,[x,y])=>sum+(x-xbar)*(y-ybar),0);
  const beta=xx ? clamp(xy/(xx*1.1),-.8,.8) : 0;
  const ar=ybar+beta*(differences.at(-1).value-xbar);
  return [last.value,last.value+mean(differences.slice(-12).map(row=>row.value))*.5,last.value+ar];
}
function score(actual,predicted,baseline) {
  const errors=actual.map((value,index)=>value-predicted[index]), naive=actual.map((value,index)=>value-baseline[index]);
  const rmse=Math.sqrt(mean(errors.map(value=>value*value))), baselineRmse=Math.sqrt(mean(naive.map(value=>value*value)));
  return {n:actual.length,mae:mean(errors.map(Math.abs)),rmse,baseline_rmse:baselineRmse,rmse_skill:baselineRmse ? 1-rmse/baselineRmse : null};
}
export function timeSeriesModel(rows, frequency="daily") {
  const candidates=frequency==="daily" ? dailyCandidates : monthlyCandidates;
  const start=Math.max(frequency==="daily" ? 35 : 48,rows.length-240), trials=[];
  for (let index=start;index<rows.length;index++) {
    const estimates=candidates(rows.slice(0,index),rows[index].date);
    if (estimates?.every(Number.isFinite)) trials.push({date:rows[index].date,actual:rows[index].value,predictions:estimates});
  }
  if (trials.length < 50) throw new Error("Not enough chronological forecast errors to estimate a distribution");
  const fitEnd=Math.floor(trials.length*.5), calibrationEnd=Math.floor(trials.length*.75);
  const training=trials.slice(0,fitEnd), calibration=trials.slice(fitEnd,calibrationEnd), holdout=trials.slice(calibrationEnd);
  const scale=Math.max(1e-10,variance(training.map(row=>row.actual))*.001);
  const inverse=[0,1,2].map(i=>1/(mean(training.map(row=>(row.actual-row.predictions[i])**2))+scale));
  const weights=inverse.map(value=>value/inverse.reduce((sum,x)=>sum+x,0));
  const predict=values=>values.reduce((sum,value,index)=>sum+value*weights[index],0);
  // Three chronological partitions: fit ensemble weights, calibrate residuals, evaluate untouched outcomes.
  const errors=calibration.map(row=>row.actual-predict(row.predictions));
  const evaluated=holdout.map(row=>({...row,predicted:predict(row.predictions)}));
  const evaluation=score(evaluated.map(row=>row.actual),evaluated.map(row=>row.predicted),evaluated.map(row=>row.predictions[0]));
  const cover=evaluated.filter(row=>row.actual>=row.predicted+quantile(errors,.1) && row.actual<=row.predicted+quantile(errors,.9)).length/evaluated.length;
  return {
    frequency,weights,errors,training_n:training.length,calibration_n:calibration.length,evaluation:{...evaluation,interval_80_coverage:cover,kind:"chronological underlying-value holdout; not a Kalshi-contract profitability backtest"},
    forecast(target) {
      const last=rows.at(-1);
      const horizon=frequency==="daily" ? (Date.parse(target)-Date.parse(last.date))/DAY : monthNumber(target)-monthNumber(last.date);
      if (!Number.isInteger(horizon) || horizon<1 || horizon>(frequency==="daily" ? 7 : 1)) return null;
      const estimates=candidates(rows,target);
      if (!estimates) return null;
      const center=predict(estimates);
      return {center,low:center+quantile(errors,.1),high:center+quantile(errors,.9),horizon,errors,weights};
    },
    chart:evaluated.slice(-60).map(row=>({date:row.date,observed:row.actual,forecast:row.predicted,baseline:row.predictions[0]}))
  };
}
export function cryptoModel(rows, spot, hours) {
  if (!Number.isFinite(spot) || spot<=0 || !Number.isFinite(hours) || hours<=0 || hours>72) return null;
  const returns=rows.slice(1).flatMap((row,index)=>{
    const previous=rows[index];
    return Date.parse(row.date)-Date.parse(previous.date)===3600000 ? [Math.log(row.value/previous.value)] : [];
  });
  if (returns.length < 90) return null;
  let ewma=variance(returns.slice(0,48));
  for (const value of returns) ewma=.94*ewma+.06*value*value;
  const sigma=Math.max(Math.sqrt(ewma),1e-5), mu=mean(returns)*.05;
  const location=Math.log(spot)+mu*hours, scale=sigma*Math.sqrt(hours), driftUncertainty=sigma/Math.sqrt(returns.length)*hours;
  const estimate=bounds=>{
    const logBounds={lower:bounds.lower>0 ? Math.log(bounds.lower) : -Infinity,upper:bounds.upper>0 ? Math.log(bounds.upper) : -Infinity};
    const probability=gaussianProbability(location,scale,logBounds);
    const alternatives=[.75,1,1.5].flatMap(multiplier=>[-1,0,1].flatMap(shift=>[-.001,0,.001].map(basis=>
      gaussianProbability(location+shift*driftUncertainty+basis,scale*multiplier,logBounds))));
    return {probability,interval:[Math.min(...alternatives),Math.max(...alternatives)],n:returns.length,effective_n:Math.max(1,Math.floor(returns.length/Math.max(1,hours))),interval_kind:"Volatility, drift and ±10bp exchange-basis sensitivity band; not a calibrated confidence interval"};
  };
  return {center:Math.exp(location),low:Math.exp(location-1.281551566*scale),high:Math.exp(location+1.281551566*scale),sigma_hourly:sigma,annualized_vol:sigma*Math.sqrt(24*365),hours,mu_hourly:mu,estimate};
}
export function executionEstimate(raw, side, quantity=100, slippage=2, coefficient=.07) {
  if (!["yes","no"].includes(side) || !Number.isInteger(quantity) || quantity<1 || quantity>1e6 || !Number.isFinite(slippage) || slippage<0 || slippage>100 || !Number.isFinite(coefficient) || coefficient<0 || coefficient>1) throw new RangeError("Invalid execution inputs");
  const fp=raw?.orderbook_fp;
  if (!fp) throw new Error("Fixed-point book missing");
  const bids=key=>{
    const aggregated=new Map();
    if (!Array.isArray(fp[key] || [])) throw new Error("Invalid book");
    for(const row of fp[key] || []) {
      if (!Array.isArray(row) || row.length!==2 || row.some(value=>value===null || value==="" || typeof value==="boolean")) throw new Error("Invalid book level");
      const [p,q]=row.map(Number);
      if (![p,q].every(Number.isFinite) || p<0 || p>1 || q<0) throw new Error("Invalid book level");
      if(q>0)aggregated.set(p,(aggregated.get(p)||0)+q);
    }
    return [...aggregated].sort((a,b)=>b[0]-a[0]);
  };
  const yes=bids("yes_dollars"),no=bids("no_dollars");
  if (yes.length && no.length && yes[0][0]+no[0][0]>1+1e-10) throw new Error("Crossed book: no execution estimate");
  const asks=(side==="yes" ? no : yes).map(([p,q])=>[Number((1-p).toFixed(10)),q]), best=asks[0]?.[0] ?? null;
  let filled=0,cost=0,fee=0,available=0;
  const fills=[];
  for(const [price,depth] of asks) {
    if (price>best+slippage/100+1e-10) break;
    available+=depth;
    const take=Math.min(quantity-filled,depth);
    if(take<=0)continue;
    const levelFee=Math.max(0,Math.ceil((coefficient*take*price*(1-price)-1e-10)*100)/100);
    filled+=take;cost+=price*take;fee+=levelFee;
    fills.push({price,quantity:take,estimated_fee:levelFee});
  }
  return {side,requested:quantity,filled,unfilled:quantity-filled,available,cost,fee,all_in:cost+fee,vwap:filled ? cost/filled : null,
    breakeven:filled ? (cost+fee)/filled : null,slippage_cents:filled ? (cost/filled-best)*100 : null,fills};
}
export function quarterKelly(probability, cost) {
  if (![probability,cost].every(Number.isFinite) || probability<0 || probability>1 || cost<0 || cost>=1) return 0;
  return .25*clamp((probability-cost)/(1-cost));
}

export function coherenceChecks(markets) {
  const groups=new Map(), findings=[];
  for(const market of markets) {
    if (!market.event_ticker || !["greater","greater_or_equal","less","less_or_equal"].includes(market.strike_type)) continue;
    const threshold=market.strike_type.startsWith("greater") ? Number(market.floor_strike) : Number(market.cap_strike);
    if (!Number.isFinite(threshold) || market.floor_strike===null && market.cap_strike===null) continue;
    const key=`${market.event_ticker}:${market.strike_type}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({...market,threshold});
  }
  for(const group of groups.values()) {
    group.sort((a,b)=>a.threshold-b.threshold);
    for(let i=1;i<group.length;i++) {
      const [low,high]=[group[i-1],group[i]], greater=low.strike_type.startsWith("greater");
      const long=greater ? low : high, short=greater ? high : low;
      const yesAsk=Number(long.yes_ask_dollars), noAsk=1-Number(short.yes_bid_dollars);
      if ([long.yes_ask_dollars,short.yes_bid_dollars].some(v=>v===null || v===undefined || v==="") || ![yesAsk,noAsk].every(v=>Number.isFinite(v)&&v>=0&&v<=1)) continue;
      const fees=.07*(yesAsk*(1-yesAsk)+noAsk*(1-noAsk)), excess=1-yesAsk-noAsk-fees;
      if(excess>0) findings.push({event_ticker:low.event_ticker,type:"Nested-threshold catalog inconsistency",long_yes:long.ticker,long_no:short.ticker,
        indicative_cost:yesAsk+noAsk,estimated_fees:fees,indicative_minimum_margin:excess,
        caveat:"Catalog-only candidate, not executable arbitrage. Same settlement source, definitions, concurrent depth and per-fill fee rounding must be verified."});
    }
  }
  return findings.sort((a,b)=>b.indicative_minimum_margin-a.indicative_minimum_margin);
}
