import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, verify, constants } from "node:crypto";
import { bookMetrics, normalizeMarket, validateTicker, excelSafe, number, signedHeaders, parsePrivateKey } from "../lib/live.mjs";

test("private keys parse from multiline, flattened, escaped and marker-free secret values",()=>{
  const pem=generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"}), body=pem.replace(/-----[^-]+-----/g,"").replace(/\s+/g,"");
  for(const value of [pem,pem.replace(/\n/g," "),pem.replace(/\n/g,"\\n"),body])assert.equal(parsePrivateKey(value).asymmetricKeyType,"ed25519");
  assert.throws(()=>parsePrivateKey("not a key"));
});

test("Kalshi signatures cover timestamp, method and path without query for Ed25519 and RSA-PSS keys",()=>{
  const url="https://external-api.kalshi.com/trade-api/v2/markets?limit=5", message=Buffer.from("1703123456789GET/trade-api/v2/markets");
  const ed=generateKeyPairSync("ed25519"), edHeaders=signedHeaders("GET",url,1703123456789,{id:"test-key",key:ed.privateKey});
  assert.equal(edHeaders["KALSHI-ACCESS-KEY"],"test-key"); assert.equal(edHeaders["KALSHI-ACCESS-TIMESTAMP"],"1703123456789");
  assert.ok(verify(null,message,ed.publicKey,Buffer.from(edHeaders["KALSHI-ACCESS-SIGNATURE"],"base64")));
  const rsa=generateKeyPairSync("rsa",{modulusLength:2048}), rsaHeaders=signedHeaders("GET",url,1703123456789,{id:"test-key",key:rsa.privateKey});
  assert.ok(verify("sha256",message,{key:rsa.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST},Buffer.from(rsaHeaders["KALSHI-ACCESS-SIGNATURE"],"base64")));
  assert.deepEqual(signedHeaders("GET",url,1,null),{}); assert.deepEqual(signedHeaders("GET",url,1,{id:"x",invalid:true}),{});
});

test("cloud static-book metrics match independent Python Decimal fixture", async () => {
  const fixture=JSON.parse(await readFile(new URL("./fixtures/book-decimal.json",import.meta.url),"utf8"));
  const metrics=bookMetrics(fixture.raw,fixture.contracts);
  for(const [key,value] of Object.entries(fixture.metrics)) {
    if(typeof value === "number") assert.ok(Math.abs(metrics[key]-value)<1e-10, key);
    else assert.equal(metrics[key],value,key);
  }
});
test("NO bids complement YES asks, duplicate levels aggregate, fills respect depth",()=>{
  const m=bookMetrics({orderbook_fp:{yes_dollars:[[".3","100"]],no_dollars:[[".6","10"],[".6","5"],[".5","5"]]}},30);
  assert.equal(m.book_ask,.4); assert.equal(m.ask_depth_2c,15); assert.equal(m.sim_filled,20); assert.equal(m.sim_fill_ratio,Math.round(2/3*1e12)/1e12); assert.equal(m.sim_cost,8.5);
});
test("crossed books never receive a fabricated fill",()=>{
  const m=bookMetrics({orderbook_fp:{yes_dollars:[[".8","30"]],no_dollars:[[".7","30"]]}},10);
  assert.equal(m.book_state,"crossed");assert.equal(m.sim_filled,0);assert.equal(m.book_midpoint,null);
});
test("empty books and missing quotes remain null",()=>{
  const m=bookMetrics({orderbook_fp:{}},100);assert.equal(m.book_state,"empty");assert.equal(m.sim_vwap,null);
  const row=normalizeMarket({ticker:"X",yes_bid_dollars:null,yes_ask_dollars:".50"},"Macro","S","https://example.com");assert.equal(row.midpoint,null);assert.equal(row.volume_24h,null);
});
test("zero boundary bids remain valid quotes",()=>{const row=normalizeMarket({yes_bid_dollars:"0",yes_ask_dollars:".01"},"Macro","S","source");assert.equal(row.catalog_quote_valid,true);assert.equal(row.midpoint,.005);});
test("invalid books, quantities, and contracts are rejected",()=>{
  for(const quantity of [0,-1,Infinity,1000001])assert.throws(()=>bookMetrics({orderbook_fp:{}},quantity));
  assert.throws(()=>bookMetrics({orderbook_fp:{yes_dollars:[["1.2","2"]]}},10));
  assert.throws(()=>bookMetrics({orderbook_fp:{yes_dollars:[[".2","-1"]]}},10));
});
test("real dotted CPI tickers allowed while paths and URLs are rejected",()=>{
  assert.equal(validateTicker("KXCPI-26NOV-T0.2"),"KXCPI-26NOV-T0.2");
  for(const t of [null,"../test","..","http://evil","A/B","."])assert.throws(()=>validateTicker(t));
});
test("untrusted workbook cell strings cannot become formulas",()=>{for(const v of ["=HYPERLINK()","+CMD","-CMD","@SUM","\tCMD"])assert.equal(excelSafe(v),"'"+v);assert.equal(excelSafe("A market title"),"A market title");});
test("number parser preserves absent values",()=>{for(const v of [null,undefined,"",false,"NaN","Infinity"])assert.equal(number(v),null);assert.equal(number("0"),0);});
