"""Tests for release_consistency.py. Suite: python -m unittest discover -s tests/pytools -v"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SCRIPT = REPO / "scripts" / "pytools" / "release_consistency.py"
FIXTURE_REPO = HERE / "fixtures" / "release"
PYTHON = sys.executable


def run_script(*argv):
    return subprocess.run([PYTHON, str(SCRIPT), *argv], capture_output=True, text=True, timeout=60)


@unittest.skipIf(not FIXTURE_REPO.exists(), "release fixture missing")
class TestReleaseConsistencyCli(unittest.TestCase):
    def test_help_renders(self):
        result = run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("usage:", result.stdout)

    def test_consistent_fixture_exits_0(self):
        result = run_script("--repo", str(FIXTURE_REPO))
        self.assertEqual(result.returncode, 0)

    def test_missing_repo_is_usage_error(self):
        result = run_script("--repo", "Z:/no/such/dir")
        self.assertEqual(result.returncode, 2)

    def test_report_is_valid_json_mode(self):
        result = run_script("--repo", str(FIXTURE_REPO), "--json")
        self.assertEqual(result.returncode, 0)
        report = json.loads(result.stdout)
        self.assertIn("versions", report)


class TestHeadingParserUnit(unittest.TestCase):
    def setUp(self):
        scripts_dir = str(REPO / "scripts" / "pytools")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        try:
            import release_consistency  # noqa: F401
        except ImportError:
            self.skipTest("release_consistency import unavailable")

    def test_parse_canonical_heading(self):
        from release_consistency import parse_changelog

        parsed = parse_changelog(FIXTURE_REPO / "CHANGELOG.md")
        self.assertEqual(parsed["version"], "9.9.9")
        self.assertEqual(parsed["date"], "2026-08-26")


if __name__ == "__main__":
    unittest.main()
