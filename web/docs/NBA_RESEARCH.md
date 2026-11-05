# NBA forecast challenger and reproducible training

The challenger is an opt-in research comparison. The existing regularized Bradley-Terry forecast remains the default. The measured composition reduced final-holdout Brier error by **1.554%**, but its whole-week paired confidence interval includes no improvement. It has not passed the predefined promotion gate and does not become an approved trade recommendation.

## Inputs and chronology

The frozen public-data capture contains 2,569 distinct completed NBA regular-season games, normalized from 90 ESPN team/season schedules. The compressed capture is approximately 48 KB at `research-data/nba-completed-games-2026-11-04.json.gz`. It contains source URLs, original retrieval timestamps, source hashes and normalized game facts. It is an archived capture, not a live feed. The input game hash is recorded in [the validation card](nba-challenger-validation.json).

Events are sorted by scheduled timestamps; equal timestamps form one group. Every group's features are calculated before any outcome in that group updates state. Features include a sequential Elo logit, exponentially weighted score margins, Laplace-smoothed last-10 win rates, rest differences, back-to-back flags, season-gap flags and history depth. No Kalshi price or bookmaker probability is an input. Current injury reports and news are excluded because a corresponding point-in-time training archive is not established.

Game start timestamps are not historical result-publication timestamps. Teams normally do not play overlapping games, but delayed games, source corrections and historical availability remain limitations. Replay claims concern the defined score-history protocol, not a historical news/lineup simulator.

## Models and mathematical composition

The candidate set was fixed before inspecting the final test: ridge logistic regression, depth-2 XGBoost and a two-hidden-layer neural classifier with 16 and 8 units. All were actually trained. Scaling uses training data only. XGBoost and logistic regression converged; the neural model reached its iteration limit and was excluded from selection. No GPU, hosted ML endpoint or additional subscription is required.

The first 60% of dated games fit the candidate models. The next 10% select the model and its mixture weight from 0%, 25%, 50%, 75% and 100%. The next 10% fit an identity-regularized monotone beta calibration map. The final 20% are held out from both selection and calibration. Timestamp ties stay on the same side of a boundary.

For the selected model, `q = 0.75 p_BT + 0.25 p_lag`, where `p_BT` is the earlier-game Bradley-Terry fit and `p_lag` is the ridge classifier. The issued probability is `sigmoid(a log(q) - b log(1-q) + c)`. The calibrated coefficients, training cutoff, feature scaler and actual dated calibration residuals are stored in the model artifact. The formula combines established methods; it is a project-specific tested composition, not a claim of a new probability theorem.

The comparison baseline is the existing Bradley-Terry fit on the first 80% of games, frozen over the same final test. Thus the challenger is not being compared with a deliberately weak constant baseline. Lag state can update from earlier completed games during the test; learned coefficients and the beta map remain frozen.

## Measured results and release rule

There are 514 held-out games in 12 UTC-week blocks. Brier decreases from 0.20253365 to 0.19938548; log loss decreases from 0.59358877 to 0.58604464. The paired mean Brier improvement is about 0.0031482. The lower endpoint of 2,000 seeded whole-week bootstrap replicates is -0.0011701. The point estimate is promising, while this sample does not establish a confidently positive improvement. Resampling whole weeks retains within-week dependence, but does not eliminate repeated-team dependence across weeks or seasonal regime changes.

Promotion requires at least 1% lower Brier, non-worse log loss, a positive 95% block-bootstrap lower improvement, at least 100 games, at least 12 weeks and complete source coverage. These rules are preserved after observing the test. Both the point result and the failed gate are exposed in the application rather than hiding the unsuccessful part.

The uncertainty range is derived from dated calibration residuals `y-p`, grouped by UTC week. Nearby probabilities are used when at least 30 observations exist; otherwise all calibration observations are retained. Whole-week bootstrap residual means and constituent disagreement produce a sensitivity range. This range is empirical model-error evidence, not a guaranteed interval for the true probability of one event. Final scores are binary; neither this range nor a favorable retrospective score guarantees a profitable paper position.

## Reproduction and inference

From `web/`, with Node 26.12.1 and Python 3.12:

```sh
npm ci
python -m venv .venv-nba
```

Activate the environment, then run:

```sh
python -m pip install -r tools/nba-ml-requirements.txt
node tools/prepare_nba_training.mjs
python tools/train_nba_challenger.py
node --test tests/nba-challenger.test.mjs
node tools/benchmark_nba_models.mjs
```

The default preparation uses the checked-in frozen capture. To retrieve current public schedules, use `node tools/prepare_nba_training.mjs --refresh`; it writes an ignored local capture. Do not relabel the frozen capture as fresh. A model trained from a changed source capture requires fresh evaluation. The production challenger refuses a changed historical training hash, an incompatible feature schema, or a source capture older than 30 days.

Production inference runs in JavaScript without Python or XGBoost native libraries. Logistic, neural and tree model parity is checked against native Python predictions, including float32 split semantics for XGBoost. The neural artifact remains available for reproducibility, while non-convergence keeps it out of the selected ensemble. [Local inference measurements](nba-inference-benchmark.json) describe their scope and exclude network latency.

## Primary research sources

- Chen and Guestrin, [XGBoost: A Scalable Tree Boosting System](https://arxiv.org/abs/1603.02754): regularized tree boosting and its computational structure.
- Kull, Silva Filho and Flach, [Beta calibration](https://proceedings.mlr.press/v54/kull17a.html): a calibration family containing the identity map. The app adds explicitly stated regularization and monotonicity constraints.
- Guo et al., [On Calibration of Modern Neural Networks](https://proceedings.mlr.press/v70/guo17a.html): accuracy and calibration are separate properties; a deeper model is not automatically a better probability model.
- Gneiting and Raftery, [Strictly Proper Scoring Rules, Prediction, and Estimation](https://sites.stat.washington.edu/people/raftery/Research/PDF/Gneiting2007jasa.pdf): proper-score evaluation of probabilistic predictions.

These papers motivate individual components. They do not validate this project's data capture, model estimates or trading outcomes. Those claims are limited to the reproducible implementation and measurements above.
