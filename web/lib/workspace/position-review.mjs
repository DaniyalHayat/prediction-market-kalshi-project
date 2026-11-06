import {book,marketDetails,trades,validateTicker} from '../live.mjs';
import {contractHistory,recentPositionIdeas,workspaceEvidence,workspaceResearch} from './router.mjs';
import {evaluatePaperPosition} from './positions.mjs';
import {WORKSPACE_CATEGORIES} from './catalog.mjs';

export const POSITION_REVIEW_BUDGET_MS=6200;
const sourceTasks=new Map(),maxConcurrentReviews=4;
const dollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const counts=new Intl.NumberFormat('en-US',{maximumFractionDigits:3});
const usd=value=>dollars.format(value);
const percent=value=>Math.round(value*1000)/10+'%';

export function parsePositionReview(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new RangeError('Supply one open paper position.');
  const {ticker,side,quantity,basis,shared_quantity=quantity,model='validated',automatic=false}=input;
  validateTicker(ticker);
  if(!['yes','no'].includes(side)||!['baseline','validated','challenger'].includes(model)||typeof automatic!=='boolean'||
    !Number.isFinite(quantity)||quantity<=0||quantity>1e6||!Number.isFinite(basis)||basis<0||basis>1e9||
    !Number.isFinite(shared_quantity)||shared_quantity<quantity||shared_quantity>1e6)
    throw new RangeError('Use a valid side, quantity, shared quantity, cost basis and research model.');
  return {ticker,side,quantity,basis,shared_quantity,model,automatic};
}

function collectPositionSources(ticker,model,deps){
  const key=ticker+'#'+model;
  if(sourceTasks.has(key))return sourceTasks.get(key);
  if(sourceTasks.size>=maxConcurrentReviews)return null;
  const work={},results={};
  function add(name,operation){
    const started=performance.now(),duration=()=>Math.round(performance.now()-started);
    const task=Promise.resolve().then(operation);
    work[name]=task.then(value=>{results[name]={value,duration:duration()};},error=>{
      results[name]={error:true,limited:error?.upstream_status===429||error?.status===429,duration:duration()};
    });
    return task;
  }
  const marketPacket=add('market',()=>deps.marketDetails(ticker));
  const orderBook=add('book',()=>deps.book(ticker,1));
  add('research',()=>deps.workspaceResearch(ticker,{fast:true,model,marketPacket,orderBook,refreshAvailability:/^KXNBAGAME-/.test(ticker)}));
  add('news',()=>deps.workspaceEvidence(ticker,{model,marketPacket}));
  add('history',()=>deps.contractHistory(ticker));
  add('flow',()=>deps.trades(ticker));
  const ready=Promise.all(Object.values(work)).finally(()=>sourceTasks.delete(key));
  const entry={ready,results};
  sourceTasks.set(key,entry);
  return entry;
}

function before(task,ms,signal){
  if(ms<=0||signal?.aborted)return Promise.resolve(false);
  return new Promise(resolve=>{
    const finish=value=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);resolve(value);};
    const aborted=()=>finish(false),timer=setTimeout(aborted,ms);
    signal?.addEventListener('abort',aborted,{once:true});
    task.then(()=>finish(true),aborted);
  });
}

function allocateBidDepth(value,side,fraction){
  const key=side+'_dollars',levels=value?.raw?.orderbook_fp?.[key];
  if(fraction===1||!Array.isArray(levels))return value;
  return {...value,raw:{...value.raw,orderbook_fp:{...value.raw.orderbook_fp,
    [key]:levels.map(([price,quantity])=>[price,Number(quantity)*fraction])}}};
}

export function summarizePositionFlow(value,ticker,now){
  const seen=new Set(),counts={yes:0,no:0};
  for(const row of value?.trades||[]){
    const time=Date.parse(row.created_time),quantity=Number(row.count_fp),side=row.taker_outcome_side??row.taker_side;
    if(row.ticker!==ticker||row.is_block_trade===true||typeof row.trade_id!=='string'||seen.has(row.trade_id)||
      !Number.isFinite(time)||time>now||time<now-25*60000||!Number.isFinite(quantity)||quantity<=0||!['yes','no'].includes(side))continue;
    seen.add(row.trade_id);
    counts[side]+=quantity;
  }
  return {sample_trades:seen.size,yes_taker_contracts:counts.yes,no_taker_contracts:counts.no,
    sample_truncated:Boolean(value?.partial),window_minutes:25,as_of:value?.as_of??null};
}

function links(rows){
  const unique=new Map();
  for(const row of rows){
    if(!row?.url||typeof row.url!=='string'||row.url.length>800)continue;
    try{
      const url=new URL(row.url);
      if(url.protocol==='https:'&&!url.username&&!url.password&&!unique.has(url.href))
        unique.set(url.href,{label:String(row.label||url.hostname).slice(0,100),url:url.href,retrieved_at:row.retrieved_at});
    }catch{}
  }
  return [...unique.values()].slice(0,8);
}

function decisionSections(input,{evaluation,action,book,history,flow,news,feedback,reason,now}){
  const p=evaluation,sections=[];
  const label=input.side.toUpperCase();
  if(p.settlement.confirmed){
    sections.push({heading:'The outcome is final',text:'Kalshi reports '+p.settlement.result.toUpperCase()+'. The remaining '+label+' paper position settles at '+usd(p.settlement.payout)+'.'});
  }else if(Number.isFinite(p.marked_value)){
    const pnl=p.unrealized_pnl;
    const mark=pnl<0?'down '+usd(-pnl):pnl>0?'up '+usd(pnl):'at break-even';
    sections.push({heading:'What the paper position is worth now',text:'Your remaining cost is '+usd(input.basis)+' for '+counts.format(input.quantity)+' '+label+' contracts. Current bids would return '+usd(p.marked_value)+' after '+usd(p.exit_fee)+' in estimated exit fees. That puts this lot '+mark+'. The original cost measures P&L. What matters for the next decision is what you could get out now compared with what holding might pay.'+
      (input.shared_quantity>input.quantity?' This lot was allocated its share of the bid depth across your open lots on the same side.':'')});
  }else{
    sections.push({heading:'What the paper position is worth now',text:'The remaining cost is '+usd(input.basis)+' for '+counts.format(input.quantity)+' '+label+' contracts. '+(p.fresh?
      'Bids cover '+counts.format(p.executable_quantity)+' of those contracts within 2¢ of the best bid, so there is no complete exit mark.':
      'A matching fresh order book was unavailable, so the scan could not price an exit.')});
  }
  const range=p.fair_value_range;
  if(range&&p.forecast_fresh){
    const status=action==='HOLD'?'Even the lower estimate beats a sale at today’s bids, after a 1¢ per-contract cushion.':
      action==='SELL'?'Even the higher estimate is below today’s net sale value, after a 1¢ per-contract cushion.':reason;
    sections.push({heading:'The hold-or-sell call',text:'The model’s estimated value for holding the remaining lot to settlement ranges from '+usd(range[0])+' to '+usd(range[1])+'. '+status+
      (action==='REVIEW'?' Look at the next fresh quote or independent source before drawing a conclusion.':' A forecast range is an estimate. The contract can still settle against you.')});
    if(p.nfl_settlement){
      const payout=p.nfl_settlement;
      sections.push({heading:'What a tie changes',text:'This NFL contract pays $1 per winning contract, '+usd(payout.tie_payout)+' on either side after a tie, and $0 on a loss. The pregame model estimates a '+percent(payout.win_probability)+' chance for this side to win and '+percent(payout.tie_probability)+' for a tie. Weighting those payouts puts the average modeled hold value at '+usd(payout.expected_per_contract)+' per contract. The range reflects sensitivity to team strength and the historical tie rate. It excludes roster effects and can miss the actual result.'});
    }
  }else if(action!=='SETTLE')sections.push({heading:'The hold-or-sell call',text:reason+' Check the missing source, liquidity or model coverage shown here before relying on a new call.'});
  if(feedback?.status==='available'&&p.forecast_fresh){
    const scenarios=feedback.scenarios.map(row=>row.name+' ('+row.status+'): '+percent(row.conditional_probability)+' YES in this scenario, using '+row.dnp_games+' games missed and '+row.regular_games+' games with regular minutes.');
    sections.push({heading:'How lineup evidence changes the risk',text:'The team model starts at '+percent(feedback.baseline_probability)+' YES. '+scenarios.join(' ')+
      ' The scan uses the wider YES range of '+feedback.decision_interval.map(percent).join(' to ')+' when comparing hold value with current bids.'});
  }
  const signal=history?.ticker===input.ticker?history.market_signal:null;
  const changes=signal?.status==='available'&&Number.isFinite(signal.last_midpoint)&&Number.isFinite(signal.prediction)&&Date.parse(signal.observed_at)>=now-180000;
  const move=changes?Math.round((signal.prediction-signal.last_midpoint)*10000)/100:null;
  const quoteText=Number.isFinite(book?.metrics?.book_spread_cents)?
    'The observed YES spread was '+counts.format(book.metrics.book_spread_cents)+'¢. Wider gaps make it harder to get out near a headline price. ':'';
  const flowText=flow.sample_trades?
    'The latest public sample contained '+counts.format(flow.sample_trades)+' trades in the last 25 minutes, with '+counts.format(flow.yes_taker_contracts)+' contracts on YES-labeled taker outcomes and '+counts.format(flow.no_taker_contracts)+' on NO-labeled outcomes. ':
    'The latest public sample did not contain usable recent trade prints. ';
  sections.push({heading:'Price movement and order flow',text:quoteText+flowText+(changes?
    'The one-minute quote model projects '+(move===0?'no midpoint change':counts.format(Math.abs(move))+'¢ '+(move>0?'higher':'lower'))+' in the YES midpoint. This measures possible quote movement and cannot tell you who wins at settlement.':
    'Recent quote history did not support a current price-path estimate.')});
  const reports=[...(news?.items||[]),...(news?.related_items||[])].filter(row=>row.title&&row.url).slice(0,3);
  sections.push({heading:'Reporting and the next thing to watch',text:reports.length?
    reports.map(row=>String(row.publisher||'Public source').slice(0,70)+': '+String(row.title).slice(0,175)).join(' • ')+
      ' Read the source dates and check whether the report changes the exact settlement condition or the independent forecast. Related reporting is context.':
    'No attributable public report matched within this scan. Check the settlement rule, the next relevant release and whether liquidity is thinning.'});
  return {sections,reports};
}

export async function reviewPaperPosition(raw,{signal,deadlineMs=POSITION_REVIEW_BUDGET_MS,now=Date.now,dependencies={}}={}){
  const start=performance.now(),input=parsePositionReview(raw);
  if(!Number.isFinite(deadlineMs)||deadlineMs<=0||deadlineMs>POSITION_REVIEW_BUDGET_MS)throw new RangeError('Invalid review deadline');
  const deps={book,marketDetails,trades,contractHistory,workspaceEvidence,workspaceResearch,recentPositionIdeas,...dependencies};
  const packet=collectPositionSources(input.ticker,input.model,deps);
  const completed=Boolean(packet)&&await before(packet.ready,deadlineMs,signal);
  const results=packet?.results||{},marketInfo=results.market?.value,bookInfo=results.book?.value;
  const news=results.news?.value?.ticker===input.ticker?results.news.value:null;
  const history=results.history?.value?.ticker===input.ticker?results.history.value:null,tradeInfo=results.flow?.value;
  const model=results.research?.value;
  const market=marketInfo?.market?.ticker===input.ticker?marketInfo.market:null,at=now();
  const depth=allocateBidDepth(bookInfo,input.side,input.quantity/input.shared_quantity);
  const open=market&&['open','active'].includes(market.status)&&Date.parse(market.close_time)>at;
  const evaluation=evaluatePaperPosition({ticker:input.ticker,side:input.side,remaining_quantity:input.quantity,remaining_basis:input.basis},
    open?depth:null,model,{now:at,feeCoefficient:Number.isFinite(model?.fee_coefficient)?model.fee_coefficient:undefined,market});
  let action=evaluation.action==='EXIT'?'SELL':evaluation.action,reason=evaluation.reason;
  if(!market&&action==='SETTLE'){action='REVIEW';reason='The current exchange settlement could not be confirmed.';}
  if(!open&&action!=='SETTLE'){
    action='REVIEW';
    reason=market?'The contract is no longer confirmed open for an exit. Wait for verified settlement or a fresh open market.':
      'The exchange did not confirm this contract’s current status within the scan.';
  }
  if((action==='SELL'||action==='HOLD')&&model?.forecast?.experimental){
    action='REVIEW';reason='This experimental forecast can inform a scenario. It cannot trigger a paper exit or hold recommendation.';
  }
  if(!packet)reason='All scan slots are busy. Try again shortly.';
  const flow=summarizePositionFlow(tradeInfo,input.ticker,at);
  const feedback=model?.forecast?.availability_feedback;
  const {sections,reports}=decisionSections(input,{evaluation,action,book:bookInfo,history,flow,news,feedback,reason,now:at});
  const sources=links([{label:'Kalshi settlement rules',url:marketInfo?.source_url,retrieved_at:marketInfo?.as_of},
    {label:'Kalshi bid depth',url:bookInfo?.source_url,retrieved_at:bookInfo?.as_of},
    {label:'Kalshi public trades',url:tradeInfo?.source_url,retrieved_at:tradeInfo?.as_of},
    {label:'Kalshi price history',url:history?.source_url,retrieved_at:history?.as_of},
    ...reports.map(row=>({label:row.publisher,url:row.url,retrieved_at:row.retrieved_at})),...(model?.sources||[])]);
  let ideas;
  if(action==='SELL'){
    const ideaTask=Promise.resolve().then(deps.recentPositionIdeas).then(value=>{ideas=value;});
    await before(ideaTask,Math.min(1000,deadlineMs-(performance.now()-start)),signal);
  }
  const alternatives=(ideas?.rows||[]).filter(row=>row.ticker!==input.ticker&&(!market?.event_ticker||row.event_ticker!==market.event_ticker)).slice(0,3);
  const sourceNames=['market','book','research','news','history','flow'],duration_ms=Math.round(performance.now()-start);
  return {ticker:input.ticker,action,reason,sections,sources,alternatives,...(feedback?{model_feedback:feedback}:{}),
    evaluation:{...evaluation,action,reason,fee_assumption:Number.isFinite(model?.fee_coefficient)?'series_schedule':'general_fee_formula'},
    flow,as_of:new Date(at).toISOString(),duration_ms,
    timings_ms:{...Object.fromEntries(sourceNames.map(key=>[key,results[key]?.duration??null])),total:duration_ms},
    partial:!completed||Object.values(results).some(row=>row.error),source_status:Object.fromEntries(sourceNames.map(key=>
      [key,results[key]?.limited?'rate_limited':results[key]?.error?'unavailable':results[key]?'loaded':'pending'])),
    alternative_coverage:{checked_categories:ideas?.checked_categories||[],category_count:WORKSPACE_CATEGORIES.length,scanned_contracts:ideas?.scanned_contracts||0,
      scope:action==='SELL'?'Up to three recent, validated $20 paper scenarios ranked by lower-bound value after fees and buffer. The sample can miss contracts or categories.':'Alternative ideas are checked after a supported sell signal.'}};
}
