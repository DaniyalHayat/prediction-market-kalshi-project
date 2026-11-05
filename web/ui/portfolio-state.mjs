export function acceptPortfolioBook(previous,value,tickers,now=Date.now()){
  const timestamp=Date.parse(value?.as_of);
  if(!tickers.includes(value?.ticker)||!Number.isFinite(timestamp)||timestamp>now+5000||!value?.raw?.orderbook_fp)return previous;
  if(previous&&timestamp<Date.parse(previous.as_of))return previous;
  return value;
}
export function portfolioTotals(ledger,evaluations){
  if(!ledger)return {realized:0,unrealized:null,marked_value:null,open_basis:0,fully_marked:false,open_count:0};
  const open=ledger.positions.filter(row=>row.remaining_quantity>1e-8),realized=ledger.positions.reduce((sum,row)=>sum+row.realized_pnl,0);
  const complete=open.every(row=>['live','settled'].includes(evaluations[row.id]?.status)&&Number.isFinite(evaluations[row.id].marked_value)&&Number.isFinite(evaluations[row.id].unrealized_pnl));
  return {realized,open_basis:open.reduce((sum,row)=>sum+row.remaining_basis,0),open_count:open.length,fully_marked:complete,
    marked_value:complete?open.reduce((sum,row)=>sum+evaluations[row.id].marked_value,0):null,
    unrealized:complete?open.reduce((sum,row)=>sum+evaluations[row.id].unrealized_pnl,0):null};
}
