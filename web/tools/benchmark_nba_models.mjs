import {readFile,writeFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {cpus,platform,arch} from 'node:os';
import artifact from '../lib/workspace/models/nba-challenger.json' with {type:'json'};
import {scoreNBAArtifact,fitNBAChallenger} from '../lib/workspace/nba-challenger.mjs';
const fixture=JSON.parse(await readFile(new URL('../tests/fixtures/nba-ml-parity.json',import.meta.url),'utf8'));
const capture=JSON.parse(gunzipSync(await readFile(new URL('../research-data/nba-completed-games-2026-11-04.json.gz',import.meta.url))).toString('utf8'));
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const scores={};let checksum=0;
for(const[name,model]of Object.entries(artifact.models)){
  const durations=[];
  for(let repeat=0;repeat<7;repeat++){
    const before=performance.now();for(let i=0;i<10000;i++)checksum+=scoreNBAArtifact(model,fixture.rows[i%fixture.rows.length].x);
    durations.push((performance.now()-before)*1000/10000);
  }
  scores[name]={median_microseconds_per_score:median(durations),repetitions:7,scores_per_repetition:10000};
}
const fitStart=performance.now(),now=Date.parse(capture.captured_at),fit=fitNBAChallenger(capture.games,{now}),construction=performance.now()-fitStart;
const game={played_at:new Date(now+7*86400000).toISOString(),home_id:'8',away_id:'20'},coldStart=performance.now();
fit.predict(game);const cold=performance.now()-coldStart;
const repeated=[];for(let repeat=0;repeat<7;repeat++){const before=performance.now();for(let i=0;i<1000;i++)checksum+=fit.predict(game).home;repeated.push((performance.now()-before)*1000/1000);}
const report={measured_at:new Date().toISOString(),runtime:process.version,platform:platform(),architecture:arch(),cpu:cpus()[0]?.model,
  source_games:capture.games.length,compiled_model_bytes:Buffer.byteLength(JSON.stringify(artifact)),models:scores,
  ensemble:{construction_ms:construction,first_score_with_residual_bootstrap_ms:cold,cached_residual_median_microseconds_per_score:median(repeated)},
  checksum,scope:'Local CPU inference microbenchmark with real trained coefficients/trees. Excludes network, source ingestion, rendering and live end-to-end latency; no whole-application speed claim.'};
await writeFile(new URL('../docs/nba-inference-benchmark.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
