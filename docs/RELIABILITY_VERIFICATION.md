# Predictir release and reliability checks

Checked November 5, 2026 UTC against [predictir.dev](https://predictir.dev), the Railway backend, Supabase catalogs/logs, provider APIs and the repository. No real-money order was submitted. Credentials, private journals and original screenshots containing secrets are excluded from this report.

## Released code

Application commit `714f14fe461f269af762ab281d4e7a8be73929a0` reached Vercel READY (`dpl_7TCVXKLM8wqmK7niEbKRiqSEm9Ey`) and Railway SUCCESS (`9577d48e-eede-4631-b883-98205e9b93f8`) from GitHub `main`. It includes the stream repair first deployed in `37f8151`, the provider error diagnostics, browser assets and the Railway settings reconciliation tool.

[Hosted Web checks](https://github.com/DaniyalHayat/predictir/actions/runs/41969700139) passed: **361 tests passed, zero failed, two optional integration tests skipped**, plus type checking, the production build, database safety checks, artifact checks and container startup. The optional tests are reported as skipped even though a separate actual container inference check succeeded. [Infrastructure checks](https://github.com/DaniyalHayat/predictir/actions/runs/41964381275) passed without provisioning AWS resources.

## One-hour log review

Each service's audit fixes its own 60-minute UTC window near the start of the request. The linked reports record exact bounds, sources, pagination and access limits. Historical errors remain visible and are attributed to their original deployments.

| Service | Evidence |
| --- | --- |
| [Vercel](VERCEL_LOG_REVIEW.md) | 43 runtime errors from the retired 55-second stream timeout; two earlier account-activation 503s in 586 CDN requests. The fixed deployment recorded no runtime errors in the window. All eight builds inspected completed. |
| [Railway](RAILWAY_LOG_REVIEW.md) | Build, runtime, HTTP, network and DNS records checked across the rollout. User settings read back from the service and deployment trigger, with the configuration drift tracked separately. |
| [Supabase](SUPABASE_LOG_REVIEW.md) | 1,268 events across the exposed services, with no error/fatal/critical entries or application SQL failures. Two managed Auth warnings and one administration connection reset were classified separately. |
| [AWS](AWS_LOG_REVIEW.md) | The legacy worker recorded one successful invocation. CloudWatch inventories succeeded in two enabled regions; 15 others denied access. Missing permissions and absent datapoints are recorded as coverage gaps. |

The [post-repair check](../review/post-repair-log-check.json) found no HTTP 5xx on the verified Vercel and Railway deployments, no Vercel runtime errors, and no Supabase error-level records in the follow-up interval. Railway's one warning was an intentional unauthenticated profile probe that correctly returned 401. An intentional unknown-path probe correctly returned JSON 404. These short post-release samples complement the fixed-hour reviews.

## Confirmed issues and repairs

| Severity | Finding | Repair and evidence |
| --- | --- | --- |
| High | GitHub source deployment had no app root, while Docker COPY paths assume `web/`. | Set source root `/web`. The subsequent hosted build found the intended Dockerfile. `cb35bb3`. The current service uses direct API settings; the legacy TOML file is not linked. |
| High | Railway rejected Docker's `VOLUME` instruction before building. A successful local Docker build did not catch this provider restriction. | Removed the declaration, retained the writable temporary model cache and added a Railway compatibility check to CI. The hosted replacement succeeded. `d230a88`. |
| High | A stalled JSON response body could leave catalog loading open indefinitely. | Catalog requests now have a 20-second deadline; generic JSON deadlines include the response body. Caller cancellation remains distinct and retry errors clear the busy state. `3f872bf`. |
| High | An initial session failure during the rollout left the paper engine uninitialized until a page refresh. | Explicit retry controls in Paper, Portfolio and Account restore a verified session and retained ledger without refreshing. Owner identity outages cannot silently fall back to guest data. `92ed162`. |
| High | The proxy retained a 55-second fetch abort timer while returning a raw SSE body. Vercel logged failed response piping when that timer expired. | Separate the five-second connection deadline from stream lifetime; relay with backpressure, clean rotation and upstream cancellation. The verified Fluid project uses an 800-second function limit and a 750-second planned stream lifetime. JSON deadlines stay unchanged. `37f8151`. |
| Medium | A separate monitoring probe attempted `extensions.pg_stat_statements` with the restricted runtime login. | Check schema USAGE and view SELECT before optional statistics queries. The runtime probe now skips unavailable statistics; an existing authorized administration connection reads them. No runtime privilege was expanded. `e257329`. |
| Medium | Reading only the latest five posts per X account could miss an older selected-team report. | One bounded recent-search query combines selected entities with curated authors, verifies returned identities and discloses incomplete pagination. Shared caching, reservations and fenced cursors remain enforced. `b2c6153`. |
| Medium | Spotify song contracts lacked a track-specific reference path. | Added exact track and artist identity matching. Authenticated artist and track searches returned HTTP 200. Spotify data remains display-only. `b2c6153`. |
| Medium | Shutdown did not await all database/listener cleanup. | Drain HTTP and pipeline work, close LISTEN clients and the pool, retain an eight-second shutdown bound. Actual local PostgreSQL tests verified listener removal. Pool size and role limits stayed unchanged. `abebb43`. |
| Medium | Successful provider retries retained an ambiguous `503` without a cause. | Preserve allowlisted failure codes through the source, queue and runtime logs. Provider timing now includes body reads for these adapters. The Apple job's two older retries still cannot prove which upstream operation failed; the third attempt stored 100 observations. `5fc65ae`. |
| Medium | Railway had no watch pattern and allowed ten restart retries. | Verified live `/web/**` and three retries after an API update. The checked manifest and reconciliation tool preview and verify future drift. `886833e`. |
| Low | Browser icon and crawler requests returned 404. | Static SVG, ICO, PNG and crawler policy now return HTTP 200. The binary files are regular Git objects, and the build checks verify their signatures. `4247434`, `714f14f`. |

## Live application checks

All eight category requests returned HTTP 200 in the observed snapshot. Returned coverage remains bounded and can be partial; these counts are not the size of the entire exchange.

| Category | Returned contracts |
| --- | ---: |
| Sports | 404 |
| Economy | 108 |
| Crypto | 401 |
| Travel | 15 |
| Weather | 48 |
| Tech & science | 75 |
| Climate | 216 |
| Culture | 268 |

The observed request durations ranged from 973 to 1,894 ms. This small sequential check includes network/cache conditions; it is not a before/after benchmark, load test or fleet percentile.

The native exchange connection reported `connected`. Switching between the Miami and Golden State outcomes changed the heading and ticker together and cleared the previous quote while the new one loaded. The selected-contract view subsequently displayed fresh matching native depth.

Two actual hosted SSE connections, for a single quote and a portfolio, returned HTTP 200 and remained active for 71.7 and 70.7 seconds. They delivered seven and six frames after the previous 55-second failure point and closed on probe cancellation without an error. The fixed deployment recorded zero response-piping errors in the checked hour. [Stream results](../review/production-stream-check.json).

The live execution endpoint returned HTTP 200 for a 20-contract scenario. At its dated Golden State snapshot, 20 YES contracts required $13.32, including $0.32 modeled fees. A separate browser run for Miami retained 11 real book events over 15.8 seconds and calculated a 12-step schedule. Insufficient flow/arrival history was explicitly withheld. Execution assumptions did not change the independent settlement forecast. These are observations of simulations against changing public books, not promised fills or returns.

Paper-account checks retained the existing ledger and its $20,000 starting-funds value. Adding $10 and decreasing $10 restored available cash and net adjustments. A one-contract Golden State paper buy consumed $0.68; its portfolio mark used $0.63 net bid proceeds and displayed a $0.05 unrealized loss. Closing recorded $0.63 proceeds, zero remaining contracts and the corresponding realized loss. The earlier $0.03 loss remained intact; cash adjustments were not counted as trading profit.

## Provider and analytics configuration

Spotify client credentials, US artist search and US track search returned HTTP 200. The root `api.spotify.com` redirects to developer documentation; authenticated resources use `/v1/`. Artist/track/album metadata can support catalog identity. This does not establish public chart history, royalty/sales data or settlement-ready music forecasts. See [provider verification](../web/docs/PROVIDER_FEED_VERIFICATION.md).

The targeted X smoke check returned HTTP 200, with a conservative maximum resource cost of $0.07. Public-read ingestion does not require posting, Direct Message access or user OAuth. Broad streams, news subscriptions and webhooks were not enabled: retrieval is tied to an explicit selected-contract request and a shared 30-minute cache. Source ranking is a relevance/quality heuristic, not a verified record of forecasting accuracy. Existing Reddit access restrictions remain disclosed rather than bypassed.

Vercel was missing `NEXT_PUBLIC_GTM_CONTAINER_ID`; it is now configured for the existing published container. GTM serves HTTP 200 and contains GA4 destination `G-NJN43KL0FQ`. `predictir.dev` was added to monitored domains. One provider loads after consent, with private financial/account/chat data excluded. The browser used for these checks advertises a privacy signal, so analytics correctly remained off. GA's receipt of a consenting visitor event is **not claimed**; the UI still reported no recent data when inspected. [Google's consent-debugging guidance](https://developers.google.com/tag-platform/security/guides/consent-debugging).

The initial confirmed saved-account user was created using the supplied credentials, without sending email. Public Auth signup is disabled and the Auth site URL is `https://predictir.dev`. The backend allowlist is configured; anonymous `/api/session` returns a guest session with login available and signup disabled. Browser sign-in succeeded. The saved account began with a separate $20,000 paper balance. A $1 addition and decrease persisted as two cash-history entries with zero net adjustment; a reload retained both entries and the $20,000 balance. The database confirmed one saved portfolio at revision 2. Private account and guest records remain separate.

## Database and runtime evidence

The two recorded `42501` extension-schema errors were statistics probes, not application writes. The recorded `42601` error came from an incomplete query in the dashboard editor. Earlier `53300` connection-limit errors predated this repair; their historical role limit cannot be reconstructed from the current setting. The current runtime role limit is 12, supporting two overlapping processes with four pooled connections and one listener each, plus two operational connections.

A fresh restricted-role inspection skipped inaccessible statistics without generating a permission error. The authorized inspection read aggregate statement statistics and found no active runtime lock waits at that instant. No Postgres ERROR/FATAL/PANIC entry was returned for the checked interval from 03:35:15 through 03:52:47 UTC. Short successful `supabase_admin` disconnection entries are not evidence of broken application sessions. Log windows and samples do not establish permanent zero-error operation. [Supabase log-query guidance](https://supabase.com/docs/guides/observability/advanced-log-filtering).

Additive migrations 004–006 completed after checking an existing completed backup. They add private owner portfolios, append-only domain events and public evidence search storage. Existing primary keys were retained; no redundant `(pk)` index was added. Database certificate and hostname verification remain enabled. No application record was deleted for this repair.

The private diagnostics endpoint returned actual bounded per-process P95/P99 distributions and provider timings. Its sample counts and measurement scopes remain explicit; provider fetch timings are not interchangeable with complete browser latency.

Actual pinned MiniLM inference ran inside the deployment image with a read-only root filesystem, UID 1000, a 384 MiB Node heap limit and a fresh temporary cache. Three normalized 384-dimensional vectors were produced; related-text cosine was 0.6468 versus 0.0074 for the unrelated control. Cold download plus inference took 3.97 seconds, RSS was about 218.6 MB and the cache held about 23.7 MB. These are local container measurements, not hosted latency guarantees. [Inspect the reproducible check](../review/hosted-image-semantic-check.json).

## Hosting choices and costs

| Setting | Checked decision |
| --- | --- |
| Railway Hobby | Existing owner-paid plan; workspace hard usage limit set to $10 and read back. No new paid add-on or recharge enabled. |
| GitHub source / Wait for CI | `main`, `/web` build context; observed deployment waited for checks and then built the reviewed commit. |
| HTTPS / extra domain | Both generated Railway names already serve HTTPS. The frontend uses the original backend name; the second alias does not add compute capacity. Vercel continues to serve `predictir.dev` over HTTPS. |
| Outbound IPv6 | Retained for supported upstream connectivity; the database continues to use its configured verified Supavisor connection. No measured latency gain is claimed. |
| CDN | Vercel serves frontend assets. Backend JSON uses `no-store`; SSE uses `no-cache, no-transform`. Railway caching must honor these headers and must not turn live/private data into cached snapshots. |
| Replicas / limits | One steady replica, sleeping off. The plan's maximum CPU/RAM limits are not proof those resources are continuously allocated or billed. |
| Local PostgreSQL containers | Disposable isolated test databases, not four managed cloud databases. Two PostgreSQL fixture containers were running at the check. They were not copied into cloud instances. |
| Paid integrations / telemetry | Existing budgets, application quotas and sampled/redacted logs retained. No Datadog, paid log drain, Kafka cluster or extra database was purchased. |

[Railway billing](https://docs.railway.com/pricing/plans), [cache behavior](https://railway.com/guides/cache-headers-cdn), [outbound networking](https://docs.railway.com/networking/outbound-networking) and [deployment context](https://docs.railway.com/deployments/monorepo) informed the review. The live service does not depend on the legacy TOML file. Native Railway IaC remains a separate migration; the checked reconciliation tool manages the two corrected settings through the authenticated API.

All 15 additional model/framework references were attempted and their reading scopes, access limits and practical uses are recorded in the [reference review](reliability-reference-review.md). A small causal TCN is a candidate challenger after a suitable immutable depth dataset and time/contract-separated evaluation exist. No untrained DeepLOB/transformer model, published equity accuracy or crypto result was substituted for prediction-market outcome evidence.

The earlier research PDFs remain dated audit snapshots. This release record supersedes their historical deployment status; their mathematical evidence and limitations still apply. Self-hosting and the separate advertising optimizer remain held.
