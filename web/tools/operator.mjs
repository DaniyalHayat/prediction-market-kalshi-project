import {createOperatorServer} from '../lib/runtime/operator.mjs';
import {createOperatorEvidenceStore} from '../lib/runtime/operator-evidence.mjs';
import {createOperatorReview} from '../lib/runtime/operator-review.mjs';
import {createOperatorSearch} from '../lib/runtime/operator-search.mjs';
import {assessOperatorSre} from '../lib/runtime/operator-sre.mjs';
import {azureSearchToken, createOperatorArchiveSearch, createOperatorLogReader, readOperatorFile} from './operator-sources.mjs';

const {OPERATOR_SNAPSHOT_PATH, OPERATOR_AZURE_METRICS_PATH, OPERATOR_ACCESS_TOKEN, OPERATOR_EVIDENCE_DIR, OPERATOR_APP_ORIGIN,
  OPERATOR_SEARCH_ENDPOINT, OPERATOR_AZURE_LOG_GROUP, OPERATOR_AZURE_LOG_APP, OPERATOR_LOG_DRAIN_PATH,
  OPERATOR_USAGE_SNAPSHOT_PATH} = process.env;
const mode = process.argv[2];
if (process.argv.length > 3 || mode && mode !== '--init-search') throw new Error('Use operator.mjs [--init-search].');
const evidence = OPERATOR_EVIDENCE_DIR ? createOperatorEvidenceStore(OPERATOR_EVIDENCE_DIR) : undefined;
const search = OPERATOR_SEARCH_ENDPOINT ? createOperatorSearch({endpoint: OPERATOR_SEARCH_ENDPOINT, getToken: azureSearchToken()}) : undefined;

async function initializeSearch() {
  if (!search || !evidence) throw new Error('Set OPERATOR_SEARCH_ENDPOINT and OPERATOR_EVIDENCE_DIR.');
  await search.ensureIndex();
  const items = await evidence.search({limit: 50});
  const receipts = (await Promise.all(items.map(item => evidence.read(item.id)))).filter(Boolean);
  if (receipts.length) await search.upsert(receipts);
  console.log('Azure Search index ready. Synchronized ' + receipts.length + ' recent local receipts.');
}

async function start() {
  if (!OPERATOR_ACCESS_TOKEN) throw new Error('Set a separate local operator access token of at least 32 characters.');
  const readJson = async path => path ? JSON.parse(await readOperatorFile(path)) : {};
  const readSnapshot = () => readJson(OPERATOR_SNAPSHOT_PATH);
  const readAzure = () => readJson(OPERATOR_AZURE_METRICS_PATH);
  const readLogs = createOperatorLogReader({group: OPERATOR_AZURE_LOG_GROUP, app: OPERATOR_AZURE_LOG_APP, drainPath: OPERATOR_LOG_DRAIN_PATH});
  const assets = evidence ? {
    js: await readOperatorFile(new URL('../../ops-ui/dist/operator.js', import.meta.url)),
    css: await readOperatorFile(new URL('../../ops-ui/dist/operator.css', import.meta.url)),
  } : undefined;
  const runReview = createOperatorReview({origin: OPERATOR_APP_ORIGIN, readSnapshot, readAzure});
  const server = createOperatorServer({
    token: OPERATOR_ACCESS_TOKEN,
    readSnapshot,
    assets,
    evidence,
    archiveSearch: evidence ? createOperatorArchiveSearch({evidence, search}) : undefined,
    runReview,
    readSre: async receipt => {
      const [snapshot, observed, exportedAllowances] = await Promise.all([
        readSnapshot().catch(() => ({})), readLogs(), readJson(OPERATOR_USAGE_SNAPSHOT_PATH).catch(() => ({})),
      ]);
      const allowances = [exportedAllowances, observed.allowances].filter(packet => Number.isFinite(Date.parse(packet?.as_of)))
        .sort((a, b) => Date.parse(b.as_of) - Date.parse(a.as_of))[0];
      return assessOperatorSre({checks: receipt.checks, logs: [...(Array.isArray(snapshot.logs) ? snapshot.logs : []), ...observed.logs],
        allowances, activity: runReview.activity(), requestThrottles: snapshot.telemetry?.request_throttles});
    },
  });
  server.listen(8790, '127.0.0.1', () => console.log('Operator review is available at http://127.0.0.1:8790'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}

if (mode === '--init-search') await initializeSearch();
else await start();
