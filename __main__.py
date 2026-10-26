import argparse
import logging
from .pipeline import EquityResearchPipeline


def main():
    parser = argparse.ArgumentParser(
        description="Kalshi Prediction Market & Gaming/Lodging Equity Research Pipeline"
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Query live Kalshi REST v2 API (defaults to calibrated Gaming & Lodging coverage dataset)"
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="outputs",
        help="Directory for CSV and Excel research exhibits"
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    pipeline = EquityResearchPipeline(output_dir=args.output_dir, use_live_api=args.live)
    artifacts = pipeline.run()

    print("\n" + "=" * 75)
    print("GAMING & LODGING HIGH-FREQUENCY PREDICTION MARKET MONITOR COMPLETE")
    print("=" * 75)
    print(f"1. High-Frequency CSV Dataset : {artifacts['csv_path']}")
    print(f"2. Institutional Excel Exhibit: {artifacts['excel_path']}")
    print("=" * 75)


if __name__ == "__main__":
    main()
