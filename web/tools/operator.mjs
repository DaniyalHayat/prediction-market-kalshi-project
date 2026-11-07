import {createOperatorServer} from '../lib/runtime/operator.mjs';
import {readBoundedTextFile} from '../lib/runtime/bounded-file.mjs';

const snapshotPath = process.env.OPERATOR_SNAPSHOT_PATH, token = process.env.OPERATOR_ACCESS_TOKEN;
if (!snapshotPath || !token) throw new Error('Set a local snapshot path and a separate operator access token of at least 32 characters');
const server = createOperatorServer({token, readSnapshot: async () => {
  return JSON.parse(await readBoundedTextFile(snapshotPath,2*1024*1024,'Snapshot exceeds the local inspection limit'));
}});
server.listen(8790, '127.0.0.1', () => console.log('Operator review is available at http://127.0.0.1:8790'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
