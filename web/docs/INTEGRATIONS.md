# Integration choices and operating budget

Reviewed against primary documentation on November 4, 2026. This ranking assumes approximately 100 unique visitors per day, shared public market ingestion, paper trading, and a $25 monthly operating allowance **in addition to existing Pro subscriptions**. Provider features do not establish a trading advantage; the benefit must appear in measured reliability, latency, reproducibility or forecast evaluation.

## Ranked recommendations

| Rank | Choice | Benefit for this app | Decision and incremental cost |
| --- | --- | --- | --- |
| 1 | Existing Supabase Postgres, private Storage and durable SQL jobs | Typed observations, joins, indexed history, retryable ingestion, owner-isolated journals and evidence archives. These support reproducible analysis and prospectively frozen forecasts. | Used. Prefer the current database and worker before buying another store. Storage and compute still consume plan quotas. |
| 2 | Vercel CDN, firewall and application quotas | Cached frontend assets reduce repeated origin work. Geographic restrictions, bounded requests and shared quotas protect the public demo and paid dependencies. | Used. Keep private responses uncached. A CDN or firewall cannot guarantee immunity from attack. [Shared responsibility](https://vercel.com/docs/security/shared-responsibility). |
| 3 | AI Gateway with the app's read-only MCP service | Explains returned rules, models and limitations through structured tools. Vercel deployment OIDC avoids an extra long-lived model-provider key. | Used. The application reserves $0.025 per chat against a default $3 monthly allowance. This is a conservative request allowance, not a provider invoice guarantee. [OIDC](https://vercel.com/docs/ai-gateway/authentication-and-byok/oidc). |
| 4 | Included Observability | Find errors, expensive requests and service bottlenecks before adding infrastructure. Measure provider failures, queue age and cache effectiveness alongside model coverage. | Use included dashboards first. Observability Plus adds $10/month on Pro plus $1.20 per million events, with 30-day retention. Defer until its extra detail justifies that allocation. [Pricing and limits](https://vercel.com/docs/observability/observability-plus). |
| 5 | Marketplace and Stores: reuse Supabase | Convenient provisioning, integration configuration and connection-variable management. The Stores page is a resource management surface, not an additional analysis engine. | Keep the existing Supabase connection. Do not provision a second Postgres database, Redis instance or object store merely to populate the dashboard. Provider plans and quotas remain separate. [Marketplace storage](https://vercel.com/docs/marketplace-storage), [existing-account integrations](https://vercel.com/docs/integrations). |
| 6 | Supabase Vault | Useful when database functions or scheduled SQL jobs genuinely need encrypted credentials. | Deferred: the worker already uses backend-only platform secrets. Vault exposes decrypted values to authorized SQL roles; encrypted storage does not remove the need for careful grants. Adopt for a concrete database-side integration, rather than duplicating every credential. [Vault](https://supabase.com/docs/guides/database/vault). |
| 7 | Supabase Wrappers | Convenient SQL access to supported external systems and potential joins with local tables. | Deferred. Remote SQL access does not inherently improve latency or reliability. Materialize approved data through bounded ingestion so repeated dashboard queries cannot repeatedly call a paid API. Database work, remote-service charges and adapter limitations still matter. [Wrappers](https://supabase.com/docs/guides/database/extensions/wrappers/overview). |
| 8 | Build a Supabase OAuth integration | Appropriate for a future product that manages customers' Supabase organizations or projects. | Deferred. The linked guide concerns **Management API authorization**, not ordinary visitor sign-in. This single-project application does not need that broad authority. Future visitor authentication should use an application login flow with owner-scoped policies; a management integration would need PKCE, state validation and secure token lifecycle handling. [Requested guide](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration). |

The Marketplace is useful for a specific missing capability, not as a collection of mandatory subscriptions. Prefer one authoritative database, one evidence store and one quota system. Installing an integration does not automatically make the app faster or its forecasts more accurate.

## Data engineering upgrades worth measuring

The application currently uses its own durable Postgres job table and worker leases. Supabase's built-in [Queues](https://supabase.com/docs/guides/queues) and [Cron](https://supabase.com/docs/guides/cron) are reasonable alternatives when SQL-native scheduling or queue administration simplifies operations. They are not claimed as installed extensions here, and migrating a working queue should preserve deduplication, visibility timeouts and retry behavior.

Use query execution plans and actual latency to decide whether to add an index or materialized aggregate. For larger offline research, a DuckDB/Parquet workflow can be evaluated without adding an always-running service. Kafka, Spark and Hadoop are deferred until measured throughput, replay or analytical workloads require them. Visitor count alone does not measure ingestion load.

Supabase Pro includes Smart CDN automatically. Its cached and uncached egress quotas are separate; documented overage rates are $0.03/GB and $0.09/GB respectively. Reusing a signed URL can improve its cache hit rate, but token expiry and cache lifetime are independent. Private journals should remain behind authenticated application responses rather than reusable public cache entries. [Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn), [egress pricing](https://supabase.com/docs/guides/platform/manage-your-usage/egress).

## $25 operating envelope

This is a planning allocation, not an invoice forecast or a guarantee that one switch caps all vendors:

| Item | Monthly allocation |
| --- | ---: |
| Railway backend/worker | $10.00 |
| X public reads and small lookup allowance | $6.50 |
| AI explanations | $3.00 |
| Transfer, storage and contingency | $5.50 |
| **Total excluding existing subscriptions** | **$25.00** |

The application bounds paid X retrieval and shares cached results. Avoid automatic credit reloads and review each provider's actual usage limits. AI Gateway's free tier includes $5 monthly credit; purchasing credits transitions the account to paid usage and removes that recurring free allowance. Do not count free and paid credits twice. [AI Gateway pricing](https://vercel.com/docs/ai-gateway/pricing).

Keep Supabase Spend Cap enabled, but it does not cover compute upgrades, preview-branch compute, read replicas, IPv4, log drains or point-in-time recovery. Automatic database branches can create costs even at low traffic. Prefer controlled, short-lived previews over persistent automatic branches. [Covered and excluded costs](https://supabase.com/docs/guides/platform/cost-control).

## Security lessons applied to this design

Vercel's React2Shell bulletin describes a React Server Components vulnerability that could permit remote code execution. Its guidance distinguishes WAF mitigation from the complete fix: upgrading affected deployed packages. Keep dependency and production-version checks alongside the firewall, and assess secret exposure if compromise is suspected. [React2Shell bulletin](https://vercel.com/kb/bulletin/react2shell).

Lovable's April 22, 2026 report describes a backend regression that re-enabled access to public projects' chats and source code. The relevant lesson is authorization regression testing, not an assumption that all generated applications share the same bug. Test anonymous, wrong-owner and valid-owner access separately; publishing a demo must not publish private journals or credentials. [First-party incident account](https://lovable.dev/blog/our-response-to-the-april-2026-incident).

Country-based blocking is an IP-location access rule, not proof of data residency or protection against VPNs. Logs support investigation and control evidence; they do not make the project SOC 2 certified. No integration supplies a guarantee against SQL injection, denial of service or key leakage. Parameterized queries, least privilege, bounded inputs and owner-isolation tests remain application responsibilities.

## Inspectable model evidence

[sports-validation.json](sports-validation.json) records the observed public-source validation, hashes, coverage, protocol and limitations. Re-run `node tests/verify-sports-live.mjs` from `web/` for a fresh result. Positive historical skill is separate from calibrated contract uncertainty, executable edge and realized trading returns.
