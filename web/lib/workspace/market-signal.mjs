const clamp=value=>Math.max(0,Math.min(1,value));
const mean=values=>values.reduce((total,value)=>total+value,0)/values.length;
const quantile=(sorted,p)=>sorted[Math.floor(p*(sorted.length-1))];
const intervalMs=60_000;
const loss=(rows,key)=>mean(rows.map(row=>(row.price-row[key])**2));

export function marketSignal(history,now=Date.now()){
  const unique=new Map();
  for(const row of history?.rows||[]){
    const time=Date.parse(row.time),value=row.midpoint??(row.value_kind==='quoted_midpoint'?row.value:null);
    if(Number.isFinite(time)&&time<=now&&Number.isFinite(value)&&value>=0&&value<=1)unique.set(time,value);
  }
  const points=[...unique].sort(([a],[b])=>a-b),latest=points.at(-1);
  const unavailable=reason=>({status:'unavailable',reason,observations:points.length});
  if(!latest||now-latest[0]>3*intervalMs)return unavailable('A recent two-sided minute quote is required for the price-path model.');
  let drift=0;
  const records=[];
  for(let i=1;i<points.length;i++){
    const [time,price]=points[i],[previous,prior]=points[i-1];
    if(time-previous!==intervalMs){drift=0;continue;}
    records.push({price,prior,candidate:clamp(prior+drift)});
    drift=.2*Math.max(-.1,Math.min(.1,price-prior))+.8*drift;
  }
  if(records.length<60)return unavailable('At least 60 adjacent minute quotes are needed to separate calibration and replay.');
  const selectionEnd=Math.floor(records.length*.5),calibrationEnd=Math.floor(records.length*.8);
  const selection=records.slice(0,selectionEnd),calibration=records.slice(selectionEnd,calibrationEnd),test=records.slice(calibrationEnd);
  const improved=loss(selection,'candidate')<loss(selection,'prior'),key=improved?'candidate':'prior';
  const predict=clamp(latest[1]+(improved?drift:0));
  const error=calibration.map(row=>row.price-row[key]).sort((a,b)=>a-b);
  const [low,high]=[quantile(error,.1),quantile(error,.9)];
  const coverage=mean(test.map(row=>{
    const residual=row.price-row[key];
    return Number(residual>=low&&residual<=high);
  }));
  return {status:'available',model:improved?'Clipped exponentially weighted quote drift':'Quote persistence',horizon_seconds:60,
    prediction:predict,interval:[clamp(Math.min(predict,predict+low)),clamp(Math.max(predict,predict+high))],last_midpoint:latest[1],
    observed_at:new Date(latest[0]).toISOString(),source_url:history.source_url,observations:points.length,
    replay:{selection_n:selection.length,calibration_n:calibration.length,replay_n:test.length,model_rmse:Math.sqrt(loss(test,key)),
      drift_rmse:Math.sqrt(loss(test,'candidate')),persistence_rmse:Math.sqrt(loss(test,'prior')),residual_range_coverage:coverage},
    scope:'One-minute YES midpoint projection. The first half selects a rule, the next 30% estimates its residual range, and the final 20% measures replay error. The range describes quote changes.'};
}
