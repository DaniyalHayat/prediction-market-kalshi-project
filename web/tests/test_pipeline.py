import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("research_pipeline", Path(__file__).resolve().parents[1] / "tools" / "research_pipeline.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


def fixture():
    return {
        "category": {"id": "travel"}, "as_of": "2026-01-01T12:00:00Z", "model_version": "test-v1",
        "quote_lineage": [{"series": "TEST", "as_of": "2026-01-01T11:59:00Z"}],
        "sources": [{"source_url": "https://www.tsa.gov/test", "retrieved_at": "2026-01-01T11:00:00Z", "sha256": "test", "rows": []}],
        "markets": [{
            "ticker": "TEST-A", "event_ticker": "TEST-EVENT", "series": "TEST", "close_time": "2026-01-02T00:00:00Z",
            "strike_type": "greater", "floor_strike": 100, "cap_strike": None, "rules_primary": "Synthetic unit-test rule",
            "yes_bid": .4, "yes_ask": .5, "volume_24h": 100, "probability": .6, "interval": [.45, .7],
            "status": "research candidate", "source_as_of": "2026-01-01T11:00:00Z", "center": 105,
        }],
    }


class PipelineTests(unittest.TestCase):
    def test_data_quality_rejects_invalid_probabilities_and_duplicates(self):
        value = fixture()
        self.assertEqual(pipeline.quality_checks(value)["modeled"], 1)
        value["markets"][0]["probability"] = 1.1
        with self.assertRaises(ValueError):
            pipeline.quality_checks(value)
        value = fixture()
        value["markets"].append(value["markets"][0])
        with self.assertRaises(ValueError):
            pipeline.quality_checks(value)

    def test_warehouse_idempotency_and_no_post_close_training_leakage(self):
        with tempfile.TemporaryDirectory() as directory:
            db = pipeline.open_warehouse(Path(directory) / "test.duckdb")
            value = fixture()
            pipeline.ingest_report(db, value, "2026-01-01T12:00:01Z")
            pipeline.ingest_report(db, value, "2026-01-01T12:00:02Z")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM fact_predictions").fetchone()[0], 1)
            db.execute("INSERT INTO fact_resolutions VALUES ('TEST-A',1,'2026-01-03','https://example.com/test')")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mart_model_evaluation").fetchone()[0], 1)
            value["as_of"] = "2026-01-04T00:00:00Z"
            pipeline.ingest_report(db, value, "2026-01-04T00:00:01Z")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mart_model_evaluation").fetchone()[0], 1)
            db.close()

    def test_late_archival_or_later_close_edits_cannot_create_a_pre_close_track_record(self):
        with tempfile.TemporaryDirectory() as directory:
            db = pipeline.open_warehouse(Path(directory) / "late.duckdb")
            value = fixture()
            pipeline.ingest_report(db, value, "2026-01-04T00:00:00Z")
            db.execute("INSERT INTO fact_resolutions VALUES ('TEST-A',1,'2026-01-05','https://example.com/test')")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mart_model_evaluation").fetchone()[0], 0)
            value["markets"][0]["close_time"] = "2026-01-10T00:00:00Z"
            pipeline.ingest_report(db, value, "2026-01-04T01:00:00Z")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mart_model_evaluation").fetchone()[0], 0)
            db.close()

    def test_calibration_refuses_an_empty_training_set(self):
        self.assertEqual(pipeline.fit_stacking([])["state"], "insufficient_samples")

    def test_stacking_has_an_event_separated_holdout_and_bootstrap(self):
        # Synthetic fixtures test the algorithm only. They are never written to the production warehouse.
        rows = []
        for index in range(160):
            p = .2 + (index % 7) * .1
            rows.append({
                "predicted_at": f"{index:04}", "event_ticker": f"EVENT-{index // 2}", "outcome": int(index % 3 != 0),
                "probability": p, "market_probability": .5, "yes_ask": .52, "yes_bid": .48,
                "upper_probability": min(1, p + .15), "lower_probability": max(0, p - .15),
                "volume_24h": 100, "days_to_close": 1,
            })
        result = pipeline.fit_stacking(rows)
        self.assertEqual(result["state"], "evaluated_not_promoted")
        self.assertEqual(result["train_markets"], 120)
        self.assertEqual(result["test_events"], 20)
        self.assertEqual(len(result["event_bootstrap_brier_improvement_95"]), 2)
        json.dumps(result, allow_nan=False)

    def test_fred_origin_520_uses_public_curl_client_without_inventing_data(self):
        csv = "observation_date,CPIAUCSL,UNRATE\n" + "".join(f"2000-{i % 12 + 1:02}-01,200,4\n" for i in range(120))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            with patch.object(pipeline, "urlopen", side_effect=HTTPError("https://fred.stlouisfed.org", 520, "origin", {}, None)):
                with patch.object(pipeline.shutil, "which", return_value="/usr/bin/curl"):
                    with patch.object(pipeline.subprocess, "run", return_value=SimpleNamespace(stdout=csv.encode())):
                        self.assertEqual(pipeline.refresh_fred(path)["state"], "snapshot_refreshed")
            self.assertEqual(json.loads(path.read_text())["text"], csv)

    def test_fred_rate_limit_never_retries_through_a_different_client(self):
        with patch.object(pipeline, "urlopen", side_effect=HTTPError("https://fred.stlouisfed.org", 429, "limited", {}, None)):
            with patch.object(pipeline.subprocess, "run") as curl:
                with self.assertRaises(HTTPError):
                    pipeline.refresh_fred(Path("/tmp/unused-fred-rate-test.json"))
                curl.assert_not_called()


if __name__ == "__main__":
    unittest.main()
