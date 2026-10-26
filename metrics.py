import math
from typing import Dict, Any, Optional
import numpy as np
import pandas as pd


class GamingLodgingMetricsEngine:
    """
    Quantitative Analytics & Equity Research Metrics Engine.
    Translates raw prediction market microstructure data into actionable
    Gaming (OSB Hold/Vig/Handle) and Lodging (RevPAR/Demand) financial metrics.
    """

    @staticmethod
    def american_odds_to_implied_prob(odds: Optional[float]) -> Optional[float]:
        """Converts traditional sportsbook American odds (-110, +240) to raw implied probability."""
        if odds is None or pd.isna(odds) or odds == 0:
            return None
        if odds > 0:
            return 100.0 / (odds + 100.0)
        return abs(odds) / (abs(odds) + 100.0)

    @staticmethod
    def compute_microstructure_metrics(df: pd.DataFrame) -> pd.DataFrame:
        """
        Computes institutional microstructure and OSB comparison metrics:
        - Mid-Market Implied Probability (%)
        - Bid-Ask Spread (bps) & Effective Exchange Take Rate
        - Traditional OSB Vig vs. Exchange Spread Savings (bps) -> "OSB Pricing Dislocation"
        - Volume-to-Open-Interest Velocity Ratio (Turnover)
        - Shannon Informational Entropy (Uncertainty index)
        """
        out = df.copy()

        # 1. Mid-price Implied Probability (Kalshi prices are 1-99 cents = % probability)
        out["mid_prob_pct"] = (out["yes_bid"] + out["yes_ask"]) / 2.0
        out["kalshi_spread_pct"] = out["yes_ask"] - out["yes_bid"]
        out["kalshi_overround_pct"] = (out["yes_ask"] + out["no_ask"]) - 100.0

        # 2. Liquidity & Turnover Velocity
        out["turnover_velocity_ratio"] = np.where(
            out["open_interest"] > 0,
            (out["volume_24h"] / out["open_interest"]).round(4),
            0.0
        )

        # 3. OSB Comparison: Vig Compression & Handle Cannibalization Risk Score
        out["osb_implied_prob_pct"] = out["traditional_osb_american_odds"].apply(
            lambda x: round(GamingLodgingMetricsEngine.american_odds_to_implied_prob(x) * 100, 2)
            if GamingLodgingMetricsEngine.american_odds_to_implied_prob(x) is not None else np.nan
        )

        # Price Dislocation: How much better price retail/sharp flow gets on Kalshi vs. OSB
        out["vig_savings_vs_osb_bps"] = np.where(
            out["traditional_osb_overround_pct"].notna(),
            ((out["traditional_osb_overround_pct"] - out["kalshi_spread_pct"]) * 100).round(0),
            np.nan
        )

        # 4. Shannon Entropy (H = -p*log2(p) - (1-p)*log2(1-p)) -> measures market consensus certainty
        def _entropy(p_pct: float) -> float:
            p = np.clip(p_pct / 100.0, 1e-6, 1 - 1e-6)
            return round(-(p * math.log2(p) + (1 - p) * math.log2(1 - p)), 4)

        out["consensus_entropy"] = out["mid_prob_pct"].apply(_entropy)

        return out

    @staticmethod
    def build_osb_sensitivity_table(
        base_annual_handle_bn: float = 48.0,
        base_structural_hold_pct: float = 10.5,
        ebitda_flowthrough_pct: float = 52.0
    ) -> pd.DataFrame:
        """
        Generates a 3-Statement Equity Research Sensitivity Table modeling the impact of
        Prediction Market (Kalshi/Polymarket) handle cannibalization and structural hold
        compression on a Tier-1 OSB Operator (e.g., DraftKings / FanDuel).
        """
        handle_cannibalization_scenarios = [0.0, -2.5, -5.0, -7.5, -10.0]  # % Handle lost to exchanges
        hold_compression_bps = [0, -25, -50, -75, -100]  # bps compression in net gaming hold

        rows = []
        base_ggr_mm = base_annual_handle_bn * 1000 * (base_structural_hold_pct / 100.0)

        for h_shock in handle_cannibalization_scenarios:
            shocked_handle_bn = base_annual_handle_bn * (1.0 + h_shock / 100.0)
            for hold_shock_bps in hold_compression_bps:
                shocked_hold_pct = base_structural_hold_pct + (hold_shock_bps / 100.0)
                implied_ggr_mm = shocked_handle_bn * 1000 * (shocked_hold_pct / 100.0)
                ggr_delta_mm = implied_ggr_mm - base_ggr_mm
                ebitda_impact_mm = ggr_delta_mm * (ebitda_flowthrough_pct / 100.0)

                rows.append({
                    "Handle_Shock_Pct": f"{h_shock:+.1f}%",
                    "Hold_Compression_Bps": f"{hold_shock_bps:+d} bps",
                    "Implied_Handle_Bn": round(shocked_handle_bn, 2),
                    "Effective_Net_Hold_Pct": round(shocked_hold_pct, 2),
                    "Implied_GGR_MM": round(implied_ggr_mm, 1),
                    "GGR_Variance_vs_Base_MM": round(ggr_delta_mm, 1),
                    "Adj_EBITDA_Impact_MM": round(ebitda_impact_mm, 1),
                })

        return pd.DataFrame(rows)
