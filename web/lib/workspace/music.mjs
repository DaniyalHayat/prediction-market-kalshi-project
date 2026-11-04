import {sourceJSON} from './providers.mjs';
import {publishDataset,chartHistory} from './warehouse.mjs';
import {cloudEnabled,store} from '../cloud/store.mjs';
import {mean,wilson} from '../intelligence/math.mjs';
import {readJSON} from '../transport.mjs';
const appleURL='https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/songs.json';
let spotifyToken;
const safeURL=(value,host)=>{try{const u=new URL(value);return u.protocol==='https:'&&(!host||u.hostname===host)?u.href:null;}catch{return null;}};
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
  const response=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(id+':'+secret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',redirect:'error',signal:AbortSignal.timeout(12000)});
  const {data}=await readJSON(response,{source:'Spotify authentication',maximumBytes:12000});
  if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in))throw new Error('Spotify app authentication is unavailable');
  spotifyToken={value:data.access_token,until:Date.now()+Math.max(0,data.expires_in-120)*1000};return spotifyToken.value;
}
export async function spotifyReferences(query){
  const access=await token();if(!access)return {status:'not_configured',references:[]};
  const url='https://api.spotify.com/v1/search?'+new URLSearchParams({q:String(query).slice(0,120),type:'artist',limit:'3'});
  const result=await sourceJSON('Spotify catalog references',url,{ttl:900,headers:{Authorization:'Bearer '+access},maximumBytes:250000});
  return {status:'available',as_of:result.as_of,references:(result.data.artists?.items||[]).map(row=>({id:row.id,name:row.name,url:safeURL(row.external_urls?.spotify,'open.spotify.com')})).filter(r=>r.url),
    policy:'Display-only Spotify catalog references; excluded from all model packets, AI prompts and warehouse analytics.'};
}
export function musicContract(market){return /spotify|apple music|billboard|most.streamed|top.song|top.artist/i.test([market.title,market.rules_primary].join(' '));}
export async function musicResearch(market,{includeSpotify=true}={}){
  if(!musicContract(market))return null;
  const artist=String(market.custom_strike?.Artist||market.yes_sub_title||'').trim();
  const [apple,spotify]=await Promise.all([appleChart().catch(error=>({tracks:[],error:error.message})),includeSpotify&&artist?spotifyReferences(artist).catch(error=>({status:'unavailable',references:[],reason:error.message})):null]);
  const matched=artist?apple.tracks?.filter(t=>(t.artist+' '+t.name).toLowerCase().includes(artist.toLowerCase())):[],history=matched?.length===1?await chartHistory('apple-music','us-songs','ordinal_rank_snapshot',matched[0].id):[];
  return {scope:'Dated source references',apple,spotify,matched_tracks:artist?matched:[],history,
    comparability:/spotify/i.test(market.rules_primary||market.title)?'This contract resolves on Spotify. Apple song ranks are cross-platform context and cannot establish Spotify artist streams or the contract outcome.':
      'Match the settlement source, territory, chart unit and reporting window. A song snapshot cannot establish total artist streams.',
    forecast:{probability:null,reason:'No settlement-matched, sufficiently long authorized chart-history dataset has been established for this contract. Current ranks and social posts do not become a trade probability.'},
    persistence:history.length?rankPersistence(history):null,
    sources:apple.source_url?[{kind:'chart_reference',label:'Apple Music US most-played songs',url:apple.source_url,retrieved_at:apple.as_of}]:[]};
}
const accounts=['talkofthecharts','spotify_data'];
export async function chartPosts(){
  if(!process.env.X_BEARER_TOKEN)return {status:'not_configured',posts:[]};
  if(!cloudEnabled())return {status:'unavailable',posts:[],reason:'A durable quota store is required before paid X reads.'};
  const s=store(),posts=[];
  for(const author of accounts){
    const value=await s.cached('x-public-feed#'+author,1800,async()=>{
      const user=await s.cached('x-user#'+author,2592000,async()=>{
        const response=await sourceJSON('X public chart news','https://api.x.com/2/users/by/username/'+author,{ttl:2592000,headers:{Authorization:'Bearer '+process.env.X_BEARER_TOKEN}});
        if(!/^\d+$/.test(response.data.data?.id||''))throw new Error('The public X account could not be resolved');return response.data.data;
      });
      const month=new Date().toISOString().slice(0,7),limit=Math.min(10000,Math.max(10,Number(process.env.X_MONTHLY_POST_READ_LIMIT||1200)));
      if(!await s.consume('x-posts#'+month,limit,5,45*86400))return {status:'budget_reached',posts:[]};
      const previous=await s.get('x-cursor#'+author),params=new URLSearchParams({max_results:'5','tweet.fields':'created_at','exclude':'retweets,replies'});
      if(previous?.newest_id)params.set('since_id',previous.newest_id);
      const response=await sourceJSON('X public chart news',`https://api.x.com/2/users/${user.id}/tweets?${params}`,{ttl:1,headers:{Authorization:'Bearer '+process.env.X_BEARER_TOKEN},maximumBytes:100000});
      const rows=(response.data.data||[]).filter(p=>/^\d+$/.test(p.id)&&typeof p.text==='string'&&Number.isFinite(Date.parse(p.created_at))&&Date.parse(p.created_at)<=Date.now()+300000).map(p=>({id:p.id,author,excerpt:p.text.slice(0,500),created_at:p.created_at,url:`https://x.com/${author}/status/${p.id}`}));
      const merged=[...new Map([...rows,...(previous?.posts||[])].map(p=>[p.id,p])).values()].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,20);
      await s.save({pk:'x-cursor#'+author,sk:'value',newest_id:rows[0]?.id||previous?.newest_id,posts:merged},true);
      return {status:'available',posts:merged,as_of:response.as_of};
    }).catch(error=>({status:'unavailable',posts:[],reason:error.message}));
    posts.push({...value,author});
  }
  return {status:posts.some(p=>p.status==='available')?'available':posts[0]?.status,posts:posts.flatMap(p=>p.posts).sort((a,b)=>b.created_at.localeCompare(a.created_at)),
    feeds:posts.map(({posts,...rest})=>rest),note:'Attributed public posts, refreshed at most every 30 minutes. They are unverified context, not direct chart observations or model inputs. Five paid reads are conservatively reserved before each request.'};
}
