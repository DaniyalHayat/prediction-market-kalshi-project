import '../../public/dashboard/paper.js';

const round=value=>Math.round(value*1e10)/1e10;
const fee=value=>Math.max(0,Math.ceil((value-1e-10)*100)/100);
export function executionCurve(book,ticker,side,action,{coefficient=.07,slippage=2,now=Date.now()}={}) {
  if(!['yes','no'].includes(side)||!['buy','sell'].includes(action)||!Number.isFinite(coefficient)||coefficient<0||coefficient>1||!Number.isFinite(slippage)||slippage<0||slippage>100)throw new RangeError('Invalid execution assumptions');
  const checked=globalThis.PredictirPaper.checkedBook(book,ticker,{now});
  const own=side==='yes'?checked.yes:checked.no,other=side==='yes'?checked.no:checked.yes;
  const raw=action==='buy'?other.map(level=>({price:round(1-level.price),quantity:level.quantity})).sort((a,b)=>a.price-b.price):own;
  const best=raw[0]?.price??null,limit=best===null?null:Math.max(0,Math.min(1,best+(action==='buy'?1:-1)*slippage/100));
  const levels=raw.filter(level=>action==='buy'?level.price<=limit+1e-10:level.price>=limit-1e-10);
  const quantities=[0],notionals=[0],fees=[0];
  for(const level of levels){quantities.push(quantities.at(-1)+level.quantity);notionals.push(notionals.at(-1)+level.quantity*level.price);fees.push(fees.at(-1)+fee(coefficient*level.quantity*level.price*(1-level.price)));}
  function quote(requested) {
    if(!Number.isFinite(requested)||requested<0||requested>1e6)throw new RangeError('Invalid contract quantity');
    const filled=Math.min(requested,quantities.at(-1));let low=0,high=levels.length;
    while(low<high){const middle=(low+high)>>1;if(quantities[middle+1]<filled-1e-10)low=middle+1;else high=middle;}
    const index=low,take=Math.max(0,filled-quantities[index]),level=levels[index];
    const notional=(notionals[index]||0)+(level?take*level.price:0),charge=(fees[index]||0)+(level?fee(coefficient*take*level.price*(1-level.price)):0);
    return {requested,filled:round(filled),unfilled:round(Math.max(0,requested-filled)),notional:round(notional),fee:round(charge),cash:round(action==='buy'?notional+charge:notional-charge),vwap:filled?notional/filled:null,complete:requested-filled<1e-8};
  }
  return {quote,best,limit,available:quantities.at(-1),levels:levels.length,as_of:checked.asOf};
}

export function affordableQuantity(curve,budget,maximum=10000) {
  if(!Number.isFinite(budget)||budget<0||!Number.isInteger(maximum)||maximum<1||maximum>10000)throw new RangeError('Invalid budget or sizing limit');
  let low=0,high=Math.min(maximum,Math.floor(curve.available));
  while(low<high){const middle=Math.ceil((low+high)/2);if(curve.quote(middle).cash<=budget+1e-9)low=middle;else high=middle-1;}
  return low;
}

export function riskConstrainedSize(curve,{bankroll,budget,probabilityLow,drawdownFloor=.8,drawdownProbability=.1,maximum=10000}={}) {
  if(![bankroll,budget,probabilityLow,drawdownFloor,drawdownProbability].every(Number.isFinite)||bankroll<=0||budget<=0||probabilityLow<0||probabilityLow>1||drawdownFloor<=0||drawdownFloor>=1||drawdownProbability<=0||drawdownProbability>=1)throw new RangeError('Invalid risk assumptions');
  const lambda=Math.log(drawdownProbability)/Math.log(drawdownFloor),cap=affordableQuantity(curve,Math.min(budget,bankroll*(1-1e-9)),maximum);
  let best={contracts:0,cost:0,expected_log_growth:0,drawdown_moment:1};
  for(let quantity=1;quantity<=cap;quantity++){
    const cost=curve.quote(quantity).cash,win=(bankroll-cost+quantity)/bankroll,lose=(bankroll-cost)/bankroll;
    const moment=probabilityLow*Math.pow(win,-lambda)+(1-probabilityLow)*Math.pow(lose,-lambda);
    const growth=probabilityLow*Math.log(win)+(1-probabilityLow)*Math.log(lose);
    if(moment<=1+1e-10&&growth>best.expected_log_growth+1e-12)best={contracts:quantity,cost,expected_log_growth:growth,drawdown_moment:moment};
  }
  return {...best,lambda,drawdown_floor:drawdownFloor,drawdown_probability:drawdownProbability,
    scope:'Discrete worst-case log-growth size with a Kelly drawdown-moment constraint. The repeated-wealth bound assumes correct stationary probabilities and repeated independent opportunities; it is not an empirical drawdown guarantee.'};
}
