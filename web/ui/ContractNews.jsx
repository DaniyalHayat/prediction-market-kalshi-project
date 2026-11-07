'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Newspaper,RefreshCw} from 'lucide-react';
import {api,dateLabel} from './api.mjs';
import {emitAnalytics} from '../app/components/analytics-policy.mjs';
import {newsURL as safeURL,readNews} from './news-reading.mjs';
import './contract-news.css';
export function ReadMode({value,onChange,label}){
  return <div className="read-mode" role="group" aria-label={label}>{[['summary','Summary'],['long','Long read']].map(([id,title])=><button key={id} aria-pressed={value===id} onClick={()=>{onChange(id);emitAnalytics(label.startsWith('Contract news')?'news_read_mode':'analysis_read_mode',{mode:id});}}>{title}</button>)}</div>;
}
export function ReadText({value}){
  const paragraphs=Array.isArray(value)?value:typeof value==='string'?value.split(/\n+/):[];
  return paragraphs.filter(row=>typeof row==='string'&&row.trim()).map((row,index)=><p key={index}>{row}</p>);
}
const kindNames={official:'Official',publisher:'Publisher',reddit:'Reddit',x:'X',hacker_news:'Hacker News',data:'Data'};
const itemKind=item=>['reddit','x','hacker_news'].includes(item.platform)?item.platform:item.confidence==='primary_source'?'official':'publisher';
const statusNames={available:'Retrieved',live:'Retrieved',partial:'Partial coverage',empty:'No results',opt_in:'Off',on_selection:'Runs when applicable',not_queried:'Waiting for selection',not_configured:'Connection required',not_applicable:'Outside source coverage',unavailable:'Unavailable',robots_blocked:'Automatic access blocked',access_blocked:'Automatic access blocked',cooldown:'Cooling down',budget_reached:'Allowance reached',refreshing:'Refreshing'};
function SourceBadge({kind}){
  return <span className="news-source-kind" data-kind={kind||'publisher'}>{kindNames[kind]||'Publisher'}</span>;
}
function BriefItem({heading,item,long}){
  return <div className="news-brief-section"><h5>{heading}</h5>
    <p>{item.excerpt||item.title} <a href={item.url} target="_blank" rel="noreferrer">{item.publisher||'Open report'} <ArrowUpRight size={12}/></a>{item.as_of&&<> · <time dateTime={item.as_of}>{dateLabel(item.as_of)}</time></>}</p>
    {long&&item.why_relevant&&<p>{item.why_relevant}</p>}
    {long&&item.impact&&<p>{item.impact}</p>}
  </div>;
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
function ModelImpact({feedback,context}){
  const percentage=value=>(100*value).toFixed(1)+'%';
  if(feedback?.status!=='available'&&context)return <div className="news-brief-section"><h5>How this fits the model</h5>
    {Number.isFinite(context.current_probability)&&<p>{context.model_name||'The independent model'} currently estimates {percentage(context.current_probability)} YES. {context.source_as_of&&<>Its inputs were observed {dateLabel(context.source_as_of)}.</>}</p>}
    <p>{context.reason}</p>
    {(context.matched_reports>0||context.related_reports>0)&&<p>This check found {context.matched_reports} matched and {context.related_reports} related reports. Start with the matched report below, then compare its observation date and specific claim with the model inputs.</p>}
  </div>;
  if(feedback?.status!=='available')return <div className="news-brief-section"><h5>Model impact</h5><p>{feedback?.reason||'No verified update changed the model in this news check. Headlines and social posts carry zero forecast weight on their own.'}</p></div>;
  return <div className="news-brief-section"><h5>What changed in the model</h5>
    <p>The team model starts at {percentage(feedback.baseline_probability)} YES. The paper screen tests {feedback.decision_interval.map(percentage).join(' to ')} YES after accounting for lineup risk.</p>
    {feedback.scenarios.map(row=><p key={row.player_id}>{row.name} is listed {row.status.toLowerCase()}. The scenario puts YES at {percentage(row.conditional_probability)}, based on {row.dnp_games} games missed and {row.regular_games} games with regular minutes.</p>)}
    {safeURL(feedback.source?.url)&&<p><a href={feedback.source.url} target="_blank" rel="noreferrer">Open the matched availability report <ArrowUpRight size={12}/></a></p>}
  </div>;
}
export default function ContractNews({ticker,model='validated',initial=null,articles=[],feedback,onAssistant}){
  const [mode,setMode]=useState('summary'),[value,setValue]=useState(initial),[loading,setLoading]=useState(!initial),[error,setError]=useState('');
  const request=useRef(null),initialValue=useRef(initial);
  const load=useCallback(async ({signal}={})=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    const pending=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const params=new URLSearchParams({ticker,model,reddit:'0',x:'0',preview:'0'});
    try{
      const result=await api('/api/workspace/evidence?'+params,{signal:pending,timeoutMs:20000});
      if(result.ticker!==ticker)throw new Error('The returned news belongs to another contract. Refresh to check the selected contract.');
      if(!pending.aborted){setValue(result);return result;}
    }catch(error){if(!pending.aborted&&error.name!=='AbortError')setError(error.message);}
    finally{if(!controller.signal.aborted)setLoading(false);}
  },[ticker,model]);
  useEffect(()=>{
    if(!initialValue.current||initialValue.current.status==='not_queried')load();
    return()=>request.current?.abort();
  },[load]);
  const news=readNews(value,articles);
  const feeds=(value?.feeds||[]).filter(feed=>!['reddit','hacker_news','x'].includes(feed.kind));
  const long=mode==='long';
  const retained=['retained','retained_ephemeral'].includes(value?.retention?.status);
  const sourceLinks=(value?.source_links||[]).filter(row=>safeURL(row.url));
  const ask=()=>onAssistant?.({detail:long?'full':'brief',evidence:value,...(!retained?{prepare:signal=>load({signal})}:{})});
  return <section className="contract-news" aria-label="Contract news and context"><div className="readout-heading"><div><span className="eyebrow">Evidence & reporting</span><h3>Contract news</h3></div><ReadMode value={mode} onChange={setMode} label="Contract news reading length"/></div>
    <div className="news-preferences">
      <button className="text-button" onClick={()=>load()} disabled={loading}><RefreshCw size={13} className={loading?'spin':''}/>Refresh</button>
      {onAssistant&&<button type="button" className="text-button" aria-label="Ask why about this contract news" onClick={ask}>Ask why <ArrowUpRight size={14}/></button>}
    </div>
    {loading&&<p className="news-progress" role="status">Checking public reporting for this contract…</p>}
    {error&&<p className="notice error" role="alert">{error}</p>}
    {value&&<>
      <div className="reading-copy news-brief"><h4><Newspaper size={16}/>{long?'The full brief':'Quick read'}</h4>
        <ModelImpact feedback={value.model_feedback||feedback} context={value.model_context}/>
        {news.lead?<BriefItem heading={news.direct?'Best-matched report':'Closest related report'} item={news.lead} long={long}/>:<p>No recent public report matched the exact contract in the sources checked.</p>}
        {news.second&&<BriefItem heading="Another publisher" item={news.second} long={long}/>}
        {!long&&news.lead?.impact&&<div className="news-brief-section"><h5>What to verify</h5><p>{news.lead.impact}</p></div>}
        {sourceLinks.length>0&&!long&&<div className="news-brief-section"><h5>Settlement reference</h5><p><a href={sourceLinks[0].url} target="_blank" rel="noreferrer">{sourceLinks[0].label} <ArrowUpRight size={12}/></a> {sourceLinks[0].detail}</p></div>}
        {long&&news.sections.map(row=><div className="news-brief-section" key={row.heading}><h5>{row.heading}</h5><p>{row.text}{safeURL(row.url)&&<> <a href={row.url} target="_blank" rel="noreferrer">Open source <ArrowUpRight size={12}/></a></>}</p></div>)}
        {long&&<div className="news-brief-section"><h5>Coverage and limits</h5><p>{news.matched.length} matched and {news.related.length} related public reports after removing duplicates. Related reporting may cover the same teams, people or topics without addressing the contract’s settlement rule.{news.social.length>0&&` ${news.social.length} social posts are listed separately.`}</p></div>}
      </div>
      <NewsCards label="More matched reporting" items={news.moreMatched} long={long}/>
      <NewsCards label="Related context" items={news.moreRelated} long={long}/>
      <NewsCards label="Social context" items={news.social} long={long}/>
      <NewsCards label="Official source checks" items={(value.official_observations||[]).filter(item=>safeURL(item.url))} long={long}/>
      {sourceLinks.length>0&&<div className="news-source-links"><h4 className="news-section-label">Go to the source</h4>{sourceLinks.map(row=><a href={row.url} key={row.url} target="_blank" rel="noreferrer"><SourceBadge kind={row.kind}/><span><strong>{row.label}</strong><small>{row.detail}</small></span><ArrowUpRight size={14}/></a>)}</div>}
      {feeds.length>0&&<details className="method news-feeds" open={long}><summary>Source coverage · {dateLabel(value.as_of)}</summary>{feeds.map(feed=><div key={feed.name}>
        <p><SourceBadge kind={feed.kind}/> <strong>{feed.name}</strong> · {statusNames[feed.status]||feed.status?.replaceAll('_',' ')}{feed.as_of?' · '+dateLabel(feed.as_of):''}</p>
        {feed.reason&&<p>{feed.reason}</p>}
        {safeURL(feed.source_url)&&<a className="text-button" href={feed.source_url} target="_blank" rel="noreferrer">Open public source <ArrowUpRight size={12}/></a>}{feed.note&&<p>{feed.note}</p>}
      </div>)}</details>}
      {mode==='long'&&value.film&&<details className="method" open><summary>Film reception and demand</summary><p>Critic weighting: {(value.film.critic_weight*100).toFixed(1)}%. {value.film.weight_basis}</p><p>{value.film.preference_index?.reason}</p><p>{value.film.note}</p><div className="scenario-comparison">{value.film.preference_index?.sensitivity?.map(row=><div key={row.critic_weight}><small>{(row.critic_weight*100).toFixed(1)}% critics</small><strong>{Number.isFinite(row.value)?row.value.toFixed(1):'No estimate'}</strong></div>)}</div>{value.film.source_links?.filter(row=>safeURL(row.url)).map(row=><p key={row.url}><a href={row.url} target="_blank" rel="noreferrer">{row.label}</a></p>)}</details>}
      {mode==='long'&&value.music_alternatives&&<details className="method"><summary>Additional music chart context</summary><p>{value.music_alternatives.scope||value.music_alternatives.reason}</p>{value.music_alternatives.measurement_date&&<p>Measurement date: {value.music_alternatives.measurement_date}. {value.music_alternatives.settlement_note}</p>}{value.music_alternatives.matched_tracks?.length>0&&<div className="table-scroll"><table><thead><tr><th>Song</th><th>Rank</th><th>Reported daily streams</th></tr></thead><tbody>{value.music_alternatives.matched_tracks.map(track=><tr key={track.id}><td>{track.name}<small>{track.artist}</small></td><td>{track.rank}</td><td>{Number.isFinite(track.streams)?track.streams.toLocaleString('en-US'):'—'}</td></tr>)}</tbody></table></div>}<p>{value.music_alternatives.note}</p></details>}
    </>}
    {news.headlines.length>0&&<><div className="section-title"><h3>Additional headlines</h3><span className="muted">Publisher links · contract match unverified</span></div><div className="news-list">{news.headlines.slice(0,long?10:3).map(article=><a key={article.url} href={article.url} target="_blank" rel="noreferrer"><small>{article.publisher||article.domain} · {dateLabel(article.published_at||article.seen_at)}</small><strong>{article.title}</strong>{long&&(article.summary||article.description)&&<p>{article.summary||article.description}</p>}<ArrowUpRight size={15}/></a>)}</div></>}
  </section>;
}
