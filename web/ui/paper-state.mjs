export const PAPER_STORAGE='kalshi-market-lab:paper-journal:v1';
export const PAPER_BALANCE='kalshi-market-lab:paper-starting-balance:v1';
export const PAPER_EVENT='kalshi-market-lab:paper-updated';
export const PAPER_LOCK='kalshi-market-lab:paper-write';
export function readStartingBalance(value){const number=Number(value);return Number.isFinite(number)&&number>0&&number<=1e9?number:1000;}
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
  try{const stored=storage.getItem(PAPER_STORAGE);if(stored!==null)current=engine.readLedger(stored);}catch{}
  if(!current)current=engine.emptyLedger();
  const balance=readStartingBalance(storage.getItem(PAPER_BALANCE));
  const next=updater(current,balance);
  if(!next||next.version!==1||!Array.isArray(next.positions)||!Array.isArray(next.trades))throw new RangeError('The paper ledger update is invalid');
  storage.setItem(PAPER_STORAGE,JSON.stringify(next));return next;
}
