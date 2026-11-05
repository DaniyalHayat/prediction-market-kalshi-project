'use client';
import {useEffect,useState} from 'react';
import {ArrowUpRight,Loader2} from 'lucide-react';
import {cents,dateLabel,dollars,percent} from './api.mjs';
import {newsURL} from './news-reading.mjs';

function Stopwatch({started}){
  const [elapsed,setElapsed]=useState(0);
  useEffect(()=>{
    const tick=()=>setElapsed(performance.now()-started);
    tick();
    const timer=setInterval(tick,100);
    return()=>clearInterval(timer);
  },[started]);
  return <span aria-hidden="true">{(elapsed/1000).toFixed(1)} s</span>;
}

const stages={market:'Market rules',book:'Order book',research:'Quant model',news:'News',history:'Price history',flow:'Recent trades'};
export default function PositionReview({position,reviews,onOpen}){
  const [expanded,setExpanded]=useState(false),[long,setLong]=useState(false);
  const review=reviews.resultFor(position),value=review?.value,loading=Boolean(review?.started);
  const watched=!reviews.settings[position.id]?.paused;
  const id='position-scan-'+position.id;
  return <div className="trade-scan">
    <div className="trade-scan-controls">
      <button type="button" className="secondary" aria-expanded={expanded} aria-controls={id} disabled={loading}
        onClick={()=>{setExpanded(true);void reviews.run(position);}}>
        {loading?'Analyzing…':value?'Scan again':'Analyze position'}
      </button>
      <label className="checkbox-label"><input type="checkbox" checked={watched} onChange={event=>reviews.toggle(position.id,event.target.checked)}/>Auto-check every 25 minutes</label>
    </div>
    {loading&&<p role="status" className="trade-scan-progress"><Loader2 className="spin" size={14}/>Checking bids, model and news <Stopwatch key={review.started} started={review.started}/></p>}
    {!expanded&&value&&<button className="text-button" onClick={()=>setExpanded(true)}>Last scan · {value.action} · {dateLabel(value.as_of)}</button>}
    {expanded&&<div id={id} className="trade-scan-result">
      {review?.error&&<p role="alert">{review.error} · {(review.elapsed/1000).toFixed(2)} s</p>}
      {value&&<section aria-label="Position analysis result" data-testid="position-scan-result">
        <header><span className={'action-badge '+(value.action==='SELL'?'exit':value.action.toLowerCase())}>{value.action}</span>
          <small>{(review.elapsed/1000).toFixed(2)} s end to end · {dateLabel(value.as_of)}{value.partial?' · Partial evidence':''}</small></header>
        <p>{value.reason}</p>
        <div className="review-range"><span>Net sell now <b>{dollars(value.evaluation?.exit_proceeds)}</b></span>
          <span>Estimated hold value <b>{value.evaluation?.fair_value_range?.map(dollars).join(' to ')||'Unavailable'}</b></span></div>
        <button className="text-button" aria-expanded={long} onClick={()=>setLong(!long)}>{long?'Show summary':'Read the full analysis'}</button>
        {(long?value.sections:value.sections?.slice(0,2))?.map(section=><div key={section.heading}><h4>{section.heading}</h4><p>{section.text}</p></div>)}
        {value.alternatives?.length>0&&<div><h4>Alternative paper setups</h4>
          {value.alternatives.map(row=><div className="trade-alternative" key={row.ticker+'-'+row.side}>
            <button className="text-button" onClick={()=>onOpen(row,row.budget)}>{row.side} · {row.title||row.ticker}<ArrowUpRight size={13}/></button>
            <small>{dollars(row.cost)} modeled entry · {cents(row.conservative_edge)} lower-bound edge per contract · {dateLabel(row.as_of)}</small>
            {Number.isFinite(row.settlement_value)&&<small>{cents(row.settlement_value)} expected payout per contract · {percent(row.win_probability)} win chance · {percent(row.tie_probability)} chance of a {cents(row.tie_payout)} payout</small>}
          </div>)}
        </div>}
        {value.action==='SELL'&&!value.alternatives?.length&&<p className="footnote">No alternative cleared the available model and execution checks in this scan.</p>}
        {value.action==='SELL'&&value.alternative_coverage&&<p className="footnote">{value.alternative_coverage.scanned_contracts} priced contracts across a candidate pool covering {value.alternative_coverage.checked_categories?.length||0} of {value.alternative_coverage.category_count} categories. Each setup gets a fresh quote before a paper buy.</p>}
        {value.sources?.length>0&&<details><summary>Sources</summary><ul>{value.sources.filter(source=>newsURL(source.url)).map((source,index)=>
          <li key={source.url+'-'+index}><a href={source.url} target="_blank" rel="noreferrer">{source.label||'Open source'}</a></li>)}</ul></details>}
        {value.timings_ms&&<details><summary>Scan timings and coverage</summary><dl>{Object.entries(stages).map(([key,label])=>
          <div key={key}><dt>{label}</dt><dd>{value.source_status?.[key]||'—'} · {Number.isFinite(value.timings_ms[key])?value.timings_ms[key]+' ms':'—'}</dd></div>)}</dl></details>}
      </section>}
      {!loading&&<button className="text-button" onClick={()=>setExpanded(false)}>Hide analysis</button>}
    </div>}
  </div>;
}
