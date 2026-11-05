import {createServer} from 'node:http';
import {createLogPipeline} from '../lib/runtime/log-pipeline.mjs';
import {createLogDrainHandler} from '../lib/runtime/log-drain.mjs';

const pipeline = createLogPipeline(), handler = createLogDrainHandler({signatureSecret: process.env.DRAIN_SIGNATURE_SECRET, pipeline});
const server = createServer({maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 5000}, handler);
server.maxConnections = 16;
server.listen(8789, '127.0.0.1', () => console.log('Filtered drain receiver is bound to loopback; external ingress is not enabled'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
