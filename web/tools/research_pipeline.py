#!/usr/bin/env python3
"""Local, credential-free research ETL and honest chronological model evaluation.

Fetches only the app's read-only endpoints. Never reads or exports Kalshi secrets.
The deployed app does not depend on Python or this local warehouse.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
import io
import math
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

CATEGORIES = ("travel", "weather", "inflation", "labor", "crypto")

SCHEMA = """
CREATE TABLE IF NOT EXISTS etl_runs (
  run_id VARCHAR PRIMARY KEY, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  status VARCHAR, quality_json JSON
);
CREATE TABLE IF NOT EXISTS raw_source_snapshots (
  source_id VARCHAR PRIMARY KEY, category VARCHAR, source_url VARCHAR,
  retrieved_at TIMESTAMPTZ, sha256 VARCHAR, snapshot BOOLEAN, payload JSON
);
CREATE TABLE IF NOT EXISTS dim_market (
  ticker VARCHAR PRIMARY KEY, event_ticker VARCHAR, category VARCHAR,
  close_time TIMESTAMPTZ, strike_type VARCHAR, floor_strike DOUBLE,
  cap_strike DOUBLE, primary_rules VARCHAR
);
CREATE TABLE IF NOT EXISTS fact_quotes (
  ticker VARCHAR, observed_at TIMESTAMPTZ, yes_bid DOUBLE, yes_ask DOUBLE,
  volume_24h DOUBLE, PRIMARY KEY(ticker, observed_at)
);
CREATE TABLE IF NOT EXISTS fact_predictions (
  ticker VARCHAR, predicted_at TIMESTAMPTZ, model_version VARCHAR,
  probability DOUBLE, lower_probability DOUBLE, upper_probability DOUBLE,
  category VARCHAR, status VARCHAR, source_as_of TIMESTAMPTZ,
  forecast DOUBLE, recorded_at TIMESTAMPTZ, close_time_at_prediction TIMESTAMPTZ,
  PRIMARY KEY(ticker, predicted_at, model_version)
);
ALTER TABLE fact_predictions ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;
ALTER TABLE fact_predictions ADD COLUMN IF NOT EXISTS close_time_at_prediction TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS fact_resolutions (
  ticker VARCHAR PRIMARY KEY, outcome INTEGER, checked_at TIMESTAMPTZ,
  source_url VARCHAR
);
CREATE OR REPLACE VIEW mart_model_evaluation AS
WITH candidates AS (
 SELECT p.*, q.yes_bid, q.yes_ask, q.volume_24h, m.event_ticker, p.close_time_at_prediction AS close_time,
   r.outcome, r.checked_at,
   ROW_NUMBER() OVER (PARTITION BY p.ticker ORDER BY p.predicted_at) AS prediction_order
 FROM fact_predictions p JOIN dim_market m USING(ticker)
 JOIN fact_resolutions r USING(ticker)
 ASOF LEFT JOIN fact_quotes q ON p.ticker=q.ticker AND p.predicted_at>=q.observed_at
 WHERE p.probability IS NOT NULL AND p.predicted_at<p.close_time_at_prediction
   AND p.recorded_at<p.close_time_at_prediction AND p.predicted_at<=p.recorded_at
   AND p.predicted_at<r.checked_at AND p.source_as_of<=p.predicted_at
)
SELECT *, (yes_bid+yes_ask)/2 AS market_probability,
  POWER(probability-outcome,2) AS model_brier,
  POWER((yes_bid+yes_ask)/2-outcome,2) AS market_brier,
  DATEDIFF('second',predicted_at,close_time)/86400.0 AS days_to_close
FROM candidates WHERE prediction_order=1 AND yes_bid>=0 AND yes_ask<=1
  AND yes_bid<=yes_ask;
CREATE OR REPLACE VIEW mart_category_metrics AS
SELECT category, COUNT(*) AS resolved_markets,
  COUNT(DISTINCT event_ticker) AS independent_events,
  AVG(model_brier) AS model_brier, AVG(market_brier) AS market_brier,
  AVG(market_brier-model_brier) AS brier_improvement
FROM mart_model_evaluation GROUP BY category;
"""


def utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def fetch_json(base: str, endpoint: str) -> dict:
    parsed = urlparse(base)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise ValueError("Use an HTTP(S) app origin without credentials")
    request = Request(base.rstrip("/") + "/api/" + endpoint, headers={"Accept": "application/json"})
    with urlopen(request, timeout=90) as response:
        body = response.read(12_000_001)
    if len(body) > 12_000_000:
        raise ValueError("App response exceeded the size bound")
    result = json.loads(body)
    if result.get("error"):
        raise ValueError(result["error"])
    return result


def open_warehouse(path: Path):
    import duckdb
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(path))
    connection.execute(SCHEMA)
    return connection


def quality_checks(report: dict) -> dict:
    seen = set()
    for row in report.get("markets", []):
        if row["ticker"] in seen:
            raise ValueError("Duplicate ticker in category snapshot")
        seen.add(row["ticker"])
        probability = row.get("probability")
        if probability is not None:
            if not finite(probability) or not 0 <= probability <= 1:
                raise ValueError("Probability outside [0,1]")
            lower, upper = row["interval"]
            if not all(finite(v) for v in (lower, upper)) or not 0 <= lower <= probability <= upper <= 1:
                raise ValueError("Invalid probability uncertainty interval")
    return {
        "category": report["category"]["id"], "rows": len(seen),
        "modeled": sum(finite(row.get("probability")) for row in report.get("markets", [])),
        "source_snapshots": sum(bool(source.get("snapshot")) for source in report.get("sources", [])),
        "source_errors": report.get("errors", []),
        "partial": report.get("partial", False),
    }


def ingest_report(connection, report: dict, recorded_at: str | None = None):
    quality = quality_checks(report)
    recorded_at = recorded_at or utc()
    category = report["category"]["id"]
    for source in report.get("sources", []):
        source_id = hashlib.sha256((category + source["source_url"] + source["retrieved_at"]).encode()).hexdigest()
        connection.execute(
            "INSERT OR IGNORE INTO raw_source_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)",
            [source_id, category, source["source_url"], source["retrieved_at"], source["sha256"],
             bool(source.get("snapshot")), json.dumps(source, allow_nan=False)],
        )
    lineage = {row["series"]: row["as_of"] for row in report.get("quote_lineage", [])}
    for row in report.get("markets", []):
        connection.execute(
            """INSERT INTO dim_market VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
            close_time=excluded.close_time, primary_rules=excluded.primary_rules""",
            [row["ticker"], row.get("event_ticker"), category, row.get("close_time"),
             row.get("strike_type"), row.get("floor_strike"), row.get("cap_strike"), row.get("rules_primary")],
        )
        if row["series"] in lineage:
            connection.execute(
                "INSERT OR IGNORE INTO fact_quotes VALUES (?, ?, ?, ?, ?)",
                [row["ticker"], lineage[row["series"]], row.get("yes_bid"), row.get("yes_ask"), row.get("volume_24h")],
            )
        interval = row.get("interval") or [None, None]
        connection.execute(
            """INSERT OR IGNORE INTO fact_predictions
            (ticker,predicted_at,model_version,probability,lower_probability,upper_probability,
             category,status,source_as_of,forecast,recorded_at,close_time_at_prediction)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [row["ticker"], report["as_of"], report["model_version"], row.get("probability"),
             interval[0], interval[1], category, row["status"], row.get("source_as_of"), row.get("center"),recorded_at,row.get("close_time")],
        )
    return quality


def collect(base: str, output: Path, categories=CATEGORIES) -> dict:
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    connection = open_warehouse(output / "research.duckdb")
    connection.execute("INSERT INTO etl_runs VALUES (?, ?, NULL, 'running', NULL)", [run_id, utc()])
    quality, failures = [], []
    for category in categories:
        try:
            report = fetch_json(base, "intelligence?" + urlencode({"category": category}))
            bronze = output / "bronze" / category
            bronze.mkdir(parents=True, exist_ok=True)
            (bronze / (run_id + ".json")).write_text(json.dumps(report, indent=2, allow_nan=False))
            connection.execute("BEGIN TRANSACTION")
            try:
                quality.append(ingest_report(connection, report))
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        except Exception as error:
            failures.append({"category": category, "error": str(error)})
    status = "partial" if failures or any(row["source_snapshots"] or row["source_errors"] for row in quality) else "success"
    if not quality:
        status = "failed"
    result = {"run_id": run_id, "status": status, "categories": quality, "failures": failures}
    connection.execute("UPDATE etl_runs SET completed_at=?, status=?, quality_json=? WHERE run_id=?",
                       [utc(), status, json.dumps(result), run_id])
    parquet = output / "silver"
    parquet.mkdir(parents=True, exist_ok=True)
    for table in ("dim_market", "fact_quotes", "fact_predictions", "fact_resolutions"):
        connection.execute(f"COPY {table} TO ? (FORMAT PARQUET)", [str(parquet / (table + ".parquet"))])
    (output / "quality.json").write_text(json.dumps(result, indent=2))
    connection.close()
    return result


def resolve(base: str, output: Path, limit: int) -> dict:
    connection = open_warehouse(output / "research.duckdb")
    pending = connection.execute("""
      SELECT m.ticker FROM dim_market m
      LEFT JOIN fact_resolutions r USING(ticker)
      WHERE r.ticker IS NULL AND m.close_time<CURRENT_TIMESTAMP
      ORDER BY m.close_time DESC LIMIT ?
    """, [limit]).fetchall()
    resolved, failures = 0, []
    for (ticker,) in pending:
        try:
            result = fetch_json(base, "market?" + urlencode({"ticker": ticker}))
            outcome = result.get("market", {}).get("result")
            if outcome in ("yes", "no"):
                connection.execute("INSERT OR IGNORE INTO fact_resolutions VALUES (?, ?, ?, ?)",
                                   [ticker, int(outcome == "yes"), result["as_of"], result["source_url"]])
                resolved += 1
        except Exception as error:
            failures.append({"ticker": ticker, "error": str(error)})
    connection.close()
    return {"checked": len(pending), "resolved": resolved, "failures": failures}


def fit_stacking(records: list[dict]) -> dict:
    """Group-separated chronological logistic stacking. No random train/test leakage."""
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import brier_score_loss, log_loss
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    records = sorted(records, key=lambda row: str(row["predicted_at"]))
    if len(records) < 100 or len({row["event_ticker"] for row in records}) < 50:
        return {"state": "insufficient_samples", "resolved_markets": len(records),
                "required": "At least 100 distinct resolved markets and 50 events; no fabricated training data is used."}
    boundary = int(len(records) * .75)
    test = records[boundary:]
    test_events = {row["event_ticker"] for row in test}
    train = [row for row in records[:boundary] if row["event_ticker"] not in test_events]
    if len(train) < 50 or len(test) < 20 or len({row["outcome"] for row in train}) < 2:
        return {"state": "insufficient_independent_training_data"}

    def logit(value):
        value = min(1 - 1e-6, max(1e-6, value))
        return math.log(value / (1 - value))

    def features(row):
        return [
            logit(row["probability"]), logit(row["market_probability"]),
            row["yes_ask"] - row["yes_bid"], row["upper_probability"] - row["lower_probability"],
            math.log1p(max(0, row["volume_24h"] or 0)), min(365, max(0, row["days_to_close"])),
        ]

    model = make_pipeline(StandardScaler(), LogisticRegression(C=.1, max_iter=2000, random_state=42))
    model.fit(np.array([features(row) for row in train]), np.array([row["outcome"] for row in train]))
    probabilities = model.predict_proba(np.array([features(row) for row in test]))[:, 1]
    outcomes = np.array([row["outcome"] for row in test])
    market = np.array([row["market_probability"] for row in test])
    improvement = (market - outcomes) ** 2 - (probabilities - outcomes) ** 2
    # Resample entire events, never pretend sibling contracts are independent.
    events = sorted({row["event_ticker"] for row in test})
    grouped = {event: [index for index, row in enumerate(test) if row["event_ticker"] == event] for event in events}
    rng = np.random.default_rng(42)
    bootstrap = []
    for _ in range(500):
        indices = [index for event in rng.choice(events, len(events), replace=True) for index in grouped[event]]
        bootstrap.append(float(np.mean(improvement[indices])))
    scaler, classifier = model.steps[0][1], model.steps[1][1]
    return {
        "state": "evaluated_not_promoted", "method": "L2 logistic stacking; chronological event-separated holdout",
        "train_markets": len(train), "test_markets": len(test), "test_events": len(events),
        "model_brier": float(brier_score_loss(outcomes, probabilities)),
        "market_brier": float(brier_score_loss(outcomes, market)),
        "model_log_loss": float(log_loss(outcomes, probabilities, labels=[0, 1])),
        "market_log_loss": float(log_loss(outcomes, market, labels=[0, 1])),
        "event_bootstrap_brier_improvement_95": np.quantile(bootstrap, [.025, .975]).tolist(),
        "feature_names": ["model_logit", "market_logit", "spread", "probability_band", "log_volume", "days_to_close"],
        "scaler_mean": scaler.mean_.tolist(), "scaler_scale": scaler.scale_.tolist(),
        "coefficients": classifier.coef_[0].tolist(), "intercept": float(classifier.intercept_[0]),
        "warning": "Not automatically promoted to the live app. This is forecast scoring, not evidence of executable, fee-adjusted P&L.",
    }


def train(output: Path) -> dict:
    connection = open_warehouse(output / "research.duckdb")
    cursor = connection.execute("SELECT * FROM mart_model_evaluation ORDER BY predicted_at")
    names = [item[0] for item in cursor.description]
    records = [dict(zip(names, row)) for row in cursor.fetchall()]
    result = fit_stacking(records)
    connection.close()
    (output / "calibration-report.json").write_text(json.dumps(result, indent=2))
    return result


def refresh_fred(snapshot: Path) -> dict:
    """Refresh the genuine public-source fallback from Python's HTTP client."""
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL,UNRATE"
    request = Request(url, headers={"Accept": "text/csv", "User-Agent": "KalshiResearch/1.0"})
    try:
        with urlopen(request, timeout=30) as response:
            text = response.read(2_000_001).decode("utf-8")
    except HTTPError as error:
        # This public FRED endpoint can return an origin/client HTTP 520 while
        # succeeding with curl. Never retry a 429 or bypass a provider cooldown.
        if error.code != 520 or not shutil.which("curl"):
            raise
        result = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--max-time", "30",
             "--max-filesize", "2000000", url],
            capture_output=True, check=True, timeout=35,
        )
        text = result.stdout.decode("utf-8")
    if len(text) > 2_000_000:
        raise ValueError("FRED response exceeded size bound")
    rows = list(csv.DictReader(io.StringIO(text)))
    if len(rows) < 120 or not {"CPIAUCSL", "UNRATE"}.issubset(rows[0]):
        raise ValueError("FRED data schema or history is insufficient")
    value = {
        "source_url": url, "retrieved_at": utc(),
        "sha256": hashlib.sha256(text.encode()).hexdigest(), "text": text,
        "description": "Actual FRED CSV retrieval. Archived fallback only; never label this snapshot as a live retrieval.",
    }
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    snapshot.write_text(json.dumps(value, indent=2) + "\n")
    return {"state": "snapshot_refreshed", "rows": len(rows), "retrieved_at": value["retrieved_at"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("ingest", "resolve", "train", "refresh-fred"))
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--output", type=Path, default=Path(".research"))
    parser.add_argument("--category", choices=CATEGORIES)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--snapshot", type=Path, default=Path("lib/intelligence/data/fred-snapshot.json"))
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error("--limit must be 1–100")
    args.output.mkdir(parents=True, exist_ok=True)
    if args.command == "refresh-fred":
        result = refresh_fred(args.snapshot)
    elif args.command == "ingest":
        result = collect(args.base_url, args.output, (args.category,) if args.category else CATEGORIES)
    elif args.command == "resolve":
        result = resolve(args.base_url, args.output, args.limit)
    else:
        result = train(args.output)
    print(json.dumps(result, indent=2, default=str))
    if result.get("status") == "failed":
        sys.exit(1)


if __name__ == "__main__":
    main()
