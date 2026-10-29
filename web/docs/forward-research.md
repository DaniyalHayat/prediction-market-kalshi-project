# Quant Strategy Lab: prospective forward evaluation

## The performance contract

A final YES/NO probability and a 60-second price forecast are different objects. The former is scored against official resolution; the latter is scored against a future, independently fetched order book. A one-minute price move cannot establish that a monthly inflation probability was correct.

This implementation provides an execution-aware **paper forward test**, not an HRT affiliation, a claim of globally novel techniques, a low-latency trading venue connection, or proof of actual fills. No actual orders are submitted.

### Experiment lifecycle

1. `POST /api/intelligence/forward/start` fixes categories, horizon, quantity, slippage and fee coefficient before future observations.
2. Each category receives the same 1–2-contract quota. Selection uses liquidity and event diversity, not knowledge of future returns.
3. Sources, rules, tape and historical candles are retrieved before a final entry-book request. Prediction/entry timestamps and raw entry depth are archived immediately.
4. All candidates, coefficients, model diagnostics, actions and abstentions are frozen in a hash-chained server-local archive.
5. The browser or Python collector waits until the latest preregistered due time. Early checkpoints return HTTP 409.
6. `POST /api/intelligence/forward/checkpoint` retrieves new books. The original forecasts are not refitted.
7. The result appends once. Concurrent readers receive the same observation, not a later, more favorable snapshot.

Actual holding times are reported per contract. A result beyond the selected horizon plus 30 seconds is labeled late and excluded from horizon-specific scoring, not disguised as an exact 60-second result. Failed requests and incomplete exits remain visible.

## Candidate families

### Purged ridge return forecast

Observed Kalshi minute candles provide returns, trailing momentum, trailing realized volatility, spread and volume. Missing/null candles are not forward-filled.

The model fits the **selected** 60/300/900-second return horizon. It standardizes features and fits ridge coefficients with lambda selected from `1, 10, 100` on an inner chronological validation set. The timeline is split 50/25/25. Every split is purged by actual label timestamp, including overlapping 15-minute targets.

An untouched holdout is compared with no-price-change persistence. Nonpositive holdout skill disables the directional forecast. The final fit uses only historical labels that already existed before the live entry snapshot. A fresh future cohort remains the real out-of-sample test.

At least 120 valid training pairs and a valid trailing feature window are required. An unavailable model stays unavailable; sparse bars are not invented to make it look trained.

### Irregular-time liquidity reversion

For sparse quotes, observed logit-price transitions use their true elapsed seconds. The process is:

`dZ = κ(μ − Z)dt + σdW`, with `P = logistic(Z)`.

The conditional transition is fitted analytically:

`Z(t+Δ) ~ N(exp(−κΔ)Z(t) + (1−exp(−κΔ))μ, σ²(1−exp(−2κΔ))/(2κ))`.

The zero-reversion case is a driftless diffusion. Reversion rates are selected on an inner chronological likelihood holdout, then evaluated on a separate, purged holdout. Poor likelihood improvement falls back to persistence. A deterministic Simpson integral calculates the logistic-normal conditional mean; this numerical integration is not a simulated profitable price history.

At least 80 real transitions are required. Historical next-observation likelihood is explicitly not mislabeled as a one-minute historical P&L backtest. Nonstationarity remains a failure mode.

### Queue / signed-flow pressure

Top-five-level book imbalance, microprice displacement and bounded recent taker-flow imbalance generate a short-horizon pressure hypothesis. These coefficients are preregistered exploratory priors, not a falsely claimed fitted order-flow model. Historical queue snapshots do not exist in the current feed, so a historical queue alpha backtest is not fabricated.

### External-source dislocation

The independent source probability supplies a slow mean-reversion prior. Category-dependent half-lives separate fast crypto from weather and slow economic releases. Failed underlying validation disables this component. A large slow-horizon probability difference is not assumed to become a large one-minute return.

### Shape-constrained relative value

Weighted pool-adjacent-violators projects same-event, same-operator threshold probabilities onto a monotone ladder. Weight is inverse spread variance, with a cap. Missing outcome sets are not normalized to sum to one; exclusivity/exhaustiveness is not guessed.

The correction is an exploratory relative-value signal, not a guaranteed paired-fill arbitrage.

### Robust ensemble

A median of available, predeclared targets reduces reliance on one extreme forecast. It is not a backfitted optimal blend. Unavailable candidates are not silently given fabricated estimates.

### Unfiltered directional control

This intentionally ignores the cost filter to measure fee/spread drag. It is always labeled diagnostic and cannot be promoted to demonstrated alpha.

## Fill and P&L assumptions

Each candidate is an alternative hypothetical portfolio, not simultaneous orders consuming the same liquidity.

- Entry buys YES or NO by sweeping actual complementary asks inside the frozen slippage cap.
- Entry fee is rounded up per consumed price level.
- Exit sells the same side into **bids**, never a midpoint.
- Exit fee is also charged.
- Net paper P&L is `exit proceeds − exit fee − entry cost − entry fee`.
- If the full position cannot be liquidated, complete-trade P&L stays null. Partial realized cash flow and remaining quantity are exposed.
- A cost-filtered candidate enters only if predicted movement covers spread, both estimated fees and a 0.5¢ per-contract buffer.

The assumed general taker formula can differ from a market's actual fee schedule. Displayed depth can vanish before execution. The record is genuine future market data but **not an actual executed fill**.

## Scoring without cherry-picking

- All preregistered candidates are reported, including losses, unavailable models and abstentions.
- Price MSE and persistence MSE use exactly the same available forecast pairs.
- Direction accuracy only scores nontrivial observed moves; it is not a probability calibration or profitability metric.
- Strategy versions and protocol variants are never pooled.
- Repeated contracts in one event do not create extra event groups.
- Confidence intervals resample whole observed event groups rather than inventing price paths.
- Familywise correction covers all registered candidate/protocol families, not only the winner.
- Unobserved pending cohorts, missing/late observations or incomplete exits prevent positive aggregate evidence.
- Fewer than 30 event groups or inadequate bootstrap-tail resolution cannot demonstrate positive evidence.
- Even positive paper evidence is not proof of actual executable profits.

The first live `forward-2.0.0` cohort covered all five categories. The diagnostic control lost $2.25 net under its frozen assumptions; cost-filtered candidates abstained. This cohort is retained, not replaced by a more flattering run. Version 2.1 adds the irregular-time model and horizon-specific purging; those hypotheses require their own prospective cohorts.

## API and storage

```text
GET  /api/intelligence/candles?category=crypto&ticker=...
POST /api/intelligence/forward/start
POST /api/intelligence/forward/checkpoint
GET  /api/intelligence/forward
GET  /api/intelligence/forward?id=...
```

Start example:

```json
{
  "categories": ["crypto", "weather", "labor", "inflation", "travel"],
  "seconds": 60,
  "per_category": 1,
  "contracts": 10,
  "slippage": 2,
  "coefficient": 0.07
}
```

Checkpoint body is `{"id":"<returned cohort ID>"}`.

Upstream reads are deduplicated and paced at at most eight starts per second per server, with provider cooldowns respected. Historical requests align to completed minute boundaries and exclude synthetic prior-price candles.

Hash-chained files are bounded and local to the server instance. They are not a shared production database or an independently trusted timestamp service. Deployments or another server instance may not retain them. Export the full audit or use the collector for durable local records.

The four genuinely observed implementation-validation runs are also retained under `public/dashboard/evidence/` with a small index, file hashes and replayable audit headers. The interface labels them **archived validation evidence**, not live runs or actual fills. Losses are retained. They are never automatically added again to live aggregate statistics.

An exported record with audit headers can be independently checked for internal consistency:

```sh
node tools/verify_forward_audit.mjs path/to/observed-cohort.json
```

This rebuilds the original freeze/result hash chain without a server or any API key. It does not transform the archive into an exchange-signed fill or a trusted external timestamp.

## Durable free collector

After installing `tools/research-requirements.txt`:

```sh
python tools/forward_collector.py \
  --base-url http://localhost:3000 \
  --cohorts 3 --seconds 60 --per-category 1 --contracts 10
```

The collector writes its fixed stopping rule before any result, archives the original response exclusively, waits for actual future data, verifies unchanged forecasts and the original hash anchor, and independently checks entry/exit accounting. It does not stop or retune when a cohort wins or loses.

Output under ignored `.research/`:

- `forward-plan-*.json`: preregistered count, protocol and stopping rule.
- `forward/<id>/frozen.json`: original locked forecast and source data.
- `forward/<id>/observed.json`: the actual later books and outcomes.
- DuckDB `forward_cohorts`, `forward_forecasts`, `forward_markouts`, and `mart_forward_performance`.
- Parquet exports of those records.

The worker needs no private key and reads no account data: it calls the app's constrained paper-research endpoints. It must actually be running for unattended observation; an always-on hosted worker has not been provisioned.
