"""Tests for capdiff.py. Suite: python -m unittest discover -s tests/pytools -v"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SCRIPT = REPO / "scripts" / "pytools" / "capdiff.py"
ROUTES = HERE / "fixtures" / "routes"
CAPS = REPO / "extension" / "lib" / "capabilities.mjs"
PYTHON = sys.executable


def run_script(*argv):
    return subprocess.run([PYTHON, str(SCRIPT), *argv], capture_output=True, text=True, timeout=60)


@unittest.skipIf(not CAPS.exists(), "capabilities.mjs missing")
class TestCapdiffCli(unittest.TestCase):
    def test_help_renders(self):
        result = run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage:", result.stdout)

    def test_complete_routes_exit_0(self):
        result = run_script("--capabilities", str(CAPS), "--routes", str(ROUTES / "complete.txt"))
        self.assertEqual(result.returncode, 0)

    @unittest.skipIf(not (ROUTES / "incomplete.txt").exists(), "fixture missing")
    def test_missing_route_exits_1_with_bucket(self):
        result = run_script("--capabilities", str(CAPS), "--routes", str(ROUTES / "incomplete.txt"), "--json")
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        self.assertIn("browser_context_status", report["advertised_but_unroutable"])

    def test_bad_capabilities_input_is_usage_error(self):
        result = run_script("--capabilities", "does-not-exist.mjs", "--routes", str(ROUTES))
        self.assertEqual(result.returncode, 2)

    def test_baseline_roundtrip(self):
        baseline_path = HERE / "fixtures" / "routes" / ".baseline.tmp.json"
        try:
            written = run_script(
                "--capabilities", str(CAPS), "--routes", str(ROUTES / "complete.txt"),
                "--write-baseline", str(baseline_path), "--json",
            )
            self.assertEqual(written.returncode, 0)
            self.assertTrue(baseline_path.exists())
            drifted = run_script(
                "--capabilities", str(CAPS), "--routes", str(ROUTES / "incomplete.txt"),
                "--baseline", str(baseline_path), "--json",
            )
            self.assertEqual(drifted.returncode, 1)
            drift = json.loads(drifted.stdout)["drift_vs_baseline"]["advertised_but_unroutable"]
            self.assertIn("browser_context_status", drift["added"])
        finally:
            baseline_path.unlink(missing_ok=True)


class TestNameMatchingUnit(unittest.TestCase):
    def setUp(self):
        scripts_dir = str(REPO / "scripts" / "pytools")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        try:
            import capdiff  # noqa: F401
        except ImportError:
            self.skipTest("capdiff import unavailable")

    def test_heuristic_matches_documented_forms(self):
        from capdiff import names_match

        self.assertTrue(names_match("browser_context_upload", "/v1/browser_context/upload"))
        self.assertTrue(names_match("browser.context.upload", "browser_context_upload"))
        self.assertFalse(names_match("plugin_actions", "/v1/browser_control/session"))


if __name__ == "__main__":
    unittest.main()
