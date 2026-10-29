#!/usr/bin/env python3
"""Preregister a fixed number of live paper cohorts and collect their future books.

No real orders, account data, API credentials, synthetic price paths or
stop-when-profitable logic. Keep this process running while the browser is closed.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import sys
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from research_pipeline import open_warehouse  # noqa: E402

FORWARD_SCHEMA = """
CREATE TABLE IF NOT EXISTS forward_cohorts (
 cohort_id VARCHAR PRIMARY KEY, strategy_version VARCHAR, protocol_hash VARCHAR,
 created_at TIMESTAMPTZ, due_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
 freeze_hash VARCHAR, final_hash VARCHAR, protocol JSON, result JSON
);
CREATE TABLE IF NOT EXISTS forward_forecasts (
 cohort_id VARCHAR, ticker VARCHAR, event_ticker VARCHAR, category VARCHAR,
 strategy VARCHAR, frozen_at TIMESTAMPTZ, predicted_mid DOUBLE, entry_mid DOUBLE,
 action VARCHAR, decision JSON, PRIMARY KEY(cohort_id,ticker,strategy)
);
CREATE TABLE IF NOT EXISTS forward_markouts (
 cohort_id VARCHAR, ticker VARCHAR, strategy VARCHAR, observed_at TIMESTAMPTZ,
 actual_seconds DOUBLE, on_time BOOLEAN, fully_liquidated BOOLEAN,
 net_pnl DOUBLE, gross_pnl DOUBLE, fees DOUBLE, squared_error DOUBLE,
 persistence_squared_error DOUBLE, payload JSON,
 PRIMARY KEY(cohort_id,ticker,strategy)
);
CREATE OR REPLACE VIEW mart_forward_performance AS
SELECT c.strategy_version,c.protocol_hash,f.strategy,
 COUNT(DISTINCT f.event_ticker) AS event_groups,
 COUNT(*) AS observed_forecasts,
 SUM(CASE WHEN m.fully_liquidated THEN 1 ELSE 0 END) AS complete_paper_exits,
 SUM(CASE WHEN m.fully_liquidated THEN m.net_pnl ELSE NULL END) AS net_paper_pnl,
 SUM(CASE WHEN m.fully_liquidated THEN m.gross_pnl ELSE NULL END) AS gross_paper_pnl,
 SUM(CASE WHEN m.fully_liquidated THEN m.fees ELSE NULL END) AS modeled_fees,
 AVG(m.squared_error) AS price_mse,
 AVG(CASE WHEN m.squared_error IS NOT NULL THEN m.persistence_squared_error ELSE NULL END) AS paired_persistence_mse
FROM forward_forecasts f JOIN forward_cohorts c USING(cohort_id)
JOIN forward_markouts m USING(cohort_id,ticker,strategy)
WHERE m.on_time
GROUP BY c.strategy_version,c.protocol_hash,f.strategy;
"""


def request_json(base, suffix, body=None):
    parsed = urlparse(base)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise ValueError("Use a trusted app origin without URL credentials")
    payload = None if body is None else json.dumps(body, allow_nan=False).encode()
    request = Request(
        base.rstrip("/") + "/api/intelligence/forward" + suffix,
        data=payload, headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    with urlopen(request, timeout=120) as response:
        raw = response.read(8_000_001)
    if len(raw) > 8_000_000:
        raise ValueError("Cohort response exceeds size bound")
    result = json.loads(raw)
    if result.get("error"):
        raise ValueError(result["error"])
    return result


def valid_id(value):
    return str(uuid.UUID(value))


def validate_completion(initial, completed):
    if completed.get("status") != "completed" or not completed.get("result"):
        raise ValueError("No future observation was recorded")
    if initial["id"] != completed["id"] or initial["frozen"] != completed["frozen"]:
        raise ValueError("Frozen forecast/protocol changed after the entry snapshot")
    if not completed["audit"].get("verified") or completed["audit"].get("freeze_hash") != initial["audit"]["last_hash"]:
        raise ValueError("Audit chain is not anchored to the locally archived initial response")
    expected = {leg["ticker"]: leg for leg in initial["frozen"]["legs"] if not leg.get("error")}
    observed = completed["result"]["markouts"]
    if len(observed) != len(expected) or {row["ticker"] for row in observed} != set(expected):
        raise ValueError("A frozen contract was silently dropped or duplicated")
    seconds = initial["frozen"]["protocol"]["seconds"]
    for row in observed:
        if row.get("error"):
            continue
        leg = expected[row["ticker"]]
        elapsed = (
            datetime.fromisoformat(row["exit_as_of"].replace("Z", "+00:00"))
            - datetime.fromisoformat(leg["frozen_at"].replace("Z", "+00:00"))
        ).total_seconds()
        if abs(elapsed - row["elapsed_seconds"]) > .01 or elapsed < seconds:
            raise ValueError("Future markout precedes the preregistered horizon")
        if row["on_time"] != (elapsed <= seconds + 30):
            raise ValueError("Late observation was relabeled on-time")
        signals = {signal["id"]: signal for signal in leg["signals"]}
        if {signal["strategy"] for signal in row["signals"]} != set(signals):
            raise ValueError("A predeclared candidate disappeared")
        for signal in row["signals"]:
            entry = signals[signal["strategy"]]
            if signal["predicted_yes_mid"] != entry["predicted_yes_mid"]:
                raise ValueError("A forecast was replaced after its outcome was observed")
            if signal.get("fully_liquidated"):
                pnl = signal["exit"]["net_proceeds"] - entry["decision"]["entry"]["all_in"]
                if not math.isfinite(signal["net_pnl"]) or abs(pnl - signal["net_pnl"]) > 1e-8:
                    raise ValueError("Net paper P&L does not include frozen entry cost and exit fees")
            elif signal.get("net_pnl") is not None:
                raise ValueError("An incomplete position was counted as a complete profit/loss")
    return True


def archive_completion(connection, completed):
    connection.execute(FORWARD_SCHEMA)
    frozen, result = completed["frozen"], completed["result"]
    connection.execute("BEGIN TRANSACTION")
    try:
        connection.execute(
            "INSERT OR IGNORE INTO forward_cohorts VALUES (?,?,?,?,?,?,?,?,?,?)",
            [completed["id"], frozen["strategy_version"], completed["protocol_hash"], frozen["created_at"],
             frozen["due_at"], result["recorded_at"], completed["audit"]["freeze_hash"],
             completed["audit"]["last_hash"], json.dumps(frozen["protocol"]), json.dumps(result)],
        )
        for leg in frozen["legs"]:
            if leg.get("error"):
                continue
            for signal in leg["signals"]:
                connection.execute(
                    "INSERT OR IGNORE INTO forward_forecasts VALUES (?,?,?,?,?,?,?,?,?,?)",
                    [completed["id"], leg["ticker"], leg["event_ticker"], leg["category"], signal["id"],
                     leg["frozen_at"], signal["predicted_yes_mid"], leg["features"]["book_mid"],
                     signal["decision"]["action"], json.dumps(signal["decision"])],
                )
        for mark in result["markouts"]:
            if mark.get("error"):
                continue
            for signal in mark["signals"]:
                connection.execute(
                    "INSERT OR IGNORE INTO forward_markouts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [completed["id"], mark["ticker"], signal["strategy"], mark["exit_as_of"],
                     mark["elapsed_seconds"], mark["on_time"], signal["fully_liquidated"],
                     signal["net_pnl"], signal["gross_pnl"], signal.get("fees_paid"),
                     signal["squared_error"], signal["persistence_squared_error"], json.dumps(signal)],
                )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise


def collect_forward(base, output, cohorts=3, seconds=60, per_category=1, contracts=10):
    output.mkdir(parents=True, exist_ok=True)
    protocol = {"categories": ["crypto", "weather", "labor", "inflation", "travel"],
                "seconds": seconds, "per_category": per_category, "contracts": contracts,
                "slippage": 2, "coefficient": .07}
    plan = {"planned_cohorts": cohorts, "protocol": protocol,
            "stopping_rule": "Fixed count committed before any result; never stop or retune on profitability."}
    plan_path = output / ("forward-plan-" + str(uuid.uuid4()) + ".json")
    plan_path.write_text(json.dumps(plan, indent=2))
    connection = open_warehouse(output / "research.duckdb")
    connection.execute(FORWARD_SCHEMA)
    summaries = []
    try:
        for index in range(cohorts):
            initial = request_json(base, "/start", protocol)
            folder = output / "forward" / valid_id(initial["id"])
            folder.mkdir(parents=True, exist_ok=True)
            # Exclusive creation: no overwriting an inconvenient original prediction.
            with (folder / "frozen.json").open("x") as handle:
                json.dump(initial, handle, indent=2, allow_nan=False)
            print(json.dumps({"state": "frozen", "cohort": index + 1, "id": initial["id"],
                              "due_at": initial["frozen"]["due_at"]}), flush=True)
            due = datetime.fromisoformat(initial["frozen"]["due_at"].replace("Z", "+00:00"))
            server = datetime.fromisoformat(initial["server_time"].replace("Z", "+00:00"))
            time.sleep(max(0, (due - server).total_seconds()) + .7)
            completed = request_json(base, "/checkpoint", {"id": initial["id"]})
            validate_completion(initial, completed)
            with (folder / "observed.json").open("x") as handle:
                json.dump(completed, handle, indent=2, allow_nan=False)
            archive_completion(connection, completed)
            summaries.append({"id": completed["id"], "summary": completed["result"]["summary"]})
            print(json.dumps({"state": "observed", **summaries[-1]}), flush=True)
        for table in ("forward_cohorts", "forward_forecasts", "forward_markouts"):
            destination = output / "silver" / (table + ".parquet")
            destination.parent.mkdir(parents=True, exist_ok=True)
            connection.execute(f"COPY {table} TO ? (FORMAT PARQUET)", [str(destination)])
    finally:
        connection.close()
    result = {"plan": plan, "completed_cohorts": len(summaries), "cohorts": summaries,
              "classification": "Real future market observations with simulated fills; not actual executed profits."}
    (output / "forward-results.json").write_text(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:3000")
    parser.add_argument("--output", type=Path, default=Path(".research"))
    parser.add_argument("--cohorts", type=int, default=3)
    parser.add_argument("--seconds", type=int, choices=(60, 300, 900), default=60)
    parser.add_argument("--per-category", type=int, choices=(1, 2), default=1)
    parser.add_argument("--contracts", type=int, default=10)
    args = parser.parse_args()
    if not 1 <= args.cohorts <= 10 or not 1 <= args.contracts <= 1000:
        parser.error("Use 1–10 fixed cohorts and 1–1000 contracts")
    collect_forward(args.base_url, args.output, args.cohorts, args.seconds, args.per_category, args.contracts)


if __name__ == "__main__":
    main()
