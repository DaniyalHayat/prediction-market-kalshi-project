import {executionCurve} from './execution-curve.mjs';
import {nflContractIdentity} from './nfl-source.mjs';
import {nflPositionPayout,usableForecast} from './positions.mjs';

export const EXPLANATION_LABS=[
  {id:'break-even',label:'Break-even',description:'Find the average payout your entry would need to earn its cost.',controls:['side','quantity','slippage']},
  {id:'fill-path',label:'Fill path',description:'Follow the requested entry through the price levels it would consume.',controls:['side','quantity','slippage']},
  {id:'liquidity-stress',label:'Vanishing depth',description:'Keep a fraction of visible liquidity and compare the resulting fills.',controls:['side','quantity','slippage','depthRetained']},
  {id:'exit-now',label:'Exit now',description:'Price the sale at public bids and compare it with your basis.',controls:['side','quantity','basis','slippage']},
  {id:'settlement',label:'Settlement table',description:'Compare the paper dollars each outcome would pay.',controls:['side','quantity','basis','slippage']},
  {id:'news-replay',label:'Headline replay',description:'Bracket a timestamped report with observed market quotes.',controls:['side','sourceIndex','windowMinutes']},
  {id:'evidence-check',label:'Evidence removal',description:'Remove one publisher from the current evidence packet and see what remains.',controls:['sourceIndex']},
  {id:'model-pressure',label:'Model stress',description:'Move the all-in entry cost and compare it with a released valuation range.',controls:['side','quantity','slippage','priceDelta']}
];

const item=(label,value,unit)=>({label,value,unit});
const cents=value=>value===null?null:value*100;
const displaySide=side=>side.toUpperCase();
const finiteRange=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max;
const validTime=value=>typeof value==='string'?Date.parse(value):NaN;
const timestamp=value=>Number.isFinite(value)?new Date(value).toISOString():null;
const marketOpen=(market,now)=>['open','active'].includes(market.status)&&validTime(market.close_time)>now;
const feeNote=verified=>verified?'Uses the reported series fee coefficient with estimated taker fee rounding.':'Uses the general 0.07 taker fee assumption.';

function publicURL(value){
  if(typeof value!=='string'||value.length>1000)return null;
  try{
    const url=new URL(value);
    return url.protocol==='https:'&&!url.username&&!url.password?url:null;
  }catch{return null;}
}

function cite(label,url,as_of){
  const safe=publicURL(url);
  return safe?{label,url:safe.href,as_of:timestamp(validTime(as_of))}:null;
}

function distinctSources(rows){
  const seen=new Set();
  return rows.filter(row=>{
    if(!row||seen.has(row.url))return false;
    seen.add(row.url);
    return true;
  });
}

function ready(classification,summary,{metrics=[],rows=[],note='',sources=[],as_of=null,options=[]}={}){
  return {status:'ready',classification,summary,metrics,rows,note,sources:distinctSources(sources),as_of,options};
}

function unavailable(summary,{classification='Awaiting evidence',options=[],sources=[]}={}){
  return {status:'unavailable',classification,summary,metrics:[],rows:[],note:'',sources:distinctSources(sources),as_of:null,options};
}

function feeAssumptions({market,fees,research}){
  const series=market.ticker.split('-')[0];
  if(fees?.series===series&&finiteRange(fees.coefficient,0,1))
    return {coefficient:fees.coefficient,feeVerified:true,feeSource:cite('Series fee schedule',fees.source_url,fees.as_of)};
  if(research?.ticker===market.ticker&&(!research.market||research.market.ticker===market.ticker)&&finiteRange(research.fee_coefficient,0,1))
    return {coefficient:research.fee_coefficient,feeVerified:true};
  return {coefficient:.07,feeVerified:false};
}

function withBook(context,run){
  const {market,book,now}=context;
  if(!marketOpen(market,now))return unavailable('A confirmed open contract is required for a live depth calculation.');
  try{globalThis.PredictirPaper.checkedBook(book,market.ticker,{now});}
  catch{return unavailable('Refresh the matching public book to use this tool. A fresh, uncrossed snapshot is required.');}
  return run({...context,...feeAssumptions(context)});
}

function quote(context,action){
  const {market,book,side,quantity,coefficient,slippage,now}=context;
  return executionCurve(book,market.ticker,side,action,{coefficient,slippage,now}).quote(quantity);
}

function quoteFacts(context){
  return {as_of:context.book.as_of,sources:[cite('Exchange order book',context.book.source_url,context.book.as_of),context.feeSource]};
}

function researchSources(research,ticker,kinds){
  if(research?.ticker!==ticker||!Array.isArray(research.sources))return [];
  return research.sources.filter(row=>kinds.includes(row?.kind)).slice(0,4)
    .map(row=>cite(typeof row.label==='string'?row.label:'Research source',row.url,row.retrieved_at||row.as_of));
}

function breakEven(context){
  const value=quote(context,'buy');
  if(!value.filled)return unavailable('There is no executable ask depth for this side in the selected price band.');
  return ready('Observed book · paper fill',value.complete?'Here is the average payout needed to recover this entry cost.':'Available asks cover only part of the requested entry. The break-even applies to that portion.',{
    ...quoteFacts(context),
    metrics:[item('Break-even payout per contract',cents(value.cash/value.filled),'cents'),item('Average ask before fees',cents(value.vwap),'cents'),
      item('Modeled entry fee',value.fee,'usd'),item('Contracts covered',value.filled,'contracts'),item('Contracts unfilled',value.unfilled,'contracts')],
    note:feeNote(context.feeVerified)+' Break-even describes entry cost. A separate payout estimate is needed to evaluate the entry.'
  });
}

function fillPath(context){
  const {market,book,side,quantity,coefficient,slippage,now}=context;
  const value=globalThis.PredictirPaper.estimate(book,market.ticker,side,'buy',quantity,{coefficient,slippage,now});
  if(!value.filled)return unavailable('There is no executable ask depth for this side in the selected price band.');
  let running=0;
  const rows=value.fills.slice(0,16).map((fill,index)=>{
    running+=fill.quantity;
    return {label:'Level '+(index+1),metrics:[item('Ask',cents(fill.price),'cents'),item('Filled',fill.quantity,'contracts'),
      item('Cumulative fill',running,'contracts'),item('Fee',fill.fee,'usd')]};
  });
  return ready('Observed book · paper fill','The scenario walks the best available asks first.',{
    ...quoteFacts(context),rows,
    metrics:[item('Total filled',value.filled,'contracts'),item('Remaining',value.unfilled,'contracts'),item('All-in entry cost',value.cash,'usd')],
    note:feeNote(context.feeVerified)+(value.fills.length>rows.length?' Totals include all '+value.fills.length+' levels. The first '+rows.length+' are shown.':'')
  });
}

function liquidityStress(context){
  const {market,book,side,quantity,coefficient,slippage,now,depthRetained}=context;
  const base=quote(context,'buy');
  if(!base.filled)return unavailable('The observed asks already have zero executable depth for this side.');
  const fp=book.raw.orderbook_fp;
  const trim=levels=>levels?.map(([price,size])=>[price,Number(size)*depthRetained/100])??null;
  const stressed={...book,raw:{orderbook_fp:{yes_dollars:trim(fp.yes_dollars),no_dollars:trim(fp.no_dollars)}}};
  const result=executionCurve(stressed,market.ticker,side,'buy',{coefficient,slippage,now}).quote(quantity);
  const row=(label,value)=>({label,metrics:[item('Filled',value.filled,'contracts'),item('Unfilled',value.unfilled,'contracts'),
    item('All-in cost per fill',value.filled?cents(value.cash/value.filled):null,'cents')]});
  return ready('Conditional depth stress',result.complete?'The full size still fits inside the selected price band.':'Some of the requested size would sit unfilled in this depth scenario.',{
    ...quoteFacts(context),metrics:[item('Retained depth',depthRetained,'percent'),item('Additional unfilled',Math.max(0,result.unfilled-base.unfilled),'contracts')],
    rows:[row('Observed book',base),row('Stress scenario',result)],
    note:'The control scales displayed sizes uniformly while holding prices fixed. '+feeNote(context.feeVerified)
  });
}

function exitNow(context){
  const {quantity,basis}=context,value=quote(context,'sell');
  if(!value.filled)return unavailable('The current public bids cover zero contracts for this side in the selected price band.');
  const portion=basis===null?null:basis*value.filled/quantity;
  return ready('Observed book · paper exit',value.complete?'Current bids cover the requested paper exit.':'Current bids cover only part of the requested exit. Any profit or loss applies to the filled portion.',{
    ...quoteFacts(context),
    metrics:[item('Net exit proceeds',value.cash,'usd'),item('Contracts covered',value.filled,'contracts'),item('Contracts unfilled',value.unfilled,'contracts'),
      item('Basis for filled portion',portion,'usd'),item('P&L on filled portion',portion===null?null:value.cash-portion,'usd')],
    note:feeNote(context.feeVerified)+(basis===null?' Enter the original all-in cost to compare paper P&L.':' The model allocates the entered basis in proportion to the fill.')
  });
}

function settlement(context){
  const {market,quantity,side,now}=context;
  if(market.market_type&&market.market_type!=='binary')return unavailable('This tool needs a binary outcome with a known payout schedule.');
  const nfl=nflContractIdentity(market),nflTicker=market.ticker.startsWith('KXNFLGAME-');
  if(nflTicker&&!nfl.tie_payout_verified)return unavailable('The selected NFL contract’s exact tie payout could not be verified from its rules.');
  let basis=context.basis,entryFacts={};
  if(basis===null){
    const entry=withBook(context,current=>{
      const value=quote(current,'buy');
      return value.complete?{basis:value.cash,...quoteFacts(current),note:feeNote(current.feeVerified)}:null;
    });
    if(entry?.basis===undefined)return unavailable('Enter an all-in basis or use a fresh book with enough ask depth to model the full position.');
    ({basis,...entryFacts}=entry);
  }
  const outcome=(label,payout)=>({label,metrics:[item('Payout per contract',cents(payout),'cents'),
    item('Settlement cash',quantity*payout,'usd'),item('Paper P&L',quantity*payout-basis,'usd')]});
  const rows=[outcome(displaySide(side)+' wins',1),...(nfl.tie_payout_verified?[outcome('Game ties',.5)]:[]),outcome(displaySide(side)+' loses',0)];
  const sources=researchSources(context.research,market.ticker,['official_market']);
  return ready('Conditional settlement outcomes','Follow the same position through each payout outcome.',{
    as_of:entryFacts.as_of,metrics:[item('Contracts',quantity,'contracts'),item('All-in basis',basis,'usd')],rows,
    sources:[...sources,cite('Exchange contract and rules',market.source_url),...(entryFacts.sources||[])],
    note:(nfl.tie_payout_verified?'The exact exchange rules specify 50¢ on a tie.':'Assumes the standard $1 winning payout and $0 losing payout. Check the exchange rules for exceptions.')
      +(entryFacts.note?' '+entryFacts.note:'')+' Outcome rows show cash and P&L conditional on settlement.'
  });
}

function eligibleEvidence({evidence,market,now}){
  if(evidence?.ticker!==market.ticker||!Array.isArray(evidence.items))return [];
  const seen=new Set();
  return evidence.items.slice(0,30).flatMap(row=>{
    const url=publicURL(row?.url),time=validTime(row?.as_of);
    if(!url||!Number.isFinite(time)||time>now||typeof row.title!=='string'||!row.title.trim()||row.match_scope!=='matched'||seen.has(url.href))return [];
    seen.add(url.href);
    return [{...row,publisher:typeof row.publisher==='string'?row.publisher.trim():'',url:url.href,time,host:url.hostname.toLowerCase().replace(/^www\./,'')}];
  });
}

function quoteObservations(history,ticker,now,side){
  if(history?.ticker!==ticker||!Array.isArray(history.rows))return [];
  const points=new Map();
  for(const row of history.rows.slice(-1500)){
    const time=validTime(row?.time),yes=row?.midpoint??(row?.value_kind==='quoted_midpoint'?row.value:null);
    if(Number.isFinite(time)&&time<=now&&finiteRange(yes,0,1))points.set(time,side==='no'?1-yes:yes);
  }
  return [...points].sort(([left],[right])=>left-right);
}

function newsReplay(context){
  const {market,history,sourceIndex,windowMinutes,now,side}=context;
  const reports=eligibleEvidence(context).filter(row=>!['reddit','x'].includes(row.platform));
  const options=reports.map((row,index)=>({value:index,label:row.title}));
  const selected=reports[sourceIndex];
  if(!selected)return unavailable('Load matching, timestamped reporting to compare it with exchange quote history.',{options});
  const rows=quoteObservations(history,market.ticker,now,side);
  const window=windowMinutes*60000,time=selected.time;
  const prior=rows.findLast(([at])=>at<time&&at>=time-window),after=rows.find(([at])=>at>time&&at<=time+window);
  const sources=[cite(selected.publisher||'Matched report',selected.url,selected.as_of),cite('Exchange quote history',history?.source_url,history?.as_of)];
  if(!prior||!after)return unavailable('The selected window needs one observed two-sided quote before the report and another after it. Try a wider window.',{options,sources});
  return ready('Observed timing · contextual report',selected.title,{
    as_of:selected.as_of,options,sources,
    metrics:[item(displaySide(side)+' quote change',cents(after[1]-prior[1]),'cents'),item('Minutes between observations',(after[0]-prior[0])/60000,'minutes')],
    rows:[{label:'Before report',as_of:timestamp(prior[0]),metrics:[item('Quoted midpoint',cents(prior[1]),'cents')]},
      {label:selected.time_basis==='provider_first_seen'?'Report first seen by index':'Report timestamp',as_of:selected.as_of,url:selected.url},
      {label:'After report',as_of:timestamp(after[0]),metrics:[item('Quoted midpoint',cents(after[1]),'cents')]}],
    note:'Both figures are observed quoted midpoints. Their timing alone cannot establish what moved the market.'
  });
}

function evidenceCheck(context){
  const {evidence,sourceIndex}=context;
  const articles=eligibleEvidence(context).filter(row=>!['reddit','x'].includes(row.platform)),publishers=new Map();
  for(const article of articles){
    const key=article.publisher&&article.publisher!=='Unverified source'?article.publisher.toLowerCase().trim():article.host;
    if(!publishers.has(key))publishers.set(key,[]);
    publishers.get(key).push(article);
  }
  const groups=[...publishers.values()];
  const options=groups.map(([row],index)=>({value:index,label:row.publisher||row.host}));
  const removed=groups[sourceIndex];
  if(!removed)return unavailable('Load matched reporting before checking which publishers support the brief.',{options});
  const remaining=groups.filter((_,index)=>index!==sourceIndex).flat();
  return ready('Conditional evidence audit','See which matched reports remain after setting one publisher aside.',{
    as_of:evidence.as_of,options,metrics:[item('Publishers remaining',groups.length-1,'count'),item('Reports set aside',removed.length,'count'),
      item('Matched reports remaining',remaining.length,'count'),item('Primary-source reports remaining',remaining.filter(row=>row.confidence==='primary_source').length,'count')],
    rows:remaining.slice(0,8).map(row=>({label:row.title,text:row.publisher||row.host,url:row.url,as_of:row.as_of})),
    sources:remaining.slice(0,6).map(row=>cite(row.publisher||row.host,row.url,row.as_of)),
    note:'Publisher counts measure coverage. Outlets can share reporting or rely on the same underlying source. Removing context leaves the independent forecast unchanged.'
  });
}

function modelPressure(context){
  const {market,research,side,now,priceDelta}=context;
  const forecast=usableForecast(research,now,market.ticker);
  if(!forecast.valid||!forecast.fresh||forecast.experimental)return unavailable('A matching, fresh and released model is required for this comparison.');
  const tie=research.forecast.outcomes?nflPositionPayout(research,market,side,now,forecast):null;
  if(tie?!tie.eligible:!forecast.eligible)return unavailable(tie?.reason||forecast.reason);
  const value=quote(context,'buy');
  if(!value.complete)return unavailable('This comparison needs enough ask depth to price the full requested entry.');
  const baseline=value.cash/value.filled,shifted=baseline+priceDelta/100;
  if(shifted<0)return unavailable('Choose a price shift that leaves the hypothetical all-in entry cost at zero or more.');
  const point=tie?.value??(side==='yes'?forecast.probability:1-forecast.probability);
  const [lower,upper]=tie?.range??(side==='yes'?forecast.interval:[1-forecast.interval[1],1-forecast.interval[0]]);
  const payouts=[lower,point,upper];
  const rows=['Lower estimate','Model estimate','Upper estimate'].map((label,index)=>({label,metrics:[
    item('Estimated payout per contract',cents(payouts[index]),'cents'),
    item('Difference after scenario cost',cents(payouts[index]-shifted),'cents'),
    item('Difference for this size',(payouts[index]-shifted)*value.filled,'usd')
  ]}));
  const facts=quoteFacts(context);
  const sources=[...facts.sources,cite(forecast.model||'Independent forecast',research.forecast.source_url,research.forecast.source_as_of),
    ...researchSources(research,market.ticker,['independent_model'])];
  return ready('Conditional model and price sensitivity','Compare the same model range with a hypothetical all-in unit cost.',{
    ...facts,sources,rows,metrics:[item('Current all-in entry',cents(baseline),'cents'),item('Scenario all-in entry',cents(shifted),'cents'),
      item('Model headroom at current cost',cents(lower-baseline),'cents')],
    note:'The shift changes the all-in cost while holding the released model and filled size fixed. '+(tie?'Payout estimates include the verified 50¢ tie amount. ': '')+feeNote(context.feeVerified)
  });
}

const evaluators={
  'break-even':context=>withBook(context,breakEven),
  'fill-path':context=>withBook(context,fillPath),
  'liquidity-stress':context=>withBook(context,liquidityStress),
  'exit-now':context=>withBook(context,exitNow),
  settlement,
  'news-replay':newsReplay,
  'evidence-check':evidenceCheck,
  'model-pressure':context=>withBook(context,modelPressure)
};

export function evaluateExplanationLab(id,input={}){
  if(!Object.hasOwn(evaluators,id))return unavailable('Choose an analysis tool.');
  const {market,now=Date.now(),side='yes',quantity=5,basis=null,slippage=2,depthRetained=50,windowMinutes=15,sourceIndex=0,priceDelta=0}=input;
  if(!market||typeof market.ticker!=='string'||!/^[A-Za-z0-9_.:-]{1,180}$/.test(market.ticker)||!finiteRange(now,-8.64e15,8.64e15))return unavailable('Choose an exact contract to start.');
  const valid={side:['yes','no'].includes(side),quantity:finiteRange(quantity,1,10000)&&Number.isInteger(quantity),
    basis:basis===null||finiteRange(basis,0,1e9),slippage:finiteRange(slippage,0,100),depthRetained:finiteRange(depthRetained,0,100),
    windowMinutes:finiteRange(windowMinutes,1,1440),sourceIndex:Number.isInteger(sourceIndex)&&finiteRange(sourceIndex,0,29),priceDelta:finiteRange(priceDelta,-100,100)};
  const controls=EXPLANATION_LABS.find(row=>row.id===id).controls;
  if(controls.some(key=>!valid[key]))return unavailable('Check the scenario inputs before calculating.');
  return evaluators[id]({...input,market,now,side,quantity,basis,slippage,depthRetained,windowMinutes,sourceIndex,priceDelta});
}
