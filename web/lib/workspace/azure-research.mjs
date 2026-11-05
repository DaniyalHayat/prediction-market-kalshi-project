import {planAzureResearch,rankAzureEvidence} from './azure-assistant.mjs';
import {safePublicURL} from './source-ranking.mjs';

const rows=value=>Array.isArray(value)?value:[];
const clean=(value,length=400)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f\[\]<>]/g,' ').trim().slice(0,length):'';
const cents=value=>Number.isFinite(value)&&value>=0&&value<=1?(100*value).toFixed(1)+'¢':null;
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const age=(value,now)=>now-Date.parse(value);
const fresh=(value,now,max)=>Number.isFinite(age(value,now))&&age(value,now)>=-5000&&age(value,now)<=max;
const dollars=value=>Number.isFinite(value)&&value>=0?'$'+value.toFixed(2):null;
const quantity=value=>new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(value);
const panelTool={analysis:'get_contract',rules:'get_contract',history:'get_price_history',evidence:'search_retained_evidence',
  execution:'analyze_execution_lab',sources:'get_source_status',paper:'get_contract'};
export const assistantPanels=Object.freeze(Object.keys(panelTool));

export function planResearchReadback(question,{panel,detail}={}){
  const intended=planAzureResearch(question).filter(tool=>tool!=='get_research');
  const quoteIntent=/\b(?:order book|bid|ask price|current quote|live quote|all-in entry|break-even)\b/i.test(question);
  const fullAnalysis=detail==='full'&&(!panel||['analysis','paper'].includes(panel));
  const supporting=[panelTool[panel],...intended,quoteIntent&&'get_contract',
    fullAnalysis&&'get_contract',fullAnalysis&&'search_retained_evidence'].filter(Boolean);
  return [...new Set(supporting)].slice(0,2).concat('get_research');
}

function publicSource(value){
  const url=safePublicURL(value);
  if(!url||url.length>1800)return null;
  const parsed=new URL(url);
  if(parsed.hostname==='api.spotify.com'||/(?:^|\/)(?:account|journal|portfolio|internal)(?:\/|$)/i.test(parsed.pathname)||
    [...parsed.searchParams.keys()].some(key=>/token|secret|password|api.?key|signature/i.test(key)))return null;
  return url;
}

const linkURL=url=>url.replaceAll('(','%28').replaceAll(')','%29');
const link=({url,label})=>'['+(clean(label,120)||new URL(url).hostname)+']('+linkURL(url)+')';

export function azureToolArguments(name,ticker,question,panel){
  if(name==='get_source_status')return {};
  if(name==='get_price_history')return {ticker,hours:/\b(?:week|7\s+days?|168\s+hours?)\b/i.test(question)?'168':'24'};
  if(name==='search_retained_evidence'){
    const query=panel==='evidence'&&/^explain the retained public reporting for /i.test(question)?
      (/^KX(?:NFL|NBA|EPL)/i.test(ticker)?'injury OR questionable OR availability OR lineup OR practice OR starter':
        'announced OR confirmed OR update OR results OR reported'):question.slice(0,300).trim();
    return {ticker,query:query.length>=3?query:'public evidence',limit:4};
  }
  return {ticker};
}

export function azureResearchPacket(name,result,ticker){
  if(result?.isError||!Array.isArray(result?.content)||result.content.length!==1||result.content[0]?.type!=='text')return null;
  const text=result.content[0].text;
  if(typeof text!=='string'||Buffer.byteLength(text)>14000)return null;
  try{
    const packet=JSON.parse(text);
    if(!packet||typeof packet!=='object'||Array.isArray(packet)||name!=='get_source_status'&&packet.ticker!==ticker)return null;
    if(name==='get_contract'&&packet.market?.ticker&&packet.market.ticker!==ticker)return null;
    return packet;
  }catch{return null;}
}

function contractFacts(contract,research,full){
  const market=contract?.market,primary=clean(contract?.rules?.primary||research?.rules?.primary,full?1800:500);
  const secondary=full&&clean(contract?.rules?.secondary||research?.rules?.secondary,700),yes=clean(market?.yes_sub_title,180);
  const settle=full&&date(market?.expected_expiration_time),close=date(market?.close_time||research?.rules?.close_time);
  const result=['yes','no'].includes(market?.result)?market.result.toUpperCase():null;
  const facts=[yes&&'YES outcome: '+yes+'.',primary&&'Primary settlement rule: '+primary,
    secondary&&'Secondary rule: '+secondary,close&&'Scheduled close: '+close+'.',
    settle&&'Expected expiration: '+settle+'.',result&&'Exchange result: '+result+'.'].filter(Boolean);
  const sources=rows(contract?.sources).filter(source=>source?.label==='Kalshi contract');
  const url=publicSource(sources[0]?.url);
  if(url)facts.push('Exchange rules: '+link({url,label:'Kalshi contract'}));
  const settlements=rows(research?.rules?.settlement_sources).flatMap(item=>{
    const url=publicSource(item?.url);
    return url?[{url,label:item.name||'Settlement publisher'}]:[];
  }).slice(0,full?3:1);
  if(settlements.length)facts.push('Published settlement data comes from '+settlements.map(link).join(', ')+'.');
  return facts.length?facts.join('\n\n'):'The exchange settlement rules were unavailable for this contract. Check its Rules tab before comparing estimates.';
}

function historyFacts(packet,full){
  const usable=rows(packet?.rows).filter(row=>row&&date(row.time)&&cents(row.price_usd_per_contract)!==null&&['last_trade','quoted_midpoint'].includes(row.value_kind))
    .sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  const newest=usable.at(-1);
  if(!newest)return 'The exchange did not return a usable candle close for the requested interval.';
  const label=newest.value_kind==='last_trade'?'last-trade candle close':'quoted-midpoint candle close';
  const parts=[`The latest returned YES ${label} was ${cents(newest.price_usd_per_contract)} per contract at ${date(newest.time)}.`];
  if(usable.length>1)parts.push(`The bounded tool response contains ${usable.length} observed closes from ${date(usable[0].time)}. Missing intervals are left blank.`);
  if(full){
    const first=usable.find(row=>row.value_kind===newest.value_kind);
    if(first!==newest){
      const change=100*(newest.price_usd_per_contract-first.price_usd_per_contract);
      parts.push(`Comparing like-for-like closes from ${date(first.time)}, the change was ${change>=0?'+':''}${change.toFixed(1)}¢ per contract.`);
    }
  }
  parts.push('These prices describe the exchange record. An independent outcome forecast requires separate evidence.');
  const url=publicSource(packet.source_url);
  if(url)parts.push(link({url,label:'Kalshi exchange candles'}));
  return parts.join(' ');
}

function quoteFacts(contract,now){
  const observed=contract?.book?.as_of,quotes=contract?.quotes;
  if(!fresh(observed,now,90000))return 'A current exchange book was unavailable for this answer. Refresh depth before comparing entry costs.';
  const asks=[['YES',quotes?.yes_ask_usd],['NO',quotes?.no_ask_usd]].flatMap(([side,price])=>cents(price)?[side+' '+cents(price)]:[]);
  if(!asks.length)return 'Neither side had a displayed ask in the latest book.';
  const book=rows(contract.sources).find(source=>source?.label==='Kalshi order book'),url=publicSource(book?.url);
  return 'Visible asks at '+date(observed)+' were '+asks.join(' and ')+' per contract before fees or depth-dependent fill costs.'+
    (url?' '+link({url,label:'Kalshi order book'}):'');
}

function paperFacts(research,ticker,now,full){
  return rows(research?.paper_scenarios).filter(row=>row?.ticker===ticker&&['YES','NO'].includes(row.side)&&fresh(row.quote_as_of,now,90000)&&
    Number.isFinite(row.contracts)&&row.contracts>0&&cents(row.break_even)&&dollars(row.cost)).slice(0,2).map(row=>{
    const breakdown=dollars(row.fee)?', including '+dollars(row.fee)+' in modeled fees':'';
    let line=`Paper ${row.side} uses ${dollars(row.cost)} for ${quantity(row.contracts)} contracts${breakdown}. The all-in break-even is ${cents(row.break_even)} per contract.`;
    if(full&&dollars(row.win_value)&&dollars(row.lose_value)){
      line+=` Ending paper balance from this scenario is ${dollars(row.win_value)} on a full payout and ${dollars(row.lose_value)} on a zero payout.`;
      if(row.partial_payout&&dollars(row.tie_value))line+=' The tie-payout balance is '+dollars(row.tie_value)+'.';
    }
    return line;
  });
}

function fullModelNotes(research,now){
  const forecast=research.forecast,checks=[];
  const reason=clean(forecast?.reason,450);
  const evidence=clean(forecast?.evidence?.label,130);
  if(evidence)checks.push('The evidence classification is '+evidence+'.');
  if(reason)checks.push(reason);
  const validation=forecast?.validation;
  if(validation?.passed===true)checks.push('The historical holdout passed its configured release check.');
  if(validation?.passed===false)checks.push('The historical holdout did not pass its configured release check.');
  if(Number.isSafeInteger(validation?.n)&&validation.n>0&&Number.isFinite(validation.brier)&&Number.isFinite(validation.baseline_brier)){
    checks.push(`Across ${quantity(validation.n)} held-out observations, the model Brier score was ${validation.brier.toFixed(4)} versus ${validation.baseline_brier.toFixed(4)} for its stated baseline. Lower is better.`);
  }
  if(cents(forecast?.outcomes?.tie)&&cents(forecast?.expected_settlement_value)&&fresh(forecast.source_as_of,now,86400000)){
    checks.push(`The model assigns ${(forecast.outcomes.tie*100).toFixed(1)}% to a tie. With the 50¢ tie payout, modeled YES settlement value averages ${cents(forecast.expected_settlement_value)} per contract.`);
  }
  const coverage=research.extensions?.sports?.coverage;
  if(coverage?.partial===true&&Number.isSafeInteger(coverage.schedules_returned)&&Number.isSafeInteger(coverage.schedules_expected)){
    checks.push(`The model saw ${coverage.schedules_returned} of ${coverage.schedules_expected} expected schedule sources.`);
  }
  const assumptions=research.decision?.assumptions;
  if(assumptions&&Number.isFinite(assumptions.uncertainty_buffer)&&cents(assumptions.uncertainty_buffer)){
    checks.push('The screen requires an extra '+cents(assumptions.uncertainty_buffer)+' per contract beyond modeled entry cost at the conservative bound.');
  }
  const feeNote=clean(assumptions?.fee_note,280);
  if(feeNote)checks.push(feeNote);
  const reasonSet=new Set([research.opinion?.reason,reason].filter(Boolean));
  for(const item of rows(research.decision?.reasons).slice(0,4)){
    const detail=clean(item,420);
    if(detail&&!reasonSet.has(detail)){checks.push(detail);reasonSet.add(detail);}
  }
  const sourceLimit=Number.isFinite(forecast?.max_source_age_seconds)?Math.max(10,Math.min(86400,forecast.max_source_age_seconds))*1000:86400000;
  if(cents(forecast?.probability)===null||!fresh(forecast.source_as_of,now,sourceLimit)){
    checks.push('What would change the read? A fresh independent estimate for the exact outcome and an executable quote with enough depth.');
  }else if(research.opinion?.side==='PASS'){
    checks.push('What would change the read? Recheck after an independent update shifts the conservative range or the quoted entry becomes cheaper. Both checks still need to pass.');
  }
  return checks;
}

function executionDetails(packet,now){
  if(!fresh(packet?.as_of,now,90000)||packet?.version!=='execution-research-v1'||!packet.schedule||!packet.controls)return [];
  const schedule=packet.schedule,settings=packet.controls;
  const tools=[['Order-flow imbalance',settings.order_flow],['Quote-arrival clustering',settings.arrival_clustering],
    ['Inventory skew',settings.inventory_skew],['Optimized schedule',settings.optimal_schedule]];
  const toggles=tools.filter(([,enabled])=>typeof enabled==='boolean').map(([name,enabled])=>name+' '+(enabled?'on':'off'));
  const facts=toggles.length?['Submitted controls. '+toggles.join(', ')+'.']:[],first=schedule.rows?.[0];
  if(schedule.available!==false&&Number.isFinite(first?.contracts)&&Number.isFinite(first?.interval_end_seconds)){
    facts.push(`The first modeled slice is ${quantity(first.contracts)} contracts over ${quantity(first.interval_end_seconds)} seconds. The immediate fill estimate still comes from the observed book.`);
  }
  if(Number.isFinite(schedule.risk_variance)&&Number.isFinite(schedule.benchmark_twap?.risk_variance)){
    facts.push(`Modeled inventory-risk variance is ${quantity(schedule.risk_variance)} USD² versus ${quantity(schedule.benchmark_twap.risk_variance)} USD² for equal slices.`);
  }
  return facts;
}

function coverageFacts(packet,full){
  if(!packet)return 'Public source status could not be read.';
  const providers=rows(packet.providers).filter(row=>row?.name&&row?.status&&!/spotify catalog/i.test(row.name)).slice(0,full?10:5)
    .map(row=>clean(row.name,80)+' is '+clean(row.status,60).replaceAll('_',' ')+'.'+(full&&row.detail?' '+clean(row.detail,220):''));
  const data=packet.warehouse;
  if(data?.configured===true){
    const counts=[['market_observations','market observations'],['source_observations','source observations'],['completed_games','completed games']]
      .filter(([key])=>Number.isSafeInteger(data[key])&&data[key]>=0).map(([key,label])=>data[key].toLocaleString('en-US')+' '+label);
    if(counts.length)providers.push('Warehouse coverage: '+counts.join(', ')+'.');
    const latest=date(data.latest_ingestion);
    if(latest)providers.push('Latest recorded ingestion: '+latest+'.');
  }else providers.push('Warehouse coverage is unavailable.');
  return providers.join('\n\n');
}

function evidenceRows(packet,ticker,now){
  const unique=new Set();
  return rows(packet?.citations).flatMap(row=>{
    const url=publicSource(row?.url);
    const label=clean(row?.title||row?.publisher,140),text=clean(row?.text,440);
    if(!url||unique.has(url)||row?.ticker!==ticker||!label||!text||!date(row.expires_at)||Date.parse(row.expires_at)<=now||
      !date(row.retrieved_at)||Date.parse(row.retrieved_at)>now+300000)return [];
    unique.add(url);
    return [{url,label,text,at:date(row.published_at)||date(row.retrieved_at),timeLabel:date(row.published_at)?'published':'retrieved'}];
  }).slice(0,4);
}

function attributedReports(research,full){
  const seen=new Set();
  return rows(research?.evidence).flatMap(item=>{
    const url=publicSource(item?.url),label=clean(item?.title,140),excerpt=clean(item?.excerpt,full?300:180);
    if(!url||!label||seen.has(url))return [];
    seen.add(url);
    return [(item.match_scope==='matched'?'Matched report':item.match_scope==='related'?'Related context':'Attributed report')+
      '. '+link({url,label})+(excerpt?' '+excerpt:'')];
  }).slice(0,full?3:2);
}

export async function azureResearchAnswer({question,ticker,panel,detail,executionControls,packets,tools,explain,authorize,signal,env,foundryFetcher,now=Date.now()}){
  const research=packets.get('get_research'),contract=packets.get('get_contract');
  const wants=tool=>tools.includes(tool);
  const current=research&&fresh(research.as_of,now,90000),parts=[],full=detail==='full',guided=Boolean(panel||full);
  const title=clean(contract?.market?.title||research?.title,160);
  if(guided&&title)parts.push(title+' ('+ticker+')');
  const side=current&&['YES','NO','PASS'].includes(research.opinion?.side)?research.opinion.side:null;
  const verdict=side?'Research screen: '+side+'. '+(side==='PASS'?'Supported allocation: 0 contracts. ':'')+clean(research.opinion.reason,450):null;
  if(guided&&verdict)parts.push(verdict);
  if(wants('get_contract'))parts.push(contractFacts(contract,research,full));
  if(wants('get_contract')&&(panel==='paper'||full&&panel!=='rules'||/\b(?:order book|bid|ask price|current quote|live quote|all-in entry|break-even)\b/i.test(question))){
    parts.push(quoteFacts(contract,now));
  }
  if(wants('analyze_execution_lab')){
    const execution=packets.get('analyze_execution_lab');
    const matches=!executionControls||execution?.controls&&Object.entries(executionControls).every(([name,value])=>execution.controls[name]===value);
    parts.push(matches?explain.execution(execution,ticker,now):
      'The execution packet did not match the submitted settings. Rerun the current settings in Execution lab to refresh it.');
    if(full&&matches)parts.push(...executionDetails(execution,now));
  }
  if(wants('get_price_history'))parts.push(historyFacts(packets.get('get_price_history'),full));
  if(wants('get_source_status'))parts.push(coverageFacts(packets.get('get_source_status'),full));
  if(!current){
    parts.push('Fresh independent research is unavailable for the selected contract. Its current recommendation and probability have not been verified.');
  }else{
    const signalData=research.market_signal;
    const validSignal=signalData?.status==='available'&&fresh(signalData.observed_at,now,180000)&&
      cents(signalData.prediction)!==null&&cents(signalData.last_midpoint)!==null;
    const forecast=research.forecast;
    const validForecast=cents(forecast?.probability)!==null&&(!forecast.outcomes||
      cents(forecast.outcomes.tie)!==null&&cents(forecast.expected_settlement_value)!==null);
    const interval=value=>rows(value).length===2&&value.every(row=>cents(row)!==null)?value:null;
    const packet={...research,evidence:[],paper_scenarios:rows(research.paper_scenarios).filter(Boolean),
      decision:{candidates:rows(research.decision?.candidates).filter(Boolean)},
      forecast:validForecast?{...forecast,interval:interval(forecast.interval)}:null,
      market_signal:validSignal?{...signalData,interval:interval(signalData.interval)}:null};
    const math=/\b(?:range|probabilit(?:y|ies)|confidence|costs?|fees?|allocation|position size)\b/i.test(question);
    if(math||full&&(!panel||['analysis','paper'].includes(panel))){
      const result=explain.math(guided?{...packet,opinion:null}:packet,ticker,now);
      parts.push(result);
    }else if(!wants('analyze_execution_lab')&&!wants('get_source_status')&&(!panel||panel==='analysis')){
      const result=explain.contract({...packet,paper_scenarios:guided?[]:packet.paper_scenarios,rules:wants('get_contract')?null:packet.rules},ticker,now);
      parts.push(guided&&title?result.split('\n\n').slice(1).join('\n\n'):result);
    }
    if(panel==='paper'||panel==='analysis'||full&&!panel){
      const comparison=paperFacts(research,ticker,now,full);
      if(comparison.length)parts.push(...comparison);
      else if(panel==='paper')parts.push('No fresh paper fill was returned for either side at the reference budget.');
    }
    if(full&&(!panel||['analysis','paper','evidence'].includes(panel))){
      const notes=fullModelNotes(research,now);
      if(notes.length)parts.push('Model checks and what could change the view',...notes);
    }
    if(!guided&&verdict&&!parts.some(part=>part.includes('Research screen: '+side)))parts.push(verdict);
  }
  if(/\b(?:buy how many|how many (?:contracts|should)|how much (?:should|to) (?:buy|spend|put)|size (?:this|my)|position size)\b/i.test(question)){
    parts.push('For a paper size, enter your own probability range and budget in Paper position. The assistant does not have your account balance or permission to place an order.');
  }
  let mode='azure-deterministic';
  if(wants('search_retained_evidence')){
    const retained=packets.get('search_retained_evidence'),evidence=evidenceRows(retained,ticker,now);
    if(evidence.length){
      const ranked=await rankAzureEvidence({question,snippets:evidence.map(row=>row.label+' '+row.text),authorize,signal},{env,fetcher:foundryFetcher});
      if(ranked.mode==='azure-foundry')mode=ranked.mode;
      parts.push(full?'Retained public evidence for this contract. Search ranks show relevance to the question. Each result keeps its publication or retrieval date.':
        'Retained public evidence for this contract. Retrieval order indicates relevance.');
      for(const index of ranked.order){
        const row=evidence[index];
        parts.push(link(row)+' ('+row.timeLabel+' '+row.at+'). '+(full?row.text:row.text.slice(0,220)));
      }
    }else{
      const reports=current?attributedReports(research,full):[];
      if(reports.length){
        parts.push('The retained search returned no usable excerpts. The research check returned these public report links. Open the sources to check publication dates.',...reports);
      }else if(retained)parts.push('No matching retained public evidence was available. Use Load contract news to collect evidence before asking again.');
      else parts.push('The retained evidence search did not complete. Use Load contract news or try the search again.');
    }
  }
  const cited=new Map();
  for(const packet of packets.values())for(const item of rows(packet?.sources)){
    const url=publicSource(item?.url);
    if(url&&cited.size<5&&!parts.some(part=>part.includes(']('+linkURL(url)+')')))cited.set(url,{url,label:item?.label});
  }
  if(cited.size)parts.push('Sources checked: '+[...cited.values()].map(link).join(', '));
  return {answer:parts.filter(Boolean).join('\n\n'),mode};
}
