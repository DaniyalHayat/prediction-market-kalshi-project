'use client';
import {memo,useCallback,useEffect,useMemo,useReducer,useRef,useState} from 'react';
import dynamic from 'next/dynamic';
import {Activity,ArrowLeft,ArrowUpRight,Bitcoin,BookOpen,Check,ChevronDown,CloudSun,Database,ExternalLink,FlaskConical,
  Leaf,Loader2,MessageSquare,Music2,Plane,RefreshCw,Search,Trophy,Landmark,X,Palette,ChartNoAxesCombined,Wallet,LayoutDashboard,FileText,UserRound,Bookmark} from 'lucide-react';
import {api,API_BASE,cents,count,dollars,percent,dateLabel} from './api.mjs';
import {initialSelection,selectionReducer,contractTitle,refreshMarketRows} from './selection';
import Chart from './Chart';
import Modal from './Modal';
import useOpinions from './useOpinions.jsx';
import Appearance from './Appearance.jsx';
import {appearance,DEFAULT_PREFERENCES,PREFERENCE_KEY} from './preferences';
import {mergeResearchRefresh,researchRefreshDelay} from './research-state';
import {researchScreenOpinion,screenFreshness} from './screen-freshness';
import ContractNews,{ReadMode,ReadText} from './ContractNews.jsx';
import useAccount,{toggleSavedMarket} from './useAccount.jsx';
import {CONTRACT_TABS,moveContractTab} from './contract-tabs';
import {assistantContext} from './assistant-context.mjs';
import usePaperLedger from './usePaperLedger.jsx';
import usePositionReviews from './usePositionReviews.jsx';
import './execution-lab.css';
import './position-review.css';
const Portfolio=dynamic(()=>import('./Portfolio.jsx'),{loading:()=> <div className="workspace-empty" role="status">Loading portfolio…</div>});
const Recommendations=dynamic(()=>import('./Recommendations.jsx'),{loading:()=> <div className="workspace-empty" role="status">Loading research screen…</div>});
const ExecutionLab=dynamic(()=>import('./ExecutionLab.jsx'),{loading:()=> <div className="workspace-empty" role="status">Loading execution lab…</div>});
const Paper=dynamic(()=>import('./Paper.jsx'));
const Journal=dynamic(()=>import('./Journal.jsx'));
const Assistant=dynamic(()=>import('./Assistant'),{loading:()=> <aside className="assistant-panel" role="status"><div className="assistant-heading"><Loader2 size={16} className="spin"/> Opening Ask Why…</div></aside>});
const Account=dynamic(()=>import('./Account.jsx'));
const marketPageSize=48;
const noPositions=[];

const categories=[['sports','Sports',Trophy],['macro','Economy',Landmark],['crypto','Crypto',Bitcoin],['travel','Travel',Plane],
  ['weather','Weather',CloudSun],['science','Tech & science',FlaskConical],['climate','Climate',Leaf],['culture','Culture',Music2]];
const safeURL=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
function AskWhy({panel,onAsk,label}){
  return <button type="button" className="text-button" onClick={()=>onAsk(panel)} aria-label={'Ask why about '+label}>Ask why <ArrowUpRight size={14}/></button>;
}

const MarketRow=memo(function MarketRow({row,selected,opinion,onSelect,onResearch,livePrices}) {
  const side=opinion?.side;
  return <div className={'market-row '+(selected?'selected':'')} data-market-ticker={row.ticker}>
    <button className="market-select" data-analytics-market={row.ticker} data-analytics-category={row.category} onClick={()=>onSelect(row)} aria-label={'Open '+contractTitle(row)} aria-current={selected?'true':undefined}>
      <div><span className="row-series">{row.series||row.ticker.split('-')[0]}</span><h2>{contractTitle(row)}</h2>{row.event_ticker&&<small className="row-event">Event {row.event_ticker}</small>}<small>{count(row.volume_24h)} 24h contracts · closes {dateLabel(row.close_time)}</small></div>
      <div className="row-prices"><strong>{cents(livePrices?livePrices.yes:row.yes_ask)}</strong><span>{livePrices?cents(livePrices.no):Number.isFinite(row.yes_bid)?cents(1-row.yes_bid):'—'}</span></div>
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
function PricePath({signal,now}){
  if(!signal)return null;
  const age=now-Date.parse(signal.observed_at),current=signal.status==='available'&&age>=0&&age<=180000;
  return <section className="method"><div className="section-title"><h3>One-minute price model</h3><span className="tag">Exchange quotes</span></div>
    {current?<><div className="model-numbers"><div><small>Last midpoint</small><strong>{cents(signal.last_midpoint)}</strong></div><div><small>Next YES midpoint</small><strong>{cents(signal.prediction)}</strong></div><div><small>{signal.replay?'Replay residual range':'Recent quote changes'}</small><strong>{signal.replay?signal.interval.map(cents).join(' – '):count(signal.updates)}</strong></div></div>
      {signal.replay?<><p>{signal.model} · {count(signal.replay.replay_n)} held-out minute steps · {cents(signal.replay.model_rmse)} model error vs {cents(signal.replay.persistence_rmse)} with no price change.</p>
        <details><summary>How this was tested</summary><p>{signal.scope} Coverage on the replay segment was {percent(signal.replay.residual_range_coverage)}. The modeled quantity is the quote midpoint.</p></details></>:<p>{signal.scope} A holdout needs more observations.</p>}</>:
      <p className="muted">{signal.reason||'Waiting for a recent candle before showing the next-minute estimate.'}</p>}</section>;
}
function ResearchReading({value,long,stale}){
  const forecast=value.forecast,validation=forecast?.validation,coverage=value.extensions?.sports?.coverage;
  const analysis=long?value.analysis?.long_read:value.analysis?.summary;
  if(analysis)return <div className="reading-copy"><ReadText value={analysis}/></div>;
  const reason=stale?'The inputs are being refreshed. Recheck the current research before relying on the displayed figures.':
    value.decision?.reasons?.[0]||forecast?.reason||value.opinion?.reason;
  const otherReasons=[...new Set(value.decision?.reasons||[])].filter(row=>row!==reason).slice(0,4);
  const qualified=Number.isFinite(forecast?.probability)&&!stale;
  return <section className="reading-copy" aria-label="Analysis explanation">
    <h4>{long?'How to read the result':'What drove this view'}</h4>
    {reason&&<p>{reason}</p>}
    {qualified&&<p>{forecast.model_name||'The independent model'} estimates the contract outcome. Paper entry also depends on the quoted price, fees and the available depth.</p>}
    {long&&<>{otherReasons.map(row=><p key={row}>{row}</p>)}
      {value.model_selection?.reason&&<p>{value.model_selection.reason}</p>}
      {validation?.reason&&validation.reason!==reason&&!otherReasons.includes(validation.reason)&&<p>{validation.reason}</p>}
      {coverage?.partial&&<p>{Number.isFinite(coverage.schedules_expected)&&Number.isFinite(coverage.schedules_returned)?`The source returned ${count(coverage.schedules_returned)} of ${count(coverage.schedules_expected)} requested schedules.`:'Schedule coverage is incomplete.'} Missing games stay out of the matchup history.</p>}
      {value.decision?.validation_note&&<p>{value.decision.validation_note}</p>}
      <p>Compare the settlement rule and its named source with the inputs to the estimate. Quoted depth can change before a hypothetical fill.</p>
    </>}
  </section>;
}
function Research({value,loading,onAssistant,onPaper,history,now,compact=false}) {
  const [readMode,setReadMode]=useState('summary');
  if(loading&&!value)return <div className="loading-section"><Loader2 className="spin" size={18}/><div><strong>Checking sources and models</strong><p>Quotes remain available while the research loads.</p></div></div>;
  if(!value)return <p className="empty">Research is not available for this contract.</p>;
  const forecast=value.forecast,screen=researchScreenOpinion(value,now),stale=Boolean(screen?.stale),side=screen?.side||'PASS';
  const feedback=forecast?.availability_feedback,lineup=feedback?.status==='available'?feedback.scenarios?.[0]:null;
  const availabilityLink=safeURL(feedback?.source?.url);
  const replay=forecast?.backtest?.url;
  const replayLink=['/research/weekly-tsa.json','/research/crypto-minute.json'].includes(replay)?replay:null;
  const setups=(value.paper_scenarios||[]).filter(row=>screenFreshness(row,{now,error:value.error}).current).sort((a,b)=>
    (b.point_edge??-Infinity)-(a.point_edge??-Infinity)||(a.required_edge??Infinity)-(b.required_edge??Infinity));
  const label=side==='PASS'?(setups.some(row=>row.scenario_eligible)?'Paper idea':'Compare sides'):side;
  const opinion=<div className={'opinion-card '+side.toLowerCase()}><div className="section-title"><h3>{compact?'Entry check':'Outcome research'}</h3><span className={'verdict '+(side==='PASS'?'unchecked':side.toLowerCase())}>{label}</span></div>
    <p>{stale?'Checking current model inputs and depth.':forecast?.outcomes?value.summary:Number.isFinite(forecast?.probability)?(value.summary||value.opinion?.reason):'Compare YES and NO entry prices with the payout needed to make each paper trade worthwhile.'}</p>
    {!stale&&Number.isFinite(forecast?.probability)&&<div className="model-numbers"><div><small>{forecast.outcomes?'YES team win chance':lineup?'Baseline P(YES)':forecast.evidence?.tier===1?'Scenario P(YES)':'Independent P(YES)'}</small><strong>{percent(forecast.probability)}</strong></div><div><small>{forecast.outcomes?'Tie chance':lineup?'Decision range':forecast.evidence?.tier===1?'Sensitivity range':'Model range'}</small><strong>{forecast.outcomes?percent(forecast.outcomes.tie):forecast.interval?.map(percent).join(' – ')||'Unavailable'}</strong></div><div><small>{forecast.outcomes?'Expected YES payout':'Evidence'}</small><strong>{forecast.outcomes?cents(forecast.expected_settlement_value):forecast.evidence?.label||'Research scenario'}</strong></div></div>}
    {!stale&&lineup&&<p><strong>Lineup check.</strong> {lineup.name} is listed {lineup.status.toLowerCase()}. Stress-testing the absence gives {percent(lineup.conditional_probability)} YES. The paper screen checks the decision range against costs. {availabilityLink&&<a href={availabilityLink} target="_blank" rel="noreferrer">See the game report</a>}</p>}
    {!stale&&replayLink&&<p className="footnote"><a href={replayLink} target="_blank" rel="noreferrer">View settled-contract backtest</a></p>}
    <small className="screen-stamp">Checked {dateLabel(value.as_of)}</small><button className="text-button" onClick={()=>onAssistant('analysis',{detail:readMode==='long'?'full':'brief'})} aria-label="Ask why about this analysis">Ask why <ArrowUpRight size={14}/></button></div>;
  const paper=setups.length>0&&<section className="method"><div className="section-title"><h3>Trade a $20 paper scenario</h3><small>Fees and visible depth included</small></div><div className="scenario-comparison">{setups.map(row=><div key={row.side}><small>{row.side} · {count(row.contracts)} contracts</small><strong>{cents(row.break_even)} all-in per contract</strong><span>{dollars(row.cost)} entry · {dollars(row.win_value)} balance at full payout</span>
    <span>{Number.isFinite(row.expected_profit)?`${dollars(row.expected_profit)} model expected P/L`:Number.isFinite(row.required_edge)?`Needs ${cents(row.required_edge)} above the quote midpoint to break even`:'A two-sided quote is needed to compare the midpoint.'}</span>
    {Number.isFinite(row.tie_value)&&<span>{dollars(row.tie_value)} balance on a tie</span>}<button className="text-button" onClick={()=>onPaper(row)}>{row.scenario_eligible?'Try':'Compare'} {row.side} in Paper <ArrowUpRight size={14}/></button></div>)}</div></section>;
  const path=<PricePath signal={history?.market_signal} now={now}/>;
  if(compact)return <>{opinion}{paper}{path}</>;
  const diagnostic=value.settlement_diagnostic;
  return <div className="research-content"><div className="readout-heading"><div><span className="eyebrow">Contract analysis</span><h3>The research brief</h3></div><ReadMode value={readMode} onChange={setReadMode} label="Contract analysis reading length"/></div>{opinion}
    {paper}{path}{!stale&&diagnostic?.available&&<details className="method"><summary>Settlement calibration experiment · {percent(diagnostic.probability)} YES</summary><p>Uses the exchange midpoint as its input. On {diagnostic.validation.overall.n} held-out events, the calibrated model scored {diagnostic.validation.overall.challenger_brier.toFixed(4)} Brier versus {diagnostic.validation.overall.midpoint_brier.toFixed(4)} for the midpoint. Lower is better. This estimate stays out of paper sizing.</p><p>{diagnostic.category_coverage.holdout_n} held-out events in this category. <a href={diagnostic.validation_url} target="_blank" rel="noreferrer">View validation data</a></p></details>}
    <ResearchReading value={value} long={readMode==='long'} stale={stale}/>
    <div className="section-title"><h3>What matters here</h3></div><div className="driver-list">{value.drivers?.slice(0,readMode==='long'?12:3).map(driver=><div key={driver.name}><Check size={15}/><div><strong>{driver.name}</strong><p>{driver.detail}</p></div></div>)}</div>
    {readMode==='long'&&value.extensions?.sports&&<SportsResearch value={value.extensions.sports}/>}
    {readMode==='long'&&value.extensions?.music&&<MusicResearch value={value.extensions.music}/>}
    {readMode==='summary'&&(value.extensions?.sports||value.extensions?.music)&&<button className="text-button long-read-link" onClick={()=>setReadMode('long')}>Read model details and supporting evidence <ArrowUpRight size={14}/></button>}
    <ContractNews ticker={value.ticker} model={value.view_model} initial={value.evidence} articles={value.news?.articles} feedback={feedback} onAssistant={options=>onAssistant('evidence',options)}/>
    <details className="method"><summary>Method, validation and limitations</summary><p>{value.summary}</p><p>{value.decision?.validation_note}</p>{value.errors?.map((error,i)=><p key={i}>{error.source}: {error.error}</p>)}</details>
  </div>;
}
function SportsResearch({value}) {
  const scoreAge=Date.now()-Date.parse(value.live_score?.observed_at||''),scoreCurrent=Number.isFinite(scoreAge)&&scoreAge>=-5000&&scoreAge<30000;
  const liveForecastCurrent=screenFreshness({probability:value.challenger?.probability,as_of:value.challenger?.source_as_of,source_as_of:value.challenger?.source_as_of,
    max_source_age_seconds:value.challenger?.max_source_age_seconds,inplay:true}).current;
  return <section className="sports-research"><div className="section-title"><h3>Matchup history</h3><small>{value.league?.toUpperCase()}</small></div>
    {value.live_score?.available&&<div className="live-score-panel"><div className="section-title"><h3>{scoreCurrent?'Live game':'Last observed game score'}</h3><span className="tag">Observed score</span></div><div className="score-line"><span>{value.event?.away_name}<strong>{value.live_score.away_score}</strong></span><div>Q{value.live_score.period}<b>{value.live_score.display_clock}</b></div><span>{value.event?.home_name}<strong>{value.live_score.home_score}</strong></span></div><p className="footnote">Observed {dateLabel(value.live_score.observed_at)}. {value.live_score.freshness_note}</p></div>}
    {value.reason&&<p className="notice">{value.reason}</p>}
    {value.coverage?.partial&&<p className="notice">Schedule coverage is incomplete. Missing games are excluded from form and model calculations.</p>}
    <div className="form-grid">{value.teams?.map(team=>{const form=team.form_last_five||team.form;return <div key={team.id}><strong>{team.name}</strong><span>{form?.wins??0}–{form?.losses??0}{form?.draws?`–${form.draws}`:''} in {form?.games??0} recent completed games</span><div className="form-dots">{form?.results?.map((result,i)=><span className={result==='W'?'win':result==='L'?'loss':'draw'} key={i}>{result}</span>)}</div>{team.last_five_games?.length>0&&<details className="recent-team-games"><summary>Last five results</summary><ol>{team.last_five_games.map((game,index)=><li key={game.id||index}><span>{game.away_name} at {game.home_name}</span><strong>{game.away_score}–{game.home_score}</strong><small>{dateLabel(game.played_at)}</small></li>)}</ol></details>}</div>;})}</div>
    <div className="table-scroll"><table><thead><tr><th>Recent meetings</th><th>Result</th><th>Date</th></tr></thead><tbody>{value.head_to_head?.map(game=><tr key={game.id}><td>{game.away_name} at {game.home_name}</td><td>{game.away_score}–{game.home_score}</td><td>{dateLabel(game.played_at)}</td></tr>)}</tbody></table></div>
    {!value.head_to_head?.length&&<p className="empty">No earlier matched meetings were returned in this history window.</p>}
    {value.player_stats?.length>0&&<section className="player-evidence"><div className="section-title"><h3>Observed player performance</h3><span>Recent completed games</span></div><div className="table-scroll"><table><thead><tr><th>Player</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>Sample</th></tr></thead><tbody>{value.player_stats.map((player,index)=><tr key={player.id||player.name||index}><td><strong>{player.name}</strong>{player.reported_status&&<small>{player.reported_status}</small>}</td><td>{count(player.averages?.minutes)}</td><td>{count(player.averages?.points)}</td><td>{count(player.averages?.rebounds)}</td><td>{count(player.averages?.assists)}</td><td>{player.games_observed??0}/{player.games_expected??'—'} games</td></tr>)}</tbody></table></div><p className="footnote">Averages use the returned box scores. Missing games are excluded.</p></section>}
    {value.lineup_scenarios?.length>0&&<section className="lineup-evidence"><div className="section-title"><h3>Availability and minutes context</h3></div>{value.lineup_scenarios.map((player,index)=><details className="method" key={player.id||player.name||index}><summary>{player.name} · {player.reported_status||'Minutes comparison'}</summary><div className="scenario-comparison">{[['low','Lower minutes'],['regular','Regular minutes']].map(([key,label])=>{const group=player[key];return group&&<div key={key}><small>{label}</small><strong>{Number.isFinite(group.rate)?percent(group.rate):'No estimate'}</strong><span>{group.n??0} observed team games</span></div>;})}</div><p>Threshold: {player.threshold_minutes??'—'} minutes. Historical splits describe different games and lineups. They do not isolate this player’s effect or establish a change in win probability.</p>{player.observed_low_minutes_games?.length>0&&<p>{player.observed_low_minutes_games.length} matched games with low observed minutes are included in this context.</p>}</details>)}</section>}
    {value.bookmaker?.probabilities&&<div className="bookmaker-comparison"><h4>Bookmaker comparison</h4><div className="form-grid">{[['home',value.teams?.[0]?.name||'Home'],['draw','Draw'],['away',value.teams?.[1]?.name||'Away']].filter(([side])=>Number.isFinite(value.bookmaker.probabilities[side])).map(([side,name])=><div key={side}><strong>{name}</strong><span>{percent(value.bookmaker.probabilities[side])} implied after proportional margin removal</span></div>)}</div><p className="footnote">{value.bookmaker.provider}{Number.isFinite(value.bookmaker.overround)?` · reported overround ${percent(value.bookmaker.overround)}`:''}. {value.bookmaker.note}</p></div>}
    {value.availability?.map(row=><div className="availability" key={row.player_id||row.name}><strong>{row.name}</strong><span>{row.status} · {row.detail}</span>{row.comparison&&<details className="method"><summary>Observed minutes and team results</summary><div className="table-scroll"><table><thead><tr><th>Observed minutes</th><th>Games</th><th>Team win rate</th><th>95% interval</th></tr></thead><tbody>{[['low',`≤ ${row.comparison.threshold_minutes} minutes`],['regular',`> ${row.comparison.threshold_minutes} minutes`]].map(([key,label])=>{const group=row.comparison[key];return group&&<tr key={key}><td>{label}</td><td>{count(group.n)}</td><td>{percent(group.rate)}</td><td>{group.n&&Array.isArray(group.interval)?group.interval.map(percent).join(' – '):'No observations'}</td></tr>;})}</tbody></table></div><p>{row.comparison.note}</p></details>}</div>)}
    {value.availability_note&&<p className="footnote">{value.availability_note}</p>}
    {value.challenger?.available&&!value.challenger.inplay&&<div className="challenger-comparison"><div className="section-title"><h3>Trained ensemble comparison</h3><span className="tag">Experimental</span></div><p>{value.challenger.model_name}</p><div className="model-numbers"><div><small>Baseline holdout Brier</small><strong>{Number.isFinite(value.challenger.comparison?.baseline_holdout_brier)?value.challenger.comparison.baseline_holdout_brier.toFixed(4):'—'}</strong></div><div><small>Ensemble holdout Brier</small><strong>{Number.isFinite(value.challenger.comparison?.challenger_holdout_brier)?value.challenger.comparison.challenger_holdout_brier.toFixed(4):'—'}</strong></div><div><small>Relative Brier improvement</small><strong>{percent(value.challenger.comparison?.relative_brier_improvement)}</strong></div></div><p className="footnote">{value.challenger.promotion_reason} Lower Brier loss is better. A measured point improvement is separate from statistical evidence that it generalizes.</p></div>}
    {value.challenger?.inplay&&<div className="challenger-comparison"><div className="section-title"><h3>Score and clock estimate</h3><span className="tag">Experimental</span></div><p>{value.challenger.model_name||'Conditional live-game research'}</p>{value.challenger.available&&liveForecastCurrent?<><div className="model-numbers"><div><small>Experimental P(YES)</small><strong>{percent(value.challenger.probability)}</strong></div><div><small>Model range</small><strong>{value.challenger.interval?.map(percent).join(' – ')}</strong></div><div><small>Remaining regulation</small><strong>{Number.isFinite(value.challenger.remaining_regulation_seconds)?Math.ceil(value.challenger.remaining_regulation_seconds/60)+' min':'—'}</strong></div></div><p className="footnote">Calibration: {value.challenger.empirical_scale?.calibration_games??'—'} historical games. Holdout: {value.challenger.validation?.heldout_games??'—'} games / {value.challenger.validation?.n??'—'} score states. Multiple states from one game are related observations. The model remains experimental.</p></>:<p className="notice">{value.challenger.available?'The previous score-clock estimate is stale. A fresh independent source check is required.':value.challenger.reason||'A fresh matching score and game clock were not available.'}</p>}{value.challenger.assumptions?.length>0&&<details className="method"><summary>Live-model assumptions</summary>{value.challenger.assumptions.map((item,index)=><p key={index}>{item}</p>)}</details>}</div>}
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
    {value.spotify?.references?.length>0&&<><h4>Spotify references</h4><div className="source-list">{value.spotify.references.map(row=><a className="source-row" key={row.id} href={row.url} target="_blank" rel="noreferrer"><span><strong>{row.name}</strong><small>{row.artists?.join(', ')||'Spotify artist reference'}</small></span><ArrowUpRight size={15}/></a>)}</div><p className="footnote">Spotify catalog references are displayed separately and are not sent to the assistant or forecasting models.</p></>}
  </section>;
}
function MarketAttribution({value}) {
  if(!value)return <p className="muted">Loading observed market moves…</p>;
  if(value.error)return <p className="notice">Observed market moves are unavailable: {value.error}</p>;
  return <details className="method"><summary>Observed market moves</summary><p>{value.scope}</p>
    {value.rows?.length?<div className="table-scroll"><table><thead><tr><th>Contract</th><th>First midpoint</th><th>Latest midpoint</th><th>Change</th><th>Observations</th></tr></thead><tbody>{value.rows.slice(0,12).map(row=><tr key={row.ticker}><td><strong>{row.title||row.ticker}</strong><small>{row.ticker}</small><small>{dateLabel(row.first_observed)} to {dateLabel(row.last_observed)}</small></td><td>{cents(row.first_midpoint)}</td><td>{cents(row.last_midpoint)}</td><td>{Number.isFinite(row.observed_price_change)&&row.observed_price_change>0?'+':''}{cents(row.observed_price_change)}</td><td>{count(row.observations)}</td></tr>)}</tbody></table></div>:<p>At least two comparable observed quotes are needed. No market moves are invented before that history exists.</p>}
  </details>;
}

export default function App({paperWorkspace=false}={}) {
  const account=useAccount();
  const paperLedger=usePaperLedger();
  const [category,setCategory]=useState('sports'),[markets,setMarkets]=useState([]),[query,setQuery]=useState(''),[listLabel,setListLabel]=useState('Sports'),
    [listLoading,setListLoading]=useState(true),[listError,setListError]=useState(''),[coverage,setCoverage]=useState(null),[rowLimit,setRowLimit]=useState(marketPageSize),
    [selection,dispatch]=useReducer(selectionReducer,initialSelection),[history,setHistory]=useState(null),[tab,setTab]=useState('overview'),
    [researchLoading,setResearchLoading]=useState(false),[streamStatus,setStreamStatus]=useState('Connecting'),[paused,setPaused]=useState(false),
    [assistant,setAssistant]=useState(false),[journal,setJournal]=useState(false),[sources,setSources]=useState(false),[sourceStatus,setSourceStatus]=useState(null),[attribution,setAttribution]=useState(null),
    [mobileDetail,setMobileDetail]=useState(false),[clock,setClock]=useState(Date.now()),[listRevision,setListRevision]=useState(0),
    [view,setView]=useState('markets'),[preferences,setPreferences]=useState(DEFAULT_PREFERENCES),[appearanceOpen,setAppearanceOpen]=useState(false),
    [preferenceError,setPreferenceError]=useState(false),[paperPreset,setPaperPreset]=useState(null),[navigationError,setNavigationError]=useState(''),
    [archiveOpen,setArchiveOpen]=useState(false),[archiveResult,setArchiveResult]=useState(null),[archiveError,setArchiveError]=useState(''),[archiveQuery,setArchiveQuery]=useState(''),[accountOpen,setAccountOpen]=useState(false),[executionContext,setExecutionContext]=useState(null);
  const search=useRef(null),listIntent=useRef(0),listRoot=useRef(null),lookupRequest=useRef(null),archiveRequest=useRef(null),assistantSequence=useRef(0);
  const reviews=usePositionReviews(paperLedger.ledger?.positions||noPositions,preferences.model);
  const activeView=useRef(view);activeView.current=view;
  const closed=Boolean(selection.market&&(['closed','settled','finalized'].includes(selection.market.status)||Date.parse(selection.market.close_time)<=clock));
  const select=useCallback((market,{openDetail=true}={})=>{listIntent.current++;dispatch({type:'select',market});setAssistant(false);setHistory(null);setTab('overview');setPaused(false);setMobileDetail(openDetail);},[]);
  const openMarket=useCallback(market=>{setView('markets');setPaperPreset(null);select(market);},[select]);
  const selectResearch=useCallback(market=>{openMarket(market);setTab('research');},[openMarket]);
  function changeCategory(id){setMobileDetail(false);if(view==='portfolio')setView('markets');if(id===category)return;lookupRequest.current?.abort();listIntent.current++;dispatch({type:'clear'});setHistory(null);setCoverage(null);setResearchLoading(false);setAssistant(false);setPaperPreset(null);setMarkets([]);setQuery('');setRowLimit(marketPageSize);setCategory(id);}
  function updatePreferences(value){const next=appearance(value);if(next.model!==preferences.model)setAssistant(false);setPreferences(next);try{localStorage.setItem(PREFERENCE_KEY,JSON.stringify(next));setPreferenceError(false);}catch{setPreferenceError(true);}}
  useEffect(()=>{try{setPreferences(appearance(localStorage.getItem(PREFERENCE_KEY)));}catch{setPreferenceError(true);}},[]);
  useEffect(()=>{document.documentElement.dataset.theme=preferences.theme;},[preferences.theme]);
  useEffect(()=>{const id=setInterval(()=>{if(!document.hidden&&activeView.current!=='ranked')setClock(Date.now());},1000);const key=e=>{if(e.key==='Escape'){setAssistant(false);setJournal(false);setSources(false);setAppearanceOpen(false);setArchiveOpen(false);}if(e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)&&!document.querySelector('.overlay,.assistant-panel')){e.preventDefault();setView('markets');setMobileDetail(false);requestAnimationFrame(()=>search.current?.focus());}};document.addEventListener('keydown',key);return()=>{clearInterval(id);document.removeEventListener('keydown',key);lookupRequest.current?.abort();};},[]);
  useEffect(()=>{
    const controller=new AbortController(),intent=listIntent.current,keepSelection=Boolean(selection.ticker&&listLabel!=='Opened from link');
    setListLoading(true);setListError('');setListLabel(categories.find(c=>c[0]===category)[1]);
    api('/api/workspace/markets?category='+category,{signal:controller.signal,timeoutMs:20000}).then(value=>{
      if(controller.signal.aborted||intent!==listIntent.current)return;
      setMarkets(value.markets);setCoverage(value);if(value.markets.length&&!keepSelection)select(value.markets[0],{openDetail:false});
    }).catch(e=>{if(e.name!=='AbortError'&&!controller.signal.aborted)setListError(e.message);}).finally(()=>{if(!controller.signal.aborted)setListLoading(false);});
    return()=>controller.abort();
  },[category,listRevision]);
  useEffect(()=>{
    if(view!=='markets'||listLoading||listLabel==='Opened from link')return;
    const controller=new AbortController();let busy=false;
    const refresh=async()=>{if(document.hidden||busy)return;busy=true;const intent=listIntent.current;
      try{const value=await api('/api/workspace/markets?category='+category,{signal:controller.signal,timeoutMs:20000});if(!controller.signal.aborted&&intent===listIntent.current){setMarkets(current=>refreshMarketRows(current,value.markets));setCoverage(value);setListError('');if(!selection.ticker&&value.markets.length)select(value.markets[0],{openDetail:false});}}
      catch{}finally{busy=false;}};
    const timer=setInterval(refresh,coverage?.stale?8000:listError?30000:60000);document.addEventListener('visibilitychange',refresh);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[category,view,listLoading,listLabel,coverage?.stale,listError,selection.ticker,select]);
  useEffect(()=>{
    if(!selection.ticker||view!=='markets')return;
    const {ticker,generation}=selection,controller=new AbortController();setResearchLoading(true);setStreamStatus('Loading quote');
    let running=false,lastRequest=0,lastFull=0,lastHistory=0,previous=null;
    const options={signal:controller.signal};
    api('/api/workspace/context?ticker='+encodeURIComponent(ticker),options).then(value=>{if(!controller.signal.aborted)dispatch({type:'context',ticker,generation,value});}).catch(e=>{if(e.name!=='AbortError'&&!controller.signal.aborted)dispatch({type:'error',ticker,generation,error:e.message});});
    function refreshHistory(){
      if(document.hidden||Date.now()-lastHistory<60000)return;
      lastHistory=Date.now();
      api('/api/workspace/history?ticker='+encodeURIComponent(ticker),options).then(value=>{if(!controller.signal.aborted&&value.ticker===ticker)setHistory(value);}).catch(e=>{if(e.name!=='AbortError'&&!controller.signal.aborted)setHistory(previous=>previous?.ticker===ticker?previous:{ticker,rows:[],error:e.message});});
    }
    refreshHistory();
    async function refreshResearch(compact=false){
      if(running||document.hidden||controller.signal.aborted)return;running=true;lastRequest=Date.now();if(!compact)lastFull=lastRequest;
      try{const value=await api('/api/workspace/research?ticker='+encodeURIComponent(ticker)+'&model='+preferences.model+(compact?'&compact=1':''),{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(60000)])});
        if(controller.signal.aborted||value.ticker!==ticker)return;const packet={...value,view_model:preferences.model};previous=compact?mergeResearchRefresh(previous,packet):packet;dispatch({type:'research',ticker,generation,value:previous});}
      catch(e){if(e.name!=='AbortError'&&!controller.signal.aborted){previous=previous?{...previous,error:'The matching research screen could not be refreshed.'}:{ticker,view_model:preferences.model,error:e.message,opinion:{side:'PASS',reason:e.message},errors:[],news:{articles:[]}};dispatch({type:'research',ticker,generation,value:previous});}}
      finally{running=false;if(!controller.signal.aborted)setResearchLoading(false);}
    }
    const refreshIfDue=()=>{refreshHistory();if(Date.now()-lastRequest>=researchRefreshDelay(previous))refreshResearch(Date.now()-lastFull<300000);};
    refreshResearch();const timer=setInterval(refreshIfDue,20000);document.addEventListener('visibilitychange',refreshIfDue);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refreshIfDue);};
  },[selection.ticker,selection.generation,view,preferences.model]);
  useEffect(()=>{
    if(!selection.ticker||paused||closed||view!=='markets')return;const {ticker,generation}=selection;let stream,stopped=false,retryTimer,retries=0,lastPoll=0;
    const controller=new AbortController();
    const receive=value=>{if(!stopped)dispatch({type:'book',ticker,generation,value});};
    const refresh=()=>{if(!document.hidden&&!stopped&&(!stream||Date.now()-lastPoll>45000))api('/api/book?ticker='+encodeURIComponent(ticker)+'&contracts=1',{signal:controller.signal}).then(value=>{receive({...value,transport:'public-rest-snapshot'});if(!stream)setStreamStatus('REST snapshot');}).catch(e=>{if(e.name!=='AbortError'&&!stopped)setStreamStatus('Quote unavailable');});};
    function connect(){if(stopped||document.hidden||stream)return;stream=new EventSource(API_BASE+'/api/stream?ticker='+encodeURIComponent(ticker));
      stream.onmessage=event=>{try{const value=JSON.parse(event.data),polled=value.transport==='public-rest-poll';
        if(value.kind==='quote'){if(polled)lastPoll=Date.parse(value.as_of);receive(value);setStreamStatus(polled?'Public quote polling':'Live stream');retries=0;}
        else if(value.kind==='connection')setStreamStatus(polled&&value.status==='backoff'?'Public polling paused':value.status==='connected'?'Live stream':value.status);
      }catch{setStreamStatus('Stream response unavailable');}};
      stream.onerror=()=>{stream?.close();stream=null;if(!stopped){setStreamStatus('Stream reconnecting');retryTimer=setTimeout(connect,Math.min(30000,1000*2**Math.min(retries++,5)));}};
    }
    refresh();connect();const interval=setInterval(refresh,30000);
    const visible=()=>{if(document.hidden){stream?.close();stream=null;clearTimeout(retryTimer);}else{refresh();connect();}};
    document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;controller.abort();stream?.close();clearInterval(interval);clearTimeout(retryTimer);document.removeEventListener('visibilitychange',visible);};
  },[selection.ticker,selection.generation,paused,closed,view]);
  async function lookup(event){event.preventDefault();if(!/^https:\/\/|^[A-Z0-9_.]+-[A-Z0-9_.-]+$/i.test(query.trim()))return;
    lookupRequest.current?.abort();const controller=new AbortController(),intent=++listIntent.current;lookupRequest.current=controller;
    setListLoading(true);setListError('');dispatch({type:'clear'});setHistory(null);
    try{const value=await api('/api/resolve?q='+encodeURIComponent(query.trim()),{signal:controller.signal});if(controller.signal.aborted||intent!==listIntent.current)return;
      setMarkets(value.contracts);setListLabel('Opened from link');setCoverage(null);if(value.contracts.length)select(value.contracts[0]);else setListError('No matching open contracts were returned.');
    }catch(e){if(e.name!=='AbortError'&&intent===listIntent.current)setListError(e.message);}finally{if(!controller.signal.aborted&&lookupRequest.current===controller)setListLoading(false);}}
  const filtered=useMemo(()=>{const q=query.toLowerCase().trim();if(!q||/^https:\/\//.test(q))return markets;return markets.filter(m=>(contractTitle(m)+' '+m.ticker).toLowerCase().includes(q));},[markets,query]);
  const displayed=useMemo(()=>filtered.slice(0,rowLimit),[filtered,rowLimit]);
  const opinions=useOpinions(listRoot,displayed,preferences.model,view==='markets'&&Boolean(selection.book||selection.research));
  const market=selection.market,book=selection.book,fp=book?.raw?.orderbook_fp;
  const selectedResearch=selection.research?.ticker===market?.ticker&&selection.research?.view_model===preferences.model?selection.research:null;
  const selectedOpinion=researchScreenOpinion(selectedResearch,clock);
  const assistantLaunch=assistant?.ticker===market?.ticker&&assistant?.model===preferences.model?assistant:null;
  function openAssistant(context={}){
    if(!market)return;
    setAssistant({...context,id:++assistantSequence.current,ticker:market.ticker,model:preferences.model});
  }
  function askPanel(panel,options){
    if(!market)return;
    const context=assistantContext(panel,market.ticker,options);
    if(context)openAssistant(context);
  }
  function askExecution(result){
    if(result)askPanel('execution',{result,detail:'full'});
  }
  async function refreshExecutionBook(signal){
    const {ticker,generation}=selection;
    const value=await api('/api/book?ticker='+encodeURIComponent(ticker)+'&contracts=1',{signal,timeoutMs:15000});
    if(value?.ticker!==ticker||!Number.isFinite(Date.parse(value.as_of)))throw new Error('The new depth could not be verified for this contract.');
    if(!signal.aborted)dispatch({type:'book',ticker,generation,value:{...value,transport:'public-rest-snapshot'}});
  }
  const eventTitle=selectedResearch?.event?.title,scheduledAt=selectedResearch?.extensions?.sports?.event?.played_at;
  const bid=fp?.yes_dollars?.length?Math.max(...fp.yes_dollars.map(row=>Number(row[0]))):null,ask=fp?.no_dollars?.length?1-Math.max(...fp.no_dollars.map(row=>Number(row[0]))):null;
  const age=book?Math.max(0,Math.floor((clock-Date.parse(book.as_of))/1000)):null;
  async function openSources(){setSourceStatus(null);setAttribution(null);setSources(true);
    await Promise.all([api('/api/workspace/sources').then(setSourceStatus).catch(e=>setSourceStatus({error:e.message})),
      api('/api/workspace/attribution').then(setAttribution).catch(e=>setAttribution({error:e.message}))]);}
  function openSelectedPaper(row){
    if(row.ticker!==market?.ticker||!screenFreshness(row).current)return;
    setPaperPreset({ticker:row.ticker,side:row.side.toLowerCase(),quantity:row.contracts,budget:20,probability:row.probability_yes,
      interval:row.interval_yes,model:row.model,as_of:row.source_as_of,source:'model_scenario'});
    setTab('paper');
  }
  async function openFromWorkspace(row,budget){
    lookupRequest.current?.abort();const controller=new AbortController(),intent=++listIntent.current;lookupRequest.current=controller;setNavigationError('');
    const value=await api('/api/workspace/context?ticker='+encodeURIComponent(row.ticker),{signal:controller.signal});
    if(controller.signal.aborted||intent!==listIntent.current)return;
    setView('markets');select(value.market);setPaperPreset(Number.isFinite(budget)&&row.contracts>0?{ticker:row.ticker,side:String(row.side).toLowerCase(),quantity:row.contracts,budget,
      probability:row.probability_yes,interval:row.interval_yes,model:row.model,as_of:row.source_as_of,source:row.experimental?'experimental_model':'model_scenario'}:null);setTab(Number.isFinite(budget)&&row.contracts>0?'paper':'research');
  }
  async function openRecommendation(row,budget){try{await openFromWorkspace(row,budget);}catch(error){if(error.name!=='AbortError')setNavigationError(error.message);}}
  async function searchArchive(){archiveRequest.current?.abort();const controller=new AbortController();archiveRequest.current=controller;const term=query.trim().slice(0,200);setArchiveQuery(term);setArchiveOpen(true);setArchiveResult(null);setArchiveError('');try{const result=await api('/api/workspace/search?q='+encodeURIComponent(term)+'&limit=30',{signal:controller.signal});if(!controller.signal.aborted)setArchiveResult(result);}catch(error){if(!controller.signal.aborted)setArchiveError(error.message);}}
  function closeArchive(){archiveRequest.current?.abort();setArchiveOpen(false);}
  async function inspectArchive(row){try{await openFromWorkspace(row);setArchiveOpen(false);}catch(error){if(error.name!=='AbortError')setArchiveError(error.message);}}
  return <div className={'workspace '+(mobileDetail?'show-detail':'')+(assistantLaunch&&view==='markets'?' with-assistant':'')} data-layout={preferences.layout} data-density={preferences.density}>
    <a className="skip-link" href="#contract-content">Skip to selected contract</a>
    <aside className="sidebar"><a className="brand" href="/" aria-label="Predictir"><span className="brand-mark" aria-hidden="true">K</span><span className="brand-name">Kalshi<br/><strong>Market Lab</strong></span></a><div className="nav-label">Markets</div><nav aria-label="Market categories">{categories.map(([id,name,Icon])=><button key={id} aria-label={name} title={name} data-analytics-category={id} className={id===category?'active':''} aria-current={id===category?'page':undefined} onClick={()=>changeCategory(id)}><Icon size={18}/><span>{name}</span></button>)}</nav>
      <div className="sidebar-bottom"><button aria-label="Forecast journal" title="Forecast journal" onClick={()=>setJournal(true)}><BookOpen size={18}/><span>Forecast journal</span></button><button aria-label="Data sources" title="Data sources" onClick={openSources}><Database size={18}/><span>Data sources</span></button><a href="/research/research-audit.pdf" aria-label="Methods and audit PDF" title="Methods and audit PDF" target="_blank" rel="noreferrer"><FileText size={18}/><span>Methods & audit</span></a><button aria-label="Appearance and models" title="Appearance and models" onClick={()=>setAppearanceOpen(true)}><Palette size={18}/><span>Appearance & models</span></button><a href="https://github.com/DaniyalHayat/predictir" aria-label="Project source" title="Project source" target="_blank" rel="noreferrer"><ExternalLink size={16}/><span>Project source</span></a><small>predictir.dev <span>Paper trading only</span></small></div></aside>
    <main className="main-workspace"><header className="workspace-header"><div><span className="breadcrumb">Market Lab</span><span className="breadcrumb-separator">/</span><strong>{view==='markets'?listLabel:view==='ranked'?'Recommended trades':'Portfolio'}</strong></div><div className="header-actions"><span className={'model-mode '+(preferences.model==='challenger'?'experimental':'')} title="Change the research model in Appearance & models">{preferences.model==='challenger'?'Experimental ensemble':'Validated model view'}</span><button className="icon-button appearance-button" aria-label="Appearance and model settings" onClick={()=>setAppearanceOpen(true)}><Palette size={18}/></button><button className="secondary compact" aria-label="Forecast journal" onClick={()=>setJournal(true)}><BookOpen size={15}/><span>Journal</span></button><button className="account-button secondary compact" aria-label={account.session?.kind==='owner'?'Your account':'Sign in'} onClick={()=>setAccountOpen(true)}><UserRound size={15}/><span>{account.session?.kind==='owner'?'Account':'Sign in'}</span>{account.conflict&&<i className="account-attention"/>}</button></div></header>
      <nav className="workspace-view-tabs" aria-label="Workspace views">{[['markets','Markets',LayoutDashboard],['ranked','Recommended trades',ChartNoAxesCombined],['portfolio','Portfolio',Wallet]].map(([id,label,Icon])=><button key={id} aria-current={view===id?'page':undefined} className={view===id?'active':''} onClick={()=>{setView(id);setAssistant(false);setNavigationError('');}}><Icon size={15}/>{label}</button>)}</nav>
      {navigationError&&<p className="notice error navigation-error" role="alert">{navigationError}</p>}
      {view==='portfolio'&&<div className="session-banner"><span>{account.session?.kind==='owner'?account.sync:'Guest paper account · records last up to 6 hours'}</span><button className="text-button" onClick={()=>setAccountOpen(true)}>{account.session?.kind==='owner'?(account.conflict?'Review saved versions':'Your account'):'Sign in to keep your saved trades'}<ArrowUpRight size={13}/></button></div>}
      {reviews.alerts.length>0&&<div aria-label="Paper position alerts" role="status">{reviews.alerts.map(alert=><div className="position-alert" key={alert.id}>
        <strong>Paper SELL signal</strong><span>{alert.title} · {alert.reason}</span><button className="text-button" onClick={()=>setView('portfolio')}>My Trades</button>
        <button className="text-button" onClick={()=>reviews.dismiss(alert.id)}>Dismiss</button></div>)}</div>}
      {view==='ranked'?<Recommendations category={category} categoryName={categories.find(row=>row[0]===category)?.[1]} model={preferences.model} onOpen={openRecommendation}/>:view==='portfolio'?<Portfolio paperLedger={paperLedger} reviews={reviews} onOpen={openFromWorkspace} onMarkets={()=>setView('markets')} clock={clock} model={preferences.model} theme={preferences.theme}/>:<div className="workspace-columns"><section className="market-list" aria-label="Market list"><div className="market-list-heading"><div><h1>{listLabel}</h1><span>{listLoading?'Loading contracts…':`${filtered.length} ${filtered.length===1?'contract':'contracts'}`}</span></div><button className="icon-button" aria-label="Refresh market list" onClick={()=>setListRevision(v=>v+1)} disabled={listLoading}><RefreshCw size={17} className={listLoading?'spin':''}/></button></div>
        <form className="market-search" onSubmit={lookup}><Search size={17}/><label className="sr-only" htmlFor="market-search">Search contracts or paste a Kalshi URL</label><input id="market-search" ref={search} value={query} onChange={e=>{setQuery(e.target.value);setRowLimit(marketPageSize);}} placeholder="Search or paste a Kalshi URL"/><kbd>/</kbd></form>
        <div className="list-columns"><span>Contract</span><span>YES / NO</span></div>
        <div className="market-rows" ref={listRoot} aria-busy={listLoading&&!displayed.length}>{listError&&<div className="notice error" role="alert">{listError}<button className="text-button" onClick={()=>setListRevision(v=>v+1)}>Try again</button></div>}{listLoading&&!displayed.length&&<div className="list-loading" role="status"><Loader2 size={18} className="spin"/><span>Loading exchange contracts</span></div>}{displayed.map(row=><MarketRow key={row.ticker} row={row} selected={row.ticker===selection.ticker} livePrices={row.ticker===selection.ticker?{yes:ask,no:bid===null?null:1-bid}:null} opinion={row.ticker===selection.ticker?selectedOpinion||opinions[row.ticker]:opinions[row.ticker]} onSelect={openMarket} onResearch={selectResearch}/>)}{displayed.length<filtered.length&&<button className="text-button" onClick={()=>setRowLimit(limit=>limit+marketPageSize)}>Show more contracts</button>}{!listLoading&&!filtered.length&&!listError&&<div className="empty">No matching contracts in this sample. Try another category or paste an exact Kalshi URL.{query.trim().length>=2&&<button className="text-button" onClick={searchArchive}>Search observed history <ArrowUpRight size={13}/></button>}</div>}</div>
        <div className="list-footer" title={'Catalog checked '+dateLabel(coverage?.as_of)+'; refreshes once a minute while visible.'}><span className="status-dot"/>{coverage?.stale?'Showing last snapshot':'Catalog snapshot'}{coverage?.partial&&<span>Partial coverage</span>}<button className="text-button" onClick={openSources}>Coverage</button></div>
      </section>
      <section className="contract-panel" id="contract-content" aria-label="Selected contract">{market?<>
        <div className="contract-heading"><button className="mobile-back text-button" onClick={()=>setMobileDetail(false)}><ArrowLeft size={16}/>Markets</button><div className="contract-meta"><span>{categories.find(c=>c[0]===market.category)?.[1]||listLabel}</span><span>Trading closes {dateLabel(market.close_time)}</span></div><h2 data-testid="selected-title">{contractTitle(market)}</h2>{eventTitle&&eventTitle!==contractTitle(market)&&<p className="contract-event" data-testid="selected-event">{eventTitle}</p>}{scheduledAt&&Number.isFinite(Date.parse(scheduledAt))&&<p className="contract-schedule">Scheduled <time dateTime={scheduledAt}>{new Date(scheduledAt).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})}</time></p>}<div className="contract-identity"><code data-testid="selected-ticker">{market.ticker}</code><div className="contract-links"><button className="text-button save-market" aria-pressed={account.watchlist.includes(market.ticker)} disabled={account.status!=='ready'} onClick={()=>{try{toggleSavedMarket(market.ticker);}catch(error){setNavigationError(error.message);}}}><Bookmark size={13}/>{account.watchlist.includes(market.ticker)?'Saved':'Save'}</button><a href={'https://kalshi.com/markets/'+(selectedResearch?.series||market.ticker.split('-')[0]).toLowerCase()} target="_blank" rel="noreferrer">On Kalshi <ArrowUpRight size={13}/></a></div></div></div>
        <div className="quote-strip"><div><small>YES ask</small><strong className="yes-price">{cents(ask)}</strong></div><div><small>NO ask</small><strong className="no-price">{bid===null?'—':cents(1-bid)}</strong></div><div><small>YES spread</small><strong>{bid===null||ask===null?'—':cents(ask-bid)}</strong></div><button className="stream-state" onClick={()=>setPaused(v=>!v)} aria-pressed={paused}><span className={'status-dot '+(age===null||age>90||paused||closed?'delayed':'')}/><span>{closed?'Closed':paused?'Stream paused':streamStatus}<small>{age===null?'Waiting for quote':`${age}s since observation`}</small></span><ChevronDown size={14}/></button></div>
        {selection.error&&<div className="notice error" role="alert">{selection.error}</div>}
        <div className="contract-tabs" role="tablist" aria-label="Contract details">{CONTRACT_TABS.map(([id,label])=><button key={id} id={'contract-tab-'+id} role="tab" aria-selected={tab===id} aria-controls="contract-tabpanel" tabIndex={tab===id?0:-1} onKeyDown={event=>{const next=moveContractTab(id,event.key);if(next){event.preventDefault();setTab(next);document.getElementById('contract-tab-'+next)?.focus();}}} onClick={()=>setTab(id)}>{label}{id==='research'&&researchLoading&&<Loader2 size={12} className="spin"/>}</button>)}<button className="ask-button" onClick={()=>assistantLaunch?setAssistant(false):openAssistant()} aria-expanded={Boolean(assistantLaunch)} aria-label="Ask about this contract"><MessageSquare size={15}/><span>Ask</span></button></div>
        <div className="contract-scroll" key={market.ticker} id="contract-tabpanel" role="tabpanel" aria-labelledby={'contract-tab-'+tab} tabIndex={0}>
          {tab==='overview'&&<><div className="section-title"><h3>Exchange price history <span className="tag">24h</span></h3><AskWhy panel="history" onAsk={askPanel} label="exchange price history"/></div><Chart rows={history?.rows||[]} error={history?.error} theme={preferences.theme} label={'Observed exchange price history for '+contractTitle(market)}/>{history?.as_of&&<p className="history-scope footnote">Checked {dateLabel(history.as_of)}. {history.scope||'Exchange candle closes; missing observations are not filled.'}</p>}<div className="section-title"><h3>Order book</h3><small>{book?.transport==='exchange-websocket'?'Native exchange stream':book?.transport==='public-rest-poll'?'Polled exchange snapshot':'Observed depth'}</small></div><Depth book={book}/><div className="section-title"><h3>Research view</h3><button className="text-button" onClick={()=>setTab('research')}>Full analysis <ArrowUpRight size={14}/></button></div><Research compact value={selectedResearch} history={history?.ticker===market.ticker?history:null} now={clock} loading={researchLoading} onAssistant={askPanel} onPaper={openSelectedPaper}/></>}
          {tab==='research'&&<Research key={market.ticker+'#'+preferences.model} value={selectedResearch} history={history?.ticker===market.ticker?history:null} now={clock} loading={researchLoading} onAssistant={askPanel} onPaper={openSelectedPaper}/>}
          {tab==='paper'&&<Paper key={market.ticker} market={market} book={book} forecast={selectedResearch?.forecast} fees={selection.fees} now={clock} preset={paperPreset} onPortfolio={()=>setView('portfolio')} assistantAction={<AskWhy panel="paper" onAsk={askPanel} label="paper position sizing"/>}/>}
          {tab==='execution'&&<ExecutionLab key={market.ticker+'#'+preferences.model} market={market} book={book} fees={selection.fees} clock={clock} closed={closed} onRefreshDepth={refreshExecutionBook} model={preferences.model} initialControls={executionContext?.ticker===market.ticker?executionContext.controls:null} onControlsChange={controls=>setExecutionContext({ticker:market.ticker,controls})} onAssistant={askExecution} paperWorkspace={paperWorkspace}/>}
          {tab==='rules'&&<><div className="section-title"><h3>Settlement rules</h3><AskWhy panel="rules" onAsk={askPanel} label="settlement rules"/></div><p className="rule-text">{market.rules_primary||'No primary rule text was returned. Inspect the exchange contract.'}</p>{market.rules_secondary&&<details className="method"><summary>Secondary rules</summary><p>{market.rules_secondary}</p></details>}<dl className="definition-list"><div><dt>Trading close</dt><dd>{dateLabel(market.close_time)}</dd></div><div><dt>Expected expiration</dt><dd>{dateLabel(market.expected_expiration_time)}</dd></div><div><dt>Status / outcome</dt><dd>{market.status||'Unknown'} / {market.result||'Unsettled'}</dd></div></dl><div className="section-title"><h3>Source records</h3><AskWhy panel="sources" onAsk={askPanel} label="source records"/></div><SourceRows sources={selectedResearch?.sources||[]}/><p className="footnote">Close, expiration and settlement are separate events. Source timestamps and missing evidence remain visible.</p></>}
        </div></>:<div className="contract-placeholder"><Activity size={28}/><h2>Select a contract</h2><p>Its rules, prices and analysis will appear here.</p></div>}</section>
      {assistantLaunch&&<Assistant key={assistantLaunch.id} market={market} book={book} fees={selection.fees} research={selectedResearch} history={history} model={assistantLaunch.model} launch={assistantLaunch} onClose={()=>setAssistant(false)}/>}
      </div>}
    </main>
    {journal&&<Journal onClose={()=>setJournal(false)}/>}
    {accountOpen&&<Account account={account} onClose={()=>setAccountOpen(false)} onOpen={async ticker=>{await openFromWorkspace({ticker});setAccountOpen(false);}}/>}
    {appearanceOpen&&<Appearance value={preferences} onChange={updatePreferences} onClose={()=>setAppearanceOpen(false)} storageError={preferenceError}/>}
    {archiveOpen&&<Modal titleId="archive-title" onClose={closeArchive}><div className="dialog-heading"><div><h2 id="archive-title">Observed history</h2><p>Retained source observations matching “{archiveQuery}”. Prices below are historical snapshots.</p></div><button className="icon-button" aria-label="Close observed history" onClick={closeArchive}><X size={20}/></button></div>{archiveError&&<p className="notice error" role="alert">{archiveError}</p>}{!archiveResult&&!archiveError&&<p className="loading-section" role="status"><Loader2 size={18} className="spin"/>Searching retained observations…</p>}<div className="archive-results">{archiveResult?.rows?.map(row=><article key={row.ticker}><button className="position-title" onClick={()=>inspectArchive(row)}>{row.outcome_label||row.title}<ArrowUpRight size={14}/></button><small>{row.ticker} · observed {dateLabel(row.observed_at)}</small><p>Historical YES bid {cents(row.yes_bid)} / ask {cents(row.yes_ask)}</p>{safeURL(row.source?.url)&&<a className="text-button" href={row.source.url} target="_blank" rel="noreferrer">Source record <ArrowUpRight size={12}/></a>}</article>)}</div>{archiveResult&&!archiveResult.rows?.length&&<p className="empty">No matching retained observation was found.</p>}<p className="footnote">{archiveResult?.scope} Selecting a result fetches current exchange details; these old quotes are never used as a live paper entry.</p></Modal>}
    {sources&&<Modal titleId="sources-title" onClose={()=>setSources(false)}><div className="dialog-heading"><div><h2 id="sources-title">Data sources</h2><p>Coverage and source freshness for this workspace.</p></div><button className="icon-button" aria-label="Close source details" onClick={()=>setSources(false)}><X size={20}/></button></div>{!sourceStatus&&<p className="loading-section" role="status"><Loader2 className="spin" size={18}/>Checking provider status…</p>}<div className="source-status">{sourceStatus?.providers?.map(row=><div key={row.id}><strong>{row.name}</strong><span>{String(row.status||'unknown').replaceAll('_',' ')}</span><small>{row.detail}</small>{row.as_of&&<small>Checked {dateLabel(row.as_of)}</small>}</div>)}</div>{sourceStatus&&!sourceStatus.error&&!sourceStatus.providers?.length&&<p className="empty">No external provider status has been recorded yet. This does not confirm that a provider is connected.</p>}{selectedResearch?.sources?.length>0&&<details className="method" open><summary>Sources for {contractTitle(market)}</summary><SourceRows sources={selectedResearch.sources}/></details>}{coverage&&<details className="method" open><summary>Current market-list coverage</summary><p>{coverage.scope}</p>{coverage.coverage?.map(row=><p key={row.series}><strong>{row.series}</strong>: {count(row.records)} contracts · checked {dateLabel(row.as_of)}{row.truncated?' · additional contracts are outside this sample':''}</p>)}{coverage.errors?.map(row=><p key={row.series}>{row.series}: {row.error}</p>)}</details>}<MarketAttribution value={attribution}/>{sourceStatus?.warehouse?.configured&&<div className="warehouse-counts"><strong>{count(sourceStatus.warehouse.market_observations)} market observations</strong><span>{count(sourceStatus.warehouse.source_batches)} source batches · {count(sourceStatus.warehouse.completed_games)} completed sports games</span></div>}{sourceStatus?.warehouse?.configured===false&&<p className="notice">Durable source history is not configured on this service.</p>}{sourceStatus?.error&&<p className="notice error" role="alert">{sourceStatus.error}</p>}<p className="footnote">Market lists are bounded source samples, not the whole exchange. Model outputs and public observations are labeled separately. No real order route is exposed.</p></Modal>}
  </div>;
}
