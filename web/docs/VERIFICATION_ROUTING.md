# Verification routing and backend startup behavior

## Public verification

The Vercel project root is `web`. Next.js serves `public/google7653305cfae6f81b.html` at `/google7653305cfae6f81b.html`. The file must remain exactly as issued by Google. `next.config.mjs` has no rewrites; its only redirects cover `/dashboard` and `/dashboard/index.html`. There is no `beforeFiles` catch-all to intercept verification files.

The root layout retains the Google-issued homepage meta value `FCoPfWp2NwEtKCMJq_AW6Cx2itHdrAZcG9PkS0PdpFQ`. The standalone `/lab.html` also includes the requested filename-derived value `google7653305cfae6f81b`. These are different values: the latter must not replace the Google-issued homepage token. Adding a tag to `/lab.html` does not establish homepage verification on its own.

All paths already receive `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`, in addition to CSP and HSTS. Keep these protections enabled.

## Backend startup and timeouts

The catch-all API handler delegates to `lib/workspace/proxy.mjs`. A configured backend is authoritative; failures must not silently switch private accounts, journals or writes to a different store. Backend provider choice is driven by `MARKET_BACKEND_URL`, not a Railway/Azure-specific branch.

- Ordinary requests retain a 50-second deadline, including response-body reading. Position reviews retain their shorter 7.6-second maximum.
- Non-streaming responses finish reading before downstream success headers are committed. Network failures and timeouts, including failures after headers arrive, return sanitized JSON with HTTP 503, `status: unavailable`, `Cache-Control: no-store` and `Retry-After: 5`.
- HTML gateway/warmup responses become JSON HTTP 502 with the same retry guidance. Valid backend statuses and `Retry-After` values are preserved.
- Writes are not automatically retried: a timeout does not prove the backend failed to commit a write.
- SSE still has its separate five-second connect deadline and 750-second clean rotation; ordinary JSON buffering does not buffer SSE.

The tests simulate startup stalls before headers and during body delivery using a local HTTP server. These simulations do not establish actual provider cold-start latency. Production Google verification and HTTP accessibility still require an external check; a READY deployment alone is not an HTTP 200 assertion.
