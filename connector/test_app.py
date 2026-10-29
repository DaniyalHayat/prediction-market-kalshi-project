from fastapi.testclient import TestClient
import pytest

import app as connector
from calculations import book_metrics


@pytest.fixture(autouse=True)
def isolated_caches():
    connector._market_cache.clear()
    connector._series_cache.clear()
    yield
    connector._market_cache.clear()
    connector._series_cache.clear()


def test_normalize_market_converts_cents_to_probability() -> None:
    market = connector._normalize_market(
        {
            "ticker": "KXFEDDECISION-26OCT-H25",
            "series_ticker": "KXFEDDECISION",
            "yes_bid": 43,
            "yes_ask": 47,
            "volume": 120, "volume_24h": 30,
        },
        "https://example.test/markets",
    )

    assert market["yes_bid"] == 0.43
    assert market["yes_ask"] == 0.47
    assert market["midpoint"] == 0.45
    assert market["volume_24h"] == 30
    assert market["vertical"] == "Macro"
    assert market["source_url"] == "https://example.test/markets"


def test_markets_endpoint_returns_dashboard_contract(monkeypatch) -> None:
    async def fake_get_json(path, params=None):
        if path == "/series":
            assert params["category"] in {"Economics", "World"}
            return {
                "series": [
                    {"ticker": "KXFEDDECISION", "category": "Economics"},
                    {"ticker": "KXMVECROSSCATEGORY", "category": "Exotics"},
                ]
            }
        assert path == "/markets"
        assert params["series_ticker"] == "KXFEDDECISION"
        return {
            "markets": [
                {
                    "ticker": "KXFEDDECISION-26OCT-H25",
                    "yes_bid": 43,
                    "yes_ask": 47,
                    "volume": 120, "volume_24h": 30,
                }
            ],
            "cursor": "",
        }

    monkeypatch.setattr(connector, "_get_json", fake_get_json)
    response = TestClient(connector.app).get("/api/markets?vertical=Macro")

    assert response.status_code == 200
    body = response.json()
    assert len(body["markets"]) == 1
    assert body["markets"][0]["ticker"] == "KXFEDDECISION-26OCT-H25"
    assert body["markets"][0]["midpoint"] == 0.45
    assert body["markets"][0]["vertical"] == "Macro"
    assert body["as_of"]
    assert body["markets"][0]["source_url"].startswith(connector.KALSHI_API)


def test_intelligence_is_not_faked() -> None:
    response = TestClient(connector.app).get("/api/intelligence?category=crypto")

    assert response.status_code == 501
    assert "separate authorized data source" in response.json()["detail"]


def test_dashboard_origin_is_allowed_by_cors() -> None:
    response = TestClient(connector.app).options(
        "/api/markets?vertical=Macro",
        headers={
            "Origin": connector.DEFAULT_DASHBOARD_ORIGIN,
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == connector.DEFAULT_DASHBOARD_ORIGIN


def test_fixed_point_contract_counts_and_subcent_quotes_remain_fractional() -> None:
    row = connector._normalize_market({
        "ticker": "KXCPI-26NOV-T0.2", "yes_bid_dollars": "0.4315", "yes_ask_dollars": "0.4325",
        "volume_fp": "123.75", "volume_24h_fp": "12.25", "open_interest_fp": "10.5",
    }, "https://example.test")
    assert row["midpoint"] == .432
    assert row["spread_cents"] == .1
    assert row["volume"] == 123.75
    assert row["volume_24h"] == 12.25
    assert row["open_interest"] == 10.5


@pytest.mark.parametrize("value", ["NaN", "sNaN", "Infinity", "-Infinity", "1e99999", True, False, {}, []])
def test_nonfinite_or_nonnumeric_values_are_missing(value) -> None:
    assert connector._decimal(value) is None
    row = connector._normalize_market({"yes_bid_dollars": value, "yes_ask_dollars": ".5",
        "volume_fp": value, "open_interest_fp": value}, "https://example.test")
    assert row["yes_bid"] is None
    assert row["midpoint"] is None
    assert row["volume"] is None
    assert row["open_interest"] is None


@pytest.mark.parametrize("quotes", [
    {"yes_bid_dollars": ".8", "yes_ask_dollars": ".2"},
    {"yes_bid_dollars": None, "yes_ask_dollars": ".5"},
    {"yes_bid_dollars": "1.2", "yes_ask_dollars": "1.3"},
    {"yes_bid_dollars": "-.1", "yes_ask_dollars": ".5"},
])
def test_missing_crossed_and_out_of_range_quotes_do_not_become_last_trade_midpoints(quotes) -> None:
    row = connector._normalize_market({**quotes, "last_price_dollars": ".72"}, "https://example.test")
    assert row["midpoint"] is None
    assert row["catalog_quote_valid"] is False
    assert row["spread_cents"] is None
    assert row["last_price"] == .72


def test_zero_quotes_and_zero_counts_are_preserved_and_negative_counts_are_missing() -> None:
    row = connector._normalize_market({"yes_bid_dollars": "0", "yes_ask_dollars": "1",
        "volume_fp": "0", "volume_24h_fp": "-1", "open_interest_fp": "0"}, "https://example.test")
    assert row["catalog_quote_valid"] is True
    assert row["midpoint"] == .5
    assert row["volume"] == 0
    assert row["open_interest"] == 0
    assert row["volume_24h"] is None


def test_market_cache_expires_after_twenty_seconds_without_refreshing_original_timestamp(monkeypatch) -> None:
    clock = [100.0]
    calls = []
    monkeypatch.setattr(connector.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(connector, "_now", lambda: f"retrieved-at-{clock[0]}")
    async def fake_get_json(path, params=None):
        calls.append((path, params))
        if path == "/series":
            return {"series": [{"ticker": "KXTSAD"}]}
        return {"markets": [{"ticker": "KXTSAD-26OCT28-T2000000", "yes_bid_dollars": ".4", "yes_ask_dollars": ".5"}], "cursor": ""}
    monkeypatch.setattr(connector, "_get_json", fake_get_json)
    client = TestClient(connector.app)
    first = client.get("/api/markets?vertical=Travel").json()
    initial_calls = len(calls)
    clock[0] = 119.999
    cached = client.get("/api/markets?vertical=Travel").json()
    assert cached["as_of"] == first["as_of"] == "retrieved-at-100.0"
    assert len(calls) == initial_calls
    clock[0] = 120.0
    refreshed = client.get("/api/markets?vertical=Travel").json()
    assert refreshed["as_of"] == "retrieved-at-120.0"
    assert len(calls) == initial_calls + 1  # Series discovery has its own longer TTL.


def test_allowed_figma_preview_origins_can_read_but_unrelated_origins_and_post_cannot() -> None:
    client = TestClient(connector.app)
    for origin in [connector.DEFAULT_DASHBOARD_ORIGIN, "https://app-preview.makeproxy-m.figma.site", "https://published-demo.figma.site"]:
        response = client.get("/health", headers={"Origin": origin})
        assert response.headers["access-control-allow-origin"] == origin
    forbidden = client.options("/api/book", headers={"Origin": "https://unrelated.example", "Access-Control-Request-Method": "GET"})
    assert forbidden.status_code == 400
    assert "access-control-allow-origin" not in forbidden.headers
    assert client.post("/api/book").status_code == 405


def test_book_endpoint_returns_untouched_raw_payload_and_correct_partial_fill_metrics(monkeypatch) -> None:
    payload = {"orderbook_fp": {"yes_dollars": [[".4", "20"]], "no_dollars": [[".55", "2.5"], [".53", "2.5"]]}}
    async def fake_get_json(path, params=None):
        assert path == "/markets/KXCPI-26NOV-T0.2/orderbook"
        assert params == {"depth": 100}
        return payload
    monkeypatch.setattr(connector, "_get_json", fake_get_json)
    response = TestClient(connector.app).get("/api/book?ticker=KXCPI-26NOV-T0.2&contracts=10")
    assert response.status_code == 200
    body = response.json()
    assert body["raw"] == payload
    assert body["orderbook_fp"] == payload["orderbook_fp"]
    assert body["metrics"]["book_ask"] == .45
    assert body["metrics"]["book_spread_cents"] == 5
    assert body["metrics"]["sim_filled"] == 5
    assert body["metrics"]["sim_fill_ratio"] == .5
    assert body["metrics"]["sim_vwap"] == .46
    assert body["source_url"].endswith("/orderbook?depth=100")
    assert body["as_of"]


def test_crossed_book_has_no_assumed_fill_and_invalid_book_returns_upstream_error(monkeypatch) -> None:
    crossed = book_metrics({"orderbook_fp": {"yes_dollars": [[".8", "100"]], "no_dollars": [[".6", "100"]]}})
    assert crossed["book_state"] == "crossed"
    assert crossed["sim_filled"] == 0
    assert crossed["sim_vwap"] is None
    async def fake_get_json(path, params=None):
        return {"orderbook_fp": {"yes_dollars": [["NaN", "10"]]}}
    monkeypatch.setattr(connector, "_get_json", fake_get_json)
    response = TestClient(connector.app).get("/api/book?ticker=KXCPI-26NOV-T0.2")
    assert response.status_code == 502
    assert "invalid fixed-point" in response.json()["detail"]


@pytest.mark.parametrize("ticker", ["../portfolio/balance", "TEST..NAME", "TEST/NAME"])
def test_invalid_tickers_never_reach_provider(ticker, monkeypatch) -> None:
    async def never_called(*args, **kwargs):
        pytest.fail("Invalid ticker reached provider")
    monkeypatch.setattr(connector, "_get_json", never_called)
    for route in ["book", "market", "trades"]:
        response = TestClient(connector.app).get(f"/api/{route}", params={"ticker": ticker})
        assert response.status_code == 400


@pytest.mark.parametrize("quantity", [float("nan"), float("inf"), True, 0, -1])
def test_invalid_simulation_quantities_fail_cleanly(quantity) -> None:
    with pytest.raises(ValueError):
        book_metrics({"orderbook_fp": {}}, quantity)
