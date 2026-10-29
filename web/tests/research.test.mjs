import test from "node:test";
import assert from "node:assert/strict";
import "../public/dashboard/research.js";
const {simulate, sizePosition} = globalThis.KalshiResearch;
const book = {orderbook_fp:{yes_dollars:[[".35","40"]], no_dollars:[[".60","10"],[".60","5"],[".59","20"],[".50","100"]]}};

test("YES fills aggregate levels, honor the slippage cap, and separate fees", () => {
  const result = simulate(book, "yes", 50, {slippage:2});
  assert.equal(result.filled, 35);
  assert.equal(result.unfilled, 15);
  assert.equal(result.available, 35);
  assert.equal(result.cost, 14.2);
  assert.equal(result.fee, .6);
  assert.equal(result.allIn, 14.8);
  assert.equal(result.fills.length, 2);
  assert.equal(result.winPnl, 20.2);
  assert.equal(result.lossPnl, -14.8);
});
test("NO buys complement YES bids rather than reusing YES asks", () => {
  const result = simulate(book, "no", 10);
  assert.equal(result.best, .65);
  assert.equal(result.cost, 6.5);
  assert.equal(result.fee, .16);
});
test("zero slippage only consumes the best level", () => {
  const result = simulate(book, "yes", 50, {slippage:0});
  assert.equal(result.filled, 15);
  assert.equal(result.cost, 6);
  assert.equal(result.fee, .26);
});
test("budget sizing includes fees and cannot invent depth", () => {
  assert.equal(sizePosition(book, "yes", 0), 0);
  const size = sizePosition(book, "yes", 10);
  assert.ok(simulate(book, "yes", size).allIn <= 10);
  assert.ok(simulate(book, "yes", size + 1).allIn > 10);
  assert.equal(sizePosition(book, "yes", 100000), 35);
});
test("empty or one-sided books do not fabricate fills", () => {
  const empty = simulate({orderbook_fp:{}}, "yes", 100);
  assert.equal(empty.filled, 0);
  assert.equal(empty.vwap, null);
  assert.equal(empty.breakeven, null);
  assert.equal(sizePosition({orderbook_fp:{}}, "no", 100), 0);
  assert.equal(simulate({orderbook_fp:{yes_dollars:[[".4","10"]]}}, "yes", 5).filled, 0);
});
test("crossed, invalid, fractional and missing assumptions are rejected", () => {
  assert.throws(()=>simulate({orderbook_fp:{yes_dollars:[[".8","10"]],no_dollars:[[".5","10"]]}}, "yes", 10));
  for (const value of [0, 1.5, -1, Infinity, 1000001]) assert.throws(()=>simulate(book, "yes", value));
  assert.throws(()=>simulate(book, "yes", 1, {slippage:null}));
  assert.throws(()=>simulate(book, "yes", 1, {coefficient:-.1}));
  assert.throws(()=>simulate(book, "yes", 1, {multiplier:101}));
});
test("fee-free scenarios and boundary prices preserve zero values", () => {
  const result = simulate(book, "yes", 10, {coefficient:0});
  assert.equal(result.fee, 0);
  const free = simulate({orderbook_fp:{no_dollars:[["1","5"]]}}, "yes", 5);
  assert.equal(free.allIn, 0);
  assert.equal(free.breakeven, 0);
});
test("an empty market feed and absent model transfer never dereference a null probability",()=>{
  const react={
    createElement:()=>null,
    useState:initial=>[typeof initial==="function" ? initial() : initial,()=>{}],
    useEffect:callback=>{const cleanup=callback();if(typeof cleanup==="function")cleanup();}
  };
  const Workbench=globalThis.KalshiResearch.createWorkbench(react,{Button:()=>null,DataComponent:()=>null});
  assert.doesNotThrow(()=>Workbench({selected:null,book:null,live:false,connector:"",contracts:100,
    setContracts:()=>{},download:()=>{},modelTransfer:null}));
});
