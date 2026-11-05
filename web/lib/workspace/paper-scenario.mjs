import {affordableQuantity,executionCurve} from './execution-curve.mjs';
import {usableForecast} from './positions.mjs';

const wholeContractPayout=1;

export function paperScenarios(market,book,research,{budget=20,coefficient=.07,now=Date.now()}={}){
  if(!['active','open'].includes(market.status)||!(Date.parse(market.close_time)>now))return [];
  const forecast=usableForecast(research,now,market.ticker);
  const estimate=research?.forecast;
  const outcomes=estimate?.outcomes;
  const tie=outcomes?.tie;
  const partial=Number.isFinite(tie)&&tie>=0&&tie<=1;
  const expected=partial?estimate.expected_settlement_value:forecast.probability;
  const bounds=partial?estimate.settlement_value_interval:forecast.interval;
  const modeled=forecast.valid&&forecast.fresh&&Number.isFinite(expected)&&Array.isArray(bounds)&&bounds.length===2&&
    bounds.every(Number.isFinite)&&bounds[0]>=0&&bounds[0]<=expected&&expected<=bounds[1]&&bounds[1]<=1;
  let curves;
  try{curves=['yes','no'].map(side=>executionCurve(book,market.ticker,side,'buy',{now,coefficient,slippage:2}));}
  catch{return [];}
  const yesAsk=curves[0].best,noAsk=curves[1].best;
  const mid=Number.isFinite(yesAsk)&&Number.isFinite(noAsk)&&yesAsk+noAsk>=1-1e-8?(yesAsk+1-noAsk)/2:null;
  return curves.flatMap((curve,i)=>{
    const side=i?'NO':'YES',contracts=affordableQuantity(curve,budget);
    if(!contracts)return [];
    const fill=curve.quote(contracts),unit=fill.cash/contracts,unspent=budget-fill.cash;
    const value=modeled?(i?1-expected:expected):null;
    const range=modeled?(i?[1-bounds[1],1-bounds[0]]:bounds):null;
    const quote=mid===null?null:i?1-mid:mid;
    const pointEdge=value===null?null:value-unit;
    const winValue=unspent+contracts*wholeContractPayout,loseValue=unspent,target=budget*2;
    const tieValue=modeled&&partial?unspent+contracts/2:null;
    const targetPossible=winValue>=target-1e-9;
    const tieReachesTarget=tieValue!==null&&tieValue>=target-1e-9;
    const winProbability=modeled?(partial?(i?outcomes.loss:outcomes.win):value):null;
    return [{ticker:market.ticker,title:market.yes_sub_title||market.title,event_ticker:market.event_ticker,category:market.category,
      side,eligible:false,scenario_eligible:pointEdge!==null&&pointEdge>.02,paper_scenario:true,partial_payout:partial,
      quote_reference:quote,break_even:unit,required_edge:quote===null?null:unit-quote,
      probability:modeled&&!partial?value:null,probability_yes:modeled&&!partial?expected:null,interval:modeled&&!partial?range:null,
      interval_yes:modeled&&!partial?bounds:null,settlement_value:value,settlement_value_range:range,
      model:modeled?forecast.model:null,contracts,cost:fill.cash,price:fill.vwap,fee:fill.fee,unspent_cash:unspent,
      win_value:winValue,lose_value:loseValue,tie_value:tieValue,profit_if_win:contracts-fill.cash,loss_if_lose:fill.cash,
      expected_profit:modeled?value*contracts-fill.cash:null,expected_profit_range:modeled?range.map(p=>p*contracts-fill.cash):null,
      point_edge:pointEdge,conservative_edge:modeled?range[0]-unit-.02:null,quote_as_of:book.as_of,close_time:market.close_time,
      source_as_of:modeled?estimate.source_as_of:null,max_source_age_seconds:estimate?.max_source_age_seconds,
      inplay:Boolean(modeled&&estimate.inplay),event_start:modeled&&!estimate.inplay?research?.extensions?.sports?.event?.played_at:null,
      chance_double:{target,possible:targetPossible,probability:!targetPossible?0:winProbability===null?null:winProbability+(tieReachesTarget?tie:0),
        interval:!partial&&modeled&&targetPossible?range:null,
        reason:tieReachesTarget?'A win or a $0.50 tie settlement reaches the target.':targetPossible?'Requires full $1 settlement.':'Even a full $1 payout would leave this budget below the target.'},
      reasons:[modeled?(pointEdge>.02?'The model point estimate clears the current all-in price by more than 2¢. Compare the range before sizing a paper entry.':'The model point estimate falls short of the 2¢ all-in entry buffer at this size.'):
        'Compare this entry with the price you would pay under your own thesis. The quoted midpoint is a reference price.' ]}];
  });
}

export function rankPaperScenarios(rows,maximum=12){
  const ranked=[...rows].sort((a,b)=>Number(b.scenario_eligible)-Number(a.scenario_eligible)||
    (b.point_edge??-Infinity)-(a.point_edge??-Infinity)||(a.required_edge??Infinity)-(b.required_edge??Infinity)||
    a.cost-b.cost||a.ticker.localeCompare(b.ticker));
  const seen=new Set();
  return ranked.filter(row=>{
    const key=row.event_ticker||row.ticker;
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  }).slice(0,maximum);
}
