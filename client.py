import time
import logging
from typing import Dict, List, Optional, Any
import requests

logger = logging.getLogger(__name__)


class KalshiResearchClient:
    """
    REST API v2 Client for Kalshi Exchange Data.
    Designed for Equity Research high-frequency data ingestion (Markets, Orderbooks, Trades, Candlesticks).
    Includes built-in rate-limit backoff and synthetic fallback for offline modeling.
    """

    BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"

    def __init__(self, api_key: Optional[str] = None, timeout: int = 10):
        self.session = requests.Session()
        self.timeout = timeout
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "EquityResearch-GamingLodging-Monitor/1.0"
        }
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self.session.headers.update(headers)

    def _get(self, endpoint: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.BASE_URL}/{endpoint.lstrip('/')}"
        for attempt in range(3):
            try:
                response = self.session.get(url, params=params, timeout=self.timeout)
                if response.status_code == 429:
                    sleep_time = 2 ** attempt
                    logger.warning(f"Rate limited. Backing off for {sleep_time}s...")
                    time.sleep(sleep_time)
                    continue
                response.raise_for_status()
                return response.json()
            except requests.RequestException as e:
                logger.debug(f"API request attempt {attempt + 1} failed ({url}): {e}")
                if attempt == 2:
                    raise
                time.sleep(1)
        return {}

    def get_active_markets(
        self,
        series_ticker: Optional[str] = None,
        status: str = "open",
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Fetches active prediction markets with pagination support."""
        markets: List[Dict[str, Any]] = []
        cursor: Optional[str] = None

        while True:
            params: Dict[str, Any] = {"limit": limit, "status": status}
            if series_ticker:
                params["series_ticker"] = series_ticker
            if cursor:
                params["cursor"] = cursor

            data = self._get("/markets", params=params)
            batch = data.get("markets", [])
            markets.extend(batch)

            cursor = data.get("cursor")
            if not cursor or len(markets) >= limit:
                break

        return markets[:limit]

    def get_orderbook(self, ticker: str, depth: int = 10) -> Dict[str, Any]:
        """Fetches level-2 orderbook depth (Yes/No bids) for liquidity & spread analysis."""
        data = self._get(f"/markets/{ticker}/orderbook", params={"depth": depth})
        return data.get("orderbook", {"yes": [], "no": []})

    def get_market_trades(self, ticker: str, limit: int = 100) -> List[Dict[str, Any]]:
        """Fetches recent executions from the public trade tape for volume velocity metrics."""
        data = self._get("/markets/trades", params={"ticker": ticker, "limit": limit})
        return data.get("trades", [])

    @staticmethod
    def generate_sample_sector_dataset() -> List[Dict[str, Any]]:
        """
        Generates a realistic calibrated dataset across Gaming (OSB Sports/Events)
        and Lodging (TSA Travel / Macro Consumer) verticals for offline Excel modeling
        and deterministic unit testing when API credentials or live endpoints are offline.
        """
        return [
            {
                "ticker": "KXNFL-SB61-KC",
                "title": "Kansas City to win Pro Football Championship",
                "category": "Sports / OSB Comp",
                "equity_Readthrough": "DKNG, FLUT, MGM, CZR",
                "yes_bid": 18,
                "yes_ask": 19,
                "no_bid": 81,
                "no_ask": 82,
                "last_price": 19,
                "volume_24h": 485200,
                "open_interest": 2140500,
                "traditional_osb_american_odds": +400,  # 20.0% implied + ~4.8% sportsbook vig
                "traditional_osb_overround_pct": 4.76,
            },
            {
                "ticker": "KXNBA-FINALS-BOS",
                "title": "Boston to win Pro Basketball Finals",
                "category": "Sports / OSB Comp",
                "equity_Readthrough": "DKNG, FLUT, PENN",
                "yes_bid": 26,
                "yes_ask": 27,
                "no_bid": 73,
                "no_ask": 74,
                "last_price": 27,
                "volume_24h": 312900,
                "open_interest": 1490000,
                "traditional_osb_american_odds": +245,  # 29.0% implied
                "traditional_osb_overround_pct": 4.92,
            },
            {
                "ticker": "KXTSA-THROUGHPUT-3M",
                "title": "TSA Daily Passenger Throughput > 3.0M Peak",
                "category": "Travel & Lodging Demand",
                "equity_Readthrough": "MAR, HLT, H, HST, RHP",
                "yes_bid": 64,
                "yes_ask": 66,
                "no_bid": 34,
                "no_ask": 36,
                "last_price": 65,
                "volume_24h": 94500,
                "open_interest": 410200,
                "traditional_osb_american_odds": None,
                "traditional_osb_overround_pct": None,
            },
            {
                "ticker": "KXCPI-YOY-ABOVE-2.5",
                "title": "USHeadline CPI YoY > 2.5% (Discretionary Spend Proxy)",
                "category": "Macro / Consumer Discretionary",
                "equity_Readthrough": "WYNN, LVS, CCL, RCL",
                "yes_bid": 41,
                "yes_ask": 43,
                "no_bid": 57,
                "no_ask": 59,
                "last_price": 42,
                "volume_24h": 620100,
                "open_interest": 3890000,
                "traditional_osb_american_odds": None,
                "traditional_osb_overround_pct": None,
            },
            {
                "ticker": "KXF1-LASVEGAS-ATTEND",
                "title": "Las Vegas Strip Q4 Major Event Peak Demand Index",
                "category": "Las Vegas Strip / Integrated Resorts",
                "equity_Readthrough": "MGM, CZR, WYNN, VICI",
                "yes_bid": 71,
                "yes_ask": 73,
                "no_bid": 27,
                "no_ask": 29,
                "last_price": 72,
                "volume_24h": 142000,
                "open_interest": 580000,
                "traditional_osb_american_odds": -240,
                "traditional_osb_overround_pct": 4.55,
            },
        ]
