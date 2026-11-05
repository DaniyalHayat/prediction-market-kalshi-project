# NFL matchup forecast

Predictir verifies the team named in the exact NFL game-winner contract against the exchange ticker, title, YES label, settlement rules and original date. ESPN's date scoreboard must identify the same two franchises and confirm a scheduled kickoff. The matched fixture carries the official NFL game-center link and ESPN team identifiers.

The Arizona example is `KXNFLGAME-26NOV08ARISEA-ARI`. Arizona visits Seattle on November 8, 2026 at 21:25 UTC. The exchange pays $1 when Arizona wins, $0 when Seattle wins, and $0.50 on a tie. The model's expected YES payout is win probability plus half the tie probability. The postponed-game and fair-price paths are outside this estimate. [Exchange contract](https://api.elections.kalshi.com/trade-api/v2/markets/KXNFLGAME-26NOV08ARISEA-ARI) · [NFL game center](https://www.nfl.com/games/cardinals-at-seahawks-2026-reg-9)

## Data and method

The bundled archive contains 937 completed regular-season games. The 2023, 2024 and 2025 seasons each have 272 distinct games and 17 appearances per team. The archive adds 121 completed 2026 games at the capture date. Four public ESPN calendar-year scoreboards provide the results. The manifest retains retrieval timestamps and response hashes.

The fit uses the existing regularized team-win likelihood with a 365-day recency half-life and a home advantage that is disabled at neutral sites. It estimates the winner conditional on a decisive result. A separately smoothed historical tie frequency supplies the third outcome. The displayed range combines team-strength parameter sensitivity with the historical tie-frequency interval. It does not incorporate roster news, injury adjustments, bookmaker odds or the exchange price.

At runtime, one cached date scoreboard establishes the fixture and one cached annual scoreboard refreshes completed results. The annual refresh has a six-hour cache and an 8 MB cap. The date lookup has a 15-minute cache and a 1.5 MB cap. When the calendar year advances beyond the archive, a second annual lookup covers the calendar boundary. A failed or incomplete refresh leaves the last verified historical estimate with partial coverage. A started, finished or unidentified game has no new pregame estimate.

## Replay

Run `node tools/freeze_nfl_results.mjs` from `web` to regenerate the evaluation and the 2025 held-out prediction rows from the local archive. `--fetch` refreshes four public scoreboards and replaces the archive after the coverage checks pass.

The same frozen method and league-outcome baseline replay all 272 games of the 2025 season. Each prediction fits only games scheduled at least 36 hours earlier. Earlier games in the replay season enter later fits after that gap. The archive records kickoff and final scores, so the gap is a conservative availability proxy for historical final-publication time. The baseline estimates home, away and tie frequencies from earlier games and uses a symmetric decisive baseline on neutral sites.

| Metric | Team-strength model | Earlier-game baseline |
| --- | ---: | ---: |
| Three-outcome Brier score | 0.154636 | 0.167288 |
| Log loss | 0.677561 | 0.717481 |
| Expected payout MSE | 0.229198 | 0.248152 |

The paired mean Brier gain is 0.012652. The seeded 95% interval from resampling whole NFL weeks runs from 0.006465 to 0.018446. All 272 fixtures map and 18 weekly blocks are scored. One tie occurred in the replay, which limits direct tie calibration. The measured result concerns historical outcomes and payoffs before execution costs. The binary recommendation gate remains withheld for this three-outcome settlement.

The verified Arizona fixture returned a 31.50% Arizona win estimate, 68.24% Seattle win estimate and 0.27% tie probability on November 5, 2026. Expected Arizona YES settlement was $0.3163, with a parameter and tie-frequency sensitivity range of $0.1682 to $0.5133. Current quarterback changes belong in the separate news and availability evidence.
