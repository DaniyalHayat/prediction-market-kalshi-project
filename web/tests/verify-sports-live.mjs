import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {leagueData,sportsResearch} from '../lib/workspace/sports.mjs';
import {appleChart} from '../lib/workspace/music.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const result={verified_at:new Date().toISOString(),classification:'Observed public-data retrieval and retrospective model validation; no trading-return claim',leagues:[],matched_contracts:[]};
for(const league of ['nba','epl']){
  const data=await leagueData(league);
  result.leagues.push({league,coverage:data.coverage,validation:data.validation,normalized_games_sha256:sha(data.games),sources:data.sources,
    limitation:'Provider content can change; rerunning live verification may produce a different data hash. Availability and bookmaker prices are excluded from fitted models.'});
}
const contracts=[
  {ticker:'KXNBAGAME-26NOV07SASPOR-SAS',event_ticker:'KXNBAGAME-26NOV07SASPOR',title:'San Antonio wins',yes_sub_title:'San Antonio',
    rules_primary:'If San Antonio wins the San Antonio vs Portland Pro Basketball game originally scheduled for Nov 7, 2026, then the market resolves to Yes.'},
  {ticker:'KXEPLGAME-26NOV08BRIBRE-TIE',event_ticker:'KXEPLGAME-26NOV08BRIBRE',title:'Tie is the result',yes_sub_title:'Tie',
    rules_primary:'If Tie is the result of the Brighton vs Brentford professional EPL soccer game originally scheduled for Nov 8, 2026 after 90 minutes plus stoppage time (does not include extra time or penalties), then the market resolves to Yes.'}
];
for(const contract of contracts){const data=await sportsResearch(contract,{includeAvailability:false});
  result.matched_contracts.push({ticker:contract.ticker,event_id:data.event?.id,teams:data.teams?.map(t=>t.name),forecast:data.forecast,bookmaker:data.bookmaker,reason:data.reason});
}
try{const apple=await appleChart();result.apple={status:'available',source_url:apple.source_url,source_updated:apple.source_updated,as_of:apple.as_of,rows:apple.tracks.length,scope:apple.scope};}
catch(error){result.apple={status:'unavailable',reason:error.message};}
await mkdir(new URL('../.research/',import.meta.url),{recursive:true});
await writeFile(new URL('../.research/sports-live-verification.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,leagues:result.leagues.map(({sources,...league})=>({...league,source_count:sources.length}))},null,2));
