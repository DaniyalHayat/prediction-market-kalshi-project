import {createServer, connect} from 'node:http2';
import {createHash, timingSafeEqual} from 'node:crypto';

function varint(value) {
  let remaining = BigInt(value); if (remaining < 0n || remaining > 0xffffffffffffffffn) throw new RangeError('Invalid protobuf uint64');
  const bytes = []; do { let byte = Number(remaining & 127n); remaining >>= 7n; if (remaining) byte |= 128; bytes.push(byte); } while (remaining);
  return Buffer.from(bytes);
}
function readVarint(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (offset >= bytes.length) throw new Error('Truncated protobuf varint');
    const byte = bytes[offset++]; if (i === 9 && byte > 1) throw new Error('Protobuf varint overflow');
    value |= BigInt(byte & 127) << BigInt(i * 7); if (!(byte & 128)) return {value, offset};
  }
  throw new Error('Invalid protobuf varint');
}
function textField(number, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'); return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]);
}
function decode(bytes) {
  const fields = new Map(); let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset); offset = tag.offset; const field = Number(tag.value >> 3n), wire = Number(tag.value & 7n);
    if (field < 1 || field > 536870911 || fields.has(field)) throw new Error('Invalid or duplicate protobuf field');
    if (wire === 0) { const value = readVarint(bytes, offset); fields.set(field, value.value); offset = value.offset; }
    else if (wire === 2) {
      const length = readVarint(bytes, offset); offset = length.offset;
      if (length.value > BigInt(bytes.length - offset)) throw new Error('Truncated protobuf field');
      const end = offset + Number(length.value); fields.set(field, bytes.subarray(offset, end)); offset = end;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4; if (offset > bytes.length) throw new Error('Truncated unknown protobuf field'); fields.set(field, undefined);
    } else throw new Error('Unsupported protobuf wire type');
  }
  return fields;
}
function text(fields, field) {
  const value = fields.get(field); if (value === undefined) return '';
  if (!Buffer.isBuffer(value)) throw new Error('Wrong protobuf wire type');
  return new TextDecoder('utf-8', {fatal: true}).decode(value);
}
function sequence(fields) {
  const value = fields.get(2) ?? 0n; if (typeof value !== 'bigint') throw new Error('Wrong sequence wire type'); return value.toString();
}
export function encodeEnvelope({streamId, sequence: value, eventId, eventType, payload}) {
  return Buffer.concat([textField(1, streamId), varint(16), varint(value), textField(3, eventId), textField(4, eventType), textField(5, Buffer.from(JSON.stringify(payload)))]);
}
export function decodeEnvelope(bytes) {
  const fields = decode(bytes), streamId = text(fields, 1), eventId = text(fields, 3), eventType = text(fields, 4), value = sequence(fields);
  if (!/^[a-zA-Z0-9_:./-]{1,160}$/.test(streamId) || !/^[a-zA-Z0-9_-]{1,160}$/.test(eventId) || !/^[a-zA-Z0-9_.-]{1,80}$/.test(eventType)) throw new Error('Invalid event envelope');
  const payload = JSON.parse(text(fields, 5)); if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Payload must be an object');
  return {streamId, sequence: value, eventId, eventType, payload};
}
export function frameGrpcMessage(payload) {
  if (payload.length > 65536) throw new RangeError('gRPC message exceeds 64 KiB');
  const header = Buffer.alloc(5); header.writeUInt32BE(payload.length, 1); return Buffer.concat([header, payload]);
}
function unframe(bytes) {
  if (bytes.length < 5 || bytes[0] !== 0 || bytes.readUInt32BE(1) !== bytes.length - 5) throw new Error('Expected one uncompressed gRPC unary message');
  return bytes.subarray(5);
}
const encodeAck = ({accepted, sequence: value = '0', reason = ''}) => Buffer.concat([varint(8), varint(accepted ? 1 : 0), varint(16), varint(value), textField(3, reason)]);

export async function startLoopbackGrpcIngest({token, onEvent, port = 0}) {
  if (typeof token !== 'string' || token.length < 32 || typeof onEvent !== 'function') throw new TypeError('Separate internal ingest token and event handler required');
  const hash = value => createHash('sha256').update(value).digest(), expected = hash(token), server = createServer({settings: {maxConcurrentStreams: 16, maxHeaderListSize: 8192}}), sessions = new Set();
  server.on('session', session => {
    if (sessions.size >= 8) { session.close(); return; }
    sessions.add(session); session.setTimeout(10000, () => session.close()); session.on('close', () => sessions.delete(session)); session.on('error', () => {});
  });
  server.on('stream', (stream, headers) => {
    let finished = false, bytes = 0, chunks = [];
    const finish = (status, body = Buffer.alloc(0)) => {
      if (finished || stream.destroyed) return; finished = true; clearTimeout(timer);
      stream.respond({':status': 200, 'content-type': 'application/grpc+proto'}, {waitForTrailers: true});
      stream.once('wantTrailers', () => { if (!stream.destroyed) stream.sendTrailers({'grpc-status': String(status)}); }); stream.end(body);
    };
    const timer = setTimeout(() => finish(4), 5000); timer.unref(); stream.on('error', () => {}); stream.once('close', () => clearTimeout(timer));
    const authorization = headers.authorization || '';
    if (typeof authorization !== 'string' || authorization.length > 512 || !authorization.startsWith('Bearer ') || !timingSafeEqual(hash(authorization.slice(7)), expected)) { finish(16); return; }
    if (headers[':method'] !== 'POST' || headers[':path'] !== '/marketlab.v1.Ingest/Publish' || !String(headers['content-type']).startsWith('application/grpc')) { finish(12); return; }
    stream.on('data', chunk => { bytes += chunk.length; if (bytes > 65541) { chunks = []; finish(8); } else if (!finished) chunks.push(chunk); });
    stream.on('end', async () => {
      if (finished) return;
      let event; try { event = decodeEnvelope(unframe(Buffer.concat(chunks))); } catch { finish(3); return; }
      try { const result = await onEvent(event, {signal: AbortSignal.timeout(4500)}); if (!finished) finish(0, frameGrpcMessage(encodeAck({accepted: result?.accepted === true, sequence: event.sequence, reason: result?.accepted === true ? '' : 'rejected'}))); }
      catch { finish(13); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {port: server.address().port, close: async () => { for (const session of sessions) session.destroy(); await new Promise(resolve => server.close(resolve)); }};
}

export async function publishLoopbackEvent({port, token, event}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 32) throw new RangeError('Invalid loopback gRPC destination');
  const session = connect('http://127.0.0.1:' + port); session.on('error', () => {});
  try {
    return await new Promise((resolve, reject) => {
      let grpcStatus, bytes = 0; const chunks = [], request = session.request({':method': 'POST', ':path': '/marketlab.v1.Ingest/Publish', 'content-type': 'application/grpc+proto', te: 'trailers', authorization: 'Bearer ' + token});
      request.setTimeout(6000, () => request.destroy(new Error('gRPC deadline exceeded'))); request.on('error', reject);
      request.on('trailers', headers => { grpcStatus = headers['grpc-status']; });
      request.on('data', chunk => { bytes += chunk.length; if (bytes > 65541) request.destroy(new Error('gRPC response exceeds bound')); else chunks.push(chunk); });
      request.on('end', () => {
        try { if (grpcStatus !== '0') throw Object.assign(new Error('Internal gRPC request rejected'), {grpcStatus}); const fields = decode(unframe(Buffer.concat(chunks))); resolve({accepted: fields.get(1) === 1n, sequence: sequence(fields), reason: text(fields, 3)}); }
        catch (error) { reject(error); }
      });
      try { request.end(frameGrpcMessage(encodeEnvelope(event))); } catch (error) { request.destroy(); reject(error); }
    });
  } finally { session.destroy(); }
}
