# Runtime and database research

The implementation uses the existing Railway process, Vercel proxy and Supabase database. No additional hosted service, paid extension, webhook destination or public presence channel is provisioned. Results below were measured on November 4, 2026 in New York local time. Local fixture benchmarks establish the tested operation, not deployed capacity or exchange latency.

## Measured improvements

Run `MARKET_TEST_DATABASE_URL=... node tools/benchmark_runtime.mjs` from `web` with a disposable database whose name ends in `_test`. The script creates only temporary benchmark tables. [Machine-readable results and query plans](runtime-benchmark.json) contain the complete measurements.

| Experiment | Before | After | Scope |
| --- | ---: | ---: | --- |
| Serialize 300 observed book views, median of seven repetitions | 59.317 ms | 2.174 ms | 2,000 retained levels versus top 100 broadcast levels. Full indexed reconstruction is retained. |
| Serialized side of that book | 26,699 bytes | 1,390 bytes | 94.8% smaller fixture payload; not a whole-application speedup. |
| Exact chart-entity lookup, 200,000 rows | 20.068 ms | 0.153 ms | Existing date-before-entity index versus entity-before-date covering B-tree index. |
| Full-text query, 200,000 rows | 19.002 ms | 0.130 ms | Sequential scan versus GIN. English query parser and source join are parameterized. |
| Recent-time query, 200,000 ordered rows | 13.415 ms | 0.354 ms | Sequential scan versus BRIN on observation time. |
| One-day query in 12 monthly partitions | 0.519 ms | 0.118 ms | The indexed unpartitioned control was faster. Production partitioning is not enabled on the basis of this test. |

The actual local HTTP test completed 240/240 fixture responses at each concurrency of 1, 8 and 32, distributed across eight synthetic visitor identities. At concurrency 32, p95 was 34.4 ms and observed throughput was 2,147 requests/second. This excludes upstream providers, database calls, hosted network latency and model computation. It does not override the production admission limits.

The actual multiplex SSE test used eight streams, twelve synthetic tickers and 100 price levels per side. It delivered 800 book frames from 840 source updates, compared with 6,720 frames without subscriber-level coalescing. Median source-to-reader age was 19.0 ms and p99 was 35.3 ms. These are local synthetic input timings. Latest-state replacement intentionally omits intermediate display states; it is not a complete tick archive.

## Realtime protocol and cost

`GET /api/portfolio/stream?tickers=A,B` accepts at most twelve distinct public tickers and uses one visitor stream slot. `book` events contain the observed book and ticker; `status` events contain ticker and transport status. The existing single-contract stream keeps its original framing. Both use the same authenticated, geographically restricted proxy.

One native Kalshi WebSocket supplies the shared server replica. Subscription control acknowledgements participate in sequence checking. A ticker removal sends `delete_markets` after the subscription ID is known, and cannot close another ticker's subscribers. Late messages from removed markets advance subscription sequence without rebuilding abandoned books. Concurrent credential failures clean every listener. Quotes are coalesced every 100 ms and materialized once per shared ticker.

Broadcasts carry at most 100 levels per side and explicitly report `depth_limit` and `depth_truncated`. The complete local price index remains intact. Paper entries use a fresh REST book; a shallow displayed book does not manufacture fills or a fully executable close. Backpressure retains only the latest state per ticker and disconnects a persistently stalled reader.

The default 60 GB monthly stream-egress reservation corresponds to approximately $3 of Railway egress at the checked $0.05/GB resource rate. It is separate from the existing 1 GB archive-write allowance. Admission also limits total streams, visitor slots, CPU, daily work and 18,000 reserved stream minutes. Egress is reserved in 64 KiB batches with replenishment before exhaustion, rather than a database write for each message. Unused reservations conservatively count against the allowance. The service-authenticated diagnostics endpoint shows used/remaining reservations and an 80% warning; these counters are not provider invoices. Vercel's separate metered-spend pause remains in force.

Assistant budgeting has an atomic reserve-and-settle path in the existing records and quotas tables. Daily admission, the monthly reserve and the opaque reservation record commit together. A completed-model usage estimate can refund the unused portion of its 25-milliUSD reservation through a service-authenticated endpoint. The settlement locks the reservation row and applies only once; conflicting duplicate settlements preserve the first recorded charge. Failed or unverifiable requests retain the full reserve. Unknown reservations, negative amounts and charges above the reserve are rejected. Two actual PostgreSQL/HTTP tests cover twenty concurrent reservation attempts and twenty duplicate settlements, counter rollback, failure retention and service authorization. Usage-based cost estimates remain distinct from the provider's invoice; a provider-side budget is a separate control.

## Database changes and deletion safety

Migration 003 adds a native enum for durable job-transition history, a private transition table, workload-specific indexes and a stored full-text document. The enum is used by actual transition rows; it is not an unused type. A row trigger writes only an insert or a changed job state. Updates to retry time or other fields do not emit another transition. `pg_notify` carries only job kind and state after commit. A dedicated LISTEN connection wakes the existing worker; durable SQL claims and the periodic scheduler remain the recovery path when a notification is lost.

The worker drains at most four jobs per turn, then yields. It no longer waits one minute between every already-queued source job. Claims still require `SKIP LOCKED`, an unexpired owner lease and idempotent publication. This uses one extra database connection, within the existing runtime connection allowance.

Evidence archives, source-batch lineage, audit events and job-transition history reject UPDATE, DELETE and TRUNCATE by default. Frozen forecast values and settled scores cannot be rewritten, deleted or hidden by changing expiry. Rescheduling and scoring preserve frozen fields. Referencing foreign keys use restrictive behavior, so deleting a parent cannot cascade through the audit trail. Exceptional maintenance requires the table owner and a transaction-local, table-and-operation-specific confirmation. Runtime credentials are not table owners. This does not prevent an authorized database owner from bypassing database protections deliberately.

`node tools/migrate.mjs` now previews pending file hashes. `--apply` is explicit, serializes schema changes using an advisory lock, rejects detected destructive statements, and records normalized hashes. Applied-file drift is rejected. Each SQL file has its own transaction, and its ledger entry is written after that file commits; a process crash in that gap can replay an already-applied file. These migrations are idempotent to permit that replay. The migration lint is an additional safeguard, not a SQL parser or a replacement for reviewing dynamic SQL. No production deletion, TRUNCATE or object drop was run for this upgrade.

`node tools/test_database.mjs` runs the checked-in pgTAP suite against a disposable `_test` database with pgTAP installed. Twenty-four assertions passed, including TRUNCATE CASCADE rejection, null/missing identity and status rejection, immutable probabilities/scores/expiry, permitted settlement, enum labels and trigger frequency. All fixture changes roll back. Ordinary PostgreSQL integration tests also verify nested search provenance and commit-time notifications. The parallel test schema setup uses an advisory lock; row/worker concurrency tests remain concurrent.

## Inspection and feature decisions

The pre-change production inspection used a read-only transaction, table/index statistics, extension availability and EXPLAIN. It observed approximately 750 market rows, 200 source observations and 311 cache/record rows. Their sizes and workload do not imply a need to partition immediately. Existing primary-key and history indexes were being used; no production REINDEX or blanket index creation was run. The covering chart index, time BRIN and FTS GIN were selected from the tested query patterns. Indexes add storage and write work; the benchmark does not establish a benefit for every query.

| Requested mechanism | Implemented or evaluated result |
| --- | --- |
| Enums, triggers, Postgres Changes, webhooks | Typed transition outbox plus commit-time NOTIFY/LISTEN is live code. Durable SQL remains authoritative. External HTTP webhooks and managed row replication are not provisioned; a future dispatcher can consume the outbox without putting network calls in row triggers. |
| Low-latency Broadcast and Realtime Protocol | Shared native WebSocket plus authenticated multiplex SSE, tested with actual local HTTP readers. Managed Supabase fanout remains an alternative when measured multi-replica load justifies its extra transport and billed message volume. |
| Presence | Public who-is-online data is not exposed. Private cross-tab paper-ledger synchronization belongs in the browser's own BroadcastChannel/storage layer. |
| Full Text Search, nested joins, JSONB and arrays | Parameterized `searchMarkets` uses GIN text search, a source-batch join, a nested provenance JSON object, and typed quality-flag arrays. Existing immutable forecast payloads remain JSONB. |
| GraphQL | A field-projection fixture measures the payload saving; the same selected nested fields are available in one SQL/REST query. No GraphQL parser or endpoint is claimed by that byte experiment. Production's `pg_graphql` extension was available but not enabled. |
| B-tree, BRIN, GIN, index advisor, reindex | Three actual query-pattern indexes are tested. The production `index_advisor` and HypoPG extensions were available, not installed. No blind reindex is run; inspect bloat/query plans before scheduling it. |
| Partitioning | A 200,000-row, twelve-partition experiment was slower than its indexed control for the tested one-day query. Keep the control and re-test larger retention/maintenance workloads before conversion. |
| Seeding, pgloader, pg-delta, migra | Benchmark seeds are explicitly synthetic and limited to temporary local tables. Real provider history retains dates and hashes. Schema-file hashes, drift checks and additive migrations are implemented; no historical trades or predictions are seeded as real. Bulk-loader and schema-diff tools are not claimed as installed. |
| Edge Functions | The existing Vercel proxy already checks geography and request bounds near the interface; the shared Railway process maintains persistent source sockets. Another edge hop to the same Ohio database must beat this measured path before replacing it. No extra function service is purchased. |
| Debugging, logger, W3C headers | Server-generated traceparent and marketlab tracestate correlate trusted hops. Untrusted tracestate and baggage values are discarded, and logs whitelist operational fields. Tokens, query strings, bodies, account data and raw errors are excluded. Service-only diagnostics samples actual database RTT and current allowances. |

## Deployment-region experiment

The existing backend ran in SFO while Supabase is in Ohio and the Vercel application uses a US-East default. Railway's documented US-East Metal identifier is `us-east4-eqdc4a` (Virginia), with the same listed resource pricing rather than an additional service. Co-location is a strong latency hypothesis. Compare service-authenticated `database_latency` samples before and after moving the existing single replica. Region documentation says the domain and private networking remain stable; volumes require separate migration. This backend has no attached volume. A region move is not claimed as completed in this document.

## Primary references

- [Kalshi subscription management](https://docs.kalshi.com/websockets/websocket-connection) and [order-book sequence semantics](https://docs.kalshi.com/websockets/orderbook-updates).
- [W3C Trace Context](https://www.w3.org/TR/trace-context/).
- [Supabase Realtime protocol](https://supabase.com/docs/guides/realtime/protocol), [triggers](https://supabase.com/docs/guides/database/postgres/triggers), and [pgTAP](https://supabase.com/docs/guides/database/extensions/pgtap).
- [pgTAP assertions](https://pgtap.org/documentation.html).
- [Railway regions](https://docs.railway.com/deployments/regions) and [resource pricing](https://docs.railway.com/pricing/plans).
