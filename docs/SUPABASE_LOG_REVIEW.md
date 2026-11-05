# Supabase service log review

The fixed one-hour window is **2026-11-05 03:29:06.407–04:29:06.407 UTC**, with the end excluded. All **1,268 recorded Supabase service events** returned for that window were inspected. There were **no ERROR/FATAL/CRITICAL events, no recorded HTTP 4xx or 5xx responses and no application-role SQL failures**. Three events needed individual interpretation: two managed Auth deprecation warnings and one admin-client connection reset. The evidence does not support a database configuration change for those events. A separate durable-job check found two Apple source retries that succeeded on their third attempt; that application-side history is detailed below and is not erased by the absence of Supabase service errors.

The [machine-readable review](../review/supabase-last-hour.json) records counts, exact log IDs, classifications and coverage limits. Raw logs and credentials are excluded from the repository.

## Coverage

| Source | Events | Observed result |
| --- | ---: | --- |
| Postgres | 456 | 455 SQLSTATE `00000`; one `08006` admin-client reset at LOG level |
| Supavisor shared pooler | 265 | INFO; authentication, termination, idle socket closes and unused-pool lifecycle |
| PgBouncer dedicated pooler | 186 | INFO; logins, requested client closes, one lifetime rotation and TLS backend establishment |
| Storage | 149 | INFO; 76 HTTP 200 responses and 73 lifecycle events |
| API Gateway | 111 | 110 HTTP 200 responses; one HTTP 204 response |
| Integration workflow runs | 44 | INFO; successful health/migration checks, existing-relation NOTICE and no functions to deploy |
| PostgREST | 32 | INFO; schema reloads and successful connections |
| Auth | 17 | 15 INFO, two WARNING; recorded HTTP statuses were ten 200 and one 204 |
| Auth audit | 4 | INFO |
| Realtime | 4 | INFO health checks |
| Edge Function invocation | 0 | No recorded events; successful query |
| Edge Function console | 0 | No recorded events; successful query |
| Database version upgrades | 0 | No recorded events; successful query |

No requested source query was unavailable. Empty function sources do not prove function execution works; the workflow logs separately report no functions to deploy. Gateway and service events can describe the same request and must not be added together as unique requests.

The initial raw query returned only 1,000 rows even with a larger SQL limit. To avoid a partial review, the hour was split into four disjoint 15-minute windows, returning **260, 435, 335 and 238 rows**. Each was below the observed result cap. All 1,268 event IDs were unique, and the raw source totals matched the independent aggregate query. Top-level `severity_text`, service-specific severity, SQLSTATE, populated HTTP statuses and message text were checked. Missing HTTP status fields were treated as absent, not successful responses. A later-ingested event appeared during the first pass; the completed partitions and final aggregate were reconciled afterward.

## Findings

### Managed Auth deprecation warnings

At **04:05:12 UTC**, GoTrue emitted one warning each for `GOTRUE_JWT_ADMIN_GROUP_NAME` and `GOTRUE_JWT_DEFAULT_GROUP_NAME`. Their log IDs are `cf7d34b1-bfa6-4aae-9da9-0963cf5c2967` and `a705d188-a2ad-42ee-b229-06a04bea6a48`.

These are managed service startup/configuration deprecations. The supported Auth configuration endpoint returned HTTP 200, but exposed neither legacy group field. No application sign-in failure accompanied them in the inspected logs. Changing JWT roles, auth providers or user records would not be an evidence-backed fix for these warnings. No such settings were changed.

### One admin-client connection reset

At **04:23:49.979 UTC**, Postgres logged `could not receive data from client: Connection reset by peer` with SQLSTATE `08006`, severity **LOG** and role **supabase_admin**. Log ID: `31060ff6-3626-4876-bc86-d8cabc653607`.

This identifies a client-side connection reset for an administration connection. It does not establish an application-role error, a failed in-flight application statement or a recurring outage. The exact client-side reason is not present in these logs. Raising application connection limits or database memory would not address an identified cause here.

### Disconnections and pooler lifecycle

Postgres recorded 364 ordinary disconnection messages, including 336 for `supabase_admin` and six for `market_lab_app`. Those six runtime sessions lasted approximately five minutes to three hours seventeen minutes; the records are not evidence of per-query connection churn.

Supavisor recorded 97 client termination messages, 98 client authentications, 52 backend authentications and 12 idle socket closes. Ten idle closes used the runtime role, one used the release-verification admin connection and one used an admin connection with the application name. All twelve were INFO and explicitly described an **idle** state. Two unused admin pools shut down gracefully and two pools started. PgBouncer recorded 91 login attempts, 90 client-requested closes, one configured server-lifetime rotation, two new backend connections and two successful TLS establishments. These counts represent different layers and are not additive counts of failed requests.

The application's related shutdown repair, commit `abebb43`, drains runtime work and releases database sessions. The logs do not establish the cause of every earlier idle close; deployment timing alone is insufficient to assign a cause. Normal connection messages remain available for diagnosis. They were not suppressed to make the error count appear smaller.

### Earlier extensions-schema permission incident

The current hour contained **zero `42501` events** and **zero `permission denied for schema extensions` messages**. The earlier diagnostic incident was outside this window. Commit `e257329` added privilege preflight before optional statistics access. The application role was not granted broad statistics permissions to accommodate a monitoring query.

## Apple ingestion job follow-up

Railway's two Apple retry messages were checked against durable job state at **04:37:08.904 UTC**, using a read-only database transaction. The query selected job metadata, not input payloads. Both Apple jobs created since 03:00 UTC were complete:

| Job | Attempts | Completed UTC | Retained last failure | Durable observations |
| --- | ---: | --- | --- | ---: |
| `apple#498291` | 1 | 03:00:39.377 | None | 100 in source batch 57 |
| `apple#498292` | 3 | 04:08:44.069 | Legacy `503` | 100 in source batch 76 |

The immutable transition records for the retried job show:

| Attempt | Running UTC | Returned state and time UTC | Elapsed |
| --- | --- | --- | ---: |
| 1 | 04:00:54.493, transition 156 | pending at 04:01:10.592, transition 157 | 16.099 s |
| 2 | 04:03:42.708, transition 160 | pending at 04:03:58.871, transition 161 | 16.163 s |
| 3 | 04:08:42.703, transition 162 | complete at 04:08:44.069, transition 163 | 1.366 s |

Batch 76 was ingested at **04:08:43.966 UTC**. An independent count at 04:42:15.896 UTC confirmed 100 actual observation rows for each batch; completion is backed by stored data. A later non-mutating Apple endpoint check returned HTTP 200 in 801 ms and passed the existing 100-track parser.

The two approximately 16-second failures are **consistent with the existing 16-second source-fetch deadline**. This is a timing-based inference. The historical `503` did not distinguish a request timeout, an upstream HTTP response or a shared-cache failure, so an exact cause cannot be proven retrospectively. Successful completion preserves the last failure code in the existing job row; `state='complete'` and `finished_at` establish the current result.

That diagnostic ambiguity was repaired in the application. New source failures preserve stable sanitized causes, including `UPSTREAM_TIMEOUT`, `UPSTREAM_BODY_TIMEOUT`, `UPSTREAM_HTTP_503`, `UPSTREAM_NETWORK_ERROR` and `UPSTREAM_INVALID_JSON`. An upstream HTTP status accompanies a failure only when a response was actually observed. Unknown exception codes become `SOURCE_UNAVAILABLE`; raw exception messages, response bodies and credentials are not written to durable job errors or pipeline logs. Provider latency and error telemetry now covers body reading and validation as well as receipt of response headers. The existing durable `error_code` field and pipeline log metadata carry the cause, attempt count and known HTTP status.

The 16-second request deadline, retry backoff, four-attempt maximum and lease ownership rules remain unchanged. Twenty-nine focused provider/evidence tests passed, plus six tests against a real isolated Postgres queue. Tests distinguish timeout, body timeout, actual HTTP 503, network failure and invalid JSON, verify private details are discarded, and exercise two retry causes followed by a successful third attempt. No migration or privilege change was required.

## Reproduction

Use an authorized Management API token through an environment variable, with the project reference and the two UTC bounds supplied as `iso_timestamp_start` and `iso_timestamp_end`. Tokens must remain outside URLs, logs and saved reports. The endpoint is `/v1/projects/{project_ref}/analytics/endpoints/logs`.

Inventory all recorded sources before applying error filters:

```sql
select source, severity_text, count() as event_count
from logs
group by source, severity_text
order by source, event_count desc
```

For complete event review, select only needed columns, including `id`, `timestamp`, `source`, `severity_text`, `event_message` and the required `log_attributes` keys. Apply an explicit half-open timestamp predicate for each partition, sort by timestamp and ID, and use a limit below or equal to the observed API cap. Compare summed partitions and unique IDs against independent counts. Query `function_edge_logs`, `function_logs` and `pg_upgrade_logs` explicitly even when they do not appear in the inventory.

No provider setting, database privilege or pool limit was changed. The log and durable-job inspection was read-only; the follow-up repair changes only application diagnostics and queue error propagation. These results describe recorded evidence in this hour; they do not establish that disabled logging, later ingestion or every unexercised application path is error-free.

Primary guidance: [querying logs with SQL](https://supabase.com/docs/guides/observability/advanced-log-filtering), [source and field definitions](https://supabase.com/docs/guides/observability/log-field-reference), and [service log selection](https://supabase.com/docs/guides/observability/logs).
