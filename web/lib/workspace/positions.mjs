import {executionCurve} from './execution-curve.mjs';
import {nflContractIdentity} from './nfl-source.mjs';

export function usableForecast(research,now=Date.now(),expectedTicker) {
  const f=research?.forecast,p=f?.probability,range=f?.interval;
  const identity=!expectedTicker||Boolean((research?.ticker===expectedTicker||research?.market?.ticker===expectedTicker)&&(!research?.ticker||research.ticker===expectedTicker)&&(!research?.market?.ticker||research.market.ticker===expectedTicker));
  const valid=identity&&Number.isFinite(p)&&p>=0&&p<=1&&Array.isArray(range)&&range.length===2&&range.every(Number.isFinite)&&range[0]>=0&&range[0]<=p&&range[1]>=p&&range[1]<=1;
  const age=now-Date.parse(f?.source_as_of||''),v=f?.validation,maxAge=Number.isFinite(f?.max_source_age_seconds)?Math.min(86400,Math.max(10,f.max_source_age_seconds))*1000:86400000;
  const validated=v?.passed===true||(Number.isFinite(v?.rmse_skill)&&v.rmse_skill>0&&v.interval_80_coverage>=.7&&v.n>=30);
  const start=Date.parse(research?.extensions?.sports?.event?.played_at||''),expiredDomain=!f?.inplay&&Number.isFinite(start)&&start<=now;
  const fresh=Number.isFinite(age)&&age>=-5000&&age<=maxAge&&!research?.error&&!expiredDomain;
  const eligible=valid&&f?.eligible!==false&&validated&&f?.evidence?.tier>=2&&fresh;
  return {valid,eligible,fresh,experimental:Boolean(f?.experimental),probability:valid?p:null,interval:valid?range:null,model:f?.model_name||null,reason:!identity?'The research packet does not match this exact contract.':!valid?'No matched independent probability is available.':research?.error?'The research refresh failed. Cached estimates cannot drive a current position action.':expiredDomain?'This pregame estimate expired when the event started. Fresh in-play research is required.':!eligible?'The latest model has not met its release, coverage or freshness requirements.':null};
}

function nflPositionPayout(research,market,side,now,forecast){
  const estimate=research.forecast,sport=research.extensions?.sports,identity=nflContractIdentity(market);
  if(estimate.settlement_kind!=='win_loss_half_on_tie'||!identity.available||!identity.tie_payout_verified)
    return {reason:'The current contract rules did not verify the modeled $0.50 tie payout.'};
  const {win,loss,tie}=estimate.outcomes,expected=estimate.expected_settlement_value,bounds=estimate.settlement_value_interval;
  const bounded=value=>Number.isFinite(value)&&value>=0&&value<=1;
  if(![win,loss,tie,expected].every(bounded)||Math.abs(win+loss+tie-1)>1e-8||
    Math.abs(win-estimate.probability)>1e-8||Math.abs(win+tie/2-expected)>1e-8||
    !Array.isArray(bounds)||bounds.length!==2||!bounds.every(bounded)||bounds[0]>expected||expected>bounds[1])
    return {reason:'The NFL outcome probabilities and payout range did not reconcile.'};
  const isYes=side==='yes',game=sport?.event,v=estimate.validation;
  const eligible=forecast.fresh&&!forecast.experimental&&estimate.model_release_passed===true&&v?.passed===true&&
    Number.isFinite(v.payout_mse)&&v.payout_mse>=0&&Number.isFinite(v.baseline_payout_mse)&&v.payout_mse<v.baseline_payout_mse&&
    sport?.league==='nfl'&&sport.coverage?.partial===false&&sport.selection?.code===identity.yes_code&&
    game?.state==='pre'&&game.status_name==='STATUS_SCHEDULED'&&game.completed===false&&Date.parse(game.played_at)>now&&
    ['active','open'].includes(market.status)&&Date.parse(market.close_time)>now;
  return {value:isYes?expected:1-expected,range:isYes?bounds:[1-bounds[1],1-bounds[0]],
    win_probability:isYes?win:loss,tie_probability:tie,tie_payout:.5,eligible,
    reason:forecast.fresh?'The tie-adjusted pregame model has not cleared fixture, coverage and payout-validation checks.':forecast.reason};
}

export function evaluatePaperPosition(position,book,research,{now=Date.now(),feeCoefficient,slippage=2,actionBufferCents=1,maxPositionLoss,market,experimental=false}={}) {
  const q=position?.remaining_quantity,basis=position?.remaining_basis,realized=Number(position?.realized_pnl)||0;
  const base={action:'REVIEW',reason:'Current matching evidence is required.',marked_value:null,unrealized_pnl:null,total_pnl:null,executable_quantity:0,fresh:false,forecast_fresh:false,source_as_of:research?.forecast?.source_as_of||null,status:'unavailable',fair_value_range:null,expected_hold_profit_range:null,exit_proceeds:null,exit_fee:null,probability:null,interval:null,model:null,as_of:book?.as_of||null,settlement:{confirmed:false}};
  if(!Number.isFinite(q)||!Number.isFinite(basis)||q<0||basis<0||!['yes','no'].includes(position.side))return {...base,reason:'The retained paper position is invalid.'};
  if(!q)return {...base,action:'CLOSED',reason:'This paper position is closed.',marked_value:0,unrealized_pnl:0,total_pnl:realized,status:'closed'};
  const detail=market||research?.market;
  if(detail?.ticker===position.ticker&&['settled','finalized'].includes(detail.status)&&['yes','no'].includes(detail.result)){
    const payout=detail.result===position.side?q:0;
    return {...base,action:'SETTLE',reason:'The exchange reports a final binary result. Record its confirmed paper settlement.',marked_value:payout,unrealized_pnl:payout-basis,total_pnl:realized+payout-basis,status:'settled',settlement:{confirmed:true,result:detail.result,payout,source_as_of:research?.as_of||null}};
  }
  let exit;
  try{exit=executionCurve(book,position.ticker,position.side,'sell',{now,slippage,coefficient:feeCoefficient??position.entry_assumptions?.coefficient??.07}).quote(q);}
  catch{return {...base,status:'stale',reason:'The live bid book is missing, stale, crossed or does not match this position.'};}
  const result={...base,fresh:true,status:exit.complete?'live':'partial',executable_quantity:exit.filled,exit_proceeds:exit.cash,exit_fee:exit.fee,
    marked_value:exit.complete?exit.cash:null,unrealized_pnl:exit.complete?exit.cash-basis:null,total_pnl:exit.complete?realized+exit.cash-basis:null};
  if(!exit.complete)return {...result,reason:`Only ${exit.filled} of ${q} contracts have executable bid depth within the slippage limit. Full-position P/L is withheld.`};
  const forecast=usableForecast(research,now,position.ticker);
  result.forecast_fresh=forecast.fresh;
  if(Number.isFinite(maxPositionLoss)&&maxPositionLoss>=0&&basis>maxPositionLoss)return {...result,action:'TRIM',suggested_reduce_fraction:Math.max(0,Math.min(1,1-maxPositionLoss/basis)),reason:'The remaining cost basis exceeds your explicit position-loss limit. Reducing exposure restores that limit independently of a forecast.'};
  if(!forecast.valid)return {...result,reason:forecast.reason};
  const payout=research.forecast.outcomes?nflPositionPayout(research,detail,position.side,now,forecast):null;
  if(payout&&!payout.range)return {...result,reason:payout.reason};
  const isYes=position.side==='yes';
  const value=payout?.value??(isYes?forecast.probability:1-forecast.probability);
  const range=payout?.range??(isYes?forecast.interval:[1-forecast.interval[1],1-forecast.interval[0]]);
  Object.assign(result,{probability:payout?null:value,interval:payout?null:range,model:forecast.model,
    ...(payout?{nfl_settlement:{win_probability:payout.win_probability,tie_probability:payout.tie_probability,tie_payout:payout.tie_payout,
      expected_per_contract:value,range_per_contract:range}}:{}),
    fair_value_range:range.map(p=>p*q),expected_hold_profit_range:range.map(p=>p*q-basis),
    hold_vs_exit_range:range.map(p=>p*q-exit.cash),expected_hold_profit:value*q-basis,expected_hold_vs_exit:value*q-exit.cash,
    entry_probability:position.entry_probability??null,price_direction:'Bid P/L is descriptive; the action compares future payoff with executable exit proceeds.'});
  const experimentalAction=!payout&&experimental&&forecast.experimental&&forecast.fresh;
  if(!(payout?.eligible??forecast.eligible)&&!experimentalAction)return {...result,reason:payout?.reason??forecast.reason};
  const prefix=experimentalAction?'Experimental paper scenario: ':'';
  result.experimental=experimentalAction;
  if(!Number.isFinite(actionBufferCents)||actionBufferCents<0||actionBufferCents>25)return {...result,reason:'Invalid action buffer; review the position assumptions.'};
  const buffer=q*actionBufferCents/100;
  if(result.hold_vs_exit_range[1]<-buffer)return {...result,action:'EXIT',reason:prefix+'Even the upper model bound values the remaining payoff below current net bid proceeds, after the action buffer.'};
  if(result.hold_vs_exit_range[0]>buffer)return {...result,action:'HOLD',reason:prefix+'The lower model bound values the remaining payoff above current net bid proceeds, after the action buffer.'};
  return {...result,reason:'The uncertainty band overlaps the current net exit value. Neither holding nor exiting has a robust modeled advantage.'};
}

export function evaluatePaperPortfolio(positions,books,research,options={}){
  const groups=new Map();
  for(const position of positions){if(position.remaining_quantity>1e-8){const key=position.ticker+'#'+position.side;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(position);}}
  return Object.fromEntries(positions.map(position=>{
    const group=groups.get(position.ticker+'#'+position.side)||[],book=books[position.ticker];let allocated=book;
    if(group.length>1&&book?.raw?.orderbook_fp){
      const total=group.reduce((sum,row)=>sum+row.remaining_quantity,0),share=position.remaining_quantity/total,key=position.side==='yes'?'yes_dollars':'no_dollars';
      const levels=book.raw.orderbook_fp[key];
      if(Array.isArray(levels))allocated={...book,raw:{...book.raw,orderbook_fp:{...book.raw.orderbook_fp,[key]:levels.map(([price,quantity])=>[price,Number(quantity)*share])}}};
    }
    const value=evaluatePaperPosition(position,allocated,research[position.ticker],options);
    return [position.id,{...value,...(group.length>1?{liquidity_allocation:'Proportional allocation of one shared bid book across open lots; exit fees are rounded separately per lot.',shared_lots:group.length}:{})}];
  }));
}
