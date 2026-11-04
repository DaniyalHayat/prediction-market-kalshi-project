export class DataResponseError extends Error {
  constructor(message, {status = 502, code = 'DATA_RESPONSE', url = ''} = {}) {
    super(message); this.name = 'DataResponseError'; this.status = status; this.code = code; this.url = url;
  }
}

export async function readJSON(response, {source = 'Data service', maximumBytes = 12_000_000} = {}) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximumBytes) throw new DataResponseError(`${source} returned too much data`);
  const reader = response.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const {value, done} = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) { await reader.cancel(); throw new DataResponseError(`${source} returned too much data`); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const original = new TextDecoder().decode(bytes),text=original.trim();
  const contentType = response.headers.get('content-type') || '';
  if (/^\s*</.test(text) || /text\/html/i.test(contentType)) {
    throw new DataResponseError(`${source} returned a web page instead of JSON. Check the API address or try again shortly.`,
      {code: 'HTML_INSTEAD_OF_JSON', status: response.ok ? 502 : response.status, url: response.url});
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new DataResponseError(`${source} returned an unreadable data response`, {code: 'INVALID_JSON', url: response.url}); }
  if (!response.ok) throw new DataResponseError(typeof data?.error === 'string' ? data.error : `${source} HTTP ${response.status}`,
    {status: response.status, code: 'HTTP_ERROR', url: response.url});
  if (data === null || typeof data !== 'object') throw new DataResponseError(`${source} returned an unexpected data shape`, {code: 'INVALID_SCHEMA'});
  return {data, raw: original};
}

export async function fetchJSON(url, options = {}) {
  const {source, maximumBytes, ...request} = options;
  return (await readJSON(await fetch(url, {...request, headers: {Accept: 'application/json', ...request.headers}}), {source, maximumBytes})).data;
}
