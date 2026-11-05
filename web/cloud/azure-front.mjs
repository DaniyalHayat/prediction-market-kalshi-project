import {readFileSync} from 'node:fs';
import {validateAzureFrontend} from '../lib/workspace/azure-mode.mjs';

const builtMode = readFileSync(new URL('../.predictir-edition', import.meta.url), 'utf8').trim();
validateAzureFrontend(process.env, builtMode);
await import('../server.js');
