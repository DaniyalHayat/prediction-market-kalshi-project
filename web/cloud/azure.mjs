import {azureMode} from '../lib/workspace/azure-mode.mjs';
import {createAzureReplayServer} from './azure-replay.mjs';
import {validateAzureLive, verifyAzureDatabase, verifyAzurePrivateDNS} from './azure-live.mjs';

const mode = azureMode();
const port = Number(process.env.PORT || 8780);
if (!mode || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Azure runtime configuration');

if (mode === 'replay') {
  const server = createAzureReplayServer();
  server.listen(port, process.env.HOST || '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
} else {
  const config = validateAzureLive();
  const {store, closeStore} = await import('../lib/cloud/store.mjs');
  try {
    await verifyAzurePrivateDNS(config.host);
    await verifyAzureDatabase(store().db, config);
  } catch {
    await closeStore().catch(() => {});
    throw new Error('Azure live could not verify its private PostgreSQL connection and app permissions');
  }
  process.env.PORT = String(port);
  await import('./railway.mjs');
}
