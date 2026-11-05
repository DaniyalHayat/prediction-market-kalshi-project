# Kalshi Market Lab: request and platform review

Review date: 4 November 2026. This is the review branch, not a production release. “Staged” means local code and tests exist; it does not mean the feature is live. Current managed services remain Vercel, Railway and Supabase. Self-hosting and the advertising optimizer are research only, on hold.

## Product requests

| Request | Review-branch status | Benefit and practical limit |
| --- | --- | --- |
| Neutral black design; preserve Kalshi Market Lab | Staged | Black, Charcoal and Light are neutral gray themes. White primary controls, quiet borders and restrained financial status colors replace the blue theme. Root browser review remains the release check. |
| Desktop and mobile usability | Staged | Responsive market/detail navigation, horizontal category controls, larger touch controls, readable forms and account access. Automated compilation is not a substitute for phone and desktop inspection. |
| Contract analysis Summary / Long read | Staged | A short cost-aware screen and drivers precede optional model and source detail. Longer text does not imply stronger evidence. |
| Contract news Summary / Long read | Staged | Explicit “Load contract news” requests evidence for the selected ticker. Reddit starts off; source access failures remain visible. |
| Retained public evidence and semantic retrieval | Staged; actual CPU model and disposable PG17 checks passed | Pinned q8 MiniLM embeddings support exact-ticker FTS/cosine rank fusion. Private account/journal/chat and Spotify catalog content are excluded. Retrieval scores do not change forecasts. |
| Source weighting, X, Reddit and publisher reporting | Staged; access-dependent | Editorial source tiers and relevance rank help prioritize review. They are not measured accuracy, causal price impact or a trading probability. Public access blocks are respected. |
| Sports last five games, head-to-head, player stats and minutes scenarios | Staged | Actual dated game/box-score rows support the displays. Small and overlapping samples, missing games and low-minutes confounding remain visible. No fabricated absence adjustment. |
| Movie critics versus demand | Staged research context | Default critic preference is 77.5%, with 75% and 80% sensitivity displays. No index is produced without compatible, dated critic and demand observations. It does not change the forecast. |
| Music alternatives | Staged context | A dated secondary US Spotify song chart can supplement reporting. It does not become an artist-total or Billboard settlement feed. |
| $20,000 initial paper balance, including current guests | Staged | Existing positions survive migration. Cash available equals starting funds plus cash adjustments and realized P/L less remaining cost basis. |
| Add / decrease paper money | Staged and tested | Explicit, dated cash movements survive buys, partial closes, full closes and settlement. Decreases cannot consume committed position funds. Cash changes are separate from trading P/L. |
| Guest lifetime and device continuity | Staged client and server | Guest records expire at six hours; the eight-hour inactivity rule is also represented. Expired guest caches/watchlists are removed without deleting owner records. Cleanup runs when the app can execute, including the next visit after a closed browser. Browser cookies identify the guest; IP changes do not erase records. |
| Sign-in and saved portfolio | Staged; activation/release pending | A sign-in modal, separate guest/owner records, saved contracts, exports and bounded account synchronization exist. Conflicting ledgers preserve both versions and stop automatic overwrites. No public signup is offered. |
| Google Analytics / GTM and settings | Staged client; container configuration reviewed separately | GTM is preferred when its public ID is configured; direct GA is the alternative, never a second concurrent loader. Consent, DNT and GPC gate loading. Private amounts, credentials, email, chat and journal content are excluded. |

UI validation: 43 focused tests passed across the reviewed UI/account suites, with TypeScript checks and a prior Next production build. They cover cash reconciliation, migration, expiry, owner-safe guest-cache removal, account isolation, empty-remote preservation, conflict handling, cross-tab identity changes, stale session responses and analytics allowlists. The final full-suite/build results and browser checks are recorded separately in the final verification section.

## Supabase choices and storage

Managed Supabase currently advertises Free and Pro from $25/month. Extra compute, egress and add-ons can change the bill; this is a published starting price, not a quote for this app. [Supabase pricing](https://supabase.com/pricing).

| Named capability | Current decision / status | Cost and benefit |
| --- | --- | --- |
| PostgreSQL | Retain existing bounded server connections | Already fits durable source history, journals and account records. Query/index measurement precedes more hardware or more connections. |
| Auth | Owner sign-in staged | Reuse the existing managed identity service and server-only secrets. Production account activation remains a separate step. |
| Storage | Existing platform capability; no bulk migration | Useful for source/artifact objects when a clear retention need exists. Storage and egress remain billable resources. |
| Realtime Broadcast | Current app streams remain the baseline | Broadcast is message delivery, not a historical ledger. A second stream adds load and duplicate-delivery semantics; adopt only for a measured need. [Broadcast](https://supabase.com/docs/guides/realtime/broadcast). |
| Realtime Presence | Not enabled | Presence tracks slow-changing shared user state, such as who is online. It is unnecessary for a single-owner paper account and is not appropriate for high-frequency prices. [Presence](https://supabase.com/docs/guides/realtime/presence). |
| Edge Functions / Functions servers | No duplicate runtime added | Existing Next/backend endpoints already own rate limits and business rules. Another runtime creates deployment and observability work. |
| Analytics / Iceberg buckets | Defer | Intended for large analytical datasets; currently documented as alpha. Start with bounded SQL and archived objects until analytical load is measured. [Analytics buckets](https://supabase.com/docs/guides/storage/analytics/introduction). |
| Vector buckets | Defer | Useful for a large embedding archive, not necessary for exact-ticker retrieval. Current docs mark the feature alpha; embedding generation and egress still have costs. [Vector buckets](https://supabase.com/docs/guides/storage/vector/creating-vector-buckets). |
| pgvector | Native exact cosine path staged and checked on disposable PG17 | The retained index is scoped to at most 256 chunks per selected ticker. The real-embedding numeric-array fallback was also tested. No HNSW speed benefit, source-truth validation or forecasting improvement is claimed. |
| OrioleDB / alternate storage engine | Evaluate, do not switch this app | Current Supabase material lists OrioleDB as public beta. Vendor high-concurrency benchmarks are not proof of a gain for this small connection budget. Require workload, extension and restore tests before changing engines. [OrioleDB overview](https://supabase.com/docs/guides/database/orioledb). |
| Foreign data wrappers / Wrappers / ETL | Defer | They query external data through SQL, but introduce remote latency and database coupling. FDWs do not provide RLS; keep them in private schemas if later used. [Supabase FDWs](https://supabase.com/docs/guides/database/extensions/wrappers/overview). |
| ORM: Prisma / Drizzle | No rewrite | The libraries can help schema/type workflows. Existing tested `pg` transactions are sufficient; adding an ORM alone creates no product capability. |
| GUI / Studio | Existing administration surface | Useful for inspection. It is not a reason to expose the database or administration UI publicly. |
| Extensions | Enable only for a concrete query or operational need | Availability is not adoption. Review compatibility, privileges and upgrade support for each extension. |
| Direct / Framework / API Keys / Server / ORM / MCP Connect choices | Ranked in the engineering review | They are alternative connection instructions, not six paid features to install together. Reuse the current direct pool and supported client. MCP remains scoped administration tooling. |
| Backups / PITR / branching | Keep managed guarantees distinct | Self-hosting does not automatically reproduce managed backups, PITR or branching. Restore testing matters more than merely enabling a backup flag. |
| PostgreSQL 17 / requested “18.6.5” | Remain on the tested PostgreSQL 17 deployment | Upstream currently lists 18.6 and 17.11. Modern upstream server versions use two components, so “18.6.5” is not an upstream server release identifier; a provider build label must be checked separately. A major upgrade still needs host support, extension compatibility and restore tests. [Versioning policy](https://www.postgresql.org/support/versioning/), [version format](https://www.postgresql.org/about/press/faq/). |

The full Connect ranking and connection/session details are in [engineering-runtime.md](engineering-runtime.md).

### Connector and wrapper catalog: grouped by purpose

These are options to evaluate, not installed integrations. A connector needs an actual account, useful data, narrowly scoped credentials and target-specific read/write review. Querying a remote system through SQL does not remove its subscription, compute, API quota or network costs. The target list is published by the [Supabase Wrappers project](https://github.com/supabase/wrappers/blob/main/README.md); availability on the exact hosted database must still be checked.

| Function | Named tools / targets | Actionable choice for Market Lab |
| --- | --- | --- |
| Databases and analytics | PostgreSQL FDW, MySQL, MongoDB, SQL Server, ClickHouse, BigQuery, Snowflake, DuckDB, Iceberg, Redis | Keep direct Postgres now. Add one read-only external target only when a defined historical dataset and benchmark justify it; never connect every database merely because a wrapper exists. |
| Object and vector storage | S3, S3 Vectors, pgvector, vector buckets | Prefer existing objects and exact entity indexes first. Review retrieval quality, retention and embedding cost before a second vector store. |
| Identity | Auth0, AWS Cognito, Clerk | Current Supabase Auth covers the proposed owner login. Another identity provider adds migration and account-lifecycle work. |
| Billing and commerce | Stripe, Paddle, Orb, Shopify | No current paper-market billing requirement. Keep disconnected; never treat payment data as public evidence. |
| CRM and operations | Airtable, HubSpot, Notion, Cal.com, Calendly, Slack | Useful for a separate internal workflow only when requested. They add no market-data or forecast capability to this app today. |
| Application / infrastructure data | Firebase, Cloudflare D1, Logflare, Infura, OpenAPI targets | Use a narrow existing API adapter first. Remote query latency and data permissions must remain visible; no credentials or foreign tables exposed in the public schema. |

### AI, retrieval and multimodal choices

| Named tool | Status / function | Self-built-first decision and cost-benefit |
| --- | --- | --- |
| pgvector hybrid search | Staged selected-ticker retained-evidence search | Actual MiniLM embeddings, FTS and exact cosine are fused with constant 60. Source dates, scope and TTLs remain binding. A tiny paraphrase diagnostic verifies mechanics; a labeled held-out retrieval evaluation is still needed before claiming quality improvement. [Hybrid search](https://supabase.com/docs/guides/ai/hybrid-search). |
| vecs | Optional Python vector client | A convenience client for a future research pipeline; it does not require replacing the web backend or independently establish relevance. |
| LangChain / LlamaIndex | Optional orchestration/retrieval frameworks | The current bounded functions and source adapters are easier to inspect. Choose one framework only if it removes demonstrated repeated work; adding both creates overlapping abstractions. [Supabase AI toolkit](https://supabase.com/docs/guides/ai), [LlamaIndex integration](https://supabase.com/docs/guides/ai/integrations/llamaindex). |
| Titan | Interpreted tentatively as Amazon Titan in the Supabase integration catalog | Titan multimodal embeddings could support an actual image-retrieval task. No model or AWS account was connected, and no current text/ticker task requires this extra inference bill. If a different Titan product was intended, its identity remains unresolved. [Supabase Titan example](https://supabase.com/docs/guides/ai/examples/semantic-image-search-amazon-titan). |
| Roboflow | Optional computer vision platform | No image labeling/detection requirement exists in the present public-market flow. Defer until a specific, authorized visual dataset and evaluation task exist. [Roboflow docs](https://docs.roboflow.com/). |
| Mixpeek | Optional multimodal extraction/search | Potentially useful for a large video/audio/image archive. Current headlines, game rows and settlement rules do not justify a separate multimodal warehouse. [Mixpeek product scope](https://mixpeek.com/). |
| Fireworks AI | Optional model inference/training provider | Benchmark quality, latency and actual token cost against the current provider before adding another API. No switch or training job is enabled. [Fireworks docs](https://docs.fireworks.ai/). |
| LiteLLM | Optional AI gateway/proxy | Reuse existing bounded model calls for now. A proxy adds another runtime; if later adopted for budget enforcement, current docs require a database for budgets, so a DB-less configuration must not be presented as a spending cap. [LiteLLM budgets](https://docs.litellm.ai/docs/proxy/users). |

The preferred build sequence is existing SQL/entity matching, a small labeled evaluation set, one demonstrated retrieval improvement, then a minimal adapter. Model, embedding, storage and egress costs should be measured separately. No tool above is claimed to be new, connected or intrinsically faster.

## Vercel and Railway, feature by feature

Vercel Hobby is for personal, non-commercial use; Pro is advertised at $20/month with included usage credit. Railway advertises Hobby at $5/month and Pro at $20/month, with the subscription credited toward usage. Runtime resources and applicable extras still matter. [Vercel pricing](https://vercel.com/pricing), [Vercel Hobby terms](https://vercel.com/docs/plans/hobby), [Railway plans](https://docs.railway.com/pricing/plans).

| Capability | Vercel role here | Railway role here | Decision / cost implication |
| --- | --- | --- | --- |
| Frontend hosting / CDN | Current frontend delivery | Can host a Node frontend, but migration is not enabled | Keep the current frontend while review is pending. Moving it does not automatically lower the total bill. |
| API / server compute | Existing same-origin Next boundary | Persistent backend and source services | Preserve clear ownership; avoid duplicate polling and duplicate servers. |
| Long-lived streaming / WebSockets | Same-origin proxy / stream delivery path | Persistent backend stream handling | Verify end-to-end disconnect and retry behavior. Server uptime and egress are still resources. |
| Database | Use the external database integration | Can run a database with a persistent volume | Retain current Supabase/Postgres until migration and restores are reviewed. |
| Object storage | Platform/integration option | Bucket option | No second object store added without a measured need. |
| Secrets and environment settings | Frontend/server configuration | Backend configuration | Account secrets remain server-side. Adding another secrets copy increases maintenance. |
| Git / builds / previews / rollbacks | Existing frontend workflow | Existing backend workflow | Local commits are review inputs. Nothing in this branch authorizes a live release. |
| Cron / scheduled jobs | Platform capability | Platform capability | Run a single bounded job owner instead of duplicate schedules. |
| Scaling and replicas | Platform-managed options | Vertical and replica options | A second backend can exhaust a small database connection allowance. Measure and budget before scaling. |
| Custom domains / TLS | Current public frontend origin | Backend origin / ingress | Preserve same-origin account cookies. An app move also needs domain, TLS and routing work. |
| WAF / access controls / private networking | Existing platform controls and available plan features | Private service networking / access options | Review the concrete exposure; no new subscription or network was activated. |
| Logs / metrics / alerts | Existing platform observability | Existing runtime metrics/logs | A local sanitized operator view is staged. External retention and incident destination are undecided. |
| Log drains | Pro/Enterprise export option | Backend can receive/process data | A self-built receiver removes a third-party receiver subscription, not the Vercel export charge: currently $0.50/GB. [Vercel Drains](https://vercel.com/docs/drains). |
| Spend controls | Usage budgets and plan controls | Resource usage and hard/soft limit controls | Use measured workload and actual invoices; no savings percentage is claimed. |

## Engineering and larger data tools

| Named technology / request | Status | Recommendation and cost-benefit |
| --- | --- | --- |
| Kubernetes / K8s | Not provisioned | Too much operational surface for one small backend today. A deployment orchestrator does not create forecasting edge. |
| NetBird | Research only | Private administrative access could be useful in a future self-hosted setup. Self-hosting still needs infrastructure; current quickstart specifies a public Linux VM with at least 1 CPU and 2 GB RAM. [NetBird quickstart](https://docs.netbird.io/selfhosted/selfhosted-quickstart). |
| Caddy / Nginx | Research only | Choose one reverse proxy if self-hosting. No need for both in front of a single app. Next recommends a reverse proxy for self-hosted production. [Next self-hosting](https://nextjs.org/docs/app/guides/self-hosting). |
| Kong | Existing component of a full Supabase self-host stack, not deployed here | A general API gateway adds configuration and another service. It is not required for the current small app boundary. |
| Databricks / Snowflake / Redshift | Not connected | Separate warehouses bring compute, storage, governance and pipeline work. No measured workload presently justifies adding any of them. |
| Apache Iceberg | Evaluation only | An analytical table format, not a replacement for the app transaction database. Consider after a large historical archive and query benchmark exist. |
| Spark / Hadoop / Hive | Not installed or provisioned | Distributed batch tooling is excessive for current bounded datasets. Keep an exportable archive so this decision can change with measured scale. |
| Provider latency p95 / p99 | Isolated telemetry module staged | Bounded measurements support diagnosis. Process percentiles are not fleet percentiles; aggregate histogram buckets before reporting fleet tail latency. |
| Production log filtering / sampling | Isolated pipeline and signed drain receiver staged | Bounds diagnostic volume and strips private fields. Sampled diagnostic logs cannot replace an immutable audit or trading journal. |
| Separate operator UI / incident tracing | Local authenticated read-only tool staged | Displays safe evidence and proposes fixes. It cannot execute fixes or change the trading interface. External deployment remains undecided. |
| LMAX-style lock-free ingest | Actual bounded SPSC shared-memory experiment staged | The local shared-ring offer/poll benchmark was slower than the simple same-thread reference queue. Worker isolation might justify it in a different measured workload; no runtime speed improvement is claimed. It is not a multi-producer LMAX Disruptor. |
| Event sourcing / CQRS | PostgreSQL event store, idempotency, replay and projection seam staged | Durable, versioned events can improve auditability. Not wired into the live request path. |
| Kafka / Kinesis | Optional outbox adapter seam; neither broker enabled | Keep PostgreSQL event replay until actual throughput/consumer requirements justify a broker and its cost. |
| Custom paper limit order book | Isolated simulator staged | Tests price/time priority and order handling. It does not model real queue position, hidden liquidity or actual fills, and does not replace quote-backed paper execution. |
| Protobuf / gRPC | Minimal loopback unary wire implementation staged | A measured internal interface experiment. Cross-host production needs supported generated stubs, transport security and interoperability validation. |
| Terraform in `/terraform` | Default-disabled reference and mocked checks staged | Registry-only and full AWS profiles are separate choices. No resource has been created; a full AWS compute/database profile exceeds the additional $25/month target. |
| CI / Docker / ECR / deploy | Review CI and manual publisher staged; deployment dormant | Local Docker/CI validation is distinct from image publication and traffic cutover. No cloud publish or deploy is authorized by these files. |
| Kalman / HMM / stochastic score diffusion / Bayesian-style context experiments | Isolated conditional math staged | These operate on explicit supplied numeric observations and assumptions. No unvalidated news/sentiment score changes the released forecast, trade side or allocation. |
| Market attribution | Observed source/price-history context remains distinct | Timestamps and price changes can show sequence, not identify a causal effect of a headline. This belongs in market research and is separate from the held advertising optimizer’s campaign attribution. |

See [engineering-runtime.md](engineering-runtime.md) for measurements and limitations, and [terraform/README.md](../terraform/README.md) for the disabled infrastructure profiles and cost arithmetic.

## Self-hosting assessment: on hold

Self-hosting is feasible, but it is not intrinsically free. A small first option would host the Next frontend, current backend and PostgreSQL behind one reverse proxy, with private administrative access and tested off-machine backups. Full self-hosted Supabase is a larger system and should be chosen for its Auth, Storage and other capabilities only when those capabilities are actually needed.

Supabase’s current Docker guide specifies at least 4 GB RAM, 2 CPU cores and 40 GB SSD for its full stack; the recommendation is 8 GB+, 4 cores+ and 80 GB+ SSD. Running on an existing computer may avoid a new hosting subscription, while adding electricity, uptime, connectivity, backup, update and recovery responsibilities. Managed branching, backups/PITR and several platform services are not reproduced simply by launching the local CLI. [Supabase self-hosting](https://supabase.com/docs/guides/self-hosting), [Docker requirements](https://supabase.com/docs/guides/self-hosting/docker).

No server, NetBird network, proxy, database migration, DNS change or cutover has been implemented for this held proposal. Compare an actual managed invoice against a tested self-host recovery plan before deciding.

## Ploy and the advertising optimizer concept: on hold

Only public search results and Ploy’s company-owned LinkedIn page were used. No Ploy website was opened, and no anonymous or incognito visit is claimed. The likely matching company is **Ploy / ploy-ai**, whose public LinkedIn description presents an AI growth teammate for building, optimizing and publishing marketing websites. This establishes a product category; it does not verify every feature, current pricing or measured customer outcomes. [Ploy on LinkedIn](https://www.linkedin.com/company/ploy-ai/).

A distinct advertising-review product could start with approved exports or read-only campaign reporting: spend, clicks, conversions, revenue, attribution window, CPA/ROAS and the matching landing page. It could identify tracking gaps, compare campaign cohorts, draft creative hypotheses and propose landing-page tests. Human review would precede publishing or spend changes. Incremental lift would need controlled tests; neither generated creative nor a higher click-through rate alone proves profitable growth. Advertising spend, model usage, platform access and hosting remain separate costs.

Google Ads retired developer tokens on 9 September 2026; access now follows the OAuth project's approval. Production access and brand verification still require review. [Google Ads API access migration](https://developers.google.com/google-ads/api/docs/api-policy/developer-token).

No Ploy clone, ad-account connection, campaign change or optimizer code was built. The proposal remains on hold.
