import {sourceJSON} from './providers.mjs';
import {publishDataset,chartHistory} from './warehouse.mjs';
import {mean,wilson} from '../intelligence/math.mjs';
import {readJSON} from '../transport.mjs';
import {publicXFeed} from './social.mjs';
import {alternativeMusicSources} from './music-alternatives.mjs';
const appleURL='https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/songs.json';
let spotifyToken,spotifyAuthJob,spotifyAuthRetryAt=0;
const safeURL=(value,host)=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!host||u.hostname===host)?u.href:null;}catch{return null;}};
const identity=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function parseApple(payload,now=Date.now()) {
  const feed=payload?.feed,stamp=Date.parse(feed?.updated);
  if(!Array.isArray(feed?.results)||feed.country!=='us'||!Number.isFinite(stamp)||stamp>now+300000)throw new Error('Apple US chart identity or timestamp is unavailable');
  const tracks=feed.results.map((row,i)=>({id:String(row.id),rank:i+1,name:row.name,artist:row.artistName,artist_id:String(row.artistId||''),
    artwork:safeURL(row.artworkUrl100),url:safeURL(row.url,'music.apple.com')})).filter(row=>/^\d+$/.test(row.id)&&row.name&&row.artist&&row.url);
  if(tracks.length!==feed.results.length||new Set(tracks.map(t=>t.id)).size!==tracks.length||!tracks.length)throw new Error('Apple chart contains missing or duplicate tracks');
  return {tracks,scope:'US · Apple Music most-played songs',measurement_date:new Date(stamp).toISOString().slice(0,10),source_updated:new Date(stamp).toISOString(),
    source_url:appleURL,note:'An ordinal song ranking snapshot. It does not report stream counts, monthly artist totals, Spotify rankings or a completed calendar-day close.'};
}
export async function appleChart(){
  const source=await sourceJSON('Apple Music US chart',appleURL,{ttl:3600}),value=parseApple(source.data);
  const rows=value.tracks.map(row=>({entity:row.id,scope:'us-songs',metric:'ordinal_rank_snapshot',measurement_date:value.measurement_date,value:row.rank,unit:'rank'}));
  const persistence=await publishDataset('apple-music',{url:appleURL,as_of:value.source_updated},source.data,rows,'observations').catch(()=>({persisted:false}));
  return {...value,as_of:source.as_of,persistence};
}
export function rankPersistence(rows,horizon=1) {
  if(!Number.isInteger(horizon)||horizon<1||horizon>31)throw new RangeError('Chart horizon must be 1–31 days');
  if(!Array.isArray(rows)||rows.some(r=>!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(Date.parse(r.date))||new Date(r.date).toISOString().slice(0,10)!==r.date||!Number.isInteger(r.value)||r.value<1||r.value>100))throw new RangeError('Dated ordinal chart ranks from 1 through 100 are required');
  const unique=new Map(rows.map(r=>[r.date,r.value])),dates=[...unique.keys()].sort(),examples=[];
  for(const date of dates){const target=new Date(Date.parse(date)+horizon*86400000).toISOString().slice(0,10);
    if(unique.get(date)===1&&unique.has(target))examples.push({origin:date,target,y:unique.get(target)===1?1:0});
  }
  const independent=[];for(const row of examples)if(!independent.length||row.origin>independent.at(-1).target)independent.push(row);
  if(independent.length<30)return {probability:null,interval:null,n:independent.length,reason:`Only ${independent.length} non-overlapping #1-to-${horizon}-day observations exist. At least 30 are required; no rank history is invented.`};
  const split=Math.floor(independent.length*.7),train=independent.slice(0,split),test=independent.slice(split),success=train.reduce((s,r)=>s+r.y,0),p=(success+.5)/(train.length+1);
  const brier=mean(test.map(r=>(r.y-p)**2)),baseline=mean(test.map(r=>(r.y-.5)**2));
  const raw=wilson(success,train.length),interval=[Math.min(raw[0],p),Math.max(raw[1],p)];
  return {probability:p,interval,n:independent.length,horizon_days:horizon,classification:'conditional_descriptive_estimate',
    validation:{n:test.length,brier,baseline_brier:baseline,brier_skill:baseline?1-brier/baseline:null,passed:test.length>=30&&brier<baseline},
    reason:'Same-source ordinal #1 persistence at the exact horizon, with non-overlapping origins and a chronological holdout. Conditional on the track being observed in both snapshots; chart exits and missing captures are excluded, so survivorship bias is possible. Does not estimate artist streams or cross-chart outcomes.'};
}
async function token() {
  if(spotifyToken?.until>Date.now())return spotifyToken.value;
  const id=process.env.SPOTIFY_CLIENT_ID,secret=process.env.SPOTIFY_CLIENT_SECRET;if(!id||!secret)return null;
  if(spotifyAuthRetryAt>Date.now())throw new Error('Spotify authentication is cooling down after a provider error. Check backend credentials, app access and account eligibility.');
  if(spotifyAuthJob)return spotifyAuthJob;
  spotifyAuthJob=(async()=>{
    try{
      const response=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(id+':'+secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',redirect:'error',signal:AbortSignal.timeout(12000)});
      const {data}=await readJSON(response,{source:'Spotify authentication',maximumBytes:12000});
      if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in))throw new Error('Invalid authentication schema');
      spotifyToken={value:data.access_token,until:Date.now()+Math.max(0,data.expires_in-120)*1000};return spotifyToken.value;
    }catch(error){spotifyAuthRetryAt=Date.now()+300000;throw Object.assign(new Error('Spotify app authentication is unavailable. Verify backend Client ID/Secret, current development-mode eligibility and quota.'),{status:error.status||503});}
  })();
  try{return await spotifyAuthJob;}finally{spotifyAuthJob=null;}
}
export function parseSpotifyReferences(payload,{query,kind='artist',artist}={}){
  if(!['artist','track'].includes(kind))throw new RangeError('Spotify references require an artist or track identity');
  const rows=(kind==='track'?payload?.tracks:payload?.artists)?.items;
  if(!Array.isArray(rows))throw new Error('Spotify catalog reference schema was not established');
  const target=identity(query),artistTarget=identity(artist);
  return rows.slice(0,10).filter(row=>target&&identity(row.name)===target&&(kind!=='track'||!artistTarget||row.artists?.some(value=>identity(value.name)===artistTarget))).map(row=>({id:row.id,name:row.name,kind,...(kind==='track'?{artists:(row.artists||[]).map(value=>value.name).filter(value=>typeof value==='string').slice(0,5)}:{}),url:safeURL(row.external_urls?.spotify,'open.spotify.com')})).filter(row=>/^[a-zA-Z0-9]{22}$/.test(row.id||'')&&row.url);
}
export async function spotifyReferences(query,{kind='artist',artist,getToken=token,get=sourceJSON}={}){
  if(!['artist','track'].includes(kind))throw new RangeError('Spotify references require an artist or track identity');
  const name=String(query||'').trim().slice(0,120);if(!name)return {status:'not_queried',references:[],reason:'An identified artist or track is required.'};
  const access=await getToken();if(!access)return {status:'not_configured',references:[]};
  const search=kind==='track'&&artist?name+' artist:'+String(artist).slice(0,80):name;
  const url='https://api.spotify.com/v1/search?'+new URLSearchParams({q:search,type:kind,limit:'3',market:'US'});
  const result=await get('Spotify catalog references',url,{ttl:900,headers:{Authorization:'Bearer '+access},maximumBytes:250000}),references=parseSpotifyReferences(result.data,{query:name,kind,artist});
  return {status:'available',as_of:result.as_of,references,kind,...(!references.length?{reason:'No exact catalog identity match was returned; similar names are not substituted.'}:{}),
    policy:'Display-only Spotify catalog references; excluded from all model packets, AI prompts and warehouse analytics.'};
}
export function musicContract(market){return /spotify|apple music|billboard|most.streamed|top.song|top.artist/i.test([market.title,market.rules_primary].join(' '));}
export function musicIdentity(market){
  const structured=market.custom_strike?.Artist,song=market.custom_strike?.Song;
  if(typeof song==='string'&&song.trim())return {artist:typeof structured==='string'?structured.trim()||null:null,song:song.trim(),kind:'track'};
  if(typeof structured==='string'&&structured.trim())return {artist:structured.trim(),song:null,kind:'artist'};
  const artistContract=/\bartist\b/i.test([market.title,market.rules_primary].join(' '))&&!/\b(?:song|track)\b/i.test(market.title||'');
  const label=typeof market.yes_sub_title==='string'?market.yes_sub_title.trim():'';
  if(!label||/^(yes|no|other)$/i.test(label))return {artist:null,song:null,kind:'unverified_song_or_other'};
  return artistContract?{artist:label,song:null,kind:'artist'}:/\b(?:song|track)\b/i.test(market.title||'')?{artist:null,song:label,kind:'track'}:{artist:null,song:null,kind:'unverified_song_or_other'};
}
export async function musicResearch(market,{includeSpotify=true,includeAlternatives=true}={}){
  if(!musicContract(market))return null;
  const {artist,song,kind}=musicIdentity(market);
  const [apple,spotify,alternatives]=await Promise.all([appleChart().catch(error=>({tracks:[],error:error.message})),includeSpotify&&(artist||song)?spotifyReferences(song||artist,{kind,artist}).catch(error=>({status:'unavailable',references:[],reason:error.message})):
    {status:'not_queried',references:[],reason:'An identified artist or track is required for catalog references.'},includeAlternatives?alternativeMusicSources(market,{artist,song}):null]);
  const matched=apple.tracks?.filter(track=>song?identity(track.name)===identity(song)&&(!artist||identity(track.artist)===identity(artist)):artist?identity(track.artist)===identity(artist):false)||[],history=matched.length===1?await chartHistory('apple-music','us-songs','ordinal_rank_snapshot',matched[0].id):[];
  return {scope:'Dated source references',apple,spotify,alternatives,matched_tracks:matched,history,
    diagnostics:{apple:{status:apple.error?'unavailable':'available',endpoint:appleURL,measurement_date:apple.measurement_date||null},spotify:{status:spotify.status,capability:'Exact artist or track catalog references only; no daily artist-stream chart endpoint is established.'},settlement:{status:'unsupported_measurement',reason:'Available catalog and cross-chart context must not be mislabeled as a settlement-matched stream history.'}},
    comparability:/spotify/i.test(market.rules_primary||market.title)?'This contract resolves on Spotify. Apple song ranks are cross-platform context and cannot establish Spotify artist streams or the contract outcome.':
      'Match the settlement source, territory, chart unit and reporting window. A song snapshot cannot establish total artist streams.',
    forecast:{probability:null,reason:'No settlement-matched, sufficiently long authorized chart-history dataset has been established for this contract. Current ranks and social posts do not become a trade probability.'},
    persistence:history.length?rankPersistence(history):null,
    sources:[...(apple.source_url?[{kind:'chart_reference',label:'Apple Music US most-played songs',url:apple.source_url,retrieved_at:apple.as_of}]:[]),...(alternatives?.sources||[])]};
}
export async function chartPosts(){
  return publicXFeed({topic:'music',enabled:true});
}
