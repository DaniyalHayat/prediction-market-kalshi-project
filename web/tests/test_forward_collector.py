import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("forward_collector", Path(__file__).resolve().parents[1] / "tools" / "forward_collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def fixtures():
    initial = {
        "id": "00000000-0000-4000-8000-000000000001", "protocol_hash": "test-protocol",
        "audit": {"last_hash": "original"}, "frozen": {
            "strategy_version": "synthetic-test-only", "protocol": {"seconds": 60},
            "created_at": "2026-01-01T00:00:00Z", "due_at": "2026-01-01T00:01:00Z",
            "legs": [{"ticker": "TEST", "event_ticker": "EVENT", "category": "crypto",
                      "frozen_at": "2026-01-01T00:00:00Z", "features": {"book_mid": .5},
                      "signals": [{"id": "test", "predicted_yes_mid": .6,
                                   "decision": {"action": "paper-entry", "entry": {"all_in": 5.18}}}]}],
        },
    }
    completed = copy.deepcopy(initial)
    completed.update(status="completed", audit={"verified": True, "freeze_hash": "original", "last_hash": "final"})
    completed["result"] = {
        "recorded_at": "2026-01-01T00:01:01Z",
        "markouts": [{"ticker": "TEST", "event_ticker": "EVENT", "category": "crypto",
                      "exit_as_of": "2026-01-01T00:01:00Z", "elapsed_seconds": 60, "on_time": True,
                      "signals": [{"strategy": "test", "predicted_yes_mid": .6, "fully_liquidated": True,
                                   "exit": {"net_proceeds": 5.6}, "net_pnl": .42, "gross_pnl": .5,
                                   "fees_paid": .08, "squared_error": 0, "persistence_squared_error": .01}]}],
    }
    return initial, completed


class ForwardCollectorTests(unittest.TestCase):
    def test_real_future_timing_and_initial_audit_anchor_are_required(self):
        initial, completed = fixtures()
        self.assertTrue(collector.validate_completion(initial, completed))
        completed["audit"]["freeze_hash"] = "changed"
        with self.assertRaises(ValueError):
            collector.validate_completion(initial, completed)

    def test_refitting_after_entry_and_inflated_profit_are_rejected(self):
        initial, completed = fixtures()
        completed["frozen"]["legs"][0]["signals"][0]["predicted_yes_mid"] = .99
        with self.assertRaises(ValueError):
            collector.validate_completion(initial, completed)
        initial, completed = fixtures()
        completed["result"]["markouts"][0]["signals"][0]["net_pnl"] = 1000
        with self.assertRaises(ValueError):
            collector.validate_completion(initial, completed)

    def test_late_or_dropped_observations_cannot_be_silently_scored(self):
        initial, completed = fixtures()
        completed["result"]["markouts"][0]["exit_as_of"] = "2026-01-01T00:02:00Z"
        with self.assertRaises(ValueError):
            collector.validate_completion(initial, completed)
        initial, completed = fixtures()
        completed["result"]["markouts"] = []
        with self.assertRaises(ValueError):
            collector.validate_completion(initial, completed)

    def test_forward_warehouse_is_idempotent_and_keeps_cost_adjusted_results(self):
        _, completed = fixtures()
        with tempfile.TemporaryDirectory() as directory:
            db = collector.open_warehouse(Path(directory) / "research.duckdb")
            collector.archive_completion(db, completed)
            collector.archive_completion(db, completed)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM forward_markouts").fetchone()[0], 1)
            self.assertAlmostEqual(db.execute("SELECT net_paper_pnl FROM mart_forward_performance").fetchone()[0], .42)
            db.close()


if __name__ == "__main__":
    unittest.main()
