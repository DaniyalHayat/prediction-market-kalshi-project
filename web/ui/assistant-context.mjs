const prompts={
  analysis:['Analysis','Explain the research view for','Identify the evidence, model assumptions, entry-cost screen and strongest uncertainty.'],
  history:['Exchange price history','Explain the exchange price history for','Describe the observed candle closes, time window and gaps. Distinguish quotes from trades and an outcome forecast.'],
  rules:['Settlement rules','Explain the settlement rules for','State the exact condition for YES, the settlement source and any timing or ambiguous cases.'],
  sources:['Source records','Explain the source coverage for','Identify the authoritative settlement source and say which provider or warehouse coverage gaps matter here.'],
  evidence:['Contract news','Explain the retained public reporting for','Compare the best-matched reports, their source dates and material limitations. Call out missing or conflicting evidence if present.'],
  paper:['Paper position','Explain the paper-position method for','Describe how depth, fees and the probability range affect hypothetical entry and break-even. Use public inputs only.'],
  execution:['Execution lab','Explain the execution lab for','Compare the submitted paper scenario with the even-paced schedule, including costs, observed depth and limits.'],
};

export function assistantContext(panel,ticker,{detail='brief',result,prepare,evidence}={}){
  const prompt=prompts[panel];
  if(!prompt)return null;
  const [label,prefix,instruction]=prompt;
  if(result&&(panel!=='execution'||result.ticker!==ticker||!result.controls))return null;
  const executionControls=result?.controls;
  const timestamp=result?.book_as_of||result?.as_of;
  const submitted=executionControls
    ?` Submitted scenario: ${executionControls.action} ${executionControls.side.toUpperCase()}, ${executionControls.contracts} contracts over ${executionControls.horizon_seconds} seconds.${Number.isFinite(Date.parse(timestamp))?' The result used depth observed at '+new Date(timestamp).toISOString()+'.':''}`
    :'';
  return {panel,detail,label:executionControls?'Submitted execution scenario':label,executionControls,prepare,evidence,
    question:`${prefix} ${ticker}.${submitted} ${instruction}`};
}

export function assistantPayload(ticker,model,messages,launch){
  return {ticker,model,messages,...(launch?.panel?{panel:launch.panel,detail:launch.detail}:{}),
    ...(launch?.executionControls?{execution_controls:launch.executionControls}:{})};
}
