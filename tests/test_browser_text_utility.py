import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "companion-plugin" / "text_utilities.py"
SPEC = importlib.util.spec_from_file_location("hermes_browser_text_utilities", MODULE_PATH)
text_utilities = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(text_utilities)


class BrowserTextUtilitiesTests(unittest.TestCase):
    def test_clean_formatting_is_deterministic_and_reports_change(self):
        result = text_utilities.run_text_utility(
            "clean_formatting",
            "  Hello\u00a0 world.  \n\n\n  Next line.  ",
        )
        self.assertTrue(result["ok"])
        self.assertTrue(result["no_model"])
        self.assertTrue(result["changed"])
        self.assertEqual(result["text"], "Hello world.\n\nNext line.")

    def test_make_bullets_preserves_sentence_punctuation(self):
        result = text_utilities.run_text_utility("make_bullets", "First item. Second item!\nThird item")
        self.assertEqual(result["text"], "• First item.\n• Second item!\n• Third item")

    def test_text_stats_returns_stable_local_metrics(self):
        result = text_utilities.run_text_utility("text_stats", "One short sentence. Another sentence here!")
        self.assertEqual(result["words"], 6)
        self.assertEqual(result["sentences"], 2)
        self.assertEqual(result["characters"], 42)
        self.assertEqual(result["reading_time_seconds"], 2)
        self.assertNotIn("text", result)

    def test_diff_is_bounded_and_counts_changes(self):
        result = text_utilities.run_text_utility(
            "diff",
            "Before line\nKeep line",
            compare_text="After line\nKeep line",
        )
        self.assertEqual(result["additions"], 1)
        self.assertEqual(result["deletions"], 1)
        self.assertIn("-Before line", result["diff"])
        self.assertIn("+After line", result["diff"])

    def test_unknown_action_and_oversized_input_fail_closed(self):
        unknown = text_utilities.run_text_utility("rewrite_with_magic", "hello")
        self.assertFalse(unknown["ok"])
        oversized = text_utilities.run_text_utility("clean_formatting", "x" * 50_001)
        self.assertFalse(oversized["ok"])
        self.assertEqual(oversized["error"], "text_too_large")


if __name__ == "__main__":
    unittest.main()
