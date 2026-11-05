import {permittedPublicPage} from './public-pages.mjs';
const decode=value=>String(value||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(Number(n)):'').trim();
const norm=value=>decode(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function parseKworbUS(html,now=Date.now()){
  if(typeof html!=='string'||html.length>1_000_000||!/Spotify Daily Chart - United States/.test(html))throw new Error('US Spotify song chart identity was not established');
  const date=html.match(/Spotify Daily Chart - United States - (\d{4})\/(\d{2})\/(\d{2})/),measurement=date?date.slice(1).join('-'):null;
  if(!measurement||!Number.isFinite(Date.parse(measurement))||new Date(measurement).toISOString().slice(0,10)!==measurement||Date.parse(measurement)>now)throw new Error('US song chart measurement date was not established');
  const table=html.match(/<table\b[^>]*id="spotifydaily"[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if(!table||!/<th[^>]*>Streams<\/th>/.test(table))throw new Error('US song stream-count columns were not established');
  const tracks=[...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap(match=>{
    const cells=[...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1]);if(cells.length<11)return [];
    const rank=Number(decode(cells[0])),streamText=decode(cells[6]),links=[...cells[2].matchAll(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)],artist=links.find(l=>/\/artist\//.test(l[1])),track=links.find(l=>/\/track\//.test(l[1])),id=track?.[1].match(/\/([A-Za-z0-9]{22})\.html$/)?.[1];
    if(!Number.isInteger(rank)||rank<1||rank>200||!id||!artist||!/^\d[\d,]*$/.test(streamText))return [];
    return [{id,rank,name:decode(track[2]),artist:decode(artist[2]),streams:Number(streamText.replaceAll(',','')),url:'https://open.spotify.com/track/'+id,unit:'reported daily song streams',territory:'US',measurement_date:measurement}];
  });
  if(tracks.length<50||new Set(tracks.map(r=>r.id)).size!==tracks.length||new Set(tracks.map(r=>r.rank)).size!==tracks.length)throw new Error('US song chart coverage is incomplete or duplicated');
  return {tracks,measurement_date:measurement,scope:'US daily Spotify song chart, as reported by Kworb',unit:'reported daily song streams',publisher:'Kworb',source_tier:'secondary_measurement',stale:now-Date.parse(measurement)>4*86400000,
    note:'Secondary public chart mirror. US top-200 song counts are neither full artist totals nor Billboard rankings. Confirm the contract’s official source, chart date, counting rules and revision policy.'};
}
export async function alternativeMusicSources(market,{artist=null,song=null,fetchPage=permittedPublicPage,now=Date.now()}={}){
  const url='https://kworb.net/spotify/country/us_daily.html';
  try{
    const response=await fetchPage('Kworb US Spotify song chart',url,{ttl:3600,maximumBytes:1_000_000});
    if(response.status!=='available')return {status:response.status,reason:response.reason,sources:[{label:'Kworb US Spotify song chart',url}],matched_tracks:[]};
    const value=parseKworbUS(response.data.text,now),matched=value.tracks.filter(t=>song?norm(t.name)===norm(song)&&(!artist||norm(t.artist)===norm(artist)):artist?norm(t.artist)===norm(artist):false);
    return {...value,status:'available',as_of:response.as_of,source_url:url,sha256:response.sha256,matched_tracks:matched,
      settlement_match:false,settlement_note:/billboard/i.test([market.title,market.rules_primary].join(' '))?'Billboard settlement: Spotify US daily counts provide streaming context only. They do not include the Billboard chart’s full methodology.':'A secondary song chart is displayed as context until exact publisher, territory, entity unit and measurement window are matched.',
      sources:[{kind:'secondary_chart',label:'Kworb US daily Spotify song chart',url,retrieved_at:response.as_of,sha256:response.sha256}],
      direct_review_links:[{label:'Official Spotify Charts',url:'https://charts.spotify.com/charts/overview/us'},{label:'Official Billboard Hot 100',url:'https://www.billboard.com/charts/hot-100/'},{label:'YouTube Charts',url:'https://charts.youtube.com/'}]};
  }catch{return {status:'unavailable',reason:'The public secondary chart or its dated schema could not be verified.',source_url:url,matched_tracks:[]};}
}
