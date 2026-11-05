# PostgreSQL query A/B benchmark

The current implementation decision is to add only the plain DISTINCT guard for exact duplicate record updates in the review code. The CASE expression that preserves an existing TOAST value remains an experimental candidate and is not adopted. No TTL normalization or production change is included. The measurements do not justify a separate `records(pk)` index without query-specific production evidence, and they quantify the database cost of removing an incorrect local quota-denial shortcut.

This is a synthetic local PostgreSQL 17.11 experiment, not a production latency or savings forecast. No production credentials, queries, DDL or payloads were used. The run created an isolated schema in a separate `query_optimization_test` database and removed that schema afterward. The active `engineering_test` application fixture was not modified.

## Method and inspectable artifacts

Run `node web/tools/benchmark_postgres_queries.mjs` with `MARKET_QUERY_BENCH_DATABASE_URL` supplied privately. The script refuses non-loopback targets and database names outside `query_*_test`, including the in-use `engineering_test` database. Defaults are 256 and 100,000 synthetic rows, 41 measured trials per variant and five warmups. Scale is capped at 200,000 rows and trial count at 101. The output never includes the connection address, credentials or payload values.

Read fixtures use the actual key/value table shape: composite primary key `(pk,sk)`, partial expiry index and pending-forecast expression index. Eighty percent of rows use unique cache keys; twenty percent use multi-row journal keys. The extra-index variant adds only `(pk)`. Write comparisons use separate tables with identical indexes and data, so index differences do not confound the update guard comparison. Fixture autovacuum is disabled only inside the disposable schema; production settings are untouched.

Each variant runs in rotating/reversed order. `EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, FORMAT JSON)` supplies server execution/planning time, buffer counts and WAL. Client round-trip time is recorded separately. Read cases vary their synthetic keys. A first touch after population is retained, followed by warm trials; neither PostgreSQL shared buffers nor the operating-system cache were flushed. Most measured reads were shared-buffer hits. First touch is not a disk-cold measurement. [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/17/sql-explain.html).

The full observations and sanitized representative plan trees are in `review/query-optimization-benchmark.json`; a compact transcript is in `review/query-optimization-benchmark.txt`. Percentiles below summarize these 41 observations, without confidence intervals. Sub-millisecond timing differences and tail values can change with desktop load and cache state.

## Separate `(pk)` index

The existing composite B-tree can use its leading `pk` column. A narrower index can sometimes be cheaper, but it duplicates key storage and adds maintenance. [PostgreSQL multicolumn indexes](https://www.postgresql.org/docs/17/indexes-multicolumn.html).

| Rows / query | Composite only p50 / p95 ms | Plus `(pk)` p50 / p95 ms | Median shared-hit blocks |
| --- | ---: | ---: | ---: |
| 256 / exact `(pk,sk)` | 0.033 / 0.047 | 0.031 / 0.043 | 3 / 3 |
| 256 / `pk` only | 0.033 / 0.045 | 0.033 / 0.054 | 3 / 3 |
| 256 / journal prefix + ordering | 0.055 / 0.071 | 0.056 / 0.073 | 16 / 16 |
| 100,000 / exact `(pk,sk)` | 0.035 / 0.045 | 0.045 / 0.065 | 4 / 4 |
| 100,000 / `pk` only | 0.032 / 0.058 | 0.032 / 0.039 | 4 / 4 |
| 100,000 / journal prefix + ordering | 0.052 / 0.077 | 0.055 / 0.126 | 10 / 10 |

At 100,000 rows the additional index occupied 7,839,744 bytes, increasing total index storage from 12,697,600 to 20,537,344 bytes. Sample inserts emitted a mean 463 bytes of WAL without it versus 535 bytes with it; server insert p50/p95 was 0.031/0.042 versus 0.040/0.068 ms. The exact-key query continued to choose the composite key at scale. A `pk`-only tail improvement of 0.019 ms in this warm run is not evidence of an end-to-end application improvement, especially when the application already supplies `sk` for ordinary lookups.

Recommendation: retain the existing indexes. Reconsider only if actual `pk`-only query frequency, cardinality and buffers establish a material benefit. A planner's estimated ten-percent cost reduction alone does not establish measured performance or justify an extra index.

## Record update comparisons

The three candidates were:

1. Existing unconditional `ON CONFLICT ... DO UPDATE`.
2. A `WHERE payload IS DISTINCT FROM EXCLUDED.payload OR expires_at IS DISTINCT FROM EXCLUDED.expires_at` guard.
3. The same guard plus `SET payload=CASE WHEN payload IS NOT DISTINCT FROM EXCLUDED.payload THEN payload ELSE EXCLUDED.payload END`, preserving the existing value when equal.

`ON CONFLICT` can lock a conflicting row even when its update predicate rejects the update; skipping the update does not mean zero locking or zero WAL. [PostgreSQL INSERT](https://www.postgresql.org/docs/17/sql-insert.html).

Four payload profiles were measured: 256-character compressible padding, 16-KiB compressible padding, 16-KiB deterministic high-entropy padding and 32-KiB high-entropy padding. “Incompressible” describes these controlled high-entropy fixtures, not arbitrary production JSON. Logical JSON size includes object fields in addition to padding. Every profile covers exact duplicate, changed payload and expiry-only changes at both table sizes.

| 100,000 rows / 32-KiB high-entropy payload | Baseline p50 / p95 ms | DISTINCT guard p50 / p95 ms | Guard + preserve CASE p50 / p95 ms | Mean WAL bytes: baseline / guard / CASE |
| --- | ---: | ---: | ---: | ---: |
| Exact duplicate | 0.602 / 0.683 | 0.119 / 0.145 | 0.118 / 0.160 | 36,448 / 54 / 54 |
| Changed payload | 0.576 / 0.783 | 0.619 / 0.802 | 0.683 / 0.925 | 36,464 / 36,493 / 36,497 |
| Expiry only | 0.576 / 0.735 | 0.641 / 0.907 | 0.233 / 0.365 | 36,455 / 36,446 / 421 |

For exact duplicates, the baseline produced 46 updates and 46 additional dead-tuple estimates across warmups plus trials. Both guarded variants produced zero updates and retained the same tuple identity. They still emitted a 54-byte lock WAL record per measured attempt. For expiry-only changes all variants created 46 heap updates, as required; the CASE variant substantially reduced TOAST/WAL work while preserving the changed expiry. These counters are short-run fixture evidence, not a measurement of production bloat.

At 256 rows, the same 32-KiB duplicate case measured baseline p95 1.578 ms and 36,454 mean WAL bytes versus CASE p95 0.149 ms and 54 bytes. Expiry-only measured 1.245 ms / 36,458 bytes versus CASE 0.910 ms / 426 bytes. Changed-payload CASE comparisons consumed extra CPU and did not reduce WAL. For small inline payloads the CASE can also add CPU without a storage benefit. This is a workload-dependent tradeoff, not a universal speed improvement.

Recommendation: adopt only the plain DISTINCT guard now, preserving every actual payload or TTL change. The expiry-only CASE fixture deliberately changes only the SQL timestamp. Actual `save` calls embed `expires_epoch` inside JSON, and cached values often contain a new `as_of`; refreshing those fields changes the JSON, so the CASE's old-value branch cannot apply. Its synthetic expiry-only benefit is not evidence of an improvement for those application writes. CASE remains deferred unless actual callers demonstrate column-only expiry changes with equal JSON, and its extra CPU cost on changed payloads must remain part of that decision. No TTL fields are removed or normalized. The measured query uses a payload-first OR predicate; an expiry-first predicate may avoid a redundant equality comparison but was not separately timed.

## Exhausted quota cost

The rejected UPSERT retains the validated `amount <= limit` insertion rule and the existing conflict guard `used <= limit-amount`. Removing a local denial cache restores database-authoritative decisions but makes each denial a database request. This experiment does not claim a missing overrun fix.

An exhausted-key UPSERT measured server p50/p95 0.056/0.072 ms, three median shared-hit blocks, zero shared reads and 54 WAL bytes from row locking. Four workers made 400 rejected requests on one hot key with round-trip p50/p95 3.581/5.052 ms. Four separate exhausted keys measured 1.971/2.850 ms. All 800 requests were denied and all five counters remained exactly 10. These local round trips include client/IPC and row-lock contention; they do not predict cross-region production latency.

This is an explicit correctness/cost tradeoff. Keep existing admission limits and the four-connection pool. A future denial cache would need authoritative expiry, exact request semantics and distributed refund/transaction invalidation; the old key-only shortcut cannot be justified by its lower latency.
