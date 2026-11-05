# Isolated context and risk-math experiments

These functions are implemented in `lib/workspace/quant-context.mjs` and deliberately have no import into the evidence, forecast or sizing pipeline. Every result is experimental, states that it has not been outcome-validated, sets `affects_forecast: false`, and supplies no probability adjustment. Numeric examples below are synthetic mathematical checks, not market backtests or reported trading returns.

## Context smoothing

`kalmanContext` accepts explicitly supplied, dated scores in [-1, 1]. It applies a scalar random-walk Kalman filter with process variance scaled by elapsed hours and a declared observation variance. The implementation uses the Joseph-form covariance update for numerical stability. Duplicate or out-of-order timestamps are rejected. It returns the filtered context score, gain, innovation and model-conditional variance. This follows the linear filtering framework of [Kalman (1960)](https://doi.org/10.1115/1.3662552).

`hmmContext` applies a causal forward filter to three assumed Gaussian-emission regimes: negative, neutral and positive context. Priors, transition probabilities and emission parameters are exposed. It requires regularly spaced observations and normalized transition rows. These are fixed experimental parameters, not trained sentiment labels or market-state probabilities. The forward recursion is described in [Rabiner (1989)](https://web.ece.ucsb.edu/Faculty/Rabiner/ece259/Reprints/tutorial%20on%20hmm%20and%20applications.pdf).

Neither function extracts sentiment from headlines or certifies a source as factual. A smoother can make a false or duplicated signal appear stable. A future experiment needs a dated, deduplicated source archive, annotated observations, a predeclared target and chronological held-out testing. Source identity, engagement and editorial rank must not be silently treated as observation precision.

## Score-margin diffusion

`simulateScoreDiffusion` draws terminal regulation score margins from an assumed Brownian process. Inputs state the current margin, regulation seconds remaining, points-per-minute drift, points-per-square-root-minute volatility, seed and simulation count. It samples the exact Gaussian terminal distribution rather than adding discretization error through small time steps. [Stern (1994)](https://www.stat.berkeley.edu/~aldous/157/Papers/stern.pdf) provides the original sports-score Brownian framework. That paper's historical fit is not evidence that this app's chosen parameters are valid for current NBA games.

The result reports scenario lead/tie frequencies, terminal-margin quantiles and Monte Carlo sampling uncertainty. A regulation lead is a different target from a final game win because overtime exists. Continuous margins also omit possessions, discrete scoring, late-game fouling and clock tactics. The returned interval excludes these model errors; running more simulations does not fix them.

For a **synthetic** case with margin 5, 720 seconds left, drift 0.5 points/minute and volatility 2 points/sqrt(minute), the mathematical terminal mean is 11 and variance is 48. With 100,000 seeded draws the observed mean was 11.0049207151 and variance 48.0366801531. These checks verify sampling mechanics only. The hypothetical lead frequency of 0.9437 is not a real game forecast.

## Conditional martingale bounds

`martingaleDrawdownBounds` requires explicit acknowledgment of a zero-conditional-drift process with deterministic absolute increment bounds `c_i`. Historical P&L cannot establish those assumptions. The exponential-supermartingale method underlying these bounds is reviewed in [Howard et al. (2020)](https://arxiv.org/html/1808.03204v6).

Let `S_0 = 0`, `E[ΔS_i | past] = 0`, `|ΔS_i| <= c_i`, `V = sum(c_i^2)` and threshold `a > 0`. Applying the maximal exponential bound to `-S` yields `P(min_{k<=n} S_k <= -a) <= exp(-a^2/(2V))`. For each possible peak time `j`, apply the same argument to the remaining increments. A union bound gives the implemented peak-to-trough upper bound `min(1, sum_j exp(-a^2/(2 sum_{i>j} c_i^2))))`. A threshold greater than `sum(c_i)` is impossible under the supplied deterministic bounds. The result can be loose or equal to one, which is reported honestly.

An independent exhaustive check enumerates all 256 equally likely paths of an eight-step symmetric +/-1 random walk. At threshold 6, 10 paths cross an initial loss of 6 and 12 paths experience a peak-to-trough drawdown of 6. The bounds are respectively 0.1053992246 and 0.2726474761, above the exact probabilities 10/256 and 12/256. This distinguishes drawdown from initial loss and checks the math on a process satisfying the assumptions.

Fees introduce drift; leverage, gaps or adaptive stakes can violate the supplied increment bounds. These functions do not infer safety from a backtest, guarantee a trading loss limit, or implement the gambling practice of doubling stakes after losses.

## Verification

Run `node --test tests/quant-context.test.mjs`. The six tests check exact Gaussian posterior updates, causal prefix behavior, timestamp constraints, HMM normalization and sign symmetry, seeded diffusion moments/monotonicity, preservation of regulation ties and exhaustive finite-path bound coverage. This is mathematical implementation verification. Promotion to any forecasting role requires a separate empirical protocol and user-reviewed scope.
