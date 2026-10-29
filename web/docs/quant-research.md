# Independent signal lab: model cards and operating guide

## What is implemented

This is a free, read-only numerical research system inside the Kalshi dashboard, not an autonomous trader. The focus is independent source analysis, explicitly modeled uncertainty, settlement mapping, cost-aware comparisons and falsifiable prediction records. No paid data account, cloud provisioning, generic web-search sentiment, LLM-generated odds, Spark cluster or training-data fabrication is involved.

The five universes were chosen for available free numerical observations, repeated measurable outcomes and a defensible source-to-contract mapping. They are **not** claimed to be the five most profitable categories. Their current research ranking is calculated from evidence tier first, then adverse-bound cost gap. A failed holdout cannot outrank better evidence just by disagreeing dramatically with the market.

### Using the interface

1. Let the initial five-category scan finish. Requests run with bounded concurrency and deduplicate/cached source fetches.
2. Inspect the category cards. Underlying forecast skill and interval coverage are shown separately; none is a trading win rate.
3. Filter the model-vs-market table. Uncheck **Modeled only** to see withholding reasons.
4. Click a contract to retrieve its full current rules, fresh order book and bounded recent trades.
5. Review the independent forecast, sample count, assumptions, uncertainty and source timestamps; then review costs and partial fills.
6. **Send model probability to sizing** explicitly copies it into the original workbench as an unvalidated assumption. It does not submit an order.
7. **Record paper hypothesis** stores a timestamped, unexecuted depth-based scenario in this browser only. Check official resolutions later and compare forecast scores with the recorded market midpoint.
8. Export research, raw observations, thesis or journal records. Browser records are lost if browser data is cleared.

## Measurement and mathematical conventions

Published integer weather values use half-degree continuity corrections. Single-decimal CPI/U-3 releases use 0.05 percentage-point corrections:

- Published rate `> 0.3%`: continuous latent rate at least `0.35%`.
- Published rate `>= 0.3%`: continuous latent rate at least `0.25%`.
- Published maximum `75–76°F`: continuous latent maximum in `[74.5, 76.5)`.

Contract date is decoded from the event ticker, not inferred from the release/settlement date. Unsupported functional/custom strikes, missing thresholds, unconfirmed source definitions, expired trading windows, stale observations and unsupported horizons withhold the probability. Missing observations and missing months are not interpolated.

### TSA travel

- **Source:** TSA's public nationwide checkpoint passenger-volume page.
- **Contracts:** explicitly mapped daily `KXTSAD` markets. Weekly/custom `KXTSA` contracts are not silently treated as daily observations.
- **Horizon:** next 1–7 observation days after the last published count.
- **Candidates:** last same weekday; weighted mean of the last four same weekdays; a robust four-week trend estimate using median pairwise slopes.
- **Ensemble:** inverse training-MSE weights, with a small variance-based regularizer.
- **Distribution:** empirical prediction residuals from a separate calibration partition. Event probabilities use Jeffreys-smoothed empirical frequencies.
- **Uncertainty:** a Wilson sampling interval with effective sample size reduced by a factor of seven. It does not cover all regime, holiday, revision or model-selection risk.
- **Important failure mode:** holidays, disruptions and seasonal changes can break the weekday pattern. Current TSA history is not an archive of original first-publication values.

### US inflation

- **Source:** seasonally adjusted CPIAUCSL from BLS, distributed by FRED's public CSV.
- **Transform:** month-over-month percent change only for consecutive observed months; a missing level makes the associated change unavailable.
- **Contracts:** mapped `KXCPI` monthly, single-decimal changes. Year-over-year/NSA/custom contracts are not substituted.
- **Horizon:** the next unreleased observation month only.
- **Candidates:** persistence, a half-strength rolling change estimate, and ridge-regularized AR(1) changes.
- **Distribution/validation:** separate fit/calibration/holdout partitions as below.
- **Important failure mode:** this is a time-series baseline, not an economic nowcast incorporating all current components, commodity prices or policy changes. Revised historical observations do not reproduce information available at the original release. An apparent huge edge can be evidence that the model is wrong.

### US unemployment

- **Source:** seasonally adjusted UNRATE from BLS via FRED.
- **Contracts:** mapped numerical `KXU3` releases.
- **Horizon/candidates:** next month; persistence, shrunken local change and ridge AR(1) changes.
- **Important failure mode:** structural labor-market shifts and revisions. A small reduction in underlying RMSE does not establish better binary-contract probabilities.

### Daily temperature

- **Source:** NWS hourly forecasts and provisional matching-station observations.
- **Mapped sites:** Central Park/KNYC (CLINYC), Chicago Midway/KMDW (CLIMDW), Miami/KMIA. Mapping must be explicitly supported by the rule text.
- **Horizon:** today through five days ahead. Today requires recent observed data after the early morning so the daily maximum is not inferred solely from remaining forecast hours.
- **Model:** maximum of the observed maximum and remaining hourly forecasts; assumed forecast-error standard deviation `2.5 + 0.6 × days ahead` °F.
- **Stress grid:** sigma × 0.7, 1.0 and 1.5; location ±1°F.
- **Important failure mode:** the forecast is a grid proxy. The Weather Company / specified final climate report can differ from NWS provisional measurements. The sigma is a visible assumption, **not a fitted or calibrated NWS forecast-error distribution**. No archived forecast backtest is claimed.

### Bitcoin and Ether

- **Source:** Coinbase spot plus completed hourly candles. Incomplete candles and missing-hour return pairs are excluded.
- **Contracts:** mapped terminal-price `KXBTC`/`KXETH` ranges/thresholds, not touch/barrier contracts.
- **Horizon:** trading close up to 72 hours; exact measurement window still needs rule review.
- **Model:** hourly log returns; EWMA variance with lambda 0.94; drift shrunk to 5% of the sample mean; a log-price distribution scaled by square-root horizon.
- **Stress grid:** volatility × 0.75, 1.0 and 1.5, drift estimation uncertainty, and ±10bp exchange/index basis.
- **Important failure mode:** Coinbase is not CF Benchmarks' settlement index, and the contract may average a measurement window. Lognormal tails, stable variance, the basis stress and the horizon mapping are assumptions, not demonstrated forecast accuracy.

## Fit, calibration, holdout and evidence gates

At most the last 240 valid chronological forecast origins are evaluated. The first 50% fit ensemble weights; the next 25% fit the residual distribution; the final 25% are untouched by either fit.

Displayed metrics are underlying-value MAE, RMSE, naive-baseline RMSE, `1 − RMSE_model / RMSE_baseline`, and observed coverage of an intended 80% value interval. This is **not** a revision-safe first-release backtest, binary-contract probability calibration, historical execution simulation, or evidence of profitable trading.

- Negative/no RMSE skill: **underperforms naive baseline**.
- Observed coverage below 70% for an 80% interval: **prediction interval undercoverage**.
- At least 30 held-out observations, positive skill, and acceptable coverage: **underlying-value holdout only**.
- Weather/crypto without an appropriate held-out error archive: **uncalibrated proxy / sensitivity only**.

Failed underlying holdouts cannot become screened candidates and have Kelly sizing disabled. Even the strongest tier has not demonstrated contract-level alpha.

## Comparison, execution and risk

The broad scan compares each side against catalog quotes, using a 100-contract assumed fee calculation:

`fee = ceil_to_cent(0.07 × contracts × P × (1 − P))`

`estimated edge = model side probability − ask − estimated fee per contract`

`stress gap = adverse model probability bound − ask − estimated fee per contract − 0.02`

This is not an executable quote. On inspection the system retrieves a fresh fixed-point book, aggregates duplicate levels, honors the slippage cap and calculates VWAP, per-level upward-rounded fees, partial fill and all-in breakeven on the filled portion only.

Hypothetical quarter-Kelly is `0.25 × max(0, (p_adverse − cost) / (1 − cost))`, limited by the user loss budget and eligible visible depth. Failed underlying validation disables it. Costs and size are estimates, no order is submitted, correlated portfolio positions are not modeled, and actual fee schedules can differ.

Top-three-level order-book imbalance, microprice and most-recent-page taker-flow imbalance are descriptive diagnostics—not independent fair-probability models.

Nested-threshold consistency checks only compare compatible threshold operators inside the same event. They report a catalog-only paired-YES/NO price inconsistency after an approximate fee, never guaranteed executable arbitrage. Completeness/exhaustiveness and simultaneous fills are not assumed.

## Provenance, freshness and source failures

Every source includes the actual URL, retrieval timestamp, observation dates, row count, unit and SHA-256. Sources use allowlisted HTTPS hosts, bounded response sizes, request timeouts, caching and failure cooldowns; credentials are never attached to external source requests.

- TSA: 30-minute source cache; stop modeling when observations are more than five days old.
- FRED: six-hour cache; stop when reference observations are more than 75 days old or the target is beyond the next month.
- NWS: 10-minute forecast cache and five-minute station-observation cache; reject forecasts older than six hours.
- Coinbase: 30-second spot/60-second candle caches; reject stale spot/candles.
- Research catalog comparisons: 90-second quote freshness gate in the UI.
- Full inspection: fresh market/book requests, with a 90-second UI expiry.

In this environment FRED's Node/Python HTTP clients can fail with HTTP 520 while its public CSV remains reachable with curl. The genuine checked-in retrieval at `lib/intelligence/data/fred-snapshot.json` is a transparent fallback with its original hash/timestamp and a prominent **archived snapshot** label. No generated, interpolated or falsely re-timestamped observations are substituted. Refresh it without an API key (the Python CLI uses curl if the origin returns 520; it never changes clients to bypass a 429):

```sh
python tools/research_pipeline.py refresh-fred
```

Research market scans are intentionally bounded to one page of at most 200 open markets per configured series; truncation is exposed. Quote/source caches and request de-duplication are per-process, not a shared distributed data service.

## Free Python ETL, warehouse and calibration tooling

The live web app remains a Node/Next.js deployment. The optional local Python pipeline provides durable research collection **on the machine where it is run**; it is not an automatically provisioned background worker or cross-instance application database.

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r tools/research-requirements.txt

# Read real snapshots through the app; no private keys enter the pipeline.
python tools/research_pipeline.py ingest --base-url http://localhost:3000

# Resolve up to 10 expired contracts already in the warehouse.
python tools/research_pipeline.py resolve --limit 10

# Refuses to fit without 100 distinct resolved markets / 50 events.
python tools/research_pipeline.py train

python -m unittest discover -s tests -p 'test_pipeline.py' -v
```

Default output `.research/` is ignored by Git:

- `bronze/{category}/{run}.json`: immutable source/report snapshots.
- `research.duckdb`: source snapshots, market dimension, quote/prediction facts, official resolutions, and ETL run-quality logs.
- `silver/*.parquet`: columnar exports for DuckDB, Pandas/Polars, Trino/Athena or later PySpark use.
- `quality.json`: invalid probabilities, duplicates, missing feeds, archived-source counts and coverage are surfaced, not hidden.
- `calibration-report.json`: honest insufficient-data state or an evaluated logistic-stacking model, not a fictional trained predictor.

The evaluation mart keeps one earliest pre-close prediction per market and only quotes/source data available at that timestamp. Actual archival time must also precede the immutable close recorded with that forecast: late imports and later edits to the market dimension cannot manufacture a pre-close track record. Older warehouse rows without archival-time provenance are excluded rather than backfilled. Logistic stacking is Python/scikit-learn with regularization. Features are independent-model logit, recorded market logit, spread, probability-band width, volume and time to close. The last chronological 25% are held out; sibling events are excluded from the training side of the split. Event-level bootstrap intervals evaluate Brier improvement against the recorded market benchmark. Model weights are serialized as inspectable JSON; no untrusted pickle loading or automatic live-model promotion occurs.

Collected data must accumulate genuine future resolutions. No training record is backfilled with information learned after its prediction timestamp. Browser journal Brier scores also remain descriptive until enough independent event outcomes exist; no synthetic profitable track record is supplied.

## Operations and deliberate exclusions

Run `npm test` for Node calculation/parser/signature tests. Run the Python command above for ETL idempotency, point-in-time training eligibility, event-separated fitting and insufficient-sample gates. Production publishing still uses the existing Next.js adapter.

No automatic orders, account balances/positions, cloud costs, paid odds APIs, IAM changes, persistent hosted workers, distributed Spark/EMR deployment or exaggerated performance claims were introduced. Those do not improve the present numerical research problem enough to justify their complexity or cost. The Parquet/DuckDB boundaries allow later scale without pretending a distributed pipeline is already deployed.
