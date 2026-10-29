from __future__ import annotations

import asyncio
import os
import re
import time
import math
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import quote

import httpx
from calculations import book_metrics
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware


KALSHI_API = os.getenv(
    "KALSHI_API_BASE_URL",
    "https://external-api.kalshi.com/trade-api/v2",
).rstrip("/")
DEFAULT_DASHBOARD_ORIGIN = (
    "https://app-djn6yih5d4aak4yaopvc76jj62rn4pw5ymm5tkgcepwxueuhzeyy."
    "makeproxy-c.figma.site"
)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", DEFAULT_DASHBOARD_ORIGIN).split(",")
    if origin.strip()
]
MAX_MARKET_PAGES = 5
MARKET_PAGE_SIZE = 200
SERIES_PAGE_SIZE = 1000
MAX_SERIES_MARKET_PAGES = 5
SERIES_CACHE_TTL = 900
MARKET_CACHE_TTL = 20
MAX_SERIES_PER_VERTICAL = 12
MAX_CONCURRENT_SERIES_REQUESTS = 3

VERTICAL_SERIES = {
    "macro": (("Economics", "World"), re.compile(r"^KX(FED|CPI|GDP|U3|PCE)", re.I)),
    "sports": (("Sports",), re.compile(r"^KX(NBA|NFL|MLB|NHL|NCAA|WNBA)", re.I)),
    "travel": (("Transportation", "Economics"), re.compile(r"^KXTSA", re.I)),
    "weather": (("Climate and Weather",), re.compile(r"^KXHIGH", re.I)),
    "crypto": (("Crypto",), re.compile(r"^KX(BTC|ETH)", re.I)),
}
_series_cache: dict[str, tuple[float, list[dict]]] = {}
_market_cache: dict[str, tuple[float, dict]] = {}

app = FastAPI(
    title="Kalshi Read-only Data Connector",
    description="Read-only public market data adapter for Kalshi Market Lab.",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"https://(?:[a-z0-9-]+\.makeproxy-[cm]\.figma\.site|[a-z0-9-]+\.figma\.site)",
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _source_url(path: str, params: dict[str, str | int] | None = None) -> str:
    url = f"{KALSHI_API}{path}"
    if params:
        query = "&".join(f"{key}={quote(str(value), safe='')}" for key, value in params.items())
        return f"{url}?{query}"
    return url


async def _get_json(
    path: str,
    params: dict[str, str | int] | None = None,
) -> dict:
    try:
        async with httpx.AsyncClient(timeout=15.0, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 KalshiMarketLab/4.0"}) as client:
            for attempt in range(3):
                response = await client.get(f"{KALSHI_API}{path}", params=params)
                if response.status_code == 429 and attempt < 2:
                    retry_after = response.headers.get("Retry-After", "1")
                    try:
                        delay = min(max(float(retry_after), 0.25), 5.0)
                    except ValueError:
                        delay = 1.0
                    await asyncio.sleep(delay)
                    continue
                response.raise_for_status()
                payload = response.json()
                break
            else:
                raise HTTPException(status_code=502, detail="Kalshi rate limit retry failed.")
    except httpx.HTTPStatusError as exc:
        status = 404 if exc.response.status_code == 404 else 502
        raise HTTPException(
            status_code=status,
            detail=f"Kalshi API returned HTTP {exc.response.status_code}.",
        ) from exc
    except (httpx.RequestError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail="Could not retrieve valid JSON from the Kalshi public API.",
        ) from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail="Kalshi API returned an unexpected response.")
    return payload


async def _get_series(category: str) -> list[dict]:
    cached = _series_cache.get(category)
    if cached and cached[0] > time.monotonic():
        return cached[1]

    payload = await _get_json("/series", {"category": category, "limit": SERIES_PAGE_SIZE})
    rows = payload.get("series", [])
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise HTTPException(status_code=502, detail="Kalshi returned an invalid series list.")
    _series_cache[category] = (time.monotonic() + SERIES_CACHE_TTL, rows)
    return rows


async def _markets_for_series(series_ticker: str, semaphore: asyncio.Semaphore) -> list[dict]:
    async with semaphore:
        params: dict[str, str | int] = {
            "status": "open",
            "limit": MARKET_PAGE_SIZE,
            "series_ticker": series_ticker,
        }
        cursor: str | None = None
        rows: list[dict] = []

        for _ in range(MAX_SERIES_MARKET_PAGES):
            page_params = {**params}
            if cursor:
                page_params["cursor"] = cursor
            payload = await _get_json("/markets", page_params)
            source_url = _source_url("/markets", page_params)
            page = payload.get("markets", [])
            if not isinstance(page, list):
                raise HTTPException(status_code=502, detail="Kalshi returned an invalid markets list.")
            for market in page:
                if isinstance(market, dict):
                    rows.append(
                        _normalize_market(
                            {**market, "series_ticker": market.get("series_ticker") or series_ticker},
                            source_url,
                        )
                    )
            cursor = payload.get("cursor")
            if not cursor or not page:
                break

        return rows


def _decimal(value: object, *, cents: bool = False) -> float | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
        if not number.is_finite():
            return None
        if cents:
            number /= Decimal(100)
        result = float(number)
    except (InvalidOperation, ValueError, TypeError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _probability(market: dict, dollars_key: str, cents_key: str) -> float | None:
    if market.get(dollars_key) is not None:
        value = _decimal(market[dollars_key])
    else:
        value = _decimal(market.get(cents_key), cents=True)
    return value if value is not None and 0 <= value <= 1 else None


def _quantity(market: dict, fixed_key: str, legacy_key: str) -> float | None:
    value = _decimal(market.get(fixed_key) if market.get(fixed_key) is not None else market.get(legacy_key))
    return value if value is not None and value >= 0 else None


def _validate_ticker(ticker: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", ticker) or ".." in ticker:
        raise HTTPException(status_code=400, detail="Invalid public market ticker.")


def _vertical(market: dict) -> str:
    series = str(market.get("series_ticker") or market.get("ticker") or "").upper()
    if re.match(r"^KX(NBA|NFL|MLB|NHL|NCAA|WNBA)", series):
        return "Sports"
    if series.startswith("KXTSA"):
        return "Travel"
    if series.startswith("KXHIGH"):
        return "Weather"
    if re.match(r"^KX(BTC|ETH)", series):
        return "Crypto"
    if re.match(r"^KX(FED|CPI|GDP|U3|PCE)", series):
        return "Macro"
    return "Other"


def _normalize_market(market: dict, source_url: str) -> dict:
    yes_bid = _probability(market, "yes_bid_dollars", "yes_bid")
    yes_ask = _probability(market, "yes_ask_dollars", "yes_ask")
    no_bid = _probability(market, "no_bid_dollars", "no_bid")
    no_ask = _probability(market, "no_ask_dollars", "no_ask")
    midpoint = (
        round((yes_bid + yes_ask) / 2, 6)
        if yes_bid is not None and yes_ask is not None and 0 <= yes_bid <= yes_ask <= 1
        else None
    )
    ticker = market.get("ticker")
    return {
        **market,
        "ticker": ticker,
        "series": market.get("series_ticker") or (ticker.split("-", 1)[0] if ticker else None),
        "vertical": _vertical(market),
        "yes_bid": yes_bid,
        "yes_ask": yes_ask,
        "no_bid": no_bid,
        "no_ask": no_ask,
        "midpoint": midpoint,
        "last_price": _probability(market, "last_price_dollars", "last_price"),
        "volume_24h": _quantity(market, "volume_24h_fp", "volume_24h"),
        "volume": _quantity(market, "volume_fp", "volume"),
        "open_interest": _quantity(market, "open_interest_fp", "open_interest"),
        "spread_cents": round((yes_ask - yes_bid) * 100, 8) if yes_bid is not None and yes_ask is not None and 0 <= yes_bid <= yes_ask <= 1 else None,
        "catalog_quote_valid": yes_bid is not None and yes_ask is not None and 0 <= yes_bid <= yes_ask <= 1,
        "source_url": source_url,
    }


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "provider": "Kalshi public API", "read_only": True}


@app.get("/")
async def root() -> dict:
    return {
        "status": "ok",
        "service": "Kalshi read-only data connector",
        "health": "/health",
        "markets": "/api/markets?vertical=Macro",
        "read_only": True,
    }


@app.get("/api/markets")
async def markets(vertical: str | None = None) -> dict:
    normalized_vertical = (vertical or "").strip().lower()
    if normalized_vertical in VERTICAL_SERIES:
        cached = _market_cache.get(normalized_vertical)
        if cached and cached[0] > time.monotonic():
            return cached[1]

        categories, ticker_pattern = VERTICAL_SERIES[normalized_vertical]
        category_series = await asyncio.gather(*(_get_series(category) for category in categories))
        series_by_ticker = {
            series["ticker"]: series
            for series_list in category_series
            for series in series_list
            if isinstance(series.get("ticker"), str)
            and ticker_pattern.match(series["ticker"])
        }
        semaphore = asyncio.Semaphore(MAX_CONCURRENT_SERIES_REQUESTS)
        selected_series = sorted(
            series_by_ticker.values(),
            key=lambda series: str(series.get("last_updated_ts") or ""),
            reverse=True,
        )[:MAX_SERIES_PER_VERTICAL]
        market_pages = await asyncio.gather(
            *(_markets_for_series(series["ticker"], semaphore) for series in selected_series)
        )
        all_markets = [market for page in market_pages for market in page]
        as_of = _now()
        category_url = _source_url(
            "/series",
            {"category": ",".join(categories), "limit": SERIES_PAGE_SIZE},
        )
        result = {
            "markets": all_markets,
            "as_of": as_of,
            "source_url": category_url,
            "vertical": vertical or "All",
        }
        _market_cache[normalized_vertical] = (time.monotonic() + MARKET_CACHE_TTL, result)
        return result

    params: dict[str, str | int] = {"status": "open", "limit": MARKET_PAGE_SIZE}
    source_url = _source_url("/markets", params)
    cursor: str | None = None
    rows: list[dict] = []

    for _ in range(MAX_MARKET_PAGES):
        page_params = {**params}
        if cursor:
            page_params["cursor"] = cursor
        payload = await _get_json("/markets", page_params)
        page = payload.get("markets", [])
        if not isinstance(page, list):
            raise HTTPException(status_code=502, detail="Kalshi returned an invalid markets list.")
        rows.extend(item for item in page if isinstance(item, dict))
        cursor = payload.get("cursor")
        if not cursor or not page:
            break

    normalized = [_normalize_market(row, source_url) for row in rows]
    if vertical and vertical.lower() not in {"all", "any"}:
        normalized = [row for row in normalized if row["vertical"].lower() == vertical.lower()]
    as_of = _now()
    return {
        "markets": normalized,
        "as_of": as_of,
        "source_url": source_url,
        "vertical": vertical or "All",
    }


@app.get("/api/market")
async def market(ticker: str = Query(min_length=1, max_length=128)) -> dict:
    _validate_ticker(ticker)
    path = f"/markets/{quote(ticker, safe='')}"
    payload = await _get_json(path)
    raw_market = payload.get("market")
    if not isinstance(raw_market, dict) or raw_market.get("ticker") != ticker:
        raise HTTPException(status_code=502, detail="Kalshi returned an invalid market detail.")
    source_url = _source_url(path)
    return {
        "market": _normalize_market(raw_market, source_url),
        "as_of": _now(),
        "source_url": source_url,
    }


@app.get("/api/book")
async def book(
    ticker: str = Query(min_length=1, max_length=128),
    contracts: int = Query(default=100, ge=1, le=10000),
) -> dict:
    _validate_ticker(ticker)
    path = f"/markets/{quote(ticker, safe='')}/orderbook"
    params = {"depth": 100}
    payload = await _get_json(path, params)
    source_url = _source_url(path, params)
    try:
        metrics = book_metrics(payload, contracts)
    except (ValueError, InvalidOperation) as exc:
        raise HTTPException(status_code=502, detail="Kalshi returned an invalid fixed-point order book.") from exc
    return {
        **payload,
        "raw": payload,
        "metrics": metrics,
        "ticker": ticker,
        "contracts": contracts,
        "as_of": _now(),
        "source_url": source_url,
    }


@app.get("/api/trades")
async def trades(
    ticker: str = Query(min_length=1, max_length=128),
    limit: int = Query(default=100, ge=1, le=1000),
) -> dict:
    _validate_ticker(ticker)
    path = "/markets/trades"
    params: dict[str, str | int] = {"ticker": ticker, "limit": limit}
    payload = await _get_json(path, params)
    source_url = _source_url(path, params)
    trade_rows = payload.get("trades", [])
    if not isinstance(trade_rows, list):
        raise HTTPException(status_code=502, detail="Kalshi returned an invalid trades list.")
    return {
        **payload,
        "trades": trade_rows,
        "ticker": ticker,
        "as_of": _now(),
        "source_url": source_url,
    }


@app.get("/api/intelligence")
@app.get("/api/intelligence/forward")
async def unavailable_intelligence(category: str | None = None) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            "This connector provides live Kalshi market, order-book, and trade data only. "
            "The dashboard's intelligence panels require a separate authorized data source."
        ),
    )
