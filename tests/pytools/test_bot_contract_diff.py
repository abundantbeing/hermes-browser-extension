"""Tests for bot_contract_diff.py. Suite: python -m unittest discover -s tests/pytools -v"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SCRIPT = REPO / "scripts" / "pytools" / "bot_contract_diff.py"
FIXTURES = HERE / "fixtures" / "botcontract"
PYTHON = sys.executable


def run_script(*argv):
    return subprocess.run([PYTHON, str(SCRIPT), *argv], capture_output=True, text=True, timeout=60)


class TestBotContractDiffCli(unittest.TestCase):
    def test_help_renders(self):
        result = run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage:", result.stdout)

    @unittest.skipIf(not (FIXTURES / "expected-v3.json").exists(), "fixture missing")
    def test_additive_drift_exits_0(self):
        result = run_script(
            "--expected", str(FIXTURES / "expected-v3.json"),
            "--live", str(FIXTURES / "live-additive.json"), "--json",
        )
        self.assertEqual(result.returncode, 0)
        report = json.loads(result.stdout)
        self.assertEqual(report["verdict"], "additive-only")

    @unittest.skipIf(not (FIXTURES / "live-broken.json").exists(), "fixture missing")
    def test_breaking_drift_exits_1_with_taxonomy(self):
        result = run_script(
            "--expected", str(FIXTURES / "expected-v3.json"),
            "--live", str(FIXTURES / "live-broken.json"), "--json",
        )
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertEqual(report["verdict"], "BREAKING DRIFT")
        canonical = report["contracts"]["canonical_session"]
        removed_keys = {entry for entry in canonical.get("cap_deltas", {}).get("removed_caps", [])}
        self.assertTrue(any("session_id" in entry for entry in removed_keys))
        self.assertEqual(report["contracts"]["group_projection"]["epoch_increments"][0]["field"], "version")
        self.assertGreater(report["contracts"]["routine_cron"]["breaking_count"], 0)
        self.assertEqual(report["contracts"]["routine_cron"]["availability_flips"][0]["field"], "available")

    def test_missing_expected_is_usage_error(self):
        result = run_script("--expected", "nope.json", "--live", "also-nope.json")
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
