const publicURL=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
function fourMonthsEarlier(now){const d=new Date(now),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-4);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));return d.getTime();}
export function analyzePublicTraderEvidence(rows,{now=Date.now(),limit=30}={}){
  if(!Array.isArray(rows)||rows.length>100000||!Number.isInteger(limit)||limit<1||limit>30)throw new RangeError('Use at most 100,000 public closed-trade records and a top-30 limit');
  const seen=new Set(),accepted=[],rejected=[];
  for(const [index,row] of rows.entries()){
    const fields=['quantity','entry_price','entry_fee','exit_fee','cash_received'];
    const opened=Date.parse(row.opened_at),closed=Date.parse(row.closed_at),url=publicURL(row.source_url);
    const key=String(row.provider||'')+'#'+String(row.trade_id||'');
    if(row.public!==true||typeof row.trader!=='string'||!row.trader.trim()||!url||!row.trade_id||seen.has(key)||!fields.every(k=>Number.isFinite(row[k]))||row.quantity<=0||row.entry_price<0||row.entry_price>1||row.entry_fee<0||row.exit_fee<0||row.cash_received<0||row.cash_received>row.quantity+1e-8||!Number.isFinite(opened)||!Number.isFinite(closed)||opened>closed||closed>now||!['yes','no'].includes(row.side)){
      rejected.push({index,reason:'Missing public provenance, duplicate identity, invalid closed-trade cash flow, or inconsistent timestamps.'});continue;
    }
    seen.add(key);const cost=row.quantity*row.entry_price+row.entry_fee,pnl=row.cash_received-row.exit_fee-cost;
    accepted.push({...row,cost,pnl,source_url:url});
  }
  const windows=[['all_observed',-Infinity],['last_7_days',now-7*86400000],['last_4_calendar_months',fourMonthsEarlier(now)]];
  const results=Object.fromEntries(windows.map(([name,start])=>{
    const grouped=new Map();
    for(const row of accepted.filter(r=>Date.parse(r.closed_at)>=start)){
      if(!grouped.has(row.trader))grouped.set(row.trader,{trader:row.trader,trades:0,net_pnl:0,entry_cost:0,total_fees:0,wins:0,largest_profit:0,categories:{},sources:new Set()});
      const g=grouped.get(row.trader);g.trades++;g.net_pnl+=row.pnl;g.entry_cost+=row.cost;g.total_fees+=row.entry_fee+row.exit_fee;g.wins+=Number(row.pnl>0);g.largest_profit=Math.max(g.largest_profit,row.pnl);g.categories[row.category||'unknown']=(g.categories[row.category||'unknown']||0)+1;g.sources.add(row.source_url);
    }
    return [name,[...grouped.values()].sort((a,b)=>b.net_pnl-a.net_pnl).slice(0,limit).map(g=>({...g,sources:[...g.sources],win_rate:g.wins/g.trades,
      pnl_per_entry_dollar:g.entry_cost?g.net_pnl/g.entry_cost:null,largest_profit_share:g.net_pnl>0?g.largest_profit/g.net_pnl:null,
      interpretation:'Observed closed-trade sample only. Entry-dollar return is turnover-based, not capital ROI. Trade motives, unobserved hedges and account-wide results are unknown.'}))];
  }));
  return {as_of:new Date(now).toISOString(),accepted:accepted.length,rejected,rankings:results,
    scope:'Top observed public records within this supplied dataset, not an official Kalshi all-time ranking. Private profiles and missing histories are never reconstructed.',
    hypothesis_tests:['Compare specialization across categories after controlling for sample size.','Measure how concentrated reported gains are in the largest winning trade.','Reprice observed entries using delayed executable asks and fees before any copy-trading hypothesis.'],
    model_use:'Exploratory hypotheses only; these records do not train outcome probabilities or prove why a trader chose an entry.'};
}
