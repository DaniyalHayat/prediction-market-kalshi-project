import {readFile,writeFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {sourceJSON,boundedMap} from '../lib/workspace/providers.mjs';
import {fitBasketball} from '../lib/workspace/sports-math.mjs';
import {parseNBAQuarterReplay,conditionalNBAProbability,inverseNormal} from '../lib/workspace/nba-inplay-math.mjs';
const base=new URL('../',import.meta.url),capture=JSON.parse(gunzipSync(await readFile(new URL('research-data/nba-completed-games-2026-11-04.json.gz',base))).toString('utf8'));
const features=JSON.parse(await readFile(new URL('.research/nba-training-features.json',base),'utf8'));
const replayPath=new URL('research-data/nba-quarter-replay-2026-11-04.json.gz',base),pick=(rows,n)=>Array.from({length:Math.min(n,rows.length)},(_,i)=>rows[Math.floor(i*rows.length/Math.min(n,rows.length))]);
const groups={calibration:pick(features.rows.filter(r=>r.split==='calibration'),40),test:pick(features.rows.filter(r=>r.split==='test'),20)};
let replay;
if(process.argv.includes('--refresh')){
  const errors=[];
  const games=await boundedMap(Object.entries(groups).flatMap(([split,rows])=>rows.map(row=>({split,id:row.id}))),3,async row=>{
    const game=capture.games.find(g=>g.id===row.id);
    try{const response=await sourceJSON('ESPN NBA quarter replay','https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event='+game.id,{ttl:604800});
      const periods=parseNBAQuarterReplay(response.data,game);if(!periods)throw new Error('Complete matching period scores were unavailable');
      const prior=capture.games.filter(g=>Date.parse(g.played_at)<Date.parse(game.played_at)-8*3600000),p=fitBasketball(prior).predict(game.home_id,game.away_id);
      if(!p)throw new Error('An earlier-game prior could not be reconstructed');
      return {...periods,split:row.split,pregame_home_probability:p.home,pregame_interval:p.interval,
        prior_training_games:prior.length,prior_cutoff:new Date(Date.parse(game.played_at)-8*3600000).toISOString(),source:{url:response.source_url,as_of:response.as_of,sha256:response.sha256}};
    }catch(error){errors.push({game_id:game.id,split:row.split,reason:error.message});return null;}
  });
  replay={captured_at:new Date().toISOString(),classification:'Observed historical quarter scores; no invented live clocks',games:games.filter(Boolean),errors};
  await writeFile(replayPath,gzipSync(Buffer.from(JSON.stringify(replay)),{level:9}));
}else replay=JSON.parse(gunzipSync(await readFile(replayPath)).toString('utf8'));
const states=game=>[1,2,3].map(quarter=>({game_id:game.game_id,played_at:game.played_at,quarter,remaining:1-quarter/4,
  lead:game.home_period_scores.slice(0,quarter).reduce((s,v)=>s+v,0)-game.away_period_scores.slice(0,quarter).reduce((s,v)=>s+v,0),
  final_margin:game.home_score-game.away_score,y:game.home_score>game.away_score?1:0,pregame:game.pregame_home_probability}));
const training=replay.games.filter(g=>g.split==='calibration'),testing=replay.games.filter(g=>g.split==='test'),calibration=training.flatMap(states),test=testing.flatMap(states);
if(training.length<30||testing.length<15)throw new Error('At least 30 calibration games and 15 held-out replay games are required');
const fitScale=rows=>{let a=0,b=0;for(const row of rows){const remainingMargin=row.final_margin-row.lead,z=inverseNormal(row.pregame);a+=remainingMargin**2/row.remaining;b+=remainingMargin*z;}return (-b+Math.sqrt(b*b+4*rows.length*a))/(2*rows.length);};
const sigma=fitScale(calibration),replicates=[];let seed=839123;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
for(let i=0;i<2000;i++){const selected=Array.from({length:training.length},()=>training[Math.floor(random()*training.length)]).flatMap(states);replicates.push(fitScale(selected));}
replicates.sort((a,b)=>a-b);const sigmaInterval=[replicates[50],replicates[1949]],score=(rows,conditional)=>{
  const probabilities=rows.map(row=>conditional?conditionalNBAProbability(row.lead,row.remaining,row.pregame,sigma):row.pregame);
  return {n:rows.length,brier:rows.reduce((s,row,i)=>s+(row.y-probabilities[i])**2,0)/rows.length,
    log_loss:rows.reduce((s,row,i)=>s-Math.log(row.y?probabilities[i]:1-probabilities[i]),0)/rows.length};
};
const validation={...score(test,true),baseline:score(test,false),heldout_games:testing.length,calibration_games:training.length,
  coverage:testing.length/groups.test.length,passed:false,protocol:'Forty deterministic spaced calibration-partition games fit the score-process scale; twenty spaced final-holdout games replay quarters 1/2/3. All three states of one game stay together. Pregame priors exclude games starting in the eight hours preceding each replay event. This is a bounded retrospective research evaluation, not prospective live-clock validation.'};
const parameters={schema_version:1,created_at:new Date().toISOString(),source_captured_at:replay.captured_at,sigma,sigma_interval:sigmaInterval,
  calibration_games:training.length,calibration_states:calibration.length,validation,
  calibration_errors:calibration.map(row=>({...row,normalized_margin_error:(row.final_margin-row.lead-sigma*inverseNormal(row.pregame)*row.remaining)/Math.sqrt(row.remaining)}))};
await writeFile(new URL('lib/workspace/models/nba-inplay.json',base),JSON.stringify(parameters,null,2)+'\n');
const report={classification:'Experimental regulation score-clock model; no Kalshi price inputs and no live-profit backtest',
  ...parameters,calibration_errors:undefined,replay_games:replay.games.length,replay_errors:replay.errors,
  replay_sha256:createHash('sha256').update(JSON.stringify(replay)).digest('hex'),replay_sources:replay.games.map(g=>({game_id:g.game_id,split:g.split,...g.source})),
  equation:'P(home win | lead l, remaining fraction r) = Phi((l + sigma Phi^-1(p_pregame) r)/(sigma sqrt(r)))',
  scale_estimation:'Let A=sum((final_margin-lead)^2/r), B=sum((final_margin-lead)Phi^-1(p_pregame)), n=calibration states. Gaussian remaining-increment likelihood gives sigma=(-B+sqrt(B^2+4nA))/(2n). Whole-game bootstrap provides the scale sensitivity interval.',
  source:{title:'Stern (1994), A Brownian Motion Model for the Progress of Sports Scores',url:'https://www.stat.berkeley.edu/~aldous/157/Papers/stern.pdf'},
  limitations:['Clock/score retrieval time is not always a provider update timestamp.','Possession, fouls, lineups and overtime mechanics are not modeled.','Only quarter-end historical states were evaluated.','Twenty held-out games do not establish calibrated live probabilities or profitable trading.','Scheduled start times lack historical result-publication timestamps; the eight-hour exclusion is conservative, not a complete point-in-time archive.']};
await writeFile(new URL('docs/nba-inplay-validation.json',base),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({sigma,sigma_interval:sigmaInterval,validation,replay_errors:replay.errors},null,2));
