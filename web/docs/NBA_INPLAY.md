# Experimental live NBA score-clock model

The app can calculate an independent research probability while a verified NBA game is in regulation. This is a functioning paper-research feature, not a simulated live feed: the source must provide the selected event, matching team identities, both scores, a period and a clock. Retrieval age must be at most 30 seconds. A separate five-second shared source cache avoids reusing the ten-minute availability snapshot.

## Conditional mathematics

Let `l` be the observed home lead and `r` the fraction of regulation remaining. A Brownian score-difference approximation gives:

`P(home win | l,r) = Phi((l + mu*r)/(sigma*sqrt(r)))`.

The app sets `mu = sigma*Phi^-1(p0)`, where `p0` is an independent team-strength prior reconstructed from earlier final scores. This makes the model return that prior at zero lead and the start of regulation. The prior excludes games beginning within the eight hours before the selected event, reducing the risk of using outcomes from overlapping games when historical result-publication timestamps are unavailable.

The underlying score-process idea comes from [Stern's 1994 paper](https://www.stat.berkeley.edu/~aldous/157/Papers/stern.pdf). The project's prior reconstruction, empirical scale fit, age checks and parameter sensitivity are explicit implementation choices. Possession, intentional fouling, lineup changes and overtime mechanics are omitted.

## Empirical scale and honest replay

The scale is fitted from **40 games in the earlier calibration partition**, never from the final 514-game test outcomes. Each game supplies actual end-of-quarter 1, 2 and 3 states from its ESPN summary. Both teams' quarter scores must sum to their reported final totals. No missing period is filled with zero.

For calibration state `i`, let `d_i = final_margin_i - lead_i`, `z_i = Phi^-1(p0_i)` and `r_i` be time remaining. Put `A=sum(d_i^2/r_i)`, `B=sum(d_i*z_i)` and `n=120` states. The Gaussian remaining-increment likelihood yields the positive solution:

`sigma = (-B + sqrt(B^2 + 4*n*A))/(2*n)`.

The fitted scale is **13.3579 points**. Two thousand seeded resamples of whole games give an empirical scale sensitivity interval of **11.4684 to 15.1933**. All three quarter states of a game stay together in each resample. The stored calibration error array contains the actual dated normalized margin residuals used for this calculation.

An independent **20 games from the final holdout** provide 60 quarter-end evaluation states. Conditional Brier is **0.139993**, compared with **0.187088** when the independent pregame probability remains frozen. Log loss is **0.396722**, compared with **0.558357**. These results show the value of observed scores in this bounded retrospective replay. They do not establish live-clock calibration or a profitable trading strategy. The validation gate remains failed because the sample and state coverage are insufficient.

The probability sensitivity range varies the independent prior over its parameter interval, the empirical score-process scale over its whole-game bootstrap interval, and possible clock advance since retrieval. It is not a calibrated interval for the true probability of one game. ESPN does not always provide the score update's own timestamp, so retrieval freshness alone cannot establish zero feed delay.

## Availability rules

- Only NBA regulation periods 1 through 4 are supported. Overtime is withheld.
- Scheduled/pre-game, final, mismatched, stale and missing-score states do not produce an in-play estimate.
- The final regulation boundary is withheld when too close relative to retrieval age; an expiring clock is not treated as final settlement.
- Actual zero scores survive parsing. Missing scores, booleans and malformed clocks do not become zero.
- Estimates are labeled experimental, have `eligible=false`, and expose their source time, assumptions and small-sample validation.

## Reproduce

From `web/`, first prepare the frozen NBA data as described in [NBA_RESEARCH.md](NBA_RESEARCH.md), then run:

```sh
node tools/train_nba_inplay.mjs
node --test tests/nba-inplay.test.mjs
```

The default uses the checked-in compressed quarter-replay capture. `node tools/train_nba_inplay.mjs --refresh` refetches the same deterministically selected 60 historical event summaries. [The machine-readable validation card](nba-inplay-validation.json) lists source URLs and hashes, formulas, calibration and test membership, limitations and measured scores. Provider corrections can change a fresh replay.
