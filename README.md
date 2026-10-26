# prediction-market-kalshi-project

# High-Frequency Prediction Market & Gaming/Lodging Equity Research Pipeline

An institutional-grade alternative data pipeline and financial modeling toolkit that ingests real-time orderbook liquidity, implied probabilities, and trade volume velocity from the **Kalshi REST API v2** to generate actionable insights for Equity Research.

## Institutional Investment Thesis & Sector Read-Through
As CFTC-regulated prediction exchanges scale into sports and macro event contracts, institutional investors face two critical questions across **Gaming & Lodging** coverage:
1. **Online Sports Betting (OSB) Hold & Handle Cannibalization (`DKNG`, `FLUT`, `MGM`, `CZR`, `PENN`):** Traditional sportsbooks charge a ~4.5%–5.0% structural overround ("vig") on straight wagers and achieve 9.5%–11.5% structural hold via Same-Game Parlays (SGPs). Prediction markets match peer-to-peer orderbook flow at tight 100–200 bps bid-ask spreads. This pipeline tracks real-time pricing dislocations (`vig_savings_vs_osb_bps`) and models downstream **GGR and Adj. EBITDA sensitivity**.
2. **High-Frequency Lodging & Las Vegas Strip Demand Indicators (`MAR`, `HLT`, `H`, `HST`, `VICI`, `WYNN`, `LVS`):** Event contracts tied to TSA daily passenger throughput, headline CPI discretionary pressure, and major Las Vegas event attendance provide real-time, crowd-arbitered probability distributions ahead of monthly STR RevPAR releases.

## Repository Architecture
```text
prediction-market-kalshi-project/
├── prediction_market_kalshi/
│   ├── __init__.py       # Package initialization & metadata
│   ├── __main__.py       # CLI entrypoint for automated daily research runs
│   ├── client.py         # Kalshi REST API v2 client with rate-limit backoff & sector dataset
│   ├── metrics.py        # Microstructure vig spread, Shannon entropy & OSB 3-statement sensitivity engine
│   └── pipeline.py       # ETL orchestrator & openpyxl institutional Excel exhibit generator
├── requirements.txt
└── README.md
