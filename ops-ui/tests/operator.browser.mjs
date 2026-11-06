import assert from 'node:assert/strict'
import {once} from 'node:events'
import {mkdtemp, readFile, readdir, rmdir, unlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createOperatorEvidenceStore} from '../../web/lib/runtime/operator-evidence.mjs'
import {createOperatorServer} from '../../web/lib/runtime/operator.mjs'

const library = process.env.PLAYWRIGHT_CORE_PATH
const {chromium} = await import(library ? pathToFileURL(library).href : 'playwright-core')
const token = 'fixture-operator-token-abcdefghijklmnopqrstuvwxyz'
const title = 'Readiness check maintenance review'
const folder = await mkdtemp(join(tmpdir(), 'predictir-operator-browser-'))
const assets = {
  js: await readFile(new URL('../dist/operator.js', import.meta.url)),
  css: await readFile(new URL('../dist/operator.css', import.meta.url)),
}
const server = createOperatorServer({
  token, assets, evidence: createOperatorEvidenceStore(folder), readSnapshot: async () => ({}),
  runReview: async (input) => {
    assert.deepEqual(input, {name: 'Readiness check', checks: ['http', 'mcp']})
    return {
      profile: input.name, captured_at: new Date().toISOString(), checks: [
        {connector: 'api', check: 'health', status: 'pass', latency_ms: 1500, status_code: 200},
        {connector: 'mcp', check: 'source_status', status: 'unavailable', status_code: 429},
      ],
    }
  },
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
let browser
try {
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true})
  const page = await browser.newPage({viewport: {width: 1180, height: 940}})
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.getByRole('heading', {name: 'Operations review'}).waitFor()
  assert.equal(await page.locator('.workspace-layout').evaluate(el => getComputedStyle(el).display), 'grid',
    'The same-origin workbench stylesheet loads under the operator CSP')
  const tokenInput = page.getByLabel('Operator token')
  await page.getByRole('button', {name: 'Run and archive'}).click()
  await page.getByText('Enter a 32–256 character operator token without spaces.').waitFor()
  await tokenInput.fill(token)
  await page.getByLabel('Profile name').fill('Readiness check')
  await page.getByRole('button', {name: 'Run and archive'}).click()
  await page.getByRole('heading', {name: title}).waitFor()
  const grid = page.getByRole('grid', {name: 'Connector readings'})
  assert.equal(await grid.getByRole('row').count(), 3)
  await page.getByText('Conditional formatting', {exact: false}).click()
  await page.getByRole('button', {name: 'Add rule'}).click()
  await grid.getByText('Latency (ms) at least 1000', {exact: true}).waitFor()
  await page.getByLabel('Filter connector').selectOption('mcp')
  assert.equal(await grid.getByRole('row').count(), 2)
  assert.equal(await grid.getByText('Latency (ms) at least 1000', {exact: true}).count(), 0)
  await page.getByLabel('Search archive').fill('no matching title')
  await page.getByRole('button', {name: 'Search', exact: true}).click()
  await page.getByText('No saved review matched this search.').waitFor()
  await page.getByLabel('Search archive').fill('readiness')
  await page.getByRole('button', {name: 'Search', exact: true}).click()
  await page.getByRole('button', {name: 'Open ' + title}).click()
  await page.getByText('Saved review opened.').waitFor()
  await page.getByLabel('Profile name').fill('Other name')
  await page.getByRole('checkbox', {name: 'Public API checks'}).uncheck()
  await page.getByRole('button', {name: 'Reuse profile'}).click()
  assert.equal(await page.getByLabel('Profile name').inputValue(), 'Readiness check')
  assert.ok(await page.getByRole('checkbox', {name: 'Public API checks'}).isChecked())
  await page.getByLabel('Filter connector').selectOption('all')
  await grid.getByText('Latency (ms) at least 1000', {exact: true}).waitFor()
  await page.setViewportSize({width: 390, height: 844})
  const {width, scrollWidth} = await page.locator('html').evaluate(el => ({width: el.clientWidth, scrollWidth: el.scrollWidth}))
  assert.ok(scrollWidth <= width, 'Only the data grids scroll horizontally on a narrow screen')
  await page.getByRole('button', {name: 'Clear access'}).click()
  assert.equal(await tokenInput.inputValue(), '')
  assert.equal(await page.getByRole('grid').count(), 0)
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0])
  const files = await readdir(folder)
  assert.equal(files.length, 1)
  assert.ok(!(await readFile(join(folder, files[0]), 'utf8')).includes(token))
  assert.deepEqual(errors, [])
  console.log('Operator browser verification passed for capture, archive, nested flags, narrow layout and access clearing.')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  for (const name of await readdir(folder)) await unlink(join(folder, name))
  await rmdir(folder)
}
