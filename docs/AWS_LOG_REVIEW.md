# AWS log review

**No actionable application failure was found in the accessible AWS logs for November 5, 2026, 03:28:25–04:28:25 UTC.** The legacy worker completed one invocation with zero reported errors or throttles. Accountwide coverage remains incomplete because the authenticated session denied access to several regional inventories. This is not an accountwide zero-error verdict.

The exact one-hour window was fixed when the review began. The structured, sanitized evidence is [`review/aws-last-hour.json`](../review/aws-last-hour.json). Raw API responses remain outside Git in the private review directory.

## Identity and coverage

Existing AWS authentication was refreshed and independently verified through `sts:GetCallerIdentity`: account **`********7413`**, role **`AccountFullAccessRole`**, profile `agent-toolkit`. The advertised official AWS MCP invocation returned `Unknown tool aws___run_script`; the AWS observability skill permits the standard CLI fallback. AWS CLI 2.39.2 performed the read-only review.

Region discovery returned 34 commercial regions: 17 enabled and 17 not opted in. All 17 enabled regions were attempted. Resource and event listings followed continuation tokens until exhausted wherever authorization permitted.

| Scope | Verified coverage |
|---|---|
| CloudWatch group inventory | Complete in `us-east-1` and `us-east-2`: zero and two groups respectively. Denied in the other 15 enabled regions. |
| Accessible log groups | Both Ohio groups read completely: two stream-list pages and three event pages, including the worker's continuation page. |
| Log events in the hour | Four worker platform records; no error-like or disconnect-like records. The web group had no streams or events. |
| CloudTrail management history | Complete in `us-east-1`, `us-east-2` and `us-west-2`: 11 returned records, none carrying `errorCode`. Other regional reads were denied. |
| Compute and ownership | Ohio lists one Lambda Event Function, one Lambda Web Function, one CloudFormation stack, nine tagged resources and zero EC2 instances. Other service/region inventories have explicit permission gaps. |
| Review API attempts | 151 orchestrated read-only attempts; 126 permission failures. These occurred during this later review and are not application failures from the fixed window. |

The denied CloudWatch regions are `ap-northeast-1`, `ap-northeast-2`, `ap-northeast-3`, `ap-south-1`, `ap-southeast-1`, `ap-southeast-2`, `ca-central-1`, `eu-central-1`, `eu-north-1`, `eu-west-1`, `eu-west-2`, `eu-west-3`, `sa-east-1`, `us-west-1` and `us-west-2`. Their resource counts and error counts are unknown. No permissions were broadened.

## Legacy market project

CloudFormation `portfolio-market-lab` is `UPDATE_COMPLETE`. Its 14 listed resources associate the web and worker groups, Lambda functions, S3, DynamoDB, scheduler, failure queue, budget and roles with the earlier market lab implementation. The checked-in `web/cloud/stack.yaml` defines matching resource families. This deployed inventory establishes the association; repository declarations alone were not treated as deployment proof.

The Ohio worker is `portfolio-market-lab-Worker-hzfwYxJWwsrU`, running Node.js 22 with 256 MB and a 60-second timeout. The four records at **04:09:23–04:09:24 UTC** are `INIT_START`, `START`, `END` and `REPORT`. The final event timestamp matches the latest timestamp returned by its stream inventory. Its report records **1,049.42 ms** duration, **1,402 ms** billed duration and **93 MB** maximum memory. Complete `AWS/Lambda` metric queries independently returned **Invocations 1, Errors 0, Throttles 0** for this hour. This single successful invocation does not establish high-load latency percentiles or future reliability.

The Lambda Web Function `portfolio-market-lab`, revision `rev-uoexb`, and its public endpoint are `Active`; the endpoint rate limit is 100. Its deployed revision sends application and system logs at **WARN/WARN** to `/portfolio/portfolio-market-lab/web`, which has no streams. Normal successful requests need not appear at those log levels. Correctly dimensioned `AWS/Lambda/Web` queries for `ExecutedRequests`, `HTTPResponseStatusClass4XX` and `HTTPResponseStatusClass5XX` completed with **no datapoints**. These are sparse metrics, so missing data is retained as unavailable rather than presented as an observed zero. Request metrics are centralized in the home region; regional quota/throttle metrics are separate. [AWS Web Function metric behavior](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-monitoring-metrics.html).

No configured CloudTrail trails were returned in Ohio; accessible management-event history was still queried. The S3 access-logging configuration read was denied, so its enabled state remains unknown. No bucket objects, forecasts, credential parameters or private journal data were read.

## Interpretation and changes

The available records support a successful legacy worker run and no observed application failure in the accessible logs. They do not establish that every AWS service has enabled logging, that denied regions contain no resources, or that the legacy web endpoint served no requests. Management-event history also excludes CloudTrail data events. Current Vercel, Railway and Supabase behavior must be evaluated through those providers' evidence.

No AWS resource, runtime code, permissions, logging level, paid monitoring feature, alarm or notification was changed. No CloudWatch Logs Insights query was started. There is no measured before/after AWS error reduction to report, and no AWS application fix was warranted by the accessible evidence.

Pagination followed the documented rules: empty `FilterLogEvents` pages with `nextToken` are not terminal; `GetLogEvents` consumers must continue until the directional token stabilizes. Telemetry can arrive late or be dropped, so the review remains a fixed-window snapshot. [FilterLogEvents](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_FilterLogEvents.html), [GetLogEvents](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_GetLogEvents.html).
