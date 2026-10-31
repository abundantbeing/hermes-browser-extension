"""No-tools writer contract. Synthetic SDK responses, no network calls."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("review_writer", Path(__file__).resolve().parents[2] / "scripts" / "hermes-review-writer.py")
writer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(writer)


def response(text="review", finish="stop", tools=None):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text, tool_calls=tools), finish_reason=finish)], usage={"prompt_tokens": 10})


class ReviewWriterTests(unittest.TestCase):
    def setUp(self):
        self.request = {"routes": [
            {"provider": "openai-codex", "model": "gpt-6.1-sol-900k", "reasoning_effort": "xhigh"},
            {"provider": "nous", "model": "deepseek/deepseek-v4.1-flash-1017", "reasoning_effort": "xhigh"}],
            "messages": [{"role": "user", "content": "untrusted PR"}]}

    def test_primary_has_no_tools_and_explicit_reasoning(self):
        captured = []
        def create(**kwargs):
            captured.append(kwargs)
            return response()
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        result = writer.completion(self.request, lambda provider, model: (client, model))
        self.assertEqual(result["provider"], "openai-codex")
        self.assertFalse(result["fallback"])
        self.assertNotIn("tools", captured[0])
        self.assertEqual(captured[0]["extra_body"]["reasoning"]["effort"], "xhigh")
        self.assertEqual(captured[0]["model"], "gpt-6.1-sol-900k")

    def test_failed_primary_uses_only_the_approved_fallback(self):
        attempted = []
        def resolve(provider, model):
            attempted.append((provider, model))
            if provider == "openai-codex":
                raise TimeoutError("never expose this provider error")
            c = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: response())))
            return c, model
        result = writer.completion(self.request, resolve)
        self.assertEqual(attempted, [("openai-codex", "gpt-6.1-sol-900k"), ("nous", "deepseek/deepseek-v4.1-flash-1017")])
        self.assertTrue(result["fallback"])
        self.assertEqual(result["failed_routes"][0]["error"], "TimeoutError")
        self.assertNotIn("never expose", str(result))

    def test_tool_calls_are_never_executed_or_accepted(self):
        self.request["routes"] = self.request["routes"][:1]
        c = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: response(tools=[{"name": "terminal"}]))))
        with self.assertRaisesRegex(RuntimeError, "All approved"):
            writer.completion(self.request, lambda p, model: (c, model))

    def test_truncated_output_is_not_a_review(self):
        self.request["routes"] = self.request["routes"][:1]
        c = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: response("partial", "length"))))
        with self.assertRaisesRegex(RuntimeError, "All approved"):
            writer.completion(self.request, lambda p, model: (c, model))

    def test_wrong_resolved_model_cannot_silently_change_routes(self):
        self.request["routes"] = self.request["routes"][:1]
        with self.assertRaisesRegex(RuntimeError, "All approved"):
            writer.completion(self.request, lambda p, model: (object(), "wrong-model"))

    def test_invalid_json_fails_over_before_the_pipeline_can_publish(self):
        self.request["expect_json"] = True
        def resolve(provider, model):
            text = 'not a structured review' if provider == 'openai-codex' else '{"summary":"review","findings":[],"limitations":[]}'
            c = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: response(text))))
            return c, model
        result = writer.completion(self.request, resolve)
        self.assertTrue(result["fallback"])
        self.assertEqual(result["model"], 'deepseek/deepseek-v4.1-flash-1017')

    def test_all_failures_do_not_reach_an_unapproved_third_model(self):
        attempted = []
        def resolve(p, model):
            attempted.append(p)
            raise OSError("provider failed")
        with self.assertRaisesRegex(RuntimeError, "All approved"):
            writer.completion(self.request, resolve)
        self.assertEqual(attempted, ["openai-codex", "nous"])


if __name__ == "__main__":
    unittest.main()
