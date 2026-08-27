"""Tests for gwlog_forensics.py. Suite: python -m unittest discover -s tests/pytools -v"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SCRIPT = REPO / "scripts" / "pytools" / "gwlog_forensics.py"
FIXTURES = HERE / "fixtures" / "journal"
PYTHON = sys.executable


def run_script(*argv):
    return subprocess.run([PYTHON, str(SCRIPT), *argv], capture_output=True, text=True, timeout=60)


class TestGwlogForensicsCli(unittest.TestCase):
    def test_help_renders(self):
        result = run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage:", result.stdout)

    @unittest.skipIf(not (FIXTURES / "mixed-connect-failures.log").exists(), "fixture missing")
    def test_mixed_failures_exit_1_with_categories(self):
        result = run_script(str(FIXTURES / "mixed-connect-failures.log"), "--json")
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertEqual(report["total_classified_failures"], 4)
        self.assertEqual(report["categories"]["401-unauthorized"]["count"], 1)
        self.assertEqual(report["categories"]["404-route-missing"]["count"], 1)
        self.assertEqual(report["categories"]["timeout/reset"]["count"], 2)

    @unittest.skipIf(not (FIXTURES / "clean.log").exists(), "fixture missing")
    def test_clean_log_exits_0(self):
        result = run_script(str(FIXTURES / "clean.log"))
        self.assertEqual(result.returncode, 0)

    def test_missing_target_is_usage_error(self):
        result = run_script(str(REPO / "definitely-not-here.log"))
        self.assertEqual(result.returncode, 2)


class TestGwlogClassifierUnit(unittest.TestCase):
    def setUp(self):
        scripts_dir = str(REPO / "scripts" / "pytools")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        try:
            import gwlog_forensics  # noqa: F401
        except ImportError:
            self.skipTest("gwlog_forensics import unavailable")

    def test_classifier_buckets(self):
        from gwlog_forensics import classify_record

        self.assertEqual(classify_record({"_raw": "2026-08-26 failed: status 401 Unauthorized"}), "401-unauthorized")
        self.assertEqual(classify_record({"status": 404, "detail": "route not found"}), "404-route-missing")
        self.assertEqual(classify_record({"_raw": "connect error: connection reset"}), "timeout/reset")
        self.assertIsNone(classify_record({"_raw": "gateway started successfully"}))


if __name__ == "__main__":
    unittest.main()
