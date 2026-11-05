export const PAPER_STORAGE='kalshi-market-lab:paper-journal:v1';
export const PAPER_BALANCE='kalshi-market-lab:paper-starting-balance:v1';
export const PAPER_EVENT='kalshi-market-lab:paper-updated';
export const PAPER_LOCK='kalshi-market-lab:paper-write';
export function readStartingBalance(value){const number=Number(value);return Number.isFinite(number)&&number>0&&number<=1e9?number:DEFAULT_PAPER_BALANCE;}
export function initializePaperAccount(ledger){
  return Number.isFinite(ledger.starting_balance)&&ledger.starting_balance>0?ledger:{...ledger,starting_balance:DEFAULT_PAPER_BALANCE,cash_movements:[]};
}
export function adjustPaperCash(ledger,action,amount,{id,time=new Date().toISOString()}={}){
  const current=initializePaperAccount(ledger);
  if(!['add','decrease'].includes(action)||!Number.isFinite(amount)||amount<=0||amount>1e9||Math.abs(amount*100-Math.round(amount*100))>1e-5)throw new RangeError('Enter an amount between $0.01 and $1,000,000,000, with at most two decimal places.');
  if(!id||current.cash_movements?.some(row=>row.id===id)||!Number.isFinite(Date.parse(time)))throw new RangeError('A unique dated cash adjustment is required.');
  if((current.cash_movements?.length||0)>=5000)throw new RangeError('Export this paper account before recording more cash adjustments.');
  const capital=paperCapital(current,current.starting_balance);
  if(action==='decrease'&&amount>capital.available+1e-8)throw new RangeError('You can only decrease available paper cash. Close positions first to release committed funds.');
  const next={...current,cash_movements:[...(current.cash_movements||[]),{id,action,amount:Math.round(amount*100)/100,occurred_at:time}]};
  paperCapital(next,next.starting_balance);return next;
}
export function portfolioTickers(positions){return [...new Set((positions||[]).filter(row=>row.remaining_quantity>1e-8&&/^[A-Za-z0-9_.-]{1,140}$/.test(row.ticker||'')).map(row=>row.ticker))].sort().slice(0,20);}
export function attachEntryContext(ledger,id,{probability,interval,source='subjective',model=null,as_of=null}={}){
  if(!Number.isFinite(probability)||probability<0||probability>1||!Array.isArray(interval)||interval.length!==2||
    !interval.every(Number.isFinite)||interval[0]<0||interval[0]>probability||interval[1]<probability||interval[1]>1)return ledger;
  return {...ledger,positions:ledger.positions.map(row=>row.id===id?{...row,entry_probability:probability,entry_interval:[...interval],
    entry_probability_source:['model_scenario','experimental_model'].includes(source)?source:'subjective',entry_model:typeof model==='string'?model.slice(0,160):null,
    entry_forecast_as_of:typeof as_of==='string'&&Number.isFinite(Date.parse(as_of))?as_of:null}:row)};
}
export function updateStoredLedger(engine,storage,updater,fallback){
  let current=fallback;
  const stored=storage.getItem(PAPER_STORAGE);if(stored!==null)current=engine.readLedger(stored);
  if(!current)current=engine.emptyLedger();
  current=initializePaperAccount(current);
  const balance=current.starting_balance;
  const next=updater(current,balance);
  if(!next||next.version!==1||!Array.isArray(next.positions)||!Array.isArray(next.trades))throw new RangeError('The paper ledger update is invalid');
  storage.setItem(PAPER_STORAGE,JSON.stringify(next));return next;
}
import {paperCapital} from './paper-capital.mjs';
export const DEFAULT_PAPER_BALANCE=20000;
