# Predictir maintenance workbench

Use the workbench to review a release or investigate unusual traffic. Name a review and choose the connectors it should use. The grid separates live public API and MCP checks, an Azure Monitor export, and an optional process-local runtime snapshot. Reopen an archived review to reuse its profile. Conditional formatting lets you reuse a threshold across reviews for a connector and nested numeric field. Measurement rules also select a specific metric and unit. A flag leaves the captured status intact.

## Run locally

From the repository root, install and build the standalone React bundle, then export Azure Monitor metrics using the Azure CLI account that can read both Container Apps.

```powershell
npm ci --prefix ops-ui
npm run build --prefix ops-ui
$opsDir = Join-Path $env:LOCALAPPDATA 'Predictir/maintenance'
New-Item -ItemType Directory -Path $opsDir -Force | Out-Null
$metricsPath = Join-Path $opsDir 'azure-monitor.json'
node terraform/azure/hosted/export-operator-metrics.mjs --resource-group predictirazv2k8lc-rg --prefix predictirazv2k8lc --hours 24 |
  Set-Content -Encoding utf8NoBOM -LiteralPath $metricsPath
$env:OPERATOR_AZURE_METRICS_PATH = $metricsPath
$env:OPERATOR_EVIDENCE_DIR = Join-Path $opsDir 'reviews'
$env:OPERATOR_APP_ORIGIN = 'https://predictirazv2k8lc-front.bravesky-edec19fa.centralus.azurecontainerapps.io'
$env:OPERATOR_ACCESS_TOKEN = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
Set-Clipboard -Value $env:OPERATOR_ACCESS_TOKEN
node web/tools/operator.mjs
```

Open [the local workbench](http://127.0.0.1:8790), paste the local operator token, and select the checks you want. Clear the clipboard after pasting. Export Azure metrics again when the snapshot ages past 30 minutes. To include process percentiles and retained throttle counts, set `OPERATOR_SNAPSHOT_PATH` to an explicitly exported `runtime_snapshot` from the existing private diagnostics endpoint. These are bounded process samples. Counts of retained 429 records can be lower than actual throttles.

The review action makes bounded reads of the configured public Azure frontend and uses the existing MCP source-coverage route. It never takes provider addresses or Azure credentials from the browser. The operator server binds to loopback and requires a separate token. Azure checks use the CLI export. The evidence archive keeps up to 256 local, content-addressed records and indexes generated labels, statuses, connectors, and safe dimensions. It stores no raw logs, model replies, connection strings, or provider tokens. The public trading interface has no management entry point. [Fluent UI v9](https://github.com/microsoft/fluentui) · [Formik validation](https://formik.org/docs/guides/validation) · [Azure Monitor metrics](https://learn.microsoft.com/azure/container-apps/metrics)

## Interpreting the traffic check

During the 24 hours ending November 6, 2026 at 6:16 a.m. Eastern, Azure Monitor reported 2,773 frontend requests and 2,324 backend requests. The two layers recorded five and three 5xx responses, respectively. Both recorded 118 HTTP 429 responses, with 88 at the frontend and 87 at the backend during the peak minute at 5:20 p.m. Eastern on November 5. Ingress and backend metrics can count the same request. A throttle can come from normal quota enforcement, shared traffic, or a misconfigured client. The observed counts alone cannot attribute the traffic or establish malicious intent.

The Azure runtime shares a per-client budget of 12 full evidence, headline replay, execution research, and recommendation requests per fixed minute. It returns a retry time before dispatching a rejected request or charging durable work. Full evidence uses six work units. Health, catalog, and lightweight evidence previews continue through their existing limits. The burst counter is per running backend process. The existing database-backed daily budget continues to apply across revisions.

The backend reached a one-minute mean working set of about 601 MiB during the measured day. A move to the smaller 512 MiB profile would put the observed workload above its memory allocation. Revisit compute sizing with peak measurements and cold-start checks before changing the warm deployment. [Container Apps billing](https://learn.microsoft.com/azure/container-apps/billing) · [Container Apps scaling](https://learn.microsoft.com/azure/container-apps/scale-app)

## Extending the evidence store

Azure Blob Storage would fit an access-controlled, shared receipt archive. Azure AI Search would add cross-document retrieval if the collection outgrows the local index. Both are optional extensions. The current workload generates metadata from bounded structured observations, which keeps capture reproducible and avoids a model call for each receipt. [Blob indexer and field mappings](https://learn.microsoft.com/azure/search/search-indexer-overview)

Kusto can attribute a future throttling burst to an allowlisted route and revision if Container Apps ingress logs are retained. The current deployment uses platform metrics and on-demand console streaming. This query is a template for a workspace with the documented `ContainerAppHTTPLogs` table.

```kusto
ContainerAppHTTPLogs
| where TimeGenerated > ago(24h)
| where ContainerAppName startswith "predictirazv2k8lc-"
| extend Route = tostring(split(tostring(Path), "?")[0]), Code = toint(StatusCode)
| where Route in ("/api/workspace/evidence", "/api/workspace/graphql",
                  "/api/workspace/execution-research", "/api/workspace/recommendations")
| summarize Requests = count(),
            Throttled = countif(Code == 429),
            ServerErrors = countif(Code between (500 .. 599))
    by ContainerAppName, RevisionName, Route, bin(TimeGenerated, 5m)
| order by TimeGenerated desc
```

The query groups by a fixed route allowlist and projects no request identifiers or query strings. It is separate from the verified live Monitor collector. [Container Apps ingress log schema](https://learn.microsoft.com/azure/container-apps/log-monitoring)
