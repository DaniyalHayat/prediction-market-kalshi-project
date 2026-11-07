# Predictir: legacy AWS deployment reference

[Predictir](https://predictir.dev/) is the current application. This document describes the legacy AWS implementation, which is not used by the current Vercel/Railway or Azure runtimes and is pending resource retirement. Existing AWS data has not been deleted. The standalone workbench accepts an event URL or exact ticker, inspects rules and depth, compares paper sizes and keeps a separate private journal. No exchange order, account position or balance route exists.

## Live data and prospective records

The backend authenticates a read-only `orderbook_delta` subscription to Kalshi's native WebSocket. It reconstructs snapshots and fractional deltas, checks subscription sequence numbers, rejects crossed/negative books and reconnects after a gap. Browser delivery coalesces to 250 ms; client-visible sequence jumps are expected. A per-environment shared connection watches at most 12 tickers. Each browser connection follows one ticker. Streams pause in background tabs and stop after trading close. REST snapshots remain identified separately.

The private S3 archive samples at most one actually observed book per second/ticker, retaining the top 100 levels per side. It is not a complete exchange-tick archive. The buffer is bounded, persistence failures remain visible and sequence gaps are not filled with synthetic data. Stream samples expire after 90 days.

The backend freezes each journal forecast before close with the exact rules, book, timestamps and SHA-256 digest. A random 256-bit browser token controls access; only its hash partitions DynamoDB records. A journal can register a contract once. Exported journal-access files contain a private token and should remain private. They never contain the exchange key. Pending records are checked hourly, six at a time, and scored only after an actual binary exchange resolution. Non-binary/unresolved cases remain unscored. Journal records expire after 180 days; exporting preserves a personal copy. The shared forward-cohort service also uses durable S3 evidence and conditional DynamoDB audit heads.

The probability and interval are user assumptions. They are not calibrated model outputs. The typed sizing engine maximizes worst-case expected log wealth only within its supplied probability/depth/fee/loss constraints and bounded integer search. Series fee metadata supplies a general coefficient when supported; market exceptions and actual fill-level rounding still require inspection. There is no demonstrated trading alpha or profitability.

## Cloud services and cost controls

`cloud/stack.yaml` deploys Node.js 24 ARM Lambda Web Functions, a private/versioned/encrypted S3 bucket, on-demand DynamoDB, an SSM SecureString reference, a scheduled settlement/cost worker, short-retention CloudWatch logs and a failure queue. SDK clients are included in the package. Secrets remain server-side. Application data and quota writes use explicit expiration, conditional updates and ownership-checked leases. Private journals persist across revisions.

The combined account budget is $10/month before credits/refunds; the hourly worker requests endpoint rate zero when reported spending reaches $8 or billing data is unavailable. Low spending permits recovery. Endpoint admission control was exercised from the deployed worker. Billing data is delayed: AWS Budgets is not a hard prepaid cap. These controls target the user's $10 combined allowance; no forecast can guarantee an exact invoice under arbitrary traffic or delayed metering.

Additional limits: two web environments, 16 concurrent requests per environment, eight streams per environment, 1,200 connection-minutes/month across the app, 6,000 weighted API work units/day, 12,000 upstream cache misses/day, 1,800 CPU-seconds/day measured in the running app, and 60 API requests/minute per observed IP/environment. The provider's minimum nonzero endpoint throttle is 100 requests/second. Application limits fail closed when quota storage is unavailable. Node's heap target is 160 MiB; it is not a hard total-process memory ceiling. Static/rejected requests and metering lag remain billable. No always-on Redis, RDS, Kinesis or paid model endpoint is provisioned.

## Reproduce the package

From `web/`, with Node.js 24 and Python 3.12:

```sh
npm ci
npm test
npm run build
npm run typecheck
node tools/build_cloud.mjs
python tools/package_cloud.py
```

The build writes `../.cloud-build/predictir.zip` and a SHA-256 deployment key in `../.cloud-build/package.json`. It includes the focused workbench, historical evidence and both server and worker bundles. The lockfile reproduces the server and sizing bundles. The legacy dashboard export is a separate local archive. In new packages, requests for `/dashboard/` and `/dashboard/index.html` go to the same-origin workbench at `/lab.html`. Browser journal access continues on that origin.

Deploy the template first with an empty `CodeKey` to create storage, upload the ZIP to the returned private bucket under its generated `code/<sha256>.zip` key, then update the stack with that key and the SSM parameter name. For streaming, create/select an exchange key yourself and store `{ "id": "key-id", "pem": "private-key" }` in the named Standard SecureString outside Git. The app uses market-only operations even if a selected exchange key permits broader access. Never paste a private key into Figma or browser code.

For local HTTP without cloud persistence, run `node tools/run_local.mjs`. Optional local streaming accepts a key-file path and key ID as documented by the script; it does not print the key. The public cloud verification script requires a separate ignored owner-token file and creates an explicitly arbitrary prospective integration forecast. Its record and Brier score do not measure forecasting skill.

## Figma frontend

`npm run figma:export` creates a static workbench in `../.figma-export`. Its entry point opens `lab.html`, with requests directed to the documented AWS backend or an HTTPS origin supplied in `MARKET_PUBLIC_API`. Existing backend origin restrictions still apply. The export includes no credentials. For live use from a different preview origin, open the hosted workbench directly. The previous Figma import and preview checks refer to the earlier export.

## Execution evidence

- `docs/cloud-verification.json`: real exchange SSE observations and isolation between two random journal tokens.
- `docs/settlement-verification.json`: a forecast frozen before close, actual final outcome and computed Brier/log loss, retained across deployment. The arbitrary 50% integration forecast scored 0.25 Brier and did worse than its contemporaneous market baseline. It is not a performance claim.
- `docs/stream-verification.json`: native exchange WebSocket snapshot/delta receipt.
- `tests/stream.test.mjs`, `tests/cloud.test.mjs`, `tests/cost.test.mjs`, `tests/sizing.test.ts`: sequence-gap rejection, token validation, atomic quota failure, lease ownership, endpoint cost-gate behavior and fee-inclusive sizing.

These are small-scale integration and correctness checks. They do not establish production availability, distributed-systems throughput or investment performance.
