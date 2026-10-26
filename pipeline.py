import os
import logging
from datetime import datetime
import pandas as pd
from .client import KalshiResearchClient
from .metrics import GamingLodgingMetricsEngine

logger = logging.getLogger(__name__)


class EquityResearchPipeline:
    """
    End-to-End Orchestrator:
    1. Pulls live Kalshi market data (or falls back to calibrated sector dataset).
    2. Computes Gaming & Lodging quantitative metrics and OSB 3-statement sensitivity tables.
    3. Exports a clean CSV dataset AND an institutional-formatted multi-tab Excel workbook.
    """

    def __init__(self, output_dir: str = "outputs", use_live_api: bool = False):
        self.output_dir = output_dir
        self.use_live_api = use_live_api
        self.client = KalshiResearchClient()
        os.makedirs(self.output_dir, exist_ok=True)

    def fetch_data(self) -> pd.DataFrame:
        if self.use_live_api:
            try:
                logger.info("Fetching live markets from Kalshi API v2...")
                raw_markets = self.client.get_active_markets(limit=50)
                if raw_markets:
                    records = []
                    for m in raw_markets:
                        records.append({
                            "ticker": m.get("ticker", ""),
                            "title": m.get("title", ""),
                            "category": m.get("category", "Event Contract"),
                            "equity_Readthrough": "Sector Watch",
                            "yes_bid": m.get("yes_bid", 0),
                            "yes_ask": m.get("yes_ask", 0),
                            "no_bid": m.get("no_bid", 0),
                            "no_ask": m.get("no_ask", 0),
                            "last_price": m.get("last_price", 0),
                            "volume_24h": m.get("volume_24h", 0),
                            "open_interest": m.get("open_interest", 0),
                            "traditional_osb_american_odds": None,
                            "traditional_osb_overround_pct": None,
                        })
                    return pd.DataFrame(records)
            except Exception as e:
                logger.warning(f"Live API fetch failed ({e}). Falling back to calibrated Gaming & Lodging dataset.")

        return pd.DataFrame(self.client.generate_sample_sector_dataset())

    def run(self) -> Dict[str, str]:
        raw_df = self.fetch_data()
        enriched_df = GamingLodgingMetricsEngine.compute_microstructure_metrics(raw_df)
        sensitivity_df = GamingLodgingMetricsEngine.build_osb_sensitivity_table()

        timestamp = datetime.now().strftime("%Y%m%d")
        csv_path = os.path.join(self.output_dir, f"kalshi_gaming_lodging_monitor_{timestamp}.csv")
        excel_path = os.path.join(self.output_dir, "BofA_Gaming_Lodging_Kalshi_Tracker.xlsx")

        enriched_df.to_csv(csv_path, index=False)
        self._export_institutional_excel(enriched_df, sensitivity_df, excel_path)

        return {"csv_path": csv_path, "excel_path": excel_path}

    @staticmethod
    def _export_institutional_excel(
        market_df: pd.DataFrame,
        sensitivity_df: pd.DataFrame,
        excel_path: str
    ) -> None:
        """Writes a formatted multi-sheet Excel exhibit ready for Equity Research notes."""
        with pd.ExcelWriter(excel_path, engine="openpyxl") as writer:
            market_df.to_excel(writer, sheet_name="High_Freq_Market_Monitor", index=False)
            sensitivity_df.to_excel(writer, sheet_name="OSB_GGR_EBITDA_Sensitivity", index=False)

            # Auto-fit column widths for clean MS Office presentation
            for sheet_name in writer.sheets:
                worksheet = writer.sheets[sheet_name]
                for col in worksheet.columns:
                    max_len = max(len(str(cell.value or "")) for cell in col)
                    col_letter = col[0].column_letter
                    worksheet.column_dimensions[col_letter].width = max(max_len + 4, 14)
