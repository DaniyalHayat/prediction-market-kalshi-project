import { createHash, createPrivateKey, sign, constants } from "node:crypto";

export const BASE = "https://external-api.kalshi.com/trade-api/v2";
// Optional public-data service; credentials are sent only to the official exchange.
const DATA_SERVICE = (process.env.KALSHI_DATA_SERVICE_URL || "").replace(/\/$/, "");
export const VERTICALS = { Macro: ["KXFEDDECISION", "KXCPI", "KXU3"], Sports: ["KXNBAGAME", "KXNFLGAME"], Travel: ["KXTSA", "KXTSAD"], Weather: ["KXHIGHNY","KXHIGHCHI","KXHIGHMIA"], Crypto: ["KXBTC","KXETH"] };
const stateKey = Symbol.for("kalshi.live.state.v1");
const state = globalThis[stateKey] ||= { cache: new Map(), inflight: new Map(), samples: [] };
// Persist cooldowns across dev hot reloads without changing successful timestamps.
state.cooldowns ||= new Map();
state.requestInflight ||= new Map();
async function reserveProviderRead() {
  const now=Date.now(),slot=Math.max(now,state.nextReadAt || 0);
  if(slot-now>10000)throw new Error("Kalshi read queue busy; retry shortly");
  state.nextReadAt=slot+125;
  if(slot>now)await new Promise(resolve=>setTimeout(resolve,slot-now));
  if(state.providerCooldown?.until>Date.now())throw upstreamError(429,Math.ceil((state.providerCooldown.until-Date.now())/1000),true);
}
export const utc = () => new Date().toISOString();
// Server-only Kalshi credentials. Values are read from runtime secrets and never returned by the API.
let signer = null;
// Secret fields may flatten PEM newlines; rebuild the key from its base64 body.
export function parsePrivateKey(pem) {
  const text = pem.replaceAll("\\n", "\n").trim();
  try { return createPrivateKey(text); } catch {}
  const body = text.replace(/-----(BEGIN|END)[A-Z ]*PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error("unparseable");
  const der = Buffer.from(body, "base64");
  for (const type of ["pkcs8", "pkcs1"]) { try { return createPrivateKey({ key: der, format: "der", type }); } catch {} }
  throw new Error("unparseable");
}
function credentials() {
  const id = process.env.KALSHI_API_KEY_ID?.trim(), pem = process.env.KALSHI_PRIVATE_KEY;
  if (!id || !pem) return null;
  if (signer?.id === id && signer.pem === pem) return signer;
  try {
    const key = parsePrivateKey(pem);
    if (!["ed25519", "rsa"].includes(key.asymmetricKeyType)) throw new Error("unsupported");
    signer = { id, pem, key };
  } catch { signer = { id, pem, invalid: true }; }
  return signer;
}
export function authStatus() {
  const creds = credentials();
  if (!creds) return "not configured";
  if (creds.invalid) return "invalid key: KALSHI_PRIVATE_KEY must contain the full private key, not the Key ID";
  return state.authRejected ? "rejected by Kalshi; using public requests" : "configured";
}
export function signedHeaders(method, url, now = Date.now(), creds = credentials()) {
  if (!creds || creds.invalid || !creds.key) return {};
  const timestamp = String(now), message = Buffer.from(timestamp + method + new URL(url).pathname);
  const signature = creds.key.asymmetricKeyType === "ed25519" ? sign(null, message, creds.key)
    : sign("sha256", message, { key: creds.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  return { "KALSHI-ACCESS-KEY": creds.id, "KALSHI-ACCESS-TIMESTAMP": timestamp, "KALSHI-ACCESS-SIGNATURE": signature.toString("base64") };
}
export const number = (value) => value === null || value === undefined || value === "" || typeof value === "boolean" || !Number.isFinite(Number(value)) ? null : Number(value);
const rounded = (value) => value === null ? null : Math.round(value * 1e12) / 1e12;
export function validateTicker(ticker) { if (typeof ticker !== "string" || !/^[A-Za-z0-9_.-]{1,140}$/.test(ticker) || ticker.includes("..") || ticker === ".") throw new RangeError("Invalid public market ticker"); return ticker; }
export function validateVertical(vertical) { if (!Object.hasOwn(VERTICALS, vertical)) throw new RangeError("Choose Macro, Sports, Travel, Weather or Crypto"); return vertical; }
export const validQuote = (bid, ask) => bid !== null && ask !== null && 0 <= bid && bid <= ask && ask <= 1;
export function normalizeMarket(m, vertical, series, source_url) {
  const yes_bid = number(m.yes_bid_dollars), yes_ask = number(m.yes_ask_dollars), valid = validQuote(yes_bid, yes_ask);
  return { ticker: m.ticker, event_ticker: m.event_ticker, title: m.title, close_time: m.close_time, rules_primary: m.rules_primary,
    series, vertical, yes_bid, yes_ask, midpoint: valid ? rounded((yes_bid + yes_ask) / 2) : null,
    spread_cents: valid ? rounded((yes_ask - yes_bid) * 100) : null, volume_24h: number(m.volume_24h_fp), volume: number(m.volume_fp),
    open_interest: number(m.open_interest_fp), last_price: number(m.last_price_dollars), catalog_quote_valid: valid, book_state: "not sampled", source_url };
}
export function bookMetrics(payload, contracts = 100) {
  if (!Number.isFinite(contracts) || contracts <= 0 || contracts > 1e6) throw new RangeError("Contracts must be greater than zero and no more than 1,000,000");
  const book = payload.orderbook_fp;
  if (!book || typeof book !== "object" || Array.isArray(book)) throw new RangeError("Missing fixed-point orderbook_fp");
  function levels(key) {
    const result = new Map();
    for (const row of book[key] || []) {
      if (!Array.isArray(row) || row.length !== 2) throw new RangeError("Invalid order-book level");
      const price = number(row[0]), quantity = number(row[1]);
      if (price === null || quantity === null || price < 0 || price > 1 || quantity < 0) throw new RangeError("Invalid level value");
      if (quantity) result.set(price, (result.get(price) || 0) + quantity);
    }
    return [...result];
  }
  const bids = levels("yes_dollars").sort((a,b) => b[0] - a[0]);
  const asks = levels("no_dollars").map(([p,q]) => [rounded(1-p),q]).sort((a,b) => a[0]-b[0]);
  const bid = bids[0]?.[0] ?? null, ask = asks[0]?.[0] ?? null;
  const crossed = bid !== null && ask !== null && bid > ask, valid = bid !== null && ask !== null && !crossed;
  let remaining = contracts, cost = 0, filled = 0;
  if (!crossed) for (const [price,quantity] of asks) { const take = Math.min(remaining,quantity); cost += take*price; filled += take; remaining -= take; if (remaining <= 0) break; }
  const depth = ask !== null && !crossed ? asks.filter(([p]) => p <= ask + .02 + 1e-12).reduce((sum,[,q]) => sum+q,0) : null;
  return { book_bid: bid, book_ask: ask, book_spread_cents: valid ? rounded((ask-bid)*100) : null, book_midpoint: valid ? rounded((ask+bid)/2) : null,
    ask_depth_2c: rounded(depth), sim_requested: contracts, sim_filled: rounded(filled), sim_fill_ratio: rounded(filled/contracts), sim_cost: rounded(cost),
    sim_vwap: filled ? rounded(cost/filled) : null, sim_slippage_cents: filled ? rounded((cost/filled-ask)*100) : null,
    book_state: crossed ? "crossed" : valid ? "two-sided" : bids.length || asks.length ? "one-sided" : "empty" };
}
export function retryAfterSeconds(header, now = Date.now()) {
  const seconds = typeof header === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(header) ? Number(header) : null;
  const date = header ? Date.parse(header) : NaN;
  return Math.max(60, Math.ceil(seconds !== null && Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? (date-now)/1000 : 60));
}
function upstreamError(status, seconds, cooldown = false) {
  const error = new Error(`Public Kalshi API HTTP ${status}${seconds ? `; retry after ${seconds}s${cooldown ? " (provider cooldown active)" : ""}` : ""}`);
  error.upstream_status = status;
  if (seconds) error.retry_after_seconds = seconds;
  return error;
}
export async function request(path, params = {}, fetcher = fetch, now = Date.now) {
  const query = new URLSearchParams(params); query.sort();
  const url = BASE + path + "?" + query;
  const blocked = [state.cooldowns.get(url), state.providerCooldown].filter(Boolean).sort((a,b)=>b.until-a.until)[0];
  if (blocked && blocked.until > now()) throw upstreamError(blocked.status, Math.ceil((blocked.until-now())/1000), true);
  if (state.requestInflight.has(url)) return state.requestInflight.get(url);
  const task = (async () => {
    await reserveProviderRead();
    const base = { Accept: "application/json", "User-Agent": "Mozilla/5.0 KalshiMarketLab/2.0" };
    const transportUrl = DATA_SERVICE ? DATA_SERVICE + path + "?" + query : url;
    const send = headers => fetcher(transportUrl, { headers, signal: AbortSignal.timeout(12000), cache: "no-store" });
    const auth = DATA_SERVICE || state.authRejected ? {} : signedHeaders("GET", url, now());
    let response = await send({ ...base, ...auth });
    // A rejected key must not hide public market data; fall back to an unsigned read.
    if ((response.status === 401 || response.status === 403) && auth["KALSHI-ACCESS-KEY"]) { state.authRejected = true; await reserveProviderRead(); response = await send(base); }
    if (!response.ok) {
      if (response.status === 429) {
        const seconds = retryAfterSeconds(response.headers.get("retry-after"), now());
        const cooldown = {status:429, until:now()+seconds*1000};
        state.cooldowns.set(url,cooldown);
        // A shared cloud IP may be limited across all endpoints; do not try a
        // different series or ticker to work around that provider response.
        if (!state.providerCooldown || cooldown.until > state.providerCooldown.until) state.providerCooldown=cooldown;
        while (state.cooldowns.size>256) state.cooldowns.delete(state.cooldowns.keys().next().value);
        throw upstreamError(429,seconds);
      }
      throw upstreamError(response.status);
    }
    const raw = await response.text();
    if (raw.length > 12e6) throw new Error("Public response exceeded size bound");
    state.cooldowns.delete(url);
    return { data: JSON.parse(raw), as_of: response.headers.get("x-kalshi-as-of") || utc(), source_url: response.headers.get("x-kalshi-source-url") || url, sha256: response.headers.get("x-kalshi-sha256") || createHash("sha256").update(raw).digest("hex") };
  })();
  state.requestInflight.set(url,task);
  try { return await task; } finally { state.requestInflight.delete(url); }
}
export async function markets(vertical = "Macro", getter = request) {
  validateVertical(vertical);
  const cached = state.cache.get(vertical);
  if (cached && Date.now()-cached.at < 20000) return cached.value;
  if (state.inflight.has(vertical)) return state.inflight.get(vertical);
  const task = (async () => {
    const results = await Promise.all(VERTICALS[vertical].map(async series => {
      try { return {series, result: await getter("/markets", { series_ticker: series, status: "open", limit: "200" })}; }
      catch(error) { return {series, error: error.message, upstream_status:error.upstream_status, retry_after_seconds:error.retry_after_seconds}; }
    }));
    const rows = new Map(), coverage = [], errors = [], lineage = [];
    for (const item of results) {
      if (item.error) { errors.push({series: item.series,error: item.error,upstream_status:item.upstream_status,retry_after_seconds:item.retry_after_seconds}); continue; }
      const {result,series} = item;
      for (const row of result.data.markets || []) if (row.ticker) rows.set(row.ticker, normalizeMarket(row,vertical,series,result.source_url));
      coverage.push({series,records:(result.data.markets || []).length,truncated:!!result.data.cursor});
      lineage.push({as_of:result.as_of,source_url:result.source_url,sha256:result.sha256});
    }
    if (!coverage.length) throw new Error("Live API unavailable: " + errors.map(x=>x.error).join("; "));
    const partial = !!errors.length || coverage.some(c=>c.truncated);
    const value = { markets:[...rows.values()].sort((a,b)=>(b.volume_24h ?? -1)-(a.volume_24h ?? -1)), as_of:utc(), source_url:BASE+"/markets", partial, coverage, errors, lineage, status:partial?"partial":"live" };
    for (const row of value.markets) state.samples.push({ observed_at:value.as_of,ticker:row.ticker,vertical,midpoint:row.midpoint,volume:row.volume,volume_24h:row.volume_24h,spread_cents:row.spread_cents });
    state.samples = state.samples.slice(-10000);
    state.cache.set(vertical,{at:Date.now(),value});
    return value;
  })();
  state.inflight.set(vertical,task);
  try { return await task; } finally { state.inflight.delete(vertical); }
}
export async function book(ticker, contracts = 100) {
  validateTicker(ticker);
  if (!Number.isFinite(contracts) || contracts <= 0 || contracts > 1e6) throw new RangeError("Invalid contract count");
  const result = await request("/markets/"+encodeURIComponent(ticker)+"/orderbook",{depth:"100"});
  return {ticker,raw:result.data,metrics:bookMetrics(result.data,contracts),as_of:result.as_of,source_url:result.source_url};
}
export async function marketDetails(ticker) {
  validateTicker(ticker);
  const result = await request("/markets/"+encodeURIComponent(ticker));
  if (!result.data.market || result.data.market.ticker !== ticker) throw new Error("Market detail response did not match the selected ticker");
  return {market:result.data.market,as_of:result.as_of,source_url:result.source_url};
}
export async function trades(ticker) { validateTicker(ticker); const result = await request("/markets/trades",{ticker,limit:"100"}); return {trades:result.data.trades || [],partial:!!result.data.cursor,as_of:result.as_of,source_url:result.source_url}; }
export function history(vertical = "Macro") {
  validateVertical(vertical);
  const previous = new Map(), samples = state.samples.filter(s=>s.vertical===vertical).map(row=>{
    const sample = {...row,interval_seconds:null,volume_delta:null,contracts_per_minute:null}, prev = previous.get(row.ticker);
    if (prev) { const seconds = (Date.parse(row.observed_at)-Date.parse(prev.observed_at))/1000; if (seconds>0 && row.volume!==null && prev.volume!==null && row.volume>=prev.volume) Object.assign(sample,{interval_seconds:seconds,volume_delta:row.volume-prev.volume,contracts_per_minute:(row.volume-prev.volume)*60/seconds}); }
    previous.set(row.ticker,row); return sample;
  });
  return {samples,vertical,as_of:utc(),storage:"Bounded in-memory observations for this server process; may reset or differ across runtime instances"};
}
export const excelSafe = value => typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? "'"+value : value;
export async function workbook(vertical = "Macro") {
  const {default:ExcelJS} = await import("exceljs");
  const result = await markets(vertical), observations = history(vertical);
  const wb = new ExcelJS.Workbook(); wb.creator="Kalshi Market Lab"; wb.created=new Date();
  const fields=["ticker","title","series","vertical","midpoint","spread_cents","volume_24h","volume","open_interest","close_time","source_url"];
  const ws=wb.addWorksheet("Markets"); ws.addRow(fields); for(const row of result.markets) ws.addRow(fields.map(k=>excelSafe(row[k] ?? null)));
  const ts=wb.addWorksheet("TimeSeries"),keys=["observed_at","ticker","midpoint","volume","volume_24h","spread_cents","interval_seconds","volume_delta","contracts_per_minute"];
  ts.addRow(["Observed UTC","Ticker","Midpoint","Cumulative contracts","24h contracts","Spread cents","Interval seconds","Volume delta","Contracts per minute"]);
  for(const row of observations.samples) ts.addRow(keys.map(k=>excelSafe(row[k] ?? null)));
  const sc=wb.addWorksheet("Scenarios");
  for(const row of [
    ["Hypothetical model input","Value","Meaning"], ["Quarterly handle",1e8,"User scenario; not measured OSB handle"], ["Hold margin",.07,"User scenario; not exchange spread"], ["Operating cost ratio",.65,"User scenario"], ["Tax rate",.25,"User scenario"],
    ["GGR / revenue",{formula:"B2*B3",result:7e6},"Handle × hold"], ["Operating profit",{formula:"B6*(1-B4)",result:2450000},"Revenue × (1 − cost ratio)"], ["After-tax profit",{formula:"B7*(1-B5)",result:1837500},"Operating profit × (1 − tax)"], ["Hold sensitivity +1ppt",{formula:"B2*0.01",result:1e6},"Incremental revenue; fixed handle"],
    ["Hotel available room nights",1e5,"User scenario"], ["Occupancy",.75,"User scenario; no TSA mapping"], ["ADR",180,"User scenario"], ["RevPAR",{formula:"B11*B12",result:135},"Occupancy × ADR; not forecast"], ["Hotel room revenue",{formula:"B10*B13",result:135e5},"Available room nights × RevPAR"]]) sc.addRow(row);
  const df=wb.addWorksheet("Definitions");
  for(const row of [["Field / constraint","Definition"],["Collection completed UTC",result.as_of],["Coverage",JSON.stringify(result.coverage)],["Partial catalog",String(result.partial)],["Midpoint","(valid YES bid + YES ask)/2; not true probability"],["Spread","(YES ask − YES bid) × 100 cents; not sportsbook vig"],["Volume","Contracts; not dollars of handle"],["History",observations.storage],["Contracts per minute","Nonnegative cumulative-volume change / actual elapsed seconds × 60; blank before second observation or on reset"],["Prices","Public quotes; no executed fill or guaranteed depth"],["OSB","No matched sportsbook feed or customer-flow data; liquidity migration not measured"],["Forecasts","No trained or validated GGR, RevPAR, equity or 3-statement forecast"],["Scenario sheet","Editable hypothetical assumptions, not measured outcomes"],["API documentation","https://docs.kalshi.com/getting_started/quick_start_market_data"]]) df.addRow(row);
  for(const sheet of wb.worksheets){ sheet.views=[{state:"frozen",ySplit:1}]; sheet.autoFilter={from:{row:1,column:1},to:{row:sheet.rowCount,column:sheet.columnCount}}; sheet.getRow(1).eachCell(cell=>{cell.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF173546"}};cell.font={bold:true,color:{argb:"FFFFFFFF"}};}); sheet.columns.forEach((column,index)=>{let width=18;column.eachCell(cell=>{width=Math.max(width,Math.min(65,String(cell.text || "").length+2));}); column.width=width;}); }
  return wb.xlsx.writeBuffer();
}
