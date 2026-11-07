import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GET} from '../app/research/research-audit.pdf/route.js';
import {assertCurrentPublicAssets, copyPublicAssets, publicSource} from '../tools/public-assets.mjs';

test('retired report returns an explicit non-cacheable removal response', async () => {
  const response = GET();
  assert.equal(response.status, 410);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, noarchive');
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  assert.doesNotMatch(await response.text(), /%PDF|https?:\/\//);
});

test('public builds reject reintroduced reports and remove stale output copies only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'predictir-public-assets-'));
  const source = join(directory, 'source');
  const output = join(directory, 'output');
  try {
    for (const path of [source, output]) await mkdir(join(path, 'research'), {recursive: true});
    await writeFile(join(source, 'current.txt'), 'current asset');
    await writeFile(join(output, 'research/research-audit.pdf'), 'retired');
    await writeFile(join(output, 'research/execution-research-audit.pdf'), 'separate report');
    await copyPublicAssets(output, source);
    await assert.rejects(access(join(output, 'research/research-audit.pdf')), {code: 'ENOENT'});
    assert.equal(await readFile(join(output, 'research/execution-research-audit.pdf'), 'utf8'), 'separate report');
    assert.equal(await readFile(join(output, 'current.txt'), 'utf8'), 'current asset');
    await writeFile(join(source, 'research/research-audit.pdf'), 'reintroduced');
    await assert.rejects(assertCurrentPublicAssets(source), /Retired/);
    await assert.rejects(copyPublicAssets(output, source), /Retired/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('current UI and generator cannot republish the retired report', async () => {
  await assertCurrentPublicAssets();
  await assert.rejects(access(join(publicSource, 'research/research-audit.pdf')), {code: 'ENOENT'});
  for (const name of ['App.jsx', 'Appearance.jsx']) {
    const source = await readFile(new URL('../ui/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /href=["']\/research\/research-audit\.pdf/);
  }
  const generator = await readFile(new URL('../tools/build_research_audit.py', import.meta.url), 'utf8');
  assert.doesNotMatch(generator, /--public-copy|shutil\.copyfile/);
  assert.match(generator, /destination\.is_relative_to\(\(BASE\/"public"\)\.resolve\(\)\)/);
});
