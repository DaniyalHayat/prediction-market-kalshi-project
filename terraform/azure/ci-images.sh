#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1

docker build --platform linux/amd64 --target backend --tag predictir-backend:ci --file web/Dockerfile.azure web
docker build --platform linux/amd64 --target front --tag predictir-replay-front:ci --file web/Dockerfile.azure web
docker build --platform linux/amd64 --target front --build-arg PREDICTIR_BUILD_MODE=live \
  --tag predictir-live-front:ci --file web/Dockerfile.azure web
docker build --platform linux/amd64 --tag predictir-bootstrap:ci --file terraform/azure/bootstrap/Dockerfile .
bash terraform/azure/bootstrap/test.sh predictir-bootstrap:ci

backend="azure-replay-backend-$$"
frontend="azure-replay-front-$$"
cleanup() { docker rm -f "$frontend" "$backend" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --detach --network none --name "$backend" --env PREDICTIR_MODE=replay predictir-backend:ci
docker run --detach --network "container:$backend" --name "$frontend" --env PREDICTIR_MODE=replay \
  --env MARKET_BACKEND_URL=http://127.0.0.1:8780 predictir-replay-front:ci
docker exec --interactive "$frontend" node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3000';
let response;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    response = await fetch(base + '/api/health', {signal: AbortSignal.timeout(3000)});
    if (response.ok) break;
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(response?.ok, 'frontend and backend ready');
assert.equal((await response.json()).provider_calls, 0);
const html = await (await fetch(base)).text();
assert.match(html, /Azure replay/);
assert.doesNotMatch(html, /googletagmanager\.com\/gtm\.js/);
const data = await (await fetch(base + '/api/workspace/replay')).json();
assert.equal(data.games.length, 6);
assert.equal((await fetch(base + '/api/workspace/markets')).status, 404);
assert.equal((await fetch(base + '/api/assistant', {method: 'POST'})).status, 404);
JS

if docker run --rm --network none --env PREDICTIR_MODE=replay predictir-live-front:ci; then
  printf 'The live image accepted a replay runtime configuration.\n' >&2
  exit 1
fi
