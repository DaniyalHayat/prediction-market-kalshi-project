export type DepthLevel = { price: number; quantity: number };
export type SizingInput = {
  ticker: string; quoteTicker: string; asOf: string; bankroll: number; budget: number;
  probabilityLow: number; probabilityHigh: number; levels: DepthLevel[];
  riskFraction: number; feeCoefficient?: number; maxContracts?: number;
};

export function sizePaperPosition(input: SizingInput, now = Date.now()) {
  const {bankroll, budget, probabilityLow: p, probabilityHigh, riskFraction} = input;
  const age = now - Date.parse(input.asOf);
  if (!input.ticker || input.ticker !== input.quoteTicker || !Number.isFinite(age) || age < -5000 || age > 90000)
    throw new RangeError('A matching quote under 90 seconds old is required');
  if (![bankroll,budget,p,probabilityHigh,riskFraction].every(Number.isFinite) || bankroll <= 0 || budget <= 0 ||
      p < 0 || probabilityHigh > 1 || p > probabilityHigh || riskFraction <= 0 || riskFraction >= 1)
    throw new RangeError('Review bankroll, budget, probability bounds and risk fraction');
  const fee = input.feeCoefficient ?? .07, maximum = input.maxContracts ?? 10000;
  if (!Number.isFinite(fee) || fee < 0 || fee > 1 || !Number.isInteger(maximum) || maximum < 1 || maximum > 10000)
    throw new RangeError('Invalid fee or contract limit');
  if (!Array.isArray(input.levels) || input.levels.length > 1000 || input.levels.some(l =>
      !Number.isFinite(l.price) || l.price <= 0 || l.price >= 1 || !Number.isFinite(l.quantity) || l.quantity < 0))
    throw new RangeError('Invalid ask depth');
  const levels = [...input.levels].sort((a,b) => a.price-b.price);
  const cap = Math.min(budget,bankroll*riskFraction), initial = Math.log(bankroll);
  let best = {contracts:0,cost:0,expectedLogGrowth:0}, spent=0, remaining=levels[0]?.quantity ?? 0, level=0, fees=0;
  const feeBases=levels.map(()=>0),roundedFee=(value:number)=>Math.ceil((value-1e-12)*100)/100;
  for (let q=1;q<=maximum;q++) {
    let needed=1;
    while (needed>1e-9 && level<levels.length) {
      const quantity=Math.min(needed,remaining), price=levels[level].price;
      spent+=quantity*price;
      const before=roundedFee(feeBases[level]);feeBases[level]+=quantity*price*(1-price)*fee;
      fees+=roundedFee(feeBases[level])-before;needed-=quantity;remaining-=quantity;
      if (remaining<1e-9) {level++;remaining=levels[level]?.quantity ?? 0;}
    }
    if (needed>1e-9) break;
    const cost=spent+fees;
    if (cost>cap+1e-9) break;
    const growth=p*Math.log(bankroll+q-cost)+(1-p)*Math.log(bankroll-cost)-initial;
    if (growth>best.expectedLogGrowth+1e-12) best={contracts:q,cost,expectedLogGrowth:growth};
  }
  return {...best,ticker:input.ticker,quoteAsOf:input.asOf,probabilityLow:p,probabilityHigh,
    classification:'SIMULATED',criterion:'Maximum worst-case expected log wealth over the supplied probability interval and visible ask depth',
    limitations:'Conditional on supplied probabilities, fees and static liquidity. No calibrated trading edge, actual fill or real-world optimality is established.'};
}
