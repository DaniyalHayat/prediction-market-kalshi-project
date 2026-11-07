import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import QuoteComparison from '../ui/QuoteComparison';

const render = (props: Parameters<typeof QuoteComparison>[0]) => renderToStaticMarkup(createElement(QuoteComparison,props));
const outcome = (label: string, tone: string, value: string) => new RegExp('class="probability-outcome probability-' + tone + '"><span>' + label + '</span><strong>' + value.replace('.','\\.') + '%</strong>');

test('a high loss probability is downside risk while the tie remains neutral',()=>{
  const html=render({bid:.21,ask:.22,age:1,forecast:{probability:.305,outcomes:{win:.305,loss:.692,tie:.003},expected_settlement_value:.3065}});
  assert.match(html,outcome('Win','low','30.5'));
  assert.match(html,outcome('Loss','low','69.2'));
  assert.doesNotMatch(html,/probability-high"><span>Loss/);
  assert.match(html,outcome('Tie','balanced','0.3'));
  assert.match(html,/Expected YES payout 30\.6/);
  assert.match(html,/Loss colors show downside risk/);
  assert.match(html,/Color is not a profit signal/);
});

test('a low loss probability uses the favorable tone without changing actual percentages or widths',()=>{
  const html=render({bid:.79,ask:.80,age:1,forecast:{outcomes:{win:.692,loss:.305,tie:.003},expected_settlement_value:.6935}});
  assert.match(html,outcome('Win','high','69.2'));
  assert.match(html,outcome('Loss','high','30.5'));
  assert.match(html,outcome('Tie','balanced','0.3'));
  assert.match(html,/--chance:30\.50%/);
  assert.match(html,/--chance:69\.20%/);
});

test('binary YES/NO likelihood colors and exact zero probabilities remain intact',()=>{
  const html=render({bid:0,ask:0,age:0,forecast:{probability:1}});
  assert.equal((html.match(outcome('YES','high','100'))||[]).length,1);
  assert.match(html,outcome('NO','low','0'));
  assert.match(html,outcome('YES','low','0'));
  assert.match(html,outcome('NO','high','100'));
  assert.match(html,/Colors show YES\/NO likelihood/);
});

test('stale estimates and invalid three-outcome totals never retain colored model probabilities',()=>{
  const forecast={outcomes:{win:.305,loss:.692,tie:.003},expected_settlement_value:.3065};
  const stale=render({bid:.21,ask:.22,age:91,forecast,stale:true});
  assert.match(stale,/Awaiting a fresh quote/);
  assert.match(stale,/Refreshing estimate/);
  assert.doesNotMatch(stale,/probability-outcome|Expected YES payout|30\.5%|69\.2%/);
  const invalid=render({bid:null,ask:null,age:null,forecast:{outcomes:{win:.4,loss:.8,tie:.1}}});
  assert.match(invalid,/Estimate unavailable/);
  assert.doesNotMatch(invalid,/probability-outcome|NaN|Infinity/);
});
