'use client';
import {memo,useCallback,useEffect,useMemo,useReducer,useRef,useState} from 'react';
import {Activity,ArrowLeft,ArrowUpRight,Bitcoin,BookOpen,Check,ChevronDown,CloudSun,Database,ExternalLink,FlaskConical,
  Leaf,Link2,Loader2,MessageSquare,Music2,Plane,RefreshCw,Search,ShieldCheck,Trophy,Landmark,X} from 'lucide-react';
import {api,API_BASE,cents,count,percent,dateLabel} from './api.mjs';
import {initialSelection,selectionReducer,contractTitle} from './selection.mjs';
import Chart from './Chart.jsx';
import Paper from './Paper.jsx';
import Journal from './Journal.jsx';
import Assistant from './Assistant.jsx';
import Modal from './Modal.jsx';
import useOpinions from './useOpinions.jsx';

const categories=[['sports','Sports',Trophy],['macro','Economy',Landmark],['crypto','Crypto',Bitcoin],['travel','Travel',Plane],
  ['weather','Weather',CloudSun],['science','Tech & science',FlaskConical],['climate','Climate',Leaf],['culture','Culture',Music2]];
const safeURL=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};

const MarketRow=memo(function MarketRow({row,selected,opinion,onSelect,onResearch}) {
  const side=opinion?.side;
  return <div className={'market-row '+(selected?'selected':'')} data-market-ticker={row.ticker}>
    <button className="market-select" onClick={()=>onSelect(row)} aria-label={'Open '+contractTitle(row)} aria-current={selected?'true':undefined}>
      <div><span className="row-series">{row.series||row.ticker.split('-')[0]}</span><h2>{contractTitle(row)}</h2><small>{count(row.volume_24h)} 24h contracts · {dateLabel(row.close_time)}</small></div>
      <div className="row-prices"><strong>{cents(row.yes_ask)}</strong><span>{Number.isFinite(row.yes_bid)?cents(1-row.yes_bid):'—'}</span></div>
    </button>
    <button className="row-opinion" onClick={()=>onResearch(row)} title={opinion?.reason||'Open the research view for model coverage and evidence gaps.'} aria-label={'Research view for '+contractTitle(row)+(side?': '+side:'')}>
      <span className={'verdict '+(side?.toLowerCase()||'unchecked')}>{side||'Check'}</span><span>View research <ArrowUpRight size={12}/></span>
    </button>
  </div>;
});

function SourceRows({sources=[]}) {
  return <div className="source-list">{sources.filter(source=>safeURL(source.url)).map((source,i)=><a className="source-row" href={source.url} target="_blank" rel="noreferrer" key={source.url+'-'+i}><span className="source-number">{i+1}</span><span><strong>{source.label||source.name||source.kind}</strong><small>{source.retrieved_at?`Checked ${dateLabel(source.retrieved_at)}`:new URL(source.url).hostname}</small></span><ArrowUpRight size={15}/></a>)}</div>;
}
function Depth({book}) {
  const fp=book?.raw?.orderbook_fp;
  const bids=(fp?.yes_dollars||[]).map(([p,q])=>[Number(p),Number(q)]).sort((a,b)=>b[0]-a[0]).slice(0,7);
  const asks=(fp?.no_dollars||[]).map(([p,q])=>[1-Number(p),Number(q)]).sort((a,b)=>a[0]-b[0]).slice(0,7);
  const max=Math.max(1,...bids.map(row=>row[1]),...asks.map(row=>row[1]));
  return <div className="depth"><div className="depth-heading"><span>YES bids <small>contracts</small></span><span>YES asks <small>contracts</small></span></div>{Array.from({length:Math.max(bids.length,asks.length)},(_,i)=><div className="depth-line" key={i}>{[bids[i],asks[i]].map((row,j)=><div className={j?'ask':'bid'} key={j} style={{'--depth':`${row?row[1]/max*100:0}%`}}><strong>{row?cents(row[0]):'—'}</strong><span>{row?count(row[1]):'—'}</span></div>)}</div>)}{!bids.length&&!asks.length&&<p className="empty">No usable depth has been returned.</p>}</div>;
}
function Research({value,loading,onAssistant,compact=false}) {
  if(loading&&!value)return <div className="loading-section"><Loader2 className="spin" size={18}/><div><strong>Checking sources and models</strong><p>Quotes remain available while the research loads.</p></div></div>;
  if(!value)return <p className="empty">Research is not available for this contract.</p>;
  const forecast=value.forecast,side=value.opinion?.side||'PASS';
  const opinion=<div className={'opinion-card '+side.toLowerCase()}><div className="section-title"><h3>{compact?'Cost-aware screen':'Research view'}</h3><span className={'verdict '+side.toLowerCase()}>{side}</span></div><p>{value.opinion?.reason||value.decision?.reasons?.[0]||value.summary}</p>{Number.isFinite(forecast?.probability)&&<div className="model-numbers"><div><small>Model P(YES)</small><strong>{percent(forecast.probability)}</strong></div><div><small>Range</small><strong>{Array.isArray(forecast.interval)?forecast.interval.map(percent).join(' – '):'Not available'}</strong></div><div><small>Evidence</small><strong>{forecast.evidence?.label||'Research scenario'}</strong></div></div>}<button className="text-button" onClick={onAssistant}>Ask why <ArrowUpRight size={14}/></button></div>;
  if(compact)return opinion;
  return <div className="research-content">{opinion}
    {value.extensions?.sports&&<SportsResearch value={value.extensions.sports}/>}
    {value.extensions?.music&&<MusicResearch value={value.extensions.music}/>}
    <div className="section-title"><h3>What matters here</h3></div><div className="driver-list">{value.drivers?.map(driver=><div key={driver.name}><Check size={15}/><div><strong>{driver.name}</strong><p>{driver.detail}</p></div></div>)}</div>
    <div className="section-title"><h3>Recent reporting</h3><span className="muted">Context</span></div><div className="news-list">{value.news?.articles?.map(article=><a key={article.url} href={safeURL(article.url)||'#'} target="_blank" rel="noreferrer"><small>{article.publisher||article.domain} · {dateLabel(article.published_at||article.seen_at)}</small><strong>{article.title}</strong><ArrowUpRight size={15}/></a>)}{!value.news?.articles?.length&&<p className="empty">No matched recent headlines were returned.</p>}</div>
    {value.extensions?.posts?.length>0&&<><div className="section-title"><h3>Chart updates on X</h3></div><div className="news-list">{value.extensions.posts.map(post=><a key={post.id} href={post.url} target="_blank" rel="noreferrer"><small>@{post.author} · {dateLabel(post.created_at)}</small><strong>{post.excerpt}</strong><ArrowUpRight size={15}/></a>)}</div></>}
    {value.extensions?.post_status&&<p className="footnote">X chart-feed status: {value.extensions.post_status.replaceAll('_',' ')}. {value.extensions.post_note}</p>}
    <details className="method"><summary>Method, validation and limitations</summary><p>{value.summary}</p><p>{value.decision?.validation_note}</p>{value.errors?.map((error,i)=><p key={i}>{error.source}: {error.error}</p>)}</details>
  </div>;
}
function SportsResearch({value}) {
  return <section className="sports-research"><div className="section-title"><h3>Matchup history</h3><small>{value.league?.toUpperCase()}</small></div>
    {value.reason&&<p className="notice">{value.reason}</p>}
    {value.coverage?.partial&&<p className="notice">Schedule coverage is incomplete. Missing games are excluded from form and model calculations.</p>}
    <div className="form-grid">{value.teams?.map(team=><div key={team.id}><strong>{team.name}</strong><span>{team.form?.wins??0}–{team.form?.losses??0}{team.form?.draws?`–${team.form.draws}`:''} in {team.form?.games??0} recent completed games</span><div className="form-dots">{team.form?.results?.map((result,i)=><span className={result==='W'?'win':result==='L'?'loss':'draw'} key={i}>{result}</span>)}</div></div>)}</div>
    <div className="table-scroll"><table><thead><tr><th>Recent meetings</th><th>Result</th><th>Date</th></tr></thead><tbody>{value.head_to_head?.map(game=><tr key={game.id}><td>{game.away_name} at {game.home_name}</td><td>{game.away_score}–{game.home_score}</td><td>{dateLabel(game.played_at)}</td></tr>)}</tbody></table></div>
    {!value.head_to_head?.length&&<p className="empty">No earlier matched meetings were returned in this history window.</p>}
    {value.bookmaker?.probabilities&&<div className="bookmaker-comparison"><h4>Bookmaker comparison</h4><div className="form-grid">{[['home',value.teams?.[0]?.name||'Home'],['draw','Draw'],['away',value.teams?.[1]?.name||'Away']].filter(([side])=>Number.isFinite(value.bookmaker.probabilities[side])).map(([side,name])=><div key={side}><strong>{name}</strong><span>{percent(value.bookmaker.probabilities[side])} implied after proportional margin removal</span></div>)}</div><p className="footnote">{value.bookmaker.provider}{Number.isFinite(value.bookmaker.overround)?` · reported overround ${percent(value.bookmaker.overround)}`:''}. {value.bookmaker.note}</p></div>}
    {value.availability?.map(row=><div className="availability" key={row.player_id||row.name}><strong>{row.name}</strong><span>{row.status} · {row.detail}</span>{row.comparison&&<details className="method"><summary>Observed minutes and team results</summary><div className="table-scroll"><table><thead><tr><th>Observed minutes</th><th>Games</th><th>Team win rate</th><th>95% interval</th></tr></thead><tbody>{[['low',`≤ ${row.comparison.threshold_minutes} minutes`],['regular',`> ${row.comparison.threshold_minutes} minutes`]].map(([key,label])=>{const group=row.comparison[key];return group&&<tr key={key}><td>{label}</td><td>{count(group.n)}</td><td>{percent(group.rate)}</td><td>{group.n&&Array.isArray(group.interval)?group.interval.map(percent).join(' – '):'No observations'}</td></tr>;})}</tbody></table></div><p>{row.comparison.note}</p></details>}</div>)}
    {value.availability_note&&<p className="footnote">{value.availability_note}</p>}
    {value.model&&<p className="footnote">{value.model.name} · {value.model.validation?.n??0} chronological holdout games. {value.model.limitation}</p>}
    {value.model?.validation?.n>0&&<details className="method"><summary>Matchup-model holdout</summary><p>{value.model.validation.protocol}</p><dl className="definition-list"><div><dt>Model Brier loss</dt><dd>{Number.isFinite(value.model.validation.brier)?value.model.validation.brier.toFixed(4):'Not available'}</dd></div><div><dt>Home-rate baseline Brier loss</dt><dd>{Number.isFinite(value.model.validation.baseline_brier)?value.model.validation.baseline_brier.toFixed(4):'Not available'}</dd></div><div><dt>Screen validation</dt><dd>{value.model.validation.passed?'Passing historical screen':'Requirements not met'}</dd></div></dl><p>A historical holdout does not establish profitable trading or a calibrated injury adjustment.</p></details>}
  </section>;
}
function MusicResearch({value}) {
  return <section className="music-research"><div className="section-title"><h3>Chart evidence</h3><small>{value.scope||'Source-specific'}</small></div>
    {value.comparability&&<p className="notice">{value.comparability}</p>}
    {value.apple?.error&&<p className="notice">Apple chart retrieval is unavailable: {value.apple.error}</p>}
    <div className="chart-tracks">{value.apple?.tracks?.slice(0,8).map(track=><a key={track.id} href={track.url} target="_blank" rel="noreferrer"><span className="rank">{track.rank}</span>{track.artwork&&<img src={track.artwork} alt="" loading="lazy" width="36" height="36"/>}<span><strong>{track.name}</strong><small>{track.artist}</small></span><ArrowUpRight size={14}/></a>)}</div>
    {value.forecast&&<p className="notice">{value.forecast.reason||`Estimated persistence: ${percent(value.forecast.probability)}`}</p>}
    {value.apple?.source_updated&&<p className="footnote">Apple feed updated {dateLabel(value.apple.source_updated)}. {value.apple.note}</p>}
    {value.spotify?.status&&value.spotify.status!=='available'&&<p className="footnote">Spotify catalog-reference status: {value.spotify.status.replaceAll('_',' ')}. {value.spotify.reason}</p>}
    {value.spotify?.references?.length>0&&<><h4>Spotify references</h4><div className="source-list">{value.spotify.references.map(row=><a className="source-row" key={row.id} href={row.url} target="_blank" rel="noreferrer"><span><strong>{row.name}</strong><small>Spotify catalog reference</small></span><ArrowUpRight size={15}/></a>)}</div><p className="footnote">Spotify catalog references are displayed separately and are not sent to the assistant or forecasting models.</p></>}
  </section>;
}
function MarketAttribution({value}) {
  if(!value)return <p className="muted">Loading observed market moves…</p>;
  if(value.error)return <p className="notice">Observed market moves are unavailable: {value.error}</p>;
  return <details className="method"><summary>Observed market moves</summary><p>{value.scope}</p>
    {value.rows?.length?<div className="table-scroll"><table><thead><tr><th>Contract</th><th>First midpoint</th><th>Latest midpoint</th><th>Change</th><th>Observations</th></tr></thead><tbody>{value.rows.slice(0,12).map(row=><tr key={row.ticker}><td><strong>{row.title||row.ticker}</strong><small>{row.ticker}</small><small>{dateLabel(row.first_observed)} to {dateLabel(row.last_observed)}</small></td><td>{cents(row.first_midpoint)}</td><td>{cents(row.last_midpoint)}</td><td>{Number.isFinite(row.observed_price_change)&&row.observed_price_change>0?'+':''}{cents(row.observed_price_change)}</td><td>{count(row.observations)}</td></tr>)}</tbody></table></div>:<p>At least two comparable observed quotes are needed. No market moves are invented before that history exists.</p>}
  </details>;
}

export default function App() {
  const [category,setCategory]=useState('sports'),[markets,setMarkets]=useState([]),[query,setQuery]=useState(''),[listLabel,setListLabel]=useState('Sports'),
    [listLoading,setListLoading]=useState(true),[listError,setListError]=useState(''),[coverage,setCoverage]=useState(null),
    [selection,dispatch]=useReducer(selectionReducer,initialSelection),[history,setHistory]=useState(null),[tab,setTab]=useState('overview'),
    [researchLoading,setResearchLoading]=useState(false),[streamStatus,setStreamStatus]=useState('Connecting'),[paused,setPaused]=useState(false),
    [assistant,setAssistant]=useState(false),[journal,setJournal]=useState(false),[sources,setSources]=useState(false),[sourceStatus,setSourceStatus]=useState(null),[attribution,setAttribution]=useState(null),
    [mobileDetail,setMobileDetail]=useState(false),[clock,setClock]=useState(Date.now()),[listRevision,setListRevision]=useState(0);
  const search=useRef(null),listIntent=useRef(0),listRoot=useRef(null),lookupRequest=useRef(null);
  const closed=Boolean(selection.market&&(['closed','settled','finalized'].includes(selection.market.status)||Date.parse(selection.market.close_time)<=clock));
  const select=useCallback((market,{openDetail=true}={})=>{listIntent.current++;dispatch({type:'select',market});setHistory(null);setTab('overview');setPaused(false);setMobileDetail(openDetail);},[]);
  const selectResearch=useCallback(market=>{select(market);setTab('research');},[select]);
  function changeCategory(id){setMobileDetail(false);if(id===category)return;lookupRequest.current?.abort();listIntent.current++;dispatch({type:'clear'});setHistory(null);setCoverage(null);setResearchLoading(false);setAssistant(false);setCategory(id);}
  useEffect(()=>{const id=setInterval(()=>setClock(Date.now()),1000);const key=e=>{if(e.key==='Escape'){setAssistant(false);setJournal(false);setSources(false);}if(e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)&&!document.querySelector('.overlay,.assistant-panel')){e.preventDefault();setMobileDetail(false);requestAnimationFrame(()=>search.current?.focus());}};document.addEventListener('keydown',key);return()=>{clearInterval(id);document.removeEventListener('keydown',key);lookupRequest.current?.abort();};},[]);
  useEffect(()=>{
    const controller=new AbortController(),intent=listIntent.current;setListLoading(true);setListError('');setMarkets([]);setQuery('');setListLabel(categories.find(c=>c[0]===category)[1]);
    api('/api/workspace/markets?category='+category,{signal:controller.signal}).then(value=>{
      if(controller.signal.aborted||intent!==listIntent.current)return;
      setMarkets(value.markets);setCoverage(value);if(value.markets.length)select(value.markets[0],{openDetail:false});
    }).catch(e=>{if(e.name!=='AbortError'&&!controller.signal.aborted)setListError(e.message);}).finally(()=>{if(!controller.signal.aborted)setListLoading(false);});
    return()=>controller.abort();
  },[category,listRevision]);
  useEffect(()=>{
    if(!selection.ticker)return;
    const {ticker,generation}=selection,controller=new AbortController();setResearchLoading(true);setStreamStatus('Loading quote');
    const options={signal:controller.signal};
    api('/api/workspace/context?ticker='+encodeURIComponent(ticker),options).then(value=>dispatch({type:'context',ticker,generation,value})).catch(e=>{if(e.name!=='AbortError')dispatch({type:'error',ticker,generation,error:e.message});});
    api('/api/workspace/history?ticker='+encodeURIComponent(ticker),options).then(value=>{if(!controller.signal.aborted&&value.ticker===ticker)setHistory(value);}).catch(e=>{if(e.name!=='AbortError'&&!controller.signal.aborted)setHistory({ticker,rows:[],error:e.message});});
    api('/api/workspace/research?ticker='+encodeURIComponent(ticker),options).then(value=>dispatch({type:'research',ticker,generation,value})).catch(e=>{if(e.name!=='AbortError')dispatch({type:'research',ticker,generation,value:{ticker,opinion:{side:'PASS',reason:e.message},errors:[],news:{articles:[]}}});}).finally(()=>{if(!controller.signal.aborted)setResearchLoading(false);});
    return()=>controller.abort();
  },[selection.ticker,selection.generation]);
  useEffect(()=>{
    if(!selection.ticker||paused||closed)return;const {ticker,generation}=selection;let stream,stopped=false,retryTimer,retries=0;
    const controller=new AbortController();
    const receive=value=>{if(!stopped)dispatch({type:'book',ticker,generation,value});};
    const refresh=()=>{if(!document.hidden&&!stopped)api('/api/book?ticker='+encodeURIComponent(ticker)+'&contracts=1',{signal:controller.signal}).then(value=>{receive({...value,transport:'public-rest-snapshot'});if(!stream)setStreamStatus('REST snapshot');}).catch(e=>{if(e.name!=='AbortError'&&!stopped)setStreamStatus('Quote unavailable');});};
    function connect(){if(stopped||document.hidden||stream)return;stream=new EventSource(API_BASE+'/api/stream?ticker='+encodeURIComponent(ticker));
      stream.onmessage=event=>{try{const value=JSON.parse(event.data);if(value.kind==='quote'){receive(value);setStreamStatus('Live stream');retries=0;}else if(value.kind==='connection')setStreamStatus(value.status==='connected'?'Live stream':value.status);}catch{setStreamStatus('Stream response unavailable');}};
      stream.onerror=()=>{stream?.close();stream=null;if(!stopped){setStreamStatus('Stream reconnecting');retryTimer=setTimeout(connect,Math.min(30000,1000*2**Math.min(retries++,5)));}};
    }
    refresh();connect();const interval=setInterval(refresh,30000);
    const visible=()=>{if(document.hidden){stream?.close();stream=null;clearTimeout(retryTimer);}else{refresh();connect();}};
    document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;controller.abort();stream?.close();clearInterval(interval);clearTimeout(retryTimer);document.removeEventListener('visibilitychange',visible);};
  },[selection.ticker,selection.generation,paused,closed]);
  async function lookup(event){event.preventDefault();if(!/^https:\/\/|^[A-Z0-9_.]+-[A-Z0-9_.-]+$/i.test(query.trim()))return;
    lookupRequest.current?.abort();const controller=new AbortController(),intent=++listIntent.current;lookupRequest.current=controller;
    setListLoading(true);setListError('');dispatch({type:'clear'});setHistory(null);
    try{const value=await api('/api/resolve?q='+encodeURIComponent(query.trim()),{signal:controller.signal});if(controller.signal.aborted||intent!==listIntent.current)return;
      setMarkets(value.contracts);setListLabel('Opened from link');setCoverage(null);if(value.contracts.length)select(value.contracts[0]);else setListError('No matching open contracts were returned.');
    }catch(e){if(e.name!=='AbortError'&&intent===listIntent.current)setListError(e.message);}finally{if(!controller.signal.aborted&&lookupRequest.current===controller)setListLoading(false);}}
  const filtered=useMemo(()=>{const q=query.toLowerCase().trim();if(!q||/^https:\/\//.test(q))return markets;return markets.filter(m=>(contractTitle(m)+' '+m.ticker).toLowerCase().includes(q));},[markets,query]);
  const opinions=useOpinions(listRoot,filtered);
  const market=selection.market,book=selection.book,fp=book?.raw?.orderbook_fp;
  const bid=fp?.yes_dollars?.length?Math.max(...fp.yes_dollars.map(row=>Number(row[0]))):null,ask=fp?.no_dollars?.length?1-Math.max(...fp.no_dollars.map(row=>Number(row[0]))):null;
  const age=book?Math.max(0,Math.floor((clock-Date.parse(book.as_of))/1000)):null;
  async function openSources(){setSourceStatus(null);setAttribution(null);setSources(true);
    await Promise.all([api('/api/workspace/sources').then(setSourceStatus).catch(e=>setSourceStatus({error:e.message})),
      api('/api/workspace/attribution').then(setAttribution).catch(e=>setAttribution({error:e.message}))]);}
  return <div className={'workspace '+(mobileDetail?'show-detail':'')+(assistant?' with-assistant':'')}>
    <a className="skip-link" href="#contract-content">Skip to selected contract</a>
    <aside className="sidebar"><a className="brand" href="/"><Activity size={24}/><span>Kalshi<br/><strong>Market Lab</strong></span></a><div className="nav-label">Markets</div><nav aria-label="Market categories">{categories.map(([id,name,Icon])=><button key={id} className={id===category?'active':''} aria-current={id===category?'page':undefined} onClick={()=>changeCategory(id)}><Icon size={18}/><span>{name}</span></button>)}</nav>
      <div className="sidebar-bottom"><button onClick={()=>setJournal(true)}><BookOpen size={18}/><span>Forecast journal</span></button><button onClick={openSources}><Database size={18}/><span>Data sources</span></button><a href="https://github.com/DaniyalHayat/predictir" target="_blank" rel="noreferrer"><ExternalLink size={16}/><span>Project source</span></a><small>predictir.dev <span>Paper trading only</span></small></div></aside>
    <main className="main-workspace"><header className="workspace-header"><div><span className="breadcrumb">Markets</span><span className="breadcrumb-separator">/</span><strong>{listLabel}</strong></div><div className="header-actions"><span className="paper-badge"><ShieldCheck size={14}/>Paper workspace</span><button className="secondary compact" onClick={()=>setJournal(true)}><BookOpen size={15}/><span>Journal</span></button></div></header>
      <div className="workspace-columns"><section className="market-list" aria-label="Market list"><div className="market-list-heading"><div><h1>{listLabel}</h1><span>{listLoading?'Loading contracts…':`${filtered.length} contracts`}</span></div><button className="icon-button" aria-label="Refresh market list" onClick={()=>setListRevision(v=>v+1)} disabled={listLoading}><RefreshCw size={17} className={listLoading?'spin':''}/></button></div>
        <form className="market-search" onSubmit={lookup}><Search size={17}/><label className="sr-only" htmlFor="market-search">Search contracts or paste a Kalshi URL</label><input id="market-search" ref={search} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search or paste a Kalshi URL"/><kbd>/</kbd></form>
        <div className="list-columns"><span>Contract</span><span>YES / NO</span></div>
        <div className="market-rows" ref={listRoot} aria-busy={listLoading}>{listError&&<div className="notice error" role="alert">{listError}<button className="text-button" onClick={()=>setListRevision(v=>v+1)}>Try again</button></div>}{listLoading&&<div className="list-loading" role="status"><Loader2 size={18} className="spin"/><span>Loading exchange contracts</span></div>}{filtered.map(row=><MarketRow key={row.ticker} row={row} selected={row.ticker===selection.ticker} opinion={row.ticker===selection.ticker?selection.research?.opinion||opinions[row.ticker]:opinions[row.ticker]} onSelect={select} onResearch={selectResearch}/>)}{!listLoading&&!filtered.length&&!listError&&<p className="empty">No matching contracts in this sample. Try another category or paste an exact Kalshi URL.</p>}</div>
        <div className="list-footer"><span className="status-dot"/>Exchange data{coverage?.partial&&<span>Partial coverage</span>}<button className="text-button" onClick={openSources}>Coverage</button></div>
      </section>
      <section className="contract-panel" id="contract-content" aria-label="Selected contract">{market?<>
        <div className="contract-heading"><button className="mobile-back text-button" onClick={()=>setMobileDetail(false)}><ArrowLeft size={16}/>Markets</button><div className="contract-meta"><span>{categories.find(c=>c[0]===market.category)?.[1]||listLabel}</span><span>Closes {dateLabel(market.close_time)}</span></div><h2 data-testid="selected-title">{contractTitle(market)}</h2><div className="contract-identity"><code data-testid="selected-ticker">{market.ticker}</code><a href={'https://kalshi.com/markets/'+(selection.research?.series||market.ticker.split('-')[0]).toLowerCase()} target="_blank" rel="noreferrer">On Kalshi <ArrowUpRight size={13}/></a></div></div>
        <div className="quote-strip"><div><small>YES ask</small><strong className="yes-price">{cents(ask)}</strong></div><div><small>NO ask</small><strong className="no-price">{bid===null?'—':cents(1-bid)}</strong></div><div><small>YES spread</small><strong>{bid===null||ask===null?'—':cents(ask-bid)}</strong></div><button className="stream-state" onClick={()=>setPaused(v=>!v)} aria-pressed={paused}><span className={'status-dot '+(age===null||age>90||paused||closed?'delayed':'')}/><span>{closed?'Closed':paused?'Stream paused':streamStatus}<small>{age===null?'Waiting for quote':`${age}s since observation`}</small></span><ChevronDown size={14}/></button></div>
        {selection.error&&<div className="notice error" role="alert">{selection.error}</div>}
        <div className="contract-tabs" role="tablist" aria-label="Contract details">{[['overview','Overview'],['research','Analysis'],['paper','Paper position'],['rules','Rules & sources']].map(([id,label])=><button key={id} id={'contract-tab-'+id} role="tab" aria-selected={tab===id} aria-controls="contract-tabpanel" tabIndex={tab===id?0:-1} onKeyDown={event=>{const ids=['overview','research','paper','rules'];let next;if(event.key==='ArrowRight')next=ids[(ids.indexOf(id)+1)%ids.length];if(event.key==='ArrowLeft')next=ids[(ids.indexOf(id)+3)%ids.length];if(event.key==='Home')next=ids[0];if(event.key==='End')next=ids.at(-1);if(next){event.preventDefault();setTab(next);document.getElementById('contract-tab-'+next)?.focus();}}} onClick={()=>setTab(id)}>{label}{id==='research'&&researchLoading&&<Loader2 size={12} className="spin"/>}</button>)}<button className="ask-button" onClick={()=>setAssistant(v=>!v)} aria-expanded={assistant}><MessageSquare size={15}/><span>Ask</span></button></div>
        <div className="contract-scroll" key={market.ticker} id="contract-tabpanel" role="tabpanel" aria-labelledby={'contract-tab-'+tab} tabIndex={0}>
          {tab==='overview'&&<><div className="section-title"><h3>Exchange price history</h3><span className="tag">24h</span></div><Chart rows={history?.rows||[]} error={history?.error} label={'Observed exchange price history for '+contractTitle(market)}/>{history?.as_of&&<p className="history-scope footnote">Checked {dateLabel(history.as_of)}. {history.scope||'Exchange candle closes; missing observations are not filled.'}</p>}<div className="section-title"><h3>Order book</h3><small>{book?.transport==='exchange-websocket'?'Native exchange stream':'Observed snapshot'}</small></div><Depth book={book}/><div className="section-title"><h3>Research view</h3><button className="text-button" onClick={()=>setTab('research')}>Full analysis <ArrowUpRight size={14}/></button></div><Research compact value={selection.research} loading={researchLoading} onAssistant={()=>setAssistant(true)}/></>}
          {tab==='research'&&<Research value={selection.research} loading={researchLoading} onAssistant={()=>setAssistant(true)}/>}
          {tab==='paper'&&<Paper key={market.ticker} market={market} book={book} forecast={selection.research?.forecast} fees={selection.fees} now={clock}/>}
          {tab==='rules'&&<><div className="section-title"><h3>Settlement rules</h3></div><p className="rule-text">{market.rules_primary||'No primary rule text was returned. Inspect the exchange contract.'}</p>{market.rules_secondary&&<details className="method"><summary>Secondary rules</summary><p>{market.rules_secondary}</p></details>}<dl className="definition-list"><div><dt>Trading close</dt><dd>{dateLabel(market.close_time)}</dd></div><div><dt>Expected expiration</dt><dd>{dateLabel(market.expected_expiration_time)}</dd></div><div><dt>Status / outcome</dt><dd>{market.status||'Unknown'} / {market.result||'Unsettled'}</dd></div></dl><h3>Source records</h3><SourceRows sources={selection.research?.sources||[]}/><p className="footnote">Close, expiration and settlement are separate events. Source timestamps and missing evidence remain visible.</p></>}
        </div></>:<div className="contract-placeholder"><Activity size={28}/><h2>Select a contract</h2><p>Its rules, prices and analysis will appear here.</p></div>}</section>
      {assistant&&market&&<Assistant key={market.ticker} market={market} research={selection.research} onClose={()=>setAssistant(false)}/>}
      </div>
    </main>
    {journal&&<Journal onClose={()=>setJournal(false)}/>}
    {sources&&<Modal titleId="sources-title" onClose={()=>setSources(false)}><div className="dialog-heading"><div><h2 id="sources-title">Data sources</h2><p>Coverage and source freshness for this workspace.</p></div><button className="icon-button" aria-label="Close source details" onClick={()=>setSources(false)}><X size={20}/></button></div>{!sourceStatus&&<p className="loading-section" role="status"><Loader2 className="spin" size={18}/>Checking provider status…</p>}<div className="source-status">{sourceStatus?.providers?.map(row=><div key={row.id}><strong>{row.name}</strong><span>{row.status}</span><small>{row.detail||dateLabel(row.as_of)}</small></div>)}</div>{sourceStatus&&!sourceStatus.error&&!sourceStatus.providers?.length&&<p className="empty">No external provider status has been recorded yet. This does not confirm that a provider is connected.</p>}{coverage&&<details className="method" open><summary>Current market-list coverage</summary><p>{coverage.scope}</p>{coverage.coverage?.map(row=><p key={row.series}><strong>{row.series}</strong>: {count(row.records)} contracts · checked {dateLabel(row.as_of)}{row.truncated?' · additional contracts are outside this sample':''}</p>)}{coverage.errors?.map(row=><p key={row.series}>{row.series}: {row.error}</p>)}</details>}<MarketAttribution value={attribution}/>{sourceStatus?.warehouse?.configured&&<div className="warehouse-counts"><strong>{count(sourceStatus.warehouse.market_observations)} market observations</strong><span>{count(sourceStatus.warehouse.source_batches)} source batches · {count(sourceStatus.warehouse.completed_games)} completed sports games</span></div>}{sourceStatus?.warehouse?.configured===false&&<p className="notice">Durable source history is not configured on this service.</p>}{sourceStatus?.error&&<p className="notice error" role="alert">{sourceStatus.error}</p>}<p className="footnote">Market lists are bounded source samples, not the whole exchange. Model outputs and public observations are labeled separately. No real order route is exposed.</p></Modal>}
  </div>;
}
