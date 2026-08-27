"""Tests for controller_trace_report.py. Suite: python -m unittest discover -s tests/pytools -v"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SCRIPT = REPO / "scripts" / "pytools" / "controller_trace_report.py"
TRACES = HERE / "fixtures" / "traces"
PYTHON = sys.executable


def run_script(*argv):
    return subprocess.run([PYTHON, str(SCRIPT), *argv], capture_output=True, text=True, timeout=60)


class TestControllerTraceCli(unittest.TestCase):
    def test_help_renders(self):
        result = run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage:", result.stdout)

    @unittest.skipIf(not (TRACES / "full-lifecycle.journal").exists(), "fixture missing")
    def test_full_lifecycle_exit_0_all_stages(self):
        result = run_script(str(TRACES / "full-lifecycle.journal"), "--json")
        self.assertEqual(result.returncode, 0)
        report = json.loads(result.stdout)
        self.assertEqual(report["missing_stages"], [])
        stages = [entry["stage"] for entry in report["timeline"]]
        self.assertIn("register", stages)
        self.assertEqual(stages[-1], "detach")

    def test_missing_target_is_usage_error(self):
        result = run_script("Z:/no/such/journal.log")
        self.assertEqual(result.returncode, 2)


class TestStageClassifierUnit(unittest.TestCase):
    def setUp(self):
        scripts_dir = str(REPO / "scripts" / "pytools")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        try:
            import controller_trace_report  # noqa: F401
        except ImportError:
            self.skipTest("controller_trace_report import unavailable")

    def test_classify_stages(self):
        from controller_trace_report import classify_stage

        self.assertEqual(classify_stage({"event": "controller.register"}), "register")
        self.assertEqual(classify_stage({"event": "lease_acquired"}), "lease")
        self.assertEqual(classify_stage({"event": "action.result"}), "action")
        self.assertIsNone(classify_stage({"_raw": "unrelated gateway noise"}))


if __name__ == "__main__":
    unittest.main()
