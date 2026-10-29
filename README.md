# Kalshi Market Lab

I built Kalshi Market Lab to make the research before an event-contract trade easier to inspect: what the contract actually resolves on, what evidence supports an estimate, how much depth is available, and what a position could cost after fees.

[Figma app workspace](https://www.figma.com/make/l70tt532rm4WDOZ5PFQIiK) · [Resume entries](docs/RESUME.md) · [Security and data handling](docs/SECURITY.md)

**Public app URL:** pending final deployment verification. The Figma link opens the app workspace; I have not used it as evidence that a public deployment is healthy.

## What I built

- A market monitor for Sports, Macro, Travel, Weather and Crypto, with 30-second refreshes while the page is visible, source timestamps, recent trades, spread diagnostics and selected-contract order-book depth.
- Contract-specific research that brings together resolution rules, source observations, independent model outputs and linked news coverage. The numerical research families use TSA passenger counts, National Weather Service forecasts, FRED economic series and Coinbase candles. Missing evidence and archived source data retain their status and timestamps.
- An execution workbench for YES and NO contracts: depth-limited fills, slippage caps, fee assumptions, break-even probabilities, outcome P/L and budget-constrained sizing.
- Browser-local paper trading with a positions ledger and execution journal. Entries consume available asks; closes and marks use available bids with modeled costs. Paper execution requires a matching public book under 90 seconds old, preserves partial fills and saves quote provenance.
- Downloadable Excel exhibits, research CSVs and paper-journal CSV/JSON. The web workbook contains Markets, TimeSeries, Scenarios and Definitions sheets.

The independent models are research hypotheses. I have not established profitable trading performance, a calibrated probability advantage or an executable arbitrage. Public quotes and available depth can change between retrieval and an actual order.

## Run the complete web app

I use Node.js 22 or newer. From this repository:

```sh
cd web
npm ci
npm run dev -- --port 8768
```

Open [the local app](http://localhost:8768/). The web server supplies the dashboard and its same-origin APIs. Public market data can be requested without an account; upstream restrictions, maintenance and rate limits can still make individual feeds unavailable.

For a local production build:

```sh
cd web
npm run build
npm run start -- --port 8768
```

I keep optional authenticated public-data requests on the server. If needed, I configure `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY` through the hosting provider's secret settings or an ignored local environment file. Credentials are never entered into the dashboard or committed to Git. No account positions, balances or real-order routes are exposed.

## Run the Python connector separately

The FastAPI connector is a smaller alternative for public Kalshi market, book, rule and trade data. It does not implement the web app's external-source intelligence or forward-research services.

```sh
cd connector
python -m venv .venv
```

Activate the virtual environment: on Windows, use `.venv\Scripts\Activate.ps1`; on macOS/Linux, use `source .venv/bin/activate`. Then run:

```sh
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Check [connector health](http://127.0.0.1:8000/health), then set **Connector origin** in the dashboard to `http://127.0.0.1:8000`. For a hosted dashboard, I deploy the connector to a reachable HTTPS origin and restrict `ALLOWED_ORIGINS` to the actual dashboard origin. A hosted page usually cannot reach a developer's localhost. The [connector guide](connector/README.md) covers its routes and deployment.

## Data and scope

| Location | Purpose and evidence |
| --- | --- |
| `web/` | Working dashboard, public-data server, source-backed research, browser-local paper trading and Excel export. Coverage is a bounded series sample rather than the full exchange. |
| `connector/` | Python/FastAPI adapter for public Kalshi market data, fixed-point depth calculations and explicit unavailable responses for unsupported intelligence routes. |
| `web/tools/` | Optional local Python/SQL research pipeline: DuckDB source snapshots, dimensions/facts, point-in-time evaluation views, Parquet exports and event-separated calibration checks. |
| Root `client.py`, `metrics.py`, `pipeline.py`, `__init__.py`, `__main__.py` | Earlier illustrative Gaming/Lodging research scaffold, retained as a separate reference. Its sector dataset, sportsbook assumptions and financial sensitivities are not the evidence behind the live dashboard. |

I do not treat the root scaffold's synthetic fallback as a live observation. Its Gaming/Lodging assumptions do not establish customer migration between exchanges and sportsbooks, actual operator hold, GGR, EBITDA or a lodging RevPAR forecast. The working app's scenario controls are explicitly labeled assumptions.

The web research engine also supports frozen forward-test cohorts and subsequent observations. Those research artifacts can use temporary server storage and may reset on a hosting restart. A cohort or a favorable short-horizon result does not establish a profitable strategy. The detailed [model guide](web/docs/quant-research.md) and [forward protocol](web/docs/forward-research.md) describe the methods and limits.

## Validation

```sh
cd web
npm test
```

```sh
cd connector
python -m pip install -r requirements-dev.txt
python -m pytest
```

The current verification record contains **81 JavaScript tests, 31 connector tests and 11 Python research-pipeline tests passing**. The checks cover parsing and source mapping, fixed-point depth, fees and partial fills, research calculations, paper-ledger accounting, freshness and ticker matching, and export safety. They establish the tested behavior; public deployment and individual live feeds require separate verification.

The production web build also passes. The 11 Python research checks exercise DuckDB SQL ingestion and point-in-time evaluation, chronological event-separated calibration, and frozen forward-audit behavior using test fixtures. A separate temporary-fixture check also verified DuckDB Parquet export and PyArrow/DuckDB readback. I ran these in an ignored local virtual environment with DuckDB 1.5.6, scikit-learn 1.9.1 and PyArrow 24.0.0; the web service does not depend on that environment. The GitHub workflow runs the locked web installation, JavaScript tests and production build on pushes and pull requests that change the app.

Paper trades stay in this browser's storage. Clearing site data removes that journal, and a different browser or app origin has a separate journal. I export it before moving environments and keep those exports private.
