import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {leagueData} from '../lib/workspace/sports.mjs';
import {buildNBARows,NBA_FEATURES} from '../lib/workspace/nba-features.mjs';
import {fitBasketball} from '../lib/workspace/sports-math.mjs';
const capturePath=new URL('../.research/nba-training-snapshot.json',import.meta.url);
const frozenPath=new URL('../research-data/nba-completed-games-2026-11-04.json.gz',import.meta.url);
const capture=process.argv.includes('--refresh')?await leagueData('nba'):process.argv.includes('--local')?JSON.parse(await readFile(capturePath,'utf8')):JSON.parse(gunzipSync(await readFile(frozenPath)).toString('utf8'));
const games=capture.games,ordered=[...games].sort((a,b)=>a.played_at.localeCompare(b.played_at)||String(a.id).localeCompare(String(b.id))),{rows}=buildNBARows(ordered);
const boundary=fraction=>ordered[Math.floor(ordered.length*fraction)].played_at;
const trainEnd=boundary(.6),selectionEnd=boundary(.7),calibrationEnd=boundary(.8);
const fit60=fitBasketball(ordered.filter(g=>g.played_at<trainEnd)),fit80=fitBasketball(ordered.filter(g=>g.played_at<calibrationEnd));
const values=rows.map(row=>({...row,split:row.played_at<trainEnd?'train':row.played_at<selectionEnd?'selection':row.played_at<calibrationEnd?'calibration':'test',
  bt60:fit60.predict(row.home_id,row.away_id)?.home??null,bt80:fit80.predict(row.home_id,row.away_id)?.home??null}));
await mkdir(new URL('../.research/',import.meta.url),{recursive:true});
if(process.argv.includes('--refresh'))await writeFile(capturePath,JSON.stringify({captured_at:capture.as_of,league:'nba',coverage:capture.coverage,sources:capture.sources,games},null,2));
if(process.argv.includes('--freeze')){await mkdir(new URL('../research-data/',import.meta.url),{recursive:true});await writeFile(frozenPath,gzipSync(Buffer.from(JSON.stringify(capture)),{level:9}));}
const result={captured_at:capture.captured_at||capture.as_of,coverage:capture.coverage,source_manifest:capture.sources,features:NBA_FEATURES,
  games_sha256:createHash('sha256').update(JSON.stringify(games)).digest('hex'),baseline_training_sha256:createHash('sha256').update(JSON.stringify(ordered.filter(g=>g.played_at<trainEnd).map(g=>[g.id,g.played_at,g.home_id,g.away_id,g.home_score,g.away_score]))).digest('hex'),
  train_end:trainEnd,selection_end:selectionEnd,calibration_end:calibrationEnd,rows:values};
await writeFile(new URL('../.research/nba-training-features.json',import.meta.url),JSON.stringify(result));
console.log(JSON.stringify({features:result.features,splits:Object.fromEntries(['train','selection','calibration','test'].map(s=>[s,values.filter(r=>r.split===s).length])),games_sha256:result.games_sha256}));
