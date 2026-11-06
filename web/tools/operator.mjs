import {readFile, stat} from 'node:fs/promises';
import {createOperatorServer} from '../lib/runtime/operator.mjs';
import {createOperatorEvidenceStore} from '../lib/runtime/operator-evidence.mjs';
import {createOperatorReview} from '../lib/runtime/operator-review.mjs';

const {OPERATOR_SNAPSHOT_PATH, OPERATOR_AZURE_METRICS_PATH, OPERATOR_ACCESS_TOKEN, OPERATOR_EVIDENCE_DIR, OPERATOR_APP_ORIGIN} = process.env;
if (!OPERATOR_ACCESS_TOKEN) throw new Error('Set a separate local operator access token of at least 32 characters.');

async function readBounded(path, limit = 2 * 1024 * 1024) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new Error('Operator input exceeds the local inspection limit.');
  return readFile(path, 'utf8');
}

const readSnapshot = async () => OPERATOR_SNAPSHOT_PATH ? JSON.parse(await readBounded(OPERATOR_SNAPSHOT_PATH)) : {};
const readAzure = async () => OPERATOR_AZURE_METRICS_PATH ? JSON.parse(await readBounded(OPERATOR_AZURE_METRICS_PATH)) : {};
const assets = OPERATOR_EVIDENCE_DIR ? {
  js: await readBounded(new URL('../../ops-ui/dist/operator.js', import.meta.url)),
  css: await readBounded(new URL('../../ops-ui/dist/operator.css', import.meta.url)),
} : undefined;
const server = createOperatorServer({
  token: OPERATOR_ACCESS_TOKEN,
  readSnapshot,
  assets,
  evidence: OPERATOR_EVIDENCE_DIR ? createOperatorEvidenceStore(OPERATOR_EVIDENCE_DIR) : undefined,
  runReview: createOperatorReview({origin: OPERATOR_APP_ORIGIN, readSnapshot, readAzure}),
});
server.listen(8790, '127.0.0.1', () => console.log('Operator review is available at http://127.0.0.1:8790'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
