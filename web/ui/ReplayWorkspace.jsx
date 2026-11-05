'use client';
import React, {useEffect, useState} from 'react';
import {api, dateLabel, percent} from './api.mjs';
import {inverseNormal} from '../lib/workspace/nba-inplay-math.mjs';
import calibration from '../lib/workspace/models/nba-inplay.json';
import QuantScenarios from './QuantScenarios.jsx';

const sum = values => values.reduce((total, value) => total + value, 0);

function ScoreReplay({game}) {
  const [quarter, setQuarter] = useState(2);
  const [revealed, setRevealed] = useState(false);
  const home = sum(game.home_period_scores.slice(0, quarter));
  const away = sum(game.away_period_scores.slice(0, quarter));
  const scoreCase = {
    margin: home - away, remaining_seconds: (4 - quarter) * 720,
    drift_points_per_minute: calibration.sigma * inverseNormal(game.pregame_home_probability) / 48,
    volatility_points_per_sqrt_minute: calibration.sigma / Math.sqrt(48),
    baseline_probability: game.pregame_home_probability, simulations: 10000,
  };
  return <>
    <section className="replay-score" aria-label="Archived scoreboard">
      <div className="execution-result-heading"><div><span className="eyebrow">Observed quarter scores</span><h2>Game {game.id}</h2><small>{dateLabel(game.played_at)}</small></div><a href={game.source_url} target="_blank" rel="noreferrer">Source record ↗</a></div>
      <div className="replay-score-controls">
        <label>Checkpoint<select value={quarter} onChange={event => {setQuarter(Number(event.target.value)); setRevealed(false);}}>
          {[1, 2, 3].map(value => <option key={value} value={value}>End of quarter {value}</option>)}
        </select></label>
        <div><small>Away</small><strong>{away}</strong></div><div><small>Home</small><strong>{home}</strong></div>
        <div><small>Pregame P(home win)</small><strong>{percent(game.pregame_home_probability)}</strong></div>
      </div>
      <button type="button" className="secondary" onClick={() => setRevealed(!revealed)}>{revealed ? 'Hide final score' : 'Reveal final score'}</button>
      {revealed && <p role="status">Final score · Away {sum(game.away_period_scores)}, Home {sum(game.home_period_scores)}</p>}
    </section>
    <QuantScenarios key={quarter} scoreCase={scoreCase}/>
  </>;
}

export default function ReplayWorkspace() {
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api('/api/workspace/replay', {signal: controller.signal, timeoutMs: 20000}).then(value => {
      if (controller.signal.aborted) return;
      if (value.mode !== 'replay' || !value.games?.length) throw new Error('No archived games were returned');
      setCatalog(value);
      setSelected(value.games[0].id);
    }).catch(() => {
      if (!controller.signal.aborted) setError('The archive service did not respond. Try again, or use the manual scenario below.');
    });
    return () => controller.abort();
  }, [attempt]);
  const game = catalog?.games.find(row => row.id === selected);
  return <main className="azure-replay" data-theme="midnight">
    <a href="#replay-content" className="skip-link">Skip to replay</a>
    <header><strong>Predictir</strong><span className="tag">Azure replay</span><a href="https://predictir.dev/">Live Market Lab ↗</a></header>
    <div className="replay-content" id="replay-content">
      <span className="eyebrow">Historical score replay</span><h1>Replay a market scenario</h1>
      <p>Compare the pregame estimate with an observed quarter score. Test the research components on the same inputs without using a live exchange or social feed.</p>
      <div className="replay-status">
        {catalog ? <><label>Held-out game<select value={selected} onChange={event => setSelected(event.target.value)}>
          {catalog.games.map(row => <option key={row.id} value={row.id}>{dateLabel(row.played_at)} · Game {row.id}</option>)}
        </select></label><small>Archive captured {dateLabel(catalog.captured_at)}</small></> :
          error ? <><p role="alert">{error}</p><button className="secondary" type="button" onClick={() => {setError(''); setAttempt(attempt + 1);}}>Retry archive</button></> :
            <p role="status">Loading the historical archive…</p>}
      </div>
      {game ? <ScoreReplay key={game.id} game={game}/> : <QuantScenarios/>}
    </div>
  </main>;
}
