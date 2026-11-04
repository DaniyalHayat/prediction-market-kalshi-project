# Kalshi Market Lab · web runtime

The current [Kalshi Market Lab](https://predictir.dev) uses the React workspace in `ui/`, public-data adapters and models in `lib/`, Vercel API routes in `app/api/`, a Railway stream/ingestion server in `cloud/`, and Supabase migrations in `database/`. The earlier standalone dashboard remains in `public/dashboard/`.

[Current deployment, security and reproduction](docs/DEPLOYMENT.md) · [Ranked integration choices](docs/INTEGRATIONS.md) · [Measured sports evaluation](docs/sports-validation.json). The sections below also describe the earlier standalone workbench and its optional research endpoints.

[Project overview](../README.md) · [Security and data handling](../docs/SECURITY.md) · [Legacy AWS runtime](docs/cloud-runtime.md) · [Figma frontend](https://www.figma.com/make/OvkxXfcBywSxzKo1oANMZj)

The [public AWS app](https://xgcpzl73zl4yxyr0.s28.lambda-web.us-east-2.on.aws/) serves this dashboard and its new native-streaming/private-journal workbench. Source import does not establish Figma preview or publication readiness.

## Run locally

From this directory, using the production-tested Node.js 26.12.1 runtime:

```sh
npm ci
npm run dev -- --port 8768
```

Open [the local app](http://localhost:8768/). For a production build, run `npm run build`, then `npm run start -- --port 8768`.

Local public research can use the GET fallback. Native streaming, durable ingestion, private journals and the MCP assistant require the configured backend and environment settings in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

The same-origin API supports public market lists, exact contract details, fixed-point order books, recent trades, bounded session history and Excel export. Optional signed public-data requests read `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` only on the server. The app exposes no account balances, account positions or real-order submission routes. Research-only POST routes freeze and checkpoint simulated forward-test cohorts.

The separate [Python/FastAPI connector](../connector/README.md) covers public Kalshi market, rule, book and trade requests. It does not implement this web runtime's external-source intelligence or forward-research services. It is not required when the same-origin APIs are working.

## Market monitor and execution research

I sample explicitly selected Kalshi series across Sports, Macro, Travel, Weather and Crypto. The market-list adapter bounds each selected series request to 200 open markets and reports incomplete coverage. Its short server cache reduces repeated requests. Browser polling runs every 30 seconds while visible; provider rate limits and unavailable responses remain visible.

The web process retains up to 10,000 actual market observations in memory. They can reset or differ across instances. The browser's session history is also temporary. I do not backfill synthetic prices into either history.

The workbench models YES and NO purchases against actual retrieved depth, aggregates duplicate levels, rejects crossed books and applies a user-set slippage limit. Unfilled quantities remain unfilled. Break-even, outcome P/L, subjective-probability expected P/L and budget sizing use only the modeled filled portion. Fee coefficients and multipliers are editable assumptions; conservative price-level cent rounding can differ from actual exchange billing.

Exact contract details preserve primary and secondary rules, trading close, expiration, early-close conditions and status. Missing fields stay unavailable. A last-traded price, midpoint and executable-side ask describe different things; I do not treat them as interchangeable probabilities or guarantees.

## Paper trading

`public/dashboard/paper.js` records virtual positions from a fresh, exact matching public book under 90 seconds old. Entries consume asks; paper closes and marks consume bids. Partial fills, entry cost basis, modeled exit fees and realized P/L remain explicit. Unrealized portfolio P/L is withheld when fresh depth cannot support a complete mark.

The positions ledger and execution journal are local to this browser and origin. They are not connected to an exchange account. I export private CSV/JSON journals before changing environments or clearing storage. Price-level simulations do not reproduce queue priority, disappearing liquidity, actual exchange execution or future settlement.

`/api/export.xlsx` creates an ExcelJS workbook with Markets, TimeSeries, Scenarios and Definitions sheets. Financial scenario inputs are assumptions rather than observed operator GGR, lodging RevPAR or sportsbook customer migration.

## Independent evidence and model research

Selected-contract briefs combine exact rules, source evidence, independent research estimates where supported, and linked news metadata. The numerical research families cover TSA passenger counts, National Weather Service temperatures, FRED inflation/unemployment and Coinbase crypto observations. Unsupported contracts remain evidence-only.

- `/api/brief?ticker=...` returns the selected-contract brief.
- `/api/intelligence?category=travel|weather|inflation|labor|crypto` returns source observations, research probabilities, coverage, lineage and available chronological validation.
- `/api/intelligence/execution?category=...&ticker=...&contracts=100` combines rules, depth and explicitly modeled execution costs.
- `/api/intelligence/catalog` and `/api/intelligence/series` describe supported numerical families and allowlisted series.

These models have not demonstrated profitable Kalshi trading. Weather and crypto estimates include uncalibrated proxy assumptions. A favorable numerical gap is a research hypothesis; unavailable validation or depth cannot be replaced by a recommendation. See [the quantitative research guide](docs/quant-research.md).

FRED requests can fail in this environment. The app can fall back to an actual archived CSV with its original retrieval timestamp and hash, labeled as a snapshot. `python tools/research_pipeline.py refresh-fred` refreshes that archive; it does not relabel an old snapshot as live.

## Optional Python, SQL and Parquet research pipeline

The local tools are separate from the deployed JavaScript service. Install their optional packages in a virtual environment:

```sh
python -m venv .venv
```

Activate `.venv` for your platform, then run:

```sh
python -m pip install -r tools/research-requirements.txt
python tools/research_pipeline.py ingest --base-url http://localhost:8768
python tools/research_pipeline.py resolve --base-url http://localhost:8768
python tools/research_pipeline.py train
```

I store source snapshots, market dimensions, quotes, predictions and resolutions in a local DuckDB warehouse, export Parquet tables and build SQL evaluation views. The evaluation join uses observations available at the prediction time, retains the original close deadline and excludes late archival from a claimed pre-close record. The calibration command withholds training when independent resolved samples are insufficient.

The forward collector fixes its stopping rule before observing outcomes:

```sh
python tools/forward_collector.py --base-url http://localhost:8768 --cohorts 3 --seconds 60
```

It freezes inputs and collects subsequent actual books for simulated markouts. The default `.research/` output is private and ignored by Git. Server-side temporary cohorts can reset on restart; local exports supply a separate archive. See [the forward evaluation protocol](docs/forward-research.md).

## Checks and Figma packaging

```sh
npm test
python -m unittest discover -s tests -p "test_*.py"
```

The Python command needs the optional research packages. Synthetic fixtures test calculations and audit behavior; they are not production forecasts or a trading track record. The root [project README](../README.md) records the current verification counts.

The existing `.figma/make/` scripts describe a Next runtime using a supported server adapter. The independently exported static frontend instead calls the live AWS backend, including its native-stream and durable-journal routes; it does not pretend those APIs execute inside Figma. The existing `figma.config.json` requests React/JSX Code Connect settings and does not establish published component bindings. See [the connection notes](docs/code-connect.md).
