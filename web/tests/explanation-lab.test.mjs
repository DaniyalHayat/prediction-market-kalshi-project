import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPLANATION_LABS,evaluateExplanationLab} from '../lib/workspace/explanation-lab.mjs';

const now=Date.parse('2026-11-06T15:00:00Z'),at=minutes=>new Date(now+minutes*60000).toISOString();
const market={ticker:'KXTEST-26NOV06-YES',status:'active',market_type:'binary',close_time:at(300)};
const source='https://external-api.kalshi.com/trade-api/v2/markets/'+market.ticker;
const book={ticker:market.ticker,as_of:at(0),source_url:source+'/orderbook',
  raw:{orderbook_fp:{yes_dollars:[['.45','4'],['.43','10']],no_dollars:[['.53','2'],['.51','5']]}}};
const forecast={probability:.62,interval:[.55,.68],source_as_of:at(-5),eligible:true,validation:{passed:true},evidence:{tier:2}};
const research={ticker:market.ticker,market,forecast};
const inputs={market,book,research,now};
const calculate=(id,more={})=>evaluateExplanationLab(id,{...inputs,...more});
const metric=(result,label)=>result.metrics.find(row=>row.label===label)?.value;
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} is not close to ${expected}`);
const report=(publisher,slug,extras={})=>({publisher,title:slug,url:'https://'+publisher.toLowerCase()+'.example/'+slug,as_of:at(-20),
  match_scope:'matched',platform:'publisher_metadata',...extras});
const history={ticker:market.ticker,source_url:source+'/candlesticks',as_of:at(0),rows:[
  {time:at(-35),midpoint:.45},{time:at(-22),midpoint:.49},{time:at(-21),value:.70,value_kind:'last_trade'},
  {time:at(-20),midpoint:.99},{time:at(-17),value:.54,value_kind:'quoted_midpoint'},
  {time:at(-10),midpoint:.55},{time:at(1),midpoint:.62}
]};

test('eight experiments are declared with supported controls and stable response shape',()=>{
  assert.equal(EXPLANATION_LABS.length,8);
  assert.equal(new Set(EXPLANATION_LABS.map(row=>row.id)).size,8);
  for(const {id,controls} of EXPLANATION_LABS){
    assert.ok(controls.length);
    const value=evaluateExplanationLab(id,inputs);
    assert.ok(['ready','unavailable'].includes(value.status));
    assert.ok(Array.isArray(value.metrics)&&Array.isArray(value.rows)&&Array.isArray(value.sources)&&Array.isArray(value.options));
  }
});

test('break-even charges each observed ask level and identifies a partial result',()=>{
  const result=calculate('break-even');
  assert.equal(result.status,'ready');
  near(metric(result,'Break-even payout per contract'),50.2);
  near(metric(result,'Average ask before fees'),48.2);
  near(metric(result,'Modeled entry fee'),.10);
  assert.equal(result.sources[0].url,book.source_url);
  const partial=calculate('break-even',{quantity:10});
  assert.match(partial.summary,/part/);
  assert.equal(metric(partial,'Contracts covered'),7);
  assert.equal(metric(partial,'Contracts unfilled'),3);
  const schedule=calculate('break-even',{fees:{series:'KXTEST',coefficient:0,as_of:at(-1),source_url:'https://example.com/fees'}});
  near(metric(schedule,'Break-even payout per contract'),48.2);
  assert.equal(schedule.sources.length,2);
});

test('fill path follows the side and honors the selected price band',()=>{
  const yes=calculate('fill-path',{slippage:0,quantity:10});
  assert.equal(yes.rows.length,1);
  near(metric(yes.rows[0],'Ask'),47);
  assert.equal(metric(yes,'Remaining'),8);
  const no=calculate('fill-path',{side:'no',quantity:6});
  assert.deepEqual(no.rows.map(row=>metric(row,'Cumulative fill')),[4,6]);
  assert.deepEqual(no.rows.map(row=>Math.round(metric(row,'Ask'))),[55,57]);
  near(metric(no,'All-in entry cost'),3.45);
});

test('depth stress is conditional, leaves the original book intact and handles total loss of depth',()=>{
  const partial=calculate('liquidity-stress',{depthRetained:50});
  assert.equal(metric(partial.rows[0],'Filled'),5);
  assert.equal(metric(partial.rows[1],'Filled'),3.5);
  near(metric(partial,'Additional unfilled'),1.5);
  assert.equal(book.raw.orderbook_fp.no_dollars[0][1],'2');
  const zero=calculate('liquidity-stress',{depthRetained:0});
  assert.equal(metric(zero.rows[1],'Filled'),0);
  assert.equal(metric(zero.rows[1],'All-in cost per fill'),null);
});

test('exit uses executable bids, deducts fees and allocates basis only to the covered portion',()=>{
  const result=calculate('exit-now',{quantity:16,basis:8});
  near(metric(result,'Net exit proceeds'),5.85);
  assert.equal(metric(result,'Contracts unfilled'),2);
  near(metric(result,'Basis for filled portion'),7);
  near(metric(result,'P&L on filled portion'),-1.15);
  assert.equal(metric(calculate('exit-now'),'P&L on filled portion'),null);
});

test('settlement computes cash and P&L from verified NFL tie rules or explicitly conditional binary payouts',()=>{
  const standard=calculate('settlement',{basis:2.51});
  near(metric(standard.rows[0],'Paper P&L'),2.49);
  near(metric(standard.rows[1],'Paper P&L'),-2.51);
  near(metric(calculate('settlement'),'All-in basis'),2.51);
  assert.equal(calculate('settlement',{book:null}).status,'unavailable');
  const nfl={...market,ticker:'KXNFLGAME-26NOV08ARISEA-ARI',event_ticker:'KXNFLGAME-26NOV08ARISEA',
    title:'Arizona wins',yes_sub_title:'Arizona',
    rules_primary:'If Arizona wins the Arizona vs Seattle Pro Football game originally scheduled for Nov 8, 2026, then the market resolves to Yes.',
    rules_secondary:'If the game ends in a tie, the market will resolve to $0.50 for each team.'};
  const result=calculate('settlement',{market:nfl,quantity:4,basis:1.80,side:'no'});
  assert.equal(result.rows[1].label,'Game ties');
  near(metric(result.rows[1],'Settlement cash'),2);
  near(metric(result.rows[1],'Paper P&L'),.20);
  assert.equal(calculate('settlement',{market:{...nfl,rules_secondary:'Unknown'},basis:1.8}).status,'unavailable');
});

test('headline replay requires strict quote brackets and keeps index and publisher timestamps distinct',()=>{
  const evidence={ticker:market.ticker,items:[report('Example','Market update',{time_basis:'provider_first_seen'})]};
  const result=calculate('news-replay',{history,evidence,side:'no',windowMinutes:5});
  near(metric(result,'NO quote change'),-5);
  assert.equal(result.rows[0].as_of,at(-22));
  assert.equal(result.rows[1].label,'Report first seen by index');
  assert.equal(result.rows[2].as_of,at(-17));
  assert.equal(result.options.length,1);
  assert.equal(calculate('news-replay',{history,evidence,windowMinutes:2}).status,'unavailable');
  assert.equal(calculate('news-replay',{history:{...history,ticker:'OTHER'},evidence}).status,'unavailable');
});

test('evidence removal drops all articles by the selected publisher and reports only matched surviving records',()=>{
  const evidence={ticker:market.ticker,as_of:at(0),items:[report('Alpha','one'),report('Alpha','two'),
    report('Beta','three',{confidence:'primary_source'}),report('Gamma','related',{match_scope:'related'}),
    report('Delta','future',{as_of:at(1)}),report('Eta','unsafe',{url:'javascript:alert(1)'}),
    report('Zeta','social',{platform:'reddit'}),report('Beta','three')]};
  const result=calculate('evidence-check',{evidence});
  assert.equal(metric(result,'Reports set aside'),2);
  assert.equal(metric(result,'Matched reports remaining'),1);
  assert.equal(metric(result,'Primary-source reports remaining'),1);
  assert.deepEqual(result.options,[{value:0,label:'Alpha'},{value:1,label:'Beta'}]);
  assert.equal(result.rows[0].label,'three');
  assert.equal(calculate('evidence-check',{evidence:{...evidence,ticker:'OTHER'}}).status,'unavailable');
});

test('model stress compares the whole released range against an all-in shift without changing probabilities',()=>{
  const result=calculate('model-pressure',{priceDelta:5});
  near(metric(result,'Current all-in entry'),50.2);
  near(metric(result,'Scenario all-in entry'),55.2);
  near(metric(result.rows[0],'Difference after scenario cost'),-.2);
  near(metric(result.rows[1],'Estimated payout per contract'),62);
  near(metric(result.rows[2],'Difference for this size'),.64);
  assert.equal(calculate('model-pressure',{quantity:8}).status,'unavailable');
  for(const changes of [{experimental:true},{eligible:false},{source_as_of:at(-2000)},{validation:{passed:false}}])
    assert.equal(calculate('model-pressure',{research:{...research,forecast:{...forecast,...changes}}}).status,'unavailable');
  assert.equal(calculate('model-pressure',{research:{...research,ticker:'OTHER'}}).status,'unavailable');
  assert.equal(calculate('model-pressure',{priceDelta:-60}).status,'unavailable');
});

test('model stress separates a verified tie payout from win probability and retains the NFL release gates',()=>{
  const nfl={...market,ticker:'KXNFLGAME-26NOV08ARISEA-ARI',event_ticker:'KXNFLGAME-26NOV08ARISEA',
    title:'Arizona wins',yes_sub_title:'Arizona',
    rules_primary:'If Arizona wins the Arizona vs Seattle Pro Football game originally scheduled for Nov 8, 2026, then the market resolves to Yes.',
    rules_secondary:'If the game ends in a tie, the market will resolve to $0.50 for each team.'};
  const payout={...forecast,probability:.4,interval:[.3,.5],eligible:false,outcomes:{win:.4,loss:.5,tie:.1},
    expected_settlement_value:.45,settlement_value_interval:[.35,.55],settlement_kind:'win_loss_half_on_tie',model_release_passed:true,
    validation:{passed:true,payout_mse:.15,baseline_payout_mse:.2}};
  const exact={ticker:nfl.ticker,market:nfl,forecast:payout,extensions:{sports:{league:'nfl',coverage:{partial:false},selection:{code:'ARI'},
    event:{state:'pre',status_name:'STATUS_SCHEDULED',completed:false,played_at:at(2400)}}}};
  const snapshot={...book,ticker:nfl.ticker},input={market:nfl,book:snapshot,research:exact,side:'no'};
  const result=calculate('model-pressure',input);
  assert.equal(result.status,'ready');
  near(metric(result.rows[1],'Estimated payout per contract'),55);
  assert.match(result.note,/50¢ tie/);
  assert.equal(calculate('model-pressure',{...input,research:{...exact,forecast:{...payout,model_release_passed:false}}}).status,'unavailable');
});

test('depth calculations fail closed on mismatched, stale, crossed and closed inputs',()=>{
  for(const depth of [{...book,ticker:'OTHER'},{...book,as_of:at(-2)},{...book,as_of:at(1)},
    {...book,raw:{orderbook_fp:{yes_dollars:[['.60','2']],no_dollars:[['.52','2']]}}}]){
    assert.equal(calculate('break-even',{book:depth}).status,'unavailable');
  }
  assert.equal(calculate('fill-path',{market:{...market,status:'settled'}}).status,'unavailable');
  assert.equal(calculate('liquidity-stress',{depthRetained:101}).status,'unavailable');
  assert.equal(calculate('exit-now',{quantity:0}).status,'unavailable');
  assert.equal(calculate('no-such-tool').status,'unavailable');
});
