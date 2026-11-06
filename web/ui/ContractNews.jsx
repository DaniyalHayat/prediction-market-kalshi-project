'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Newspaper,RefreshCw} from 'lucide-react';
import {api,dateLabel,percent} from './api.mjs';
import {emitAnalytics} from '../app/components/analytics-policy.mjs';
import './contract-news.css';
const safeURL=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
export function ReadMode({value,onChange,label}){
  return <div className="read-mode" role="group" aria-label={label}>{[['summary','Summary'],['long','Long read']].map(([id,title])=><button key={id} aria-pressed={value===id} onClick={()=>{onChange(id);emitAnalytics(label.startsWith('Contract news')?'news_read_mode':'analysis_read_mode',{mode:id});}}>{title}</button>)}</div>;
}
export function ReadText({value}){
  const paragraphs=Array.isArray(value)?value:typeof value==='string'?value.split(/\n+/):[];
  return paragraphs.filter(row=>typeof row==='string'&&row.trim()).map((row,index)=><p key={index}>{row}</p>);
}
const kindNames={official:'Official',publisher:'Publisher',reddit:'Reddit',x:'X',data:'Data'};
const itemKind=item=>item.platform==='reddit'?'reddit':item.platform==='x'?'x':item.confidence==='primary_source'?'official':'publisher';
const statusNames={available:'Retrieved',live:'Retrieved',partial:'Partial coverage',empty:'No results',opt_in:'Off',on_selection:'Runs when applicable',not_queried:'Waiting for selection',not_configured:'Connection required',not_applicable:'Outside source coverage',unavailable:'Unavailable',robots_blocked:'Automatic access blocked',access_blocked:'Automatic access blocked',cooldown:'Cooling down',budget_reached:'Allowance reached',refreshing:'Refreshing'};
function SourceBadge({kind}){
  return <span className="news-source-kind" data-kind={kind||'publisher'}>{kindNames[kind]||'Publisher'}</span>;
}
function NewsCards({items,long,label}){
  if(!items.length)return null;
  return <div className="news-card-group"><h4 className="news-section-label">{label}</h4><div className="evidence-items">
    {items.slice(0,long?8:3).map(item=><article key={item.id||item.url}>
      <div className="evidence-item-meta"><div><SourceBadge kind={itemKind(item)}/><span>{item.publisher}</span></div><time dateTime={item.as_of}>{dateLabel(item.as_of)}</time></div>
      {safeURL(item.url)?<a href={item.url} target="_blank" rel="noreferrer"><h4>{item.title}</h4><ArrowUpRight size={15}/></a>:<h4>{item.title}</h4>}
      {item.excerpt&&item.excerpt!==item.title&&<p>{item.excerpt}</p>}
      {long&&<>{item.why_relevant&&<p><b>Match</b> {item.why_relevant}</p>}{item.impact&&<p><b>Watch for</b> {item.impact}</p>}<ReadText value={item.limitations?.filter(note=>!note.startsWith('Editorial relevance rank'))}/></>}
    </article>)}
  </div></div>;
}
function SourceSwitch({label,active,onToggle}){
  return <button type="button" className="news-toggle" role="switch" aria-checked={active} onClick={onToggle}>
    <span className="news-toggle-track" aria-hidden="true"/>{label}
  </button>;
}
function ModelImpact({feedback}){
  if(feedback?.status!=='available')return <div className="news-brief-section"><h5>Model impact</h5><p>{feedback?.reason||'No verified update changed the model in this check. Headlines and social posts carry zero forecast weight on their own.'}</p></div>;
  return <div className="news-brief-section"><h5>What changed in the model</h5>
    <p>The team model starts at {percent(feedback.baseline_probability)} YES. The paper screen tests {feedback.decision_interval.map(percent).join(' to ')} YES after accounting for lineup risk.</p>
    {feedback.scenarios.map(row=><p key={row.player_id}>{row.name} is listed {row.status.toLowerCase()}. The scenario puts YES at {percent(row.conditional_probability)}, based on {row.dnp_games} games missed and {row.regular_games} games with regular minutes.</p>)}
    {safeURL(feedback.source?.url)&&<p><a href={feedback.source.url} target="_blank" rel="noreferrer">Open the matched availability report <ArrowUpRight size={12}/></a></p>}
  </div>;
}
export default function ContractNews({ticker,model='validated',initial=null,articles=[],feedback,onEvidence}){
  const [mode,setMode]=useState('summary'),[reddit,setReddit]=useState(false),[x,setX]=useState(false),[value,setValue]=useState(initial),[loading,setLoading]=useState(!initial),[error,setError]=useState('');
  const request=useRef(null);
  const load=useCallback(async ({includeReddit=false,includeX=false,preview=false}={})=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    const params=new URLSearchParams({ticker,model,reddit:includeReddit?'1':'0',x:includeX?'1':'0',preview:preview?'1':'0'});
    try{
      const result=await api('/api/workspace/evidence?'+params,{signal:controller.signal});
      if(result.ticker!==ticker)throw new Error('The returned news belongs to another contract. Refresh to check the selected contract.');
      if(!controller.signal.aborted){setValue(result);onEvidence?.(result,!preview);}
    }catch(error){if(!controller.signal.aborted&&error.name!=='AbortError')setError(error.message);}
    finally{if(!controller.signal.aborted)setLoading(false);}
  },[ticker,model,onEvidence]);
  useEffect(()=>{
    if(!initial)load({preview:true});
    return()=>request.current?.abort();
  },[initial,load]);
  const canShow=item=>item.platform==='reddit'?reddit:item.platform==='x'?x:true;
  const items=(value?.items||[]).filter(canShow),related=(value?.related_items||[]).filter(canShow),headlines=articles.filter(article=>safeURL(article.url));
  const feeds=(value?.feeds||[]).filter(feed=>feed.kind==='reddit'?reddit:feed.kind==='x'?x:true);
  const long=mode==='long';
  const hasSources=Boolean(value?.source_links?.length);
  return <section className="contract-news" aria-label="Contract news and context"><div className="readout-heading"><div><span className="eyebrow">Evidence & reporting</span><h3>Contract news</h3></div><ReadMode value={mode} onChange={setMode} label="Contract news reading length"/></div>
    <div className="news-preferences">
      <SourceSwitch label="Reddit context" active={reddit} onToggle={()=>{setReddit(!reddit);load({includeReddit:!reddit,includeX:x});}}/>
      <SourceSwitch label="X reports" active={x} onToggle={()=>{setX(!x);load({includeReddit:reddit,includeX:!x});}}/>
      <button className="text-button" onClick={()=>load({includeReddit:reddit,includeX:x})} disabled={loading}><RefreshCw size={13} className={loading?'spin':''}/>Refresh</button>
    </div>
    {loading&&<p className="news-progress" role="status">{reddit||x?'Checking selected reporting and social sources…':'Checking public reporting for this contract…'}</p>}
    {error&&<p className="notice error" role="alert">{error}</p>}
    {value&&<>
      <div className="reading-copy news-brief"><h4><Newspaper size={16}/>{long?'The full brief':'Quick read'}</h4>
        <ModelImpact feedback={value.model_feedback||feedback}/>
        {long&&value.news_sections?.length?value.news_sections.map(row=><div className="news-brief-section" key={row.heading}><h5>{row.heading}</h5><p>{row.text}{safeURL(row.url)&&<> <a href={row.url} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={12}/></a></>}</p></div>):
          <ReadText value={long?(value.news_long_read||value.long_read||value.news_summary||value.summary):(value.news_summary||value.summary)}/>}
      </div>
      <NewsCards label="Matched reporting" items={items.filter(item=>!['reddit','x'].includes(item.platform))} long={long}/>
      <NewsCards label="Related context" items={related.filter(item=>!['reddit','x'].includes(item.platform))} long={long}/>
      <NewsCards label="Social context" items={[...items,...related].filter(item=>['reddit','x'].includes(item.platform))} long={long}/>
      {hasSources&&<div className="news-source-links"><h4 className="news-section-label">Go to the source</h4>{value.source_links.filter(row=>safeURL(row.url)).map(row=><a href={row.url} key={row.url} target="_blank" rel="noreferrer"><SourceBadge kind={row.kind}/><span><strong>{row.label}</strong><small>{row.detail}</small></span><ArrowUpRight size={14}/></a>)}</div>}
      {feeds.length>0&&<details className="method news-feeds" open={long||reddit||x}><summary>Source coverage · {dateLabel(value.as_of)}</summary>{feeds.map(feed=><div key={feed.name}>
        <p><SourceBadge kind={feed.kind}/> <strong>{feed.name}</strong> · {statusNames[feed.status]||feed.status?.replaceAll('_',' ')}{feed.as_of?' · '+dateLabel(feed.as_of):''}</p>
        {feed.reason&&<p>{feed.reason}</p>}
        {safeURL(feed.search_url)&&<a className="text-button" href={feed.search_url} target="_blank" rel="noreferrer">Open Reddit search <ArrowUpRight size={12}/></a>}
      </div>)}</details>}
      {mode==='long'&&value.film&&<details className="method" open><summary>Film reception and demand</summary><p>Critic weighting: {(value.film.critic_weight*100).toFixed(1)}%. {value.film.weight_basis}</p><p>{value.film.preference_index?.reason}</p><p>{value.film.note}</p><div className="scenario-comparison">{value.film.preference_index?.sensitivity?.map(row=><div key={row.critic_weight}><small>{(row.critic_weight*100).toFixed(1)}% critics</small><strong>{Number.isFinite(row.value)?row.value.toFixed(1):'No estimate'}</strong></div>)}</div>{value.film.source_links?.filter(row=>safeURL(row.url)).map(row=><p key={row.url}><a href={row.url} target="_blank" rel="noreferrer">{row.label}</a></p>)}</details>}
      {mode==='long'&&value.music_alternatives&&<details className="method"><summary>Additional music chart context</summary><p>{value.music_alternatives.scope||value.music_alternatives.reason}</p>{value.music_alternatives.measurement_date&&<p>Measurement date: {value.music_alternatives.measurement_date}. {value.music_alternatives.settlement_note}</p>}{value.music_alternatives.matched_tracks?.length>0&&<div className="table-scroll"><table><thead><tr><th>Song</th><th>Rank</th><th>Reported daily streams</th></tr></thead><tbody>{value.music_alternatives.matched_tracks.map(track=><tr key={track.id}><td>{track.name}<small>{track.artist}</small></td><td>{track.rank}</td><td>{Number.isFinite(track.streams)?track.streams.toLocaleString('en-US'):'—'}</td></tr>)}</tbody></table></div>}<p>{value.music_alternatives.note}</p></details>}
    </>}
    {headlines.length>0&&<><div className="section-title"><h3>{value?'Additional headlines':'Recent headlines'}</h3><span className="muted">Publisher links</span></div><div className="news-list">{headlines.slice(0,mode==='long'?10:3).map(article=><a key={article.url} href={article.url} target="_blank" rel="noreferrer"><small>{article.publisher||article.domain} · {dateLabel(article.published_at||article.seen_at)}</small><strong>{article.title}</strong>{mode==='long'&&(article.summary||article.description)&&<p>{article.summary||article.description}</p>}<ArrowUpRight size={15}/></a>)}</div></>}
  </section>;
}
