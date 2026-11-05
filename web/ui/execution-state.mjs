import {api} from './api.mjs';

export const EXECUTION_DEFAULTS=Object.freeze({enabled:true,side:'yes',action:'buy',contracts:20,horizon_seconds:300,steps:12,
  risk_aversion:.001,temporary_impact:.0001,volatility:.02,inventory:0,order_flow:true,arrival_clustering:true,inventory_skew:true,optimal_schedule:true});
export const EXECUTION_FEATURES=Object.freeze([
  {key:'order_flow',title:'Order-flow pressure',description:'Compare consecutive book events to measure changes in buying and selling pressure.'},
  {key:'arrival_clustering',title:'Arrival clustering',description:'Fit event clustering and compare it with a constant-rate arrival model.'},
  {key:'inventory_skew',title:'Inventory-aware quotes',description:'Move the model’s reservation quote as inventory and price risk change.'},
  {key:'optimal_schedule',title:'Risk-aware schedule',description:'Balance assumed market impact against the risk of waiting to finish.'}
]);
const fields=Object.keys(EXECUTION_DEFAULTS);
export function executionControls(value=EXECUTION_DEFAULTS){
  const result=Object.fromEntries(fields.map(key=>[key,value[key]??EXECUTION_DEFAULTS[key]]));
  if(!['yes','no'].includes(result.side)||!['buy','sell'].includes(result.action))throw new RangeError('Choose a valid side and action.');
  for(const key of ['enabled',...EXECUTION_FEATURES.map(row=>row.key)])if(typeof result[key]!=='boolean')throw new RangeError('Choose a valid model setting.');
  for(const key of ['contracts','horizon_seconds','steps','risk_aversion','temporary_impact','volatility','inventory']){
    if(!['number','string'].includes(typeof result[key]))throw new RangeError('Scenario assumptions must be finite numbers.');
    if(typeof result[key]==='string'&&!result[key].trim())throw new RangeError('Complete every scenario assumption.');
    result[key]=Number(result[key]);if(!Number.isFinite(result[key]))throw new RangeError('Scenario assumptions must be finite numbers.');
  }
  return result;
}
export function executionFingerprint(controls){return JSON.stringify(executionControls(controls));}
export async function requestExecution(ticker,controls,{signal,transport=api,model='validated'}={}){
  const value=await transport('/api/workspace/execution-research',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({ticker,controls:executionControls(controls),model})});
  if(value?.ticker!==ticker)throw new Error('The execution result belongs to a different contract. Run this contract again.');
  return value;
}
