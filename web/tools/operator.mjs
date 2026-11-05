import {readFile, stat} from 'node:fs/promises';
import {createOperatorServer} from '../lib/runtime/operator.mjs';

const snapshotPath = process.env.OPERATOR_SNAPSHOT_PATH, token = process.env.OPERATOR_ACCESS_TOKEN;
if (!snapshotPath || !token) throw new Error('Set a local snapshot path and a separate operator access token of at least 32 characters');
const server = createOperatorServer({token, readSnapshot: async () => {
  if ((await stat(snapshotPath)).size > 2 * 1024 * 1024) throw new Error('Snapshot exceeds the local inspection limit');
  return JSON.parse(await readFile(snapshotPath, 'utf8'));
}});
server.listen(8790, '127.0.0.1', () => console.log('Operator review is available at http://127.0.0.1:8790'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
