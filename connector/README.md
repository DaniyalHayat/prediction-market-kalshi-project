# Kalshi read-only connector

A small FastAPI service that adapts Kalshi's public market API to the request
routes used by the Kalshi Market Lab dashboard. It does not place trades and
does not need Kalshi credentials.

## Routes

- `GET /health`
- `GET /api/markets?vertical=Macro`
- `GET /api/market?ticker=...`
- `GET /api/book?ticker=...&contracts=100`
- `GET /api/trades?ticker=...`

The market-list response includes `markets`, `as_of`, and `source_url`, as
required by the dashboard. Prices are normalized to probabilities from 0 to 1.
Rows include retrieval-independent Kalshi fields plus `vertical`, `midpoint`,
`catalog_quote_valid`, `spread_cents`, and `source_url`. Dollar quotes and contract
counts retain finite fractional values. Invalid, crossed or missing quotes have
no midpoint; a last trade remains a separate `last_price` field. Missing data is
not converted to zero. Successful vertical market lists are cached for 20 seconds,
preserving the original `as_of` timestamp until a new retrieval completes.
Vertical requests discover matching Kalshi series and read
open markets from the 12 most recently updated matching series. This keeps
refreshes responsive and within public API rate limits; it is a live sample,
not an exhaustive catalog.

The dashboard also requests `/api/intelligence` and
`/api/intelligence/forward` for non-Kalshi intelligence panels. Those routes
return HTTP 501 rather than inventing or presenting unavailable data. The
connector covers live Kalshi markets, order books, and recent trades only.

The book route returns both the unmodified public `raw` payload and computed
`metrics`. Depth is bounded to 100 levels. Static-book fill estimates preserve
fractional depth and report partially filled quantities; crossed books have no
assumed fill. These estimates exclude fees, queue position and subsequent changes
in liquidity, and they do not submit orders.

## Run locally

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

Set **Connector origin** in the dashboard to `http://127.0.0.1:8000` only when
the browser can reach the computer running this service. A hosted dashboard
usually cannot reach a developer's localhost.

## Deploy from a Git repository with Render

1. Put this project directory in a Git repository and push it to GitHub.
2. In Render, choose **New → Blueprint**, connect that repository, and select
   `render.yaml`.
3. Confirm the `ALLOWED_ORIGINS` value is exactly the dashboard's browser
   origin, then deploy. No Kalshi key or secret is required.
4. Open `https://<your-render-service>.onrender.com/health` and confirm it
   reports `"status": "ok"`.
5. Test `GET /api/markets?vertical=Macro` and confirm it returns a non-empty
   `markets` array, an ISO-8601 `as_of`, and a `source_url`.
6. Enter the service's HTTPS base URL (without `/api/...`) in **Connector
   origin** and click **Connect**.

If Render assigns a different service hostname, the URL is the Render service
origin, and `ALLOWED_ORIGINS` remains the dashboard origin (not the connector
origin). Keep the service public only if you are comfortable exposing public
market data; add authentication only if the dashboard supports sending it.

## Local checks

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest
```
