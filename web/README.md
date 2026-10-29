# Kalshi Market Lab · web runtime

I use this Next.js app to serve the market dashboard, public-data APIs, selected-contract research and browser-local paper trading. This `web/` directory is the complete web project. Its browser assets live in `public/dashboard/`; its server-side adapters and calculations live in `lib/` and `app/api/`.

[Project overview](../README.md) · [Security and data handling](../docs/SECURITY.md) · [Resume entries](../docs/RESUME.md) · [Figma app workspace](https://www.figma.com/make/l70tt532rm4WDOZ5PFQIiK)

The public deployment URL is pending final verification. The Figma workspace link is not a production health check.

## Run locally

From this directory, with Node.js 22 or newer:

```sh
npm ci
npm run dev -- --port 8768
```

Open [the local app](http://localhost:8768/). For a production build, run `npm run build`, then `npm run start -- --port 8768`.

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

The scripts in `.figma/make/` install, start and package this Next runtime. Deployment must retain server APIs through the Next adapter. The existing `figma.config.json` documents requested React/JSX Code Connect settings; it does not establish published design-component bindings. See [the connection notes](docs/code-connect.md).
