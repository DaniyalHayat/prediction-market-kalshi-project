# Predictir

**Prediction market research and paper trading**

Predictir brings contract rules, live market prices, independent forecasts and trading costs into one workspace. Practise with simulated money, track paper positions and review the evidence behind each decision.

**[Open Predictir](https://predictir.dev)**

[Latest release checks](docs/RELIABILITY_VERIFICATION.md): live market and paper-account checks, one-hour log reviews, provider verification, analytics and hosting settings.

| Technical overview |
| --- |
| Next.js, React and TypeScript sizing; a Node.js backend; PostgreSQL on Supabase; exchange WebSocket feeds; and a read-only MCP research assistant. Forecast checks, order-book depth and modeled fees support the paper-trading workflow. |

Previously titled Predictir. The repository address is retained so existing links and service integrations continue to work.

<details>
<summary>Methods, engineering and local setup</summary>

[Security and data handling](docs/SECURITY.md)

**[Open Predictir](https://predictir.dev)**. The current workspace runs on Vercel, Railway and Supabase. It includes eight market categories, native streaming, contract-specific research, cost-aware screens, a paper portfolio, private prospective journals, and a read-only MCP research assistant. [Deployment and reproduction](web/docs/DEPLOYMENT.md) · [Integration ranking and costs](web/docs/INTEGRATIONS.md) · [Sports validation](web/docs/sports-validation.json).

The [AWS workbench](https://xgcpzl73zl4yxyr0.s28.lambda-web.us-east-2.on.aws/lab.html) uses a separate journal store. The current Figma export opens the standalone workbench.

The research upgrade adds selectable dark themes, ranked budget scenarios, live paper-position decisions and confirmed settlement accounting. The experimental NBA ensemble and score-clock model are selectable alongside validated research. [Full feature review](web/docs/FEATURE_REVIEW.md), [pregame model evidence](web/docs/NBA_RESEARCH.md), [in-play replay](web/docs/NBA_INPLAY.md) and [runtime benchmarks](web/docs/RUNTIME_RESEARCH.md) explain the methods, measured results and integration decisions.

## Features

- A market workspace for Sports, Economy, Travel, Weather, Crypto, Tech & science, Climate and Culture, with native exchange streaming, bounded REST fallback, source timestamps, spread diagnostics and selected-contract order-book depth.
- Regularized NBA team-strength and EPL attack/defense research, with chronological evaluation, coverage gates, recent form, head-to-head games and descriptive player-minute comparisons. Apple chart snapshots and attributed public X posts remain distinct from settlement-matched forecasting inputs. Spotify catalog references are display-only.
- [NFL winner research](web/docs/NFL_RESEARCH.md) matches the exact fixture and models wins, losses and the 50¢ tie payout. The quote model replays one-minute price predictions across categories when enough observations exist. The [settlement calibration experiment](web/docs/SETTLEMENT_CALIBRATION.md) remains separate from paper sizing after its holdout loss to the raw midpoint.
- Analysis shows both sides' fee-inclusive paper setups. Contract news starts with public reporting and official references. Reddit and X are opt-in. Execution scenarios use observed depth, explain the modeled fills and download as PDF.
- An MCP tool-backed explanation assistant, consent-based GA4 traffic measurement, observed market-price attribution, private journal score attribution, and durable, retryable source ingestion into relational tables and hashed compressed evidence archives.
- Contract-specific research that brings together resolution rules, source observations, independent model outputs and linked news coverage. The numerical research families use TSA passenger counts, National Weather Service forecasts, FRED economic series and Coinbase candles. Missing evidence and archived source data retain their status and timestamps.
- An execution workbench for YES and NO contracts: depth-limited fills, slippage caps, fee assumptions, break-even probabilities, outcome P/L and budget-constrained sizing.
- Browser-local paper trading with a positions ledger and execution journal. Entries consume available asks; closes and marks use available bids with modeled costs. Paper execution requires a matching public book under 90 seconds old, preserves partial fills and saves quote provenance.
- Downloadable Excel exhibits, research CSVs and paper-journal CSV/JSON. The web workbook contains Markets, TimeSeries, Scenarios and Definitions sheets.

The independent models are research hypotheses. I have not established profitable trading performance, a calibrated probability advantage or an executable arbitrage. Public quotes and available depth can change between retrieval and an actual order.

## Run the web workspace locally

The current production build was tested with Node.js 26.12.1. From this repository:

```sh
cd web
npm ci
npm run dev -- --port 8768
```

Open [the local app](http://localhost:8768/). Without backend configuration, local public research uses the GET fallback. Native streaming, durable ingestion, private journals and the MCP assistant require the backend and private environment settings in the [deployment guide](web/docs/DEPLOYMENT.md). Public market data can be requested without an account; upstream restrictions, maintenance and rate limits can still make individual feeds unavailable.

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

The web research engine also supports frozen forward-test cohorts and subsequent observations. The AWS deployment stores these in versioned private S3 with transactional DynamoDB chain heads; a completed cloud freeze/checkpoint is recorded in [the integration receipt](web/docs/forward-cloud-verification.json). Without the documented cloud configuration, cohorts use temporary server storage and may reset on a hosting restart. A cohort or a favorable short-horizon result does not establish a profitable strategy. The detailed [model guide](web/docs/quant-research.md) and [forward protocol](web/docs/forward-research.md) describe the methods and limits.

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

The earlier verification record contained **81 JavaScript tests, 31 connector tests and 11 Python research-pipeline tests passing**. The current web suite additionally covers streaming indexes, transactional PostgreSQL quotas and jobs, MCP transport, sports and music source mapping, selection consistency, paper cash and analytics privacy. The checks establish tested behavior; public deployment and individual live feeds require separate verification.

The production web build also passes. The 11 Python research checks exercise DuckDB SQL ingestion and point-in-time evaluation, chronological event-separated calibration, and frozen forward-audit behavior using test fixtures. A separate temporary-fixture check also verified DuckDB Parquet export and PyArrow/DuckDB readback. I ran these in an ignored local virtual environment with DuckDB 1.5.6, scikit-learn 1.9.1 and PyArrow 24.0.0; the web service does not depend on that environment. The GitHub workflow runs the locked web installation, JavaScript tests and production build on pushes and pull requests that change the app.

Paper trades stay in this browser's storage. Clearing site data removes that journal, and a different browser or app origin has a separate journal. I export it before moving environments and keep those exports private.

## November 4 implementation and validation

The web application adds TypeScript sizing at `POST /api/paper/size`: integer enumeration maximizes worst-case expected log wealth under supplied probability bounds, fees, visible depth and loss limits. Stale/mismatched quotes are rejected and zero position is allowed. This is conditional simulation, not established real-world optimality. Payload CMS/SQLite implements a local research-note collection with draft/reviewed status and access rules. From `web`, run `npm run cms:verify` for real database CRUD and blocked anonymous reads. This is a local API integration, not a deployed admin site. `npm test`, `npm run typecheck`, `npm run build`, and `npm run verify:artifacts` check behavior, types, production compilation and public assets. The local checks require no paid services; hosted provider usage is described in the deployment guide. No real orders are involved.

</details>
