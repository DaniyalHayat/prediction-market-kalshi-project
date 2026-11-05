# Railway logs and settings review

The review covers **2026-11-05 03:30:00–04:30:00 UTC**, a fixed 60-minute window. It includes the four deployments created during the window and the preceding deployment that was still serving at its start. The sanitized evidence is [railway-last-hour.json](../review/railway-last-hour.json). Raw logs remain private and are excluded from the repository.

## Coverage

| Log type | Records reviewed | Retrieval |
| --- | ---: | --- |
| Build | 267 | All five deployment IDs, no severity filter |
| Runtime/deployment | 348 | All five deployment IDs, no severity filter |
| HTTP | 377 | All five deployment IDs, all statuses |
| Network flow | 7,870 | Twelve contiguous five-minute service intervals |
| DNS | 868 | Full service window, all response codes |

Every final query returned fewer than its 5,000-record ceiling. The first whole-window network request hit that ceiling, so it was replaced by twelve five-minute queries; the largest slice contained 1,226 records. Network records were deduplicated by `flowId`, `timestamp`, `captureStart` and `captureEnd`. All 7,870 slice records were unique under that key. Deployment-specific HTTP retrieval was necessary because an unqualified CLI HTTP query defaults to the latest deployment. Network and DNS queries are service scoped and reject a deployment ID. [Railway log CLI](https://docs.railway.com/cli/logs).

These counts describe accessible emitted records. Successful application messages are intentionally sampled; the report does not imply that every internal operation emits a log. HTTP, network and DNS evidence were also checked, rather than treating a quiet application error log as sufficient verification.

## Findings and disposition

HTTP records contained **370 responses with status 200, five with status 404 and two with status 503**. The five 404s were `/api/session` requests served by the old backend during frontend/backend replacement. Later backend versions implement the route, and `92ed162` adds an explicit account retry that preserves stored paper records. The two 503s were owner-only `/api/account/profile` probes before owner login activation. Guest `/api/session` is separate; the owner endpoint was not weakened or changed to report a misleading success.

One build failed at **03:49:42 UTC** because Railway rejects Dockerfile `VOLUME`. Commit `d230a88` removed that instruction and retained an ephemeral model cache. The next three builds succeeded. The active deployment at the window's end was `04c6a7a9`, built from `37f8151`, with status `SUCCESS`.

Two Apple ingestion attempts requested retry at **04:01:10** and **04:04:01 UTC**. A separate read-only Supabase job inspection confirmed that the same job completed on attempt three at **04:08:44.069 UTC**. Its retained earlier `503` error field is historical; it does not override the completed state. Thirteen pipeline completion records and two retry-scheduled records were observed in the window.

Three older containers emitted ordinary `Stopping Container` entries as their replacements became active. Those lifecycle entries are distinct from a crash or failed database reconnect. The latest deployment emitted no runtime error in this window, but it also had no completed HTTP records within the window; subsequent health probes provide separate evidence.

## Network and DNS

There were **278 drop-marked TCP flow records**, with 278 distinct flow IDs:

| Deployment | `NO_SOCKET` | `TCP_INVALID_SYN` | `TCP_OLD_DATA` |
| --- | ---: | ---: | ---: |
| `2ab5d79f` | 197 | 11 | 5 |
| `5a5f8f27` | 32 | 2 | 3 |
| `c7e3a4a5` | 27 | 0 | 1 |
| `04c6a7a9` | 0 | 0 | 0 |

All were **ingress TCP from Internet port 443 to ephemeral client ports**. They were not inbound requests to the application's listening port. The kernel labels distinguish missing valid sockets, unexpected SYN flags and old data. These can occur around closed or interrupted outbound TLS connections, but the available records do not prove which application request initiated each one. They are not counted as 278 failed HTTP requests. No packet checks, TLS validation or transport safeguards were disabled to suppress them. [Linux drop-reason definitions](https://github.com/torvalds/linux/blob/master/include/net/dropreason-core.h).

All **868 DNS responses were `NOERROR`**. Of these, 427 had empty answers, which can represent an address-family NODATA result. They do not establish failed name resolution. IPv6 remains enabled; there was no evidence supporting disabling it.

## Settings checked and drift corrected

The API confirmed the GitHub source repository, `main` branch, `/web` root, Wait for CI enabled and an accepted check suite. The existing backend uses one replica, remains awake, and checks `/api/health` with a 120-second startup timeout. Both Railway domains passed HTTPS certificate verification and returned health status 200 with `Cache-Control: no-store`. They are aliases for the same service, rather than two backend instances.

CDN caching is enabled with automatic HTML handling, a 7,200-second fallback TTL, stale-while-revalidate enabled and HTML purge on deploy. Dynamic health/API responses retain their explicit cache controls. The existing second alias was retained to preserve working links. Changes were limited to rebuild watch patterns and restart retries; the existing $10 workspace usage cap, service identity, paid tiers, credentials and database permissions were preserved.

Two settings had drifted from the checked-in intent: automatic rebuilds had no watch pattern, and the restart policy allowed ten retries instead of three. An attempt to link `/web/railway.toml` was rejected because this service cannot opt into deprecated Config as Code. That failed request changed nothing. The two intended settings were then applied directly through the authenticated CLI API and independently read back:

```json
{
  "watchPatterns": ["/web/**"],
  "restartPolicyMaxRetries": 3
}
```

[railway-service.json](../web/infra/railway-service.json) records the exact existing target and these managed settings. [reconcile_railway.mjs](../web/tools/reconcile_railway.mjs) previews drift by default, checks the project/environment/service/repository/root identity, applies only those two fields with `--apply`, and verifies the result. A second live preview returned no changes. Two tests cover preview safety, idempotence, wrong-target rejection and failed readback. No manual redeployment was issued; the existing CI-gated source workflow handles the next release.

The provider's native TypeScript IaC system is a separate migration. The legacy TOML file is not currently linked to the service, and is not claimed as the active deployment controller. Existing legacy Config as Code support ends December 1, 2026. [Railway IaC and migration behavior](https://docs.railway.com/infrastructure-as-code).

## Remaining dependency maintenance

Each successful build emitted nine transitive package deprecation warnings plus the `npm cache clean --force` warning. The deprecated packages were `rimraf`, `lodash.isequal`, `inflight`, `glob`, `@esbuild-kit/esm-loader`, `@esbuild-kit/core-utils`, `fstream`, `node-domexception` and `uuid`. These are retained findings, rather than relabeled as clean builds with no warnings.

A current production-dependency audit reported **zero high, zero critical, seven moderate and three low entries**. Several entries describe the same transitive advisory chain. Payload/CMS tooling is separate from the hosted server import path; the reviewed ExcelJS UUID calls use `v4()` without a supplied buffer, while the UUID advisory concerns the `v3/v5/v6` buffer API. No reachable exploit was established in this review. A breaking ExcelJS downgrade and unverified transitive overrides were not applied. The residual advisories remain inspectable: [UUID](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [deepmerge](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), [esbuild development server](https://github.com/advisories/GHSA-67mh-4wv8-2f99).
