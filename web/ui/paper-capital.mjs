export function paperCapital(ledger,startingBalance) {
  if(!Number.isFinite(startingBalance)||startingBalance<=0||!Array.isArray(ledger?.positions))throw new RangeError('A positive simulated starting balance and loaded paper ledger are required');
  let committed=0,realized=0;
  for(const position of ledger.positions){
    if(!Number.isFinite(position.remaining_basis)||position.remaining_basis<0||!Number.isFinite(position.realized_pnl))throw new RangeError('The retained paper ledger contains invalid cash amounts');
    committed+=position.remaining_basis;realized+=position.realized_pnl;
  }
  if(!Number.isFinite(committed)||!Number.isFinite(realized))throw new RangeError('The paper ledger exceeds supported cash amounts');
  const balance=startingBalance+realized-committed;
  if(!Number.isFinite(balance)||Math.abs(balance)>1e12)throw new RangeError('The paper ledger exceeds supported cash amounts');
  const available=Math.round(balance*1e10)/1e10;
  return {startingBalance,committed,realized,available:Math.max(0,available),shortfall:Math.max(0,-available)};
}
