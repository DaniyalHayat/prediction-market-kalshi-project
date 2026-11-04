import test from 'node:test';
import assert from 'node:assert/strict';
import {readJSON} from '../lib/transport.mjs';
import {initialSelection, selectionReducer, contractTitle} from '../ui/selection.mjs';

test('HTML success and proxy failure responses become a useful typed error', async () => {
  for (const status of [200, 502]) await assert.rejects(() => readJSON(new Response('<!doctype html><h1>Unavailable</h1>',
    {status, headers: {'content-type': 'text/html'}})), error => error.code === 'HTML_INSTEAD_OF_JSON' && !error.message.includes('Unexpected token'));
});
test('JSON errors and byte bounds are enforced without returning raw markup', async () => {
  await assert.rejects(() => readJSON(new Response('{"error":"Wait before retrying"}', {status:429})), /Wait before retrying/);
  await assert.rejects(() => readJSON(new Response('{"data":"1234567890"}'), {maximumBytes:5}), /too much data/);
  assert.deepEqual((await readJSON(new Response('{"ok":true}'))).data, {ok:true});
});
test('switching contracts atomically clears old research and refuses late responses', () => {
  const a = selectionReducer(initialSelection, {type:'select', market:{ticker:'A', title:'A title'}});
  const b = selectionReducer({...a, book:{ticker:'A'}, research:{ticker:'A'}}, {type:'select', market:{ticker:'B', title:'B title'}});
  assert.equal(b.market.title, 'B title'); assert.equal(b.book, null); assert.equal(b.research, null);
  assert.equal(selectionReducer(b, {type:'context', ticker:'A', generation:a.generation, value:{market:{ticker:'A'}}}), b);
  assert.equal(selectionReducer(b, {type:'research', ticker:'B', generation:b.generation, value:{ticker:'A'}}), b);
});
test('outcome names accompany shared event titles and stale quotes cannot replace newer data', () => {
  assert.equal(contractTitle({title:'Who wins?', yes_sub_title:'Los Angeles'}), 'Who wins? · Los Angeles');
  const state = {...selectionReducer(initialSelection, {type:'select', market:{ticker:'A'}}), book:{ticker:'A', as_of:'2026-11-04T12:00:00Z'}};
  assert.equal(selectionReducer(state, {type:'book', ticker:'A', generation:state.generation,
    value:{ticker:'A', as_of:'2026-11-04T11:00:00Z'}}), state);
});
