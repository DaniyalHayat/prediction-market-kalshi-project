# V3 local verification and release boundary

Status: final-local-review

This report describes the local review branch. The V3 application has not been deployed. Earlier published-release checks are retained separately and do not certify V3 production behavior.

## Completed checks

- Forty-three focused UI/account tests passed, covering cash conservation, legacy $20,000 migration, guest expiry, owner-safe expired guest-cache removal, cross-tab identity changes, stale session responses, owner synchronization conflicts and analytics allowlists. TypeScript checks passed after those fixes.
- The final aggregate run passed **286 tests**: **276 Node tests plus 10 TypeScript tests**, with **zero failures and two intentional default opt-in skips**. TypeScript checks and the production build passed with both public GTM/GA IDs configured. Six live opt-in checks passed separately; those runs are reported separately rather than added to the aggregate as unique tests.
- Actual MiniLM CPU inference and disposable PostgreSQL 17 checks passed for native pgvector/FTS/RRF, numeric-array cosine fallback, ticker isolation and RLS. A Linux read-only-root, non-root Docker run downloaded the pinned q8 model and produced real 384-dimensional embeddings. Exact captures and scope are in the semantic verification record.
- Backend account tests exercise canonical financial replay, owner isolation, concurrent revision conflicts, cookie tampering, CSRF rejection, token refresh and logout. Truncated first uploads are rejected explicitly while the browser copy is retained. Transient Auth failures preserve owner cookies and return an unavailable response rather than switching the user to a guest.
- Local desktop development-browser review observed the neutral black workspace, changing contract titles with old quotes cleared, explicit news loading, real retained-evidence search responses and cash additions/decreases of $100 reconciling to the starting $20,000.
- A clean navigation then recorded one **PHI YES** paper contract for **$0.93 including modeled fees**, closed it against fresh bids for **$0.90 net proceeds**, and produced **-$0.03 incremental realized paper P/L** with **zero open quantity**. The exact contract was KXNBAGAME-26NOV04PHIDET-PHI. Existing simulated history was preserved. This is a bookkeeping/execution-path check, not a return backtest or a real exchange order.
- Mobile layouts have CSS and logic checks. A dependable phone-sized browser viewport could not be established in the available visual tools; no claim of complete phone visual testing is made.

## Google configuration saved separately

GTM container GTM-5635HXLP version 2, Public workspace measurement, was published and checked in the Google interface. Its public script returned HTTP 200. Both tags require analytics_storage consent, and the app retains a single-loader path with privacy-safe explicit events.

Four custom dimensions were verified again in a fresh Google interface tab. The ten-card Reports snapshot persisted after reload. paper_entry is a once-per-session key event with no default monetary value. Automatic forms/history/user-provided-data collection and advertising features are disabled in the reviewed configuration.

The property cards remain empty/zero and the new application loader remains held with the application release. Configuration persistence is verified; actual consented production visitor collection and recruiter identity are not established.

## Remaining release boundary

A local production-server launch was rejected by automatic review with the generic message "blocked by policy" and no detailed reason. That launch was not retried. The production build passed; actual browser checks use the already authorized loopback development preview. Production-preview browser verification is not claimed.

No new Vercel/Railway application deployment, Supabase production migration, real account activation, AWS resource creation, self-hosted cutover or advertising optimizer is implied by the completed local checks.

Guest expiry is enforced while the app can execute and on the next active visit. A closed browser cannot run physical deletion at the six-hour wall-clock instant. Cleanup preserves active owner records.
