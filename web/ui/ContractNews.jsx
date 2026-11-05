'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Newspaper,RefreshCw} from 'lucide-react';
import {api,dateLabel} from './api.mjs';
import {emitAnalytics} from '../app/components/analytics-policy.mjs';
const safeURL=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
export function ReadMode({value,onChange,label}){
  return <div className="read-mode" role="group" aria-label={label}>{[['summary','Summary'],['long','Long read']].map(([id,title])=><button key={id} aria-pressed={value===id} onClick={()=>{onChange(id);emitAnalytics(label.startsWith('Contract news')?'news_read_mode':'analysis_read_mode',{mode:id});}}>{title}</button>)}</div>;
}
export function ReadText({value}){
  const paragraphs=Array.isArray(value)?value:typeof value==='string'?value.split(/\n+/):[];
  return paragraphs.filter(row=>typeof row==='string'&&row.trim()).map((row,index)=><p key={index}>{row}</p>);
}
export default function ContractNews({ticker,initial=null,articles=[],onEvidence}){
  const [mode,setMode]=useState('summary'),[reddit,setReddit]=useState(false),[value,setValue]=useState(initial),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const request=useRef(null);
  useEffect(()=>()=>request.current?.abort(),[]);
  async function load(includeReddit=reddit){
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    try{const result=await api('/api/workspace/evidence?ticker='+encodeURIComponent(ticker)+'&reddit='+(includeReddit?'1':'0'),{signal:controller.signal});if(!controller.signal.aborted&&result.ticker===ticker){setValue(result);onEvidence?.(result);}}
    catch(error){if(error.name!=='AbortError')setError(error.message);}finally{if(!controller.signal.aborted)setLoading(false);}
  }
  const items=value?.items||[],headlines=articles.filter(article=>safeURL(article.url));
  return <section className="contract-news" aria-label="Contract news and context"><div className="readout-heading"><div><span className="eyebrow">Evidence & reporting</span><h3>Contract news</h3></div><ReadMode value={mode} onChange={setMode} label="Contract news reading length"/></div>
    {!value&&<div className="evidence-invitation"><Newspaper size={20}/><div><strong>Check the reporting behind this contract</strong><p>Load matched reporting, source notes and relevant public discussion.</p></div><button className="secondary" onClick={()=>load()} disabled={loading}>{loading?'Checking sources…':'Load contract news'}</button></div>}
    <div className="news-preferences"><label className="checkbox-label"><input type="checkbox" checked={reddit} onChange={event=>{setReddit(event.target.checked);if(value)load(event.target.checked);}}/>Include Reddit context</label><span>Public discussion is unverified context.</span>{value&&<button className="text-button" onClick={()=>load()} disabled={loading}><RefreshCw size={13} className={loading?'spin':''}/>Refresh</button>}</div>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {value&&<><div className="reading-copy"><ReadText value={mode==='long'?(value.news_long_read||value.long_read||value.news_summary||value.summary):(value.news_summary||value.summary)}/></div>
      {items.length>0&&<div className="evidence-items">{items.slice(0,mode==='long'?12:4).map((item,index)=><article key={item.id||item.url||index}><div className="evidence-item-meta"><span>{item.publisher||'Source context'}</span><span>{item.confidence==='unverified_context'?'Unverified context':item.confidence==='primary_source'?'Primary source':'Attributed report'}</span></div>{safeURL(item.url)?<a href={item.url} target="_blank" rel="noreferrer"><h4>{item.title}</h4><ArrowUpRight size={15}/></a>:<h4>{item.title}</h4>}{item.excerpt&&<p>{item.excerpt}</p>}{item.why_relevant&&<p className="evidence-relevance"><b>Why it matters</b> {item.why_relevant}</p>}{mode==='long'&&<>{item.impact&&<p><b>Possible impact</b> {item.impact}</p>}{item.limitations&&<ReadText value={item.limitations}/>}<div className="evidence-item-footer">{Number.isFinite(item.score)&&<span title="Editorial relevance ranking; not a probability or trading confidence">Relevance {item.score}/100</span>}<span>{dateLabel(item.as_of)}</span></div></>}</article>)}</div>}
      {!items.length&&<p className="empty">No additional matched source items were returned.</p>}{mode==='long'&&value.feeds?.length>0&&<details className="method"><summary>Source coverage and limitations</summary>{value.feeds.map((feed,index)=><div key={feed.id||index}><p><strong>{feed.name||feed.provider||feed.id}</strong> · {feed.status?.replaceAll('_',' ')}{feed.reason||feed.note?' · '+(feed.reason||feed.note):''}</p>{safeURL(feed.search_url)&&<a className="text-button" href={feed.search_url} target="_blank" rel="noreferrer">Review directly <ArrowUpRight size={12}/></a>}</div>)}</details>}
      {mode==='long'&&value.film&&<details className="method" open><summary>Film reception and demand</summary><p>Critic weighting: {(value.film.critic_weight*100).toFixed(1)}%. {value.film.weight_basis}</p><p>{value.film.preference_index?.reason}</p><p>{value.film.note}</p><div className="scenario-comparison">{value.film.preference_index?.sensitivity?.map(row=><div key={row.critic_weight}><small>{(row.critic_weight*100).toFixed(1)}% critics</small><strong>{Number.isFinite(row.value)?row.value.toFixed(1):'No estimate'}</strong></div>)}</div>{value.film.source_links?.filter(row=>safeURL(row.url)).map(row=><p key={row.url}><a href={row.url} target="_blank" rel="noreferrer">{row.label}</a></p>)}</details>}
      {mode==='long'&&value.music_alternatives&&<details className="method"><summary>Additional music chart context</summary><p>{value.music_alternatives.scope||value.music_alternatives.reason}</p>{value.music_alternatives.measurement_date&&<p>Measurement date: {value.music_alternatives.measurement_date}. {value.music_alternatives.settlement_note}</p>}{value.music_alternatives.matched_tracks?.length>0&&<div className="table-scroll"><table><thead><tr><th>Song</th><th>Rank</th><th>Reported daily streams</th></tr></thead><tbody>{value.music_alternatives.matched_tracks.map(track=><tr key={track.id}><td>{track.name}<small>{track.artist}</small></td><td>{track.rank}</td><td>{Number.isFinite(track.streams)?track.streams.toLocaleString('en-US'):'—'}</td></tr>)}</tbody></table></div>}<p>{value.music_alternatives.note}</p></details>}
    </>}
    {headlines.length>0&&<><div className="section-title"><h3>{value?'Additional headlines':'Recent headlines'}</h3><span className="muted">Publisher links</span></div><div className="news-list">{headlines.slice(0,mode==='long'?10:3).map(article=><a key={article.url} href={article.url} target="_blank" rel="noreferrer"><small>{article.publisher||article.domain} · {dateLabel(article.published_at||article.seen_at)}</small><strong>{article.title}</strong>{mode==='long'&&(article.summary||article.description)&&<p>{article.summary||article.description}</p>}<ArrowUpRight size={15}/></a>)}</div></>}
  </section>;
}
