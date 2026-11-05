# Quantitative scenarios and validation

`evaluateQuantScenario` assembles the context filters, score diffusion and stopping policy for the research view. Each calculation keeps its own inputs, units and evidence. The response marks scenario outputs experimental and sets `affects_forecast: false`. An observed score archive supports the NBA replay. Seeded fixtures support the context and stopping checks.

## Context smoothing

`kalmanContext` accepts explicitly supplied, dated scores in [-1, 1]. It applies a scalar random-walk Kalman filter with process variance scaled by elapsed hours and a declared observation variance. The implementation uses the Joseph-form covariance update for numerical stability. Duplicate or out-of-order timestamps are rejected. It returns the filtered context score, gain, innovation and model-conditional variance. This follows the linear filtering framework of [Kalman (1960)](https://doi.org/10.1115/1.3662552).

`hmmContext` applies a causal forward filter to three assumed Gaussian-emission regimes: negative, neutral and positive context. Priors, transition probabilities and emission parameters are exposed. It requires regularly spaced observations and normalized transition rows. These are fixed experimental parameters, not trained sentiment labels or market-state probabilities. The forward recursion is described in [Rabiner (1989)](https://web.ece.ucsb.edu/Faculty/Rabiner/ece259/Reprints/tutorial%20on%20hmm%20and%20applications.pdf).

The scenario accepts timestamped numeric scores with explicit provenance. When both filters are selected, it averages their causal estimates on the same input. The equal blend is fixed in advance. Empirical context evaluation requires a dated, deduplicated archive, annotated observations and a predeclared target.

## Score-margin diffusion

`simulateScoreDiffusion` draws terminal regulation score margins from an assumed Brownian process. Inputs state the current margin, regulation seconds remaining, points-per-minute drift, points-per-square-root-minute volatility, seed and simulation count. It samples the exact Gaussian terminal distribution rather than adding discretization error through small time steps. [Stern (1994)](https://www.stat.berkeley.edu/~aldous/157/Papers/stern.pdf) provides the original sports-score Brownian framework. That paper's historical fit is not evidence that this app's chosen parameters are valid for current NBA games.

The result reports scenario lead/tie frequencies, terminal-margin quantiles and Monte Carlo sampling uncertainty. A regulation lead is a different target from a final game win because overtime exists. Continuous margins also omit possessions, discrete scoring, late-game fouling and clock tactics. The returned interval excludes these model errors; running more simulations does not fix them.

For a **synthetic** case with margin 5, 720 seconds left, drift 0.5 points/minute and volatility 2 points/sqrt(minute), the mathematical terminal mean is 11 and variance is 48. With 100,000 seeded draws the observed mean was 11.0049207151 and variance 48.0366801531. These checks verify sampling mechanics only. The hypothetical lead frequency of 0.9437 is not a real game forecast.

## Conditional martingale bounds

`martingaleDrawdownBounds` requires explicit acknowledgment of a zero-conditional-drift process with deterministic absolute increment bounds `c_i`. Historical P&L cannot establish those assumptions. The exponential-supermartingale method underlying these bounds is reviewed in [Howard et al. (2020)](https://arxiv.org/html/1808.03204v6).

Let `S_0 = 0`, `E[ΔS_i | past] = 0`, `|ΔS_i| <= c_i`, `V = sum(c_i^2)` and threshold `a > 0`. Applying the maximal exponential bound to `-S` yields `P(min_{k<=n} S_k <= -a) <= exp(-a^2/(2V))`. For each possible peak time `j`, apply the same argument to the remaining increments. A union bound gives the implemented peak-to-trough upper bound `min(1, sum_j exp(-a^2/(2 sum_{i>j} c_i^2))))`. A threshold greater than `sum(c_i)` is impossible under the supplied deterministic bounds. The result can be loose or equal to one, which is reported honestly.

An independent exhaustive check enumerates all 256 equally likely paths of an eight-step symmetric +/-1 random walk. At threshold 6, 10 paths cross an initial loss of 6 and 12 paths experience a peak-to-trough drawdown of 6. The bounds are respectively 0.1053992246 and 0.2316125799, above the exact probabilities 10/256 and 12/256. The suffix sum includes only suffixes with enough deterministic magnitude to reach the threshold.

## Finite stopping policy

`optionalStoppingScenario` values a hypothetical position in a bounded fair-value lattice. At each interior node, the up weight is chosen to make the conditional mean of the next mark equal to the current mark. Boundary nodes settle at the binary payoff. At the final step, settlement pays one dollar with the terminal node's supplied probability.

Backward induction compares immediate net proceeds with the certainty equivalent of continuation. It uses exponential utility with a risk-neutral limit and values the next states using their transition weights. Future liquidation uses an explicitly supplied per-contract cost. A supplied current net exit quote applies only at the first node. An explicit null disables immediate exit. Forward propagation calculates the expected gross stopped mark, net proceeds, variance and exit probabilities. The finite martingale identity applies to the gross stopped mark. [MIT notes on martingales and stopping times](https://math.mit.edu/~sheffield/600/Lecture35.pdf)

In the path-dependent fixture with a 0.25 starting probability, 20 contracts and a three-cent exit cost, the policy continues initially and exits early on half the paths. Expected gross stopped value is $5.00. Net expected proceeds are $4.70, compared with $5.00 from holding. The certainty equivalent rises from $4.466 to $4.534 at the specified risk preference. In the risk-neutral fixture the policy holds and pays no assumed exit costs.

## Verification

Run `node --test tests/quant-context.test.mjs tests/quant-scenario.test.mjs tests/nba-inplay.test.mjs` from `web`. The tests cover exact filtering updates, causal prefixes, input gates, seeded diffusion, regulation ties, finite-path drawdown bounds and a brute-force stopping oracle.

Run `node tools/validate_quant_scenarios.mjs` to reproduce `public/research/quant-scenario-validation.json` from local inputs. The report contains all 16 toggle combinations, the cumulative stages and separate validation for each quantity.

| Experiment | Baseline and outcomes | Evidence |
| --- | --- | --- |
| Context smoothing | Persistent regimes yield MSE 0.1090 raw, 0.0556 HMM, 0.0734 Kalman and 0.0601 blended. The blend trails raw scores under rapid reversals. A zero reference wins when inputs and latent targets are independent. | Eight fixed seeds per scenario, with 120 warmup and 240 evaluation points per run. The persistent regimes plant the type of dependence the HMM is designed to recover. |
| NBA score-clock replay | Regulation-lead Brier scores are 0.1920 for the pregame reference, 0.1635 for analytic Brownian and 0.1644 for seeded Monte Carlo. The game-cluster 95% interval for the analytic gain spans −0.0507 to 0.0996. | Forty earlier calibration games and twenty later held-out games. The runner verifies all sixty pregame priors against earlier archived results. It uses scores through the fourth period as its target and retains the tied regulation game. |
| Optional stopping | Exact lattice values and 12,000 new seeded paths per case compare the policy with holding. The risk-averse policy can improve certainty equivalent while incurring exit costs and reducing mean cash. | Four assumed-price cases with common paths across the two decisions. Future displayed bids and fills remain unobserved in this experiment. |

The NBA game-cluster interval describes a small retrospective sample and repeated-team dependence can persist. The held-out target is regulation lead. The fixed pregame reference originally estimates final game win, which can diverge in overtime. Monte Carlo samples the same continuous model as the analytic calculation. The separate prospective paper test in `forward-research.md` covers observed future books and fee-aware hypothetical executions.
