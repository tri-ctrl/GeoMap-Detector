"""Local backend diagnostics use real orchestration with imagery/ML facades."""
from contextlib import ExitStack
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import test_identity
from test_identity import load, feature

Trace = load("gmd020_telemetry", "telemetry.py").Trace


class TelemetryTests(unittest.TestCase):
    def test_monotonic_clock_balanced_errors_and_scalar_payloads(self):
        clock = [10.0]
        trace = Trace(clock=lambda: clock[0])
        with trace.span("job", jobId="job", modelKey="m" * 10000, geometry={"secret": True}):
            clock[0] = 10.1
        with self.assertRaises(ValueError):
            with trace.span("imagery"):
                clock[0] = 10.2
                raise ValueError("PRIVATE ERROR DETAILS")
        with trace.span("clip"):
            clock[0] = 9
        result = trace.snapshot()
        ends = [e for e in result["events"] if e["type"] == "end"]
        self.assertAlmostEqual(ends[0]["durationMs"], 100)
        self.assertEqual([e["status"] for e in ends], ["ok", "error", "ok"])
        self.assertTrue(all(e["durationMs"] >= 0 for e in ends))
        self.assertNotIn("PRIVATE ERROR DETAILS", json.dumps(result))
        self.assertNotIn("geometry", json.dumps(result))
        self.assertEqual(len(ends[0]["modelKey"]), 160)
        self.assertEqual(result["active"], [])
        ends[0]["durationMs"] = -1
        self.assertGreaterEqual(trace.snapshot()["events"][1]["durationMs"], 0)

    def test_ring_and_active_limits_do_not_limit_real_work(self):
        trace = Trace(limit=8)
        with ExitStack() as stack:
            for _ in range(100):
                stack.enter_context(trace.span("clip"))
            self.assertEqual(len(trace.snapshot()["active"]), 64)
            self.assertEqual(trace.snapshot()["omittedActive"], 36)
        result = trace.snapshot()
        self.assertEqual(len(result["events"]), 8)
        self.assertEqual(result["droppedEvents"], 192)
        self.assertEqual(result["active"], [])
        self.assertEqual(result["omittedActive"], 0)
        self.assertTrue(all("startMs" in e for e in result["events"]))

    def test_cancellation_and_byte_counter_units(self):
        class CancelledError(Exception):
            pass
        trace = Trace()
        with self.assertRaises(CancelledError):
            with trace.span("inference"):
                raise CancelledError()
        trace.count("rasterBytes", 16)
        trace.count("rasterBytes", 32)
        trace.count("arbitrary counter", 10)
        trace.count("encodedBytes", float("inf"))
        result = trace.snapshot()
        self.assertEqual(result["events"][-1]["status"], "cancelled")
        self.assertEqual(result["counters"], {"rasterBytes": 48})
        self.assertEqual(result["context"]["kind"], "backend")
        self.assertIsNone(result["context"]["timeOrigin"])
        self.assertRegex(result["context"]["revision"], r"^sha256:[a-f0-9]{64}$")

    def test_pipeline_failure_publishes_terminal_stages_and_atomic_optional_sidecar(self):
        dependencies = test_identity.IdentityTests().dependencies()
        dependencies["wayback"].build_raster = mock.Mock(side_effect=ValueError("private network details"))
        pipeline = load("gmd020_pipeline", "pipeline.py", dependencies)
        with tempfile.TemporaryDirectory() as directory:
            pipeline.OUT_DIR = Path(directory)
            with mock.patch.object(pipeline.threading, "Thread"):
                job_id = pipeline.start_job({"aois": {"features": [feature()]}, "detect": False})
            pipeline._run(job_id)
            job = pipeline.JOBS[job_id]
            self.assertEqual(job["status"], "error")
            result = pipeline.job_diagnostics(job)
            self.assertEqual(result["active"], [])
            self.assertEqual(result["events"][-1]["name"], "job")
            self.assertEqual(result["events"][-1]["status"], "error")
            self.assertNotIn("private network details", json.dumps(result))
            saved = json.loads((pipeline.OUT_DIR / job_id / "diagnostics.json").read_text())
            self.assertEqual(saved, result)
            self.assertEqual(list((pipeline.OUT_DIR / job_id).glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
