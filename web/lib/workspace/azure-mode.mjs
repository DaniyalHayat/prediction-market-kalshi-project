export const AZURE_STREAM_LIFETIME_MS = 210000;
export const providerCredentialNames = [
  'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'X_BEARER_TOKEN',
  'REDDIT_ACCESS_TOKEN', 'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_REFRESH_TOKEN',
];

export function azureMode(value = process.env.PREDICTIR_MODE) {
  if (!value) return null;
  if (value !== 'replay' && value !== 'live') throw new Error('Choose replay or live for PREDICTIR_MODE');
  return value;
}

export function azureOrigin(value = process.env.APP_ORIGIN) {
  if (!value) return null;
  let url;
  try { url = new URL(value); }
  catch { throw new Error('APP_ORIGIN must be a canonical HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value) {
    throw new Error('APP_ORIGIN must be a canonical HTTPS origin');
  }
  return url.origin;
}

export function azureBackendOrigin(value, {allowLoopback = false} = {}) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Use the private Azure backend origin'); }
  const local = allowLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const azure = url.protocol === 'https:' && !url.port && /^[a-z0-9-]+\.internal\.[a-z0-9-]+\.[a-z0-9-]+\.azurecontainerapps\.io$/.test(url.hostname);
  if (url.origin !== value || url.username || url.password || !local && !azure) throw new Error('Use the private Azure backend origin');
  return url.origin;
}

export function assertAzureServiceSecrets(env, {account = false} = {}) {
  const names = ['MARKET_EDGE_SECRET', 'ASSISTANT_SERVICE_SECRET', ...(account ? ['ACCOUNT_COOKIE_SECRET'] : [])];
  const values = names.map(name => env[name]);
  if (values.some(value => typeof value !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(value)) || new Set(values).size !== names.length) {
    throw new Error('Azure live requires distinct edge, research and backend account secrets');
  }
}

export function validateAzureFrontend(env, builtMode) {
  const mode = azureMode(env.PREDICTIR_MODE);
  if (!mode || mode !== builtMode) throw new Error('The Azure frontend runtime edition must match the image');
  const allowLoopback = !env.CONTAINER_APP_NAME && (mode === 'replay' || env.PREDICTIR_AZURE_LOCAL === '1');
  const backendOrigin = azureBackendOrigin(env.MARKET_BACKEND_URL, {allowLoopback});
  if (env.CONTAINER_APP_ENV_DNS_SUFFIX && !new URL(backendOrigin).hostname.endsWith('.internal.' + env.CONTAINER_APP_ENV_DNS_SUFFIX)) {
    throw new Error('Use the private backend in this Azure Container Apps environment');
  }
  if ((mode === 'live' || !allowLoopback) && !azureOrigin(env.APP_ORIGIN)) throw new Error('Set the canonical Azure application origin');
  const backendOnly = ['DATABASE_URL', 'DATABASE_CA_CERT', 'PREDICTIR_DATABASE_HOST', 'ACCOUNT_COOKIE_SECRET', 'KALSHI_API_KEY_ID', 'KALSHI_PRIVATE_KEY', ...providerCredentialNames];
  if (backendOnly.some(name => env[name])) throw new Error('Azure frontend cannot receive database, exchange, account or provider credentials');
  if (mode === 'live') assertAzureServiceSecrets(env);
  if (mode === 'replay' && (env.MARKET_EDGE_SECRET || env.ASSISTANT_SERVICE_SECRET)) throw new Error('Azure replay does not use service credentials');
  return {mode, backendOrigin};
}
