# Implementation verification

This records the verification completed on November 4, 2026 before the initial production release. See the separate [production reliability verification](RELIABILITY_VERIFICATION.md) for the rollout and subsequent checks.

## Project presentation

GitHub About and the README describe Predictir as prediction market research and simulated trading. The README links to the public app and summarizes its architecture. The presentation update reached main in `c2aea8ae2130ac44aa7c0dc0804796730e420b90` while the application build was held for review.

## Database correctness

All three primary keys were verified against the live catalog using read-only catalog/statistics queries. No production writes, index creation, schema migration, grants, vacuum, truncation or destructive maintenance was performed. The suggested quota-overrun defect did not apply to the actual validated `limit-amount` binding.

Implemented duplicate record-write suppression, database-authoritative quota admission, post-lock lease deadlines, stale-producer fencing, atomic X-cursor publication and safe recovery from local refresh contention or temporary X budget denial. Existing sliding expiry and immutable journal rules were preserved. An additional `(pk)` index was not justified by measured read/write/storage tradeoffs. Both positive and negative A/B results remain in the report.

Database verification passed 302 tests with zero failures and two opt-in embedding and vector tests skipped. Type checking passed. PostgreSQL integration tests used a disposable local `query_runtime_test` database. The experiment used a separate local `query_optimization_test` database, and its benchmark schemas were removed after verification.

## Execution model and research tools

The selected-contract interface now has a fifth tab, Execution lab. The existing MCP server already had five tools; `analyze_execution_lab` is the sixth. The assistant receives the same validated controls and selected forecast model, scoped to the exact ticker. A standard explanation can read back deterministic tool figures without a language-model generation charge. Other assistant questions retain bounded tool calls and existing allowance controls.

The model composes observed order-flow imbalance and a chronological next-quote challenger, exponential Hawkes quote-arrival likelihood, inventory-sensitive quote scenarios, a discrete tridiagonal execution optimizer and finite hold-versus-exit utility. Switches affect these calculations. They do not rewrite the independent settlement probability. The quote challenger and arrival model can remain unapplied when their local gates fail; unavailable features are not replaced with invented data.

The native feed retains a bounded, per-contract circular history of validated best queues before browser throttling. It explicitly requests non-conflated updates, checks exchange subscription sequence continuity, and resets the research generation on snapshots, gaps, disconnects or a one-sided book. The lab captures book and event history together. Unaligned or stale data cannot adjust another book. The arrival model decays through observed silence only when the connection establishes that observation window. Quote updates are not mislabeled as trades or news.

Independent review found and resolved book/window mismatch, a Hawkes training cutoff that depended on the first holdout timestamp, missing idle-time decay, a derived-volatility boundary failure, dimensional labels and unverified fee assumptions. Dedicated counterexamples verify the fixes. Unknown fee metadata retains an explicit default scenario and withholds a released exit decision. Fill estimates retain the same two-cent slippage convention and per-level cent rounding as existing paper execution.

## Evidence, limits and reproduction

The final combined suite passed **331 tests, zero failures**, including actual local PostgreSQL integration and 13 TypeScript tests. Two opt-in tests for the pinned embedding model and native vector/RLS path were intentionally skipped in this combined run; their earlier separate checks remain documented in V3 verification. The production build and type checking passed. No pre-commit configuration exists.

The research runner records 32 synthetic category/side/action cases, five numerical toggle ablations, five planted-signal controls and five independent-noise controls. Separate stock experiments use three sets of 10,000 paired liquidation paths, including jump stress and a historical IBM daily-volatility scale. They measure conditional execution cost and variance, not stock or Kalshi strategy profitability. Short holdouts, repeated rolling tests, assumed impact parameters and the daily-to-intraday conversion are documented rather than hidden.

The source ledger tracks all 97 requested domain/title entries: 78 exact targets opened, six resolved targets blocked and 13 unresolved or ambiguous. Reading scopes distinguish abstracts, selected sections and metadata checks. Twenty additional primary papers/documents were checked; three existing project references are disclosed, leaving 17 canonical URLs new to the scanned documentation. A failed open does not receive a successful-read checkbox.

The source ledger addresses inventory-price intuition, GLFT signs and solution methods, OFI data requirements, stock and binary modeling assumptions, DeepLOB training and inference, cache lines, kernel isolation, and the distinction between LMSR and an order book. The experiments measure the implemented numerical models and data paths.

The UI was exercised with an actual public Golden State contract and current REST book. At the observed snapshot, 20 YES contracts required $13.52 including $0.32 modeled fees. Raising the supplied risk preference changed the first target slice from about 1.715 to 11.111 contracts and reduced assumed timing variance while increasing expected execution cost. Disabling the model restored equal 1.667-contract slices and the same independent P(YES), about 57.3%. These are dated UI observations, not expected future prices or returns. No native streaming key was configured in the local preview, so live fitted features correctly displayed missing continuous history. The native-window integration was verified with deterministic stream fixtures and independent counterexamples.

The new tab supports numeric controls, keyboard tab navigation, bounded inputs, stale-result labeling, cancellation, ticker/model changes and JSON export. The connected browser-to-backend-to-MCP explanation reproduced the current 20-contract costs and controls without a language-model generation. The browser's export produced a parseable scenario JSON file with its dated observations and assumptions. All eight category adapters render in tests. Desktop browser review and responsive CSS checks do not establish a native mobile-device visual test; no such result is claimed.

Run the documented tests from `web/` and use `node tools/validate_execution_research.mjs` for the seeded experiments. The PDF builder uses pinned ReportLab dependencies. Report inputs include public source observations, local benchmark results, and synthetic fixtures.
