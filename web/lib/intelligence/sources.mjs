import { createHash } from "node:crypto";
import fredSnapshot from "./data/fred-snapshot.json" with {type:"json"};

const hosts = new Set(["www.tsa.gov","fred.stlouisfed.org","api.weather.gov","api.coinbase.com","api.exchange.coinbase.com"]);
const state = globalThis[Symbol.for("kalshi.independent.sources.v1")] ||= {cache:new Map(),inflight:new Map()};
state.failures ||= new Map();
export const DAY = 86400000;
export const isoDay = value => new Date(value).toISOString().slice(0,10);
export const monthNumber = date => Number(date.slice(0,4))*12+Number(date.slice(5,7))-1;

export async function sourceText(url, ttl = 300000, fetcher = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !hosts.has(parsed.hostname) || parsed.username || parsed.password) throw new RangeError("Unapproved research source");
  const cached = state.cache.get(url);
  if (cached && Date.now()-cached.at < ttl) return cached.value;
  const failed=state.failures.get(url);
  if(failed && Date.now()-failed.at<60000)throw new Error(failed.message);
  if (state.inflight.has(url)) return state.inflight.get(url);
  const task = (async()=>{
    const response = await fetcher(url, {headers:{Accept:"application/json,text/csv,text/html", "User-Agent":"KalshiMarketLab/3.0 (read-only quantitative research)"},signal:AbortSignal.timeout(16000),redirect:"error",cache:"no-store"});
    if (!response.ok) throw new Error(`${parsed.hostname} returned HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > 6000000) throw new Error("Source response too large");
    const reader = response.body.getReader(), parts = [];
    let bytes = 0;
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 6000000) {await reader.cancel(); throw new Error("Source response too large");}
        parts.push(value);
      }
    } finally {reader.releaseLock();}
    const text = Buffer.concat(parts).toString("utf8");
    const value = {text,source_url:url,retrieved_at:new Date().toISOString(),sha256:createHash("sha256").update(text).digest("hex")};
    state.cache.set(url,{at:Date.now(),value});
    return value;
  })();
  state.inflight.set(url,task);
  try {const result=await task;state.failures.delete(url);return result;}
  catch(error){state.failures.set(url,{at:Date.now(),message:error.message});throw error;}
  finally {state.inflight.delete(url);}
}
const provenance = (response, name, rows, unit, extra={}) => ({
  name,source_url:response.source_url,retrieved_at:response.retrieved_at,sha256:response.sha256,
  latest_observation:rows.at(-1)?.date || null,row_count:rows.length,unit,rows,...extra
});

export function parseTsa(html, now = Date.now()) {
  const rows = new Map();
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    for (const match of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell=>cell[1].replace(/<[^>]*>/g,"").replace(/&nbsp;|&#160;/g," ").trim());
      const date = cells[0]?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!date || !/^[\d,]+$/.test(cells[1] || "")) continue;
      const day = `${date[3]}-${date[1].padStart(2,"0")}-${date[2].padStart(2,"0")}`, value = Number(cells[1].replaceAll(",",""));
      if (value > 0 && value < 1e7 && Date.parse(day) <= now && isoDay(day) === day) rows.set(day,{date:day,value});
    }
  }
  return [...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export async function tsaSource() {
  const response = await sourceText("https://www.tsa.gov/travel/passenger-volumes",1800000);
  const rows = parseTsa(response.text);
  if (rows.length < 60) throw new Error("TSA page did not contain at least 60 valid daily observations");
  return provenance(response,"TSA checkpoint passenger counts",rows,"passengers",{
    revision_note:"Current published observations; original first-publication vintages are not reconstructed."
  });
}
export function parseFred(csv, series) {
  const lines = csv.trim().split(/\r?\n/), header = lines.shift().split(",");
  const index = header.indexOf(series);
  if (index < 1 || !/^(observation_date|DATE)$/i.test(header[0])) throw new Error("FRED CSV schema changed");
  const rows = [];
  for (const line of lines) {
    const fields = line.split(","), text = fields[index];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields[0]) || !text?.trim()) continue;
    const value = Number(text);
    if (Number.isFinite(value) && value >= 0 && Date.parse(fields[0]) <= Date.now()) rows.push({date:fields[0],value});
  }
  return rows.sort((a,b)=>a.date.localeCompare(b.date));
}
export async function macroSource(id) {
  let response, fallbackReason;
  try {response = await sourceText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL,UNRATE",21600000);}
  catch (error) {
    // A genuine archived retrieval, not generated or interpolated history.
    // Its original retrieval time is preserved and the UI must label it a snapshot.
    response = fredSnapshot;
    fallbackReason = error.message;
  }
  const series = id === "inflation" ? "CPIAUCSL" : "UNRATE";
  const levels = parseFred(response.text,series);
  const rows = id === "inflation" ? levels.flatMap((row,index)=>{
    const previous = levels[index-1];
    return previous && previous.value > 0 && monthNumber(row.date)-monthNumber(previous.date) === 1
      ? [{date:row.date,value:100*(row.value/previous.value-1)}] : [];
  }) : levels;
  if (rows.length < 120) throw new Error("Insufficient valid FRED history");
  return provenance(response,id === "inflation" ? "FRED CPIAUCSL · seasonally adjusted CPI MoM" : "FRED UNRATE · seasonally adjusted unemployment",rows,id === "inflation" ? "% MoM" : "%",{
    series,levels:levels.slice(-120),snapshot:!!fallbackReason,fallback_reason:fallbackReason || null,
    revision_note:"Latest-vintage BLS data distributed by FRED. Historical evaluation is chronological, not revision-safe first-release validation."
  });
}
export const WEATHER_SITES = {
  KXHIGHNY:{name:"New York · Central Park",lat:40.7789,lon:-73.9692,station:"KNYC",zone:"America/New_York",rule:/central park|CLINYC/i},
  KXHIGHCHI:{name:"Chicago · Midway",lat:41.7868,lon:-87.7522,station:"KMDW",zone:"America/Chicago",rule:/midway|CLIMDW/i},
  KXHIGHMIA:{name:"Miami International",lat:25.7959,lon:-80.2871,station:"KMIA",zone:"America/New_York",rule:/miami/i}
};
export function localDay(timestamp, zone) {
  const parts = new Intl.DateTimeFormat("en-US",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(timestamp));
  const get = name => parts.find(part=>part.type === name).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export async function weatherSource(series) {
  const site = WEATHER_SITES[series];
  if (!site) throw new RangeError("Unsupported weather station");
  const point = await sourceText(`https://api.weather.gov/points/${site.lat},${site.lon}`,86400000);
  const hourlyUrl = JSON.parse(point.text).properties?.forecastHourly;
  if (!hourlyUrl?.startsWith("https://api.weather.gov/gridpoints/")) throw new Error("NWS forecast location missing");
  const forecast = await sourceText(hourlyUrl,600000);
  const properties = JSON.parse(forecast.text).properties;
  const periods = (properties?.periods || []).flatMap(row=>{
    const value = row.temperatureUnit === "F" ? row.temperature : row.temperatureUnit === "C" ? row.temperature*9/5+32 : NaN;
    return Number.isFinite(value) && row.startTime ? [{date:row.startTime,value,day:localDay(row.startTime,site.zone)}] : [];
  });
  if (periods.length < 12) throw new Error("NWS hourly forecast unavailable");
  let observation = null, observation_error = null;
  try {
    const response = await sourceText(`https://api.weather.gov/stations/${site.station}/observations?limit=100`,300000);
    const rows = (JSON.parse(response.text).features || []).flatMap(row=>{
      const p = row.properties, temperature = p?.temperature?.value;
      return Number.isFinite(temperature) && p?.timestamp ? [{date:p.timestamp,value:temperature*9/5+32,day:localDay(p.timestamp,site.zone)}] : [];
    }).sort((a,b)=>a.date.localeCompare(b.date));
    observation = provenance(response,`${site.station} observed temperature`,rows,"°F");
  } catch (error) {observation_error = error.message;}
  return provenance(forecast,`NWS hourly temperature · ${site.name}`,periods,"°F",{
    series,station:site.station,zone:site.zone,updated_at:properties.updateTime || properties.generatedAt,
    observation,observation_error,revision_note:"NWS grid forecast and provisional station observations are independent proxies. The contract’s specified climate report / Weather Company settlement feed may differ."
  });
}
export function parseCandles(data, now = Date.now()) {
  const rows = new Map();
  if (!Array.isArray(data)) throw new Error("Coinbase candle schema changed");
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [start,low,high,open,close,volume] = row.map(Number);
    if (![start,low,high,open,close,volume].every(Number.isFinite) || close <= 0 || low <= 0 || high < low || volume < 0 || (start+3600)*1000 > now) continue;
    rows.set(start,{date:new Date((start+3600)*1000).toISOString(),value:close,open,low,high,volume});
  }
  return [...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export async function cryptoSource(asset) {
  if (!["BTC","ETH"].includes(asset)) throw new RangeError("Unsupported crypto asset");
  const [candles,spot] = await Promise.all([
    sourceText(`https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=3600`,60000),
    sourceText(`https://api.coinbase.com/v2/prices/${asset}-USD/spot`,30000)
  ]);
  const rows = parseCandles(JSON.parse(candles.text));
  const amount = Number(JSON.parse(spot.text).data?.amount);
  if (rows.length < 100 || !Number.isFinite(amount) || amount <= 0) throw new Error("Insufficient Coinbase price data");
  return provenance(candles,`Coinbase ${asset}/USD · completed hourly candles`,rows,"USD",{
    asset,spot:amount,spot_as_of:spot.retrieved_at,spot_source_url:spot.source_url,spot_sha256:spot.sha256,
    revision_note:"Coinbase spot is a proxy for Kalshi’s specified settlement index; exchange basis and averaging-window risk remain."
  });
}
