import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import sitemap from '../app/sitemap.js';

test('HIBP ownership file is exact plain public text outside page proxy matching',async()=>{
  assert.equal(await readFile(new URL('../public/hibp-verification.txt',import.meta.url),'utf8'),'dweb_qt5cu4ajmekylu2uhy4b7j0v\n');
  const config=await import('../next.config.mjs');
  assert.equal(typeof config.default.rewrites,'undefined');
});

test('native sitemap lists the canonical Predictir homepage and excludes private or retired routes',()=>{
  const rows=sitemap();
  assert.deepEqual(rows.map(row=>row.url),['https://predictir.dev/']);
  assert.ok(rows.every(row=>!row.url.includes('/api/')&&!row.url.includes('/research/')));
});

