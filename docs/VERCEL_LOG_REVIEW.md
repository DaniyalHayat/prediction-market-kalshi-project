# Vercel one-hour reliability review

Reviewed Predictir's production and preview logs from **2026-11-05 03:30:00 through 04:30:00 UTC**. Runtime and request queries used the explicit project/team, a 1,000-record page size and a fixed end time. Both responses returned `hasMore: false` with no excluded intervals: 43 runtime records and 586 CDN requests. These are recorded events, not proof of every client experience. [Sanitized evidence](../review/vercel-last-hour.json).

## Findings and validation

| Finding | Assessment and action |
| --- | --- |
| 43 failed response-piping errors | Every record has the same timeout cause on `/api/stream` or `/api/portfolio/stream`, on four deployments predating `37f8151`. The last occurred at 04:13:49 UTC. The old 55-second upstream abort was replaced by a separate connection deadline, backpressure and clean stream rotation/cancellation. |
| Fixed deployment | `37f8151` had 26 recorded requests, all HTTP 200, and no runtime error records in this window. Two actual hosted streams remained active for over 70 seconds, delivered frames after 55 seconds and closed without error on client cancellation. The 750-second planned rotation is verified with injected-deadline HTTP tests; a full hosted 750-second wait is not claimed. [Live stream evidence](../review/production-stream-check.json). |
| Two account-profile HTTP 503 responses | Both were direct checks at 04:01:02 and 04:01:31 UTC, before the owner allowlist was configured. Code returns 503 when account activation is pending. This cause is corroborated by the deployment configuration and earlier setup checks, rather than a captured response body in CDN logs. Activation and browser sign-in subsequently succeeded. An anonymous profile request now returns the expected 401, and guest sessions remain available. |
| Five session HTTP 404 responses | Older backend deployments did not yet expose the released session route during rollout. Current session checks return HTTP 200; explicit session retry recovers the paper engine. These historical responses are retained in the report. |
| Six browser/crawler asset HTTP 404 responses | Five favicon requests and one `robots.txt` request found missing files. Added small static icons and crawler metadata. Verified all four supplied assets return HTTP 200 with the expected MIME types. Binary icons initially exposed Git LFS pointers in the new source deployment; the final nested attribute override stores actual image bytes, and CI now verifies their signatures. |
| Thirteen other HTTP 404 responses | Requests targeted paths absent from this application, such as `/js/qrcode_twint.js` and `/bot-connect.js`. Their pattern is consistent with automated probing, but requester intent is not established. Unknown paths continue to return 404. |
| One root HTTP 403 response | Vercel recorded WAF action `deny` for this request. Retained as an access-control response, separate from server failures; protection was not disabled to improve the reported success count. |

The status totals are 558 HTTP 200, one 304, one 403, 24 HTTP 404 and two HTTP 503. No HTTP 500, 502 or 504 response was recorded. A stream can return HTTP 200 and fail later, which is why runtime error records and actual stream-body checks were reviewed separately.

## Builds and remaining warnings

Read build logs for all eight deployments created in this window, including previews; all completed successfully. Recurring warnings concern Vercel's npm `cache-dir` environment option and six transitive install-script approval entries. Successful builds and actual pinned model inference are verified separately. No blanket install-script approval, dependency downgrade or warning suppression was applied. Provider-controlled build warnings are not classified as application runtime failures.

The static-asset changes passed local type checking and a production build. Final deployment IDs and CI references are recorded in the [release verification](RELIABILITY_VERIFICATION.md). No private cookies, credentials, visitor addresses or raw provider payloads are published.

## Rechecking

Use project-scoped `vercel logs runtime` and `vercel logs requests` with explicit `--since`, `--until`, `--limit` and `--json`. Follow the response's pagination cursor if `hasMore` is true; preserve reported excluded intervals. Parse each typed line's `data` object, not the wrapper, and inspect both request status and runtime severity. Check deployments and build logs separately. Compare new failures to their owning deployment rather than attributing an old error to current code.
