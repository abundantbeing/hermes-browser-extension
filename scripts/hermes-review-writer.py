#!/usr/bin/env python
"""One no-tools review completion using explicit Hermes provider credentials.

JSON on stdin/stdout. No agent loop, memory, MCP, GitHub client, or repo execution.
The caller supplies the only allowed primary/fallback routes. No global fallback.
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import site
import sys


class ReviewRoutesError(RuntimeError):
    def __init__(self, failures):
        super().__init__("All approved review routes failed")
        self.failures = failures


class ReviewOutputError(RuntimeError):
    pass


def completion(request, resolver):
    failures = []
    routes = request.get("routes", [])
    if not routes or len(routes) > 2:
        raise ValueError("Expected one primary and at most one fallback route")
    for index, route in enumerate(routes):
        provider, model = route["provider"], route["model"]
        if not provider or not model:
            raise ValueError("Provider and model must both be explicit")
        finish, text = None, ""
        try:
            client, resolved = resolver(provider, model=model)
            if client is None or resolved != model:
                raise RuntimeError("Requested provider/model could not be resolved exactly")
            kwargs = {
                "model": model,
                "messages": request["messages"],
                "timeout": request.get("timeout", 480),
            }
            effort = route.get("reasoning_effort", "xhigh")
            if provider == "openai-codex":
                kwargs["extra_body"] = {"reasoning": {"enabled": True, "effort": effort}}
                kwargs["no_progress_timeout"] = min(float(request.get("timeout", 480)), 300.0)
            else:
                kwargs["reasoning_effort"] = effort
                kwargs["max_tokens"] = 65536
                kwargs["stream"] = True
            response = client.chat.completions.create(**kwargs)
            if hasattr(response, "choices"):
                choice = response.choices[0]
                text = choice.message.content or ""
                if getattr(choice.message, "tool_calls", None):
                    raise RuntimeError("Writer attempted a tool call")
                finish = choice.finish_reason
                usage = getattr(response, "usage", None)
            else:
                chunks, finish, usage = [], None, None
                try:
                    for event in response:
                        if getattr(event, "usage", None):
                            usage = event.usage
                        if not event.choices:
                            continue
                        choice = event.choices[0]
                        if getattr(choice.delta, "tool_calls", None):
                            raise RuntimeError("Writer attempted a tool call")
                        if choice.delta.content:
                            chunks.append(choice.delta.content)
                        if choice.finish_reason:
                            finish = choice.finish_reason
                finally:
                    response.close()
                text = "".join(chunks)
            if not text.strip() or finish not in ("stop", "completed"):
                raise ReviewOutputError("Writer response was empty or incomplete")
            if request.get("expect_json"):
                cleaned = text.strip()
                if cleaned.startswith("```"):
                    cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0].strip()
                structured = json.loads(cleaned)
                if not isinstance(structured.get("summary"), str) or not isinstance(structured.get("findings"), list) or not isinstance(structured.get("limitations"), list):
                    raise ReviewOutputError("Review schema mismatch")
                text = json.dumps(structured, ensure_ascii=False)
            if hasattr(usage, "model_dump"):
                usage = usage.model_dump()
            elif usage is not None and not isinstance(usage, dict):
                usage = vars(usage)
            return {"text": text, "provider": provider, "model": model,
                    "reasoning_effort": effort, "fallback": index > 0,
                    "failed_routes": failures, "usage": usage}
        except Exception as exc:
            # Provider exception text can contain URLs/credentials. Never return it.
            failures.append({"provider": provider, "model": model, "error": type(exc).__name__, "status": getattr(exc, "status_code", None), "finish_reason": finish if finish in ("stop", "completed", "length", "tool_calls", "content_filter") else None, "content_chars": len(text)})
    raise ReviewRoutesError(failures)


def main():
    request = json.load(sys.stdin)
    runtime = os.environ.get("HERMES_REVIEW_RUNTIME_ROOT", "")
    packages = os.environ.get("HERMES_REVIEW_SITE_PACKAGES", "")
    if not runtime or not Path(runtime, "agent", "auxiliary_client.py").is_file():
        raise RuntimeError("Explicit Hermes runtime root is required")
    if packages:
        site.addsitedir(packages)
    sys.path.insert(0, runtime)
    # Provider setup can print notices. stdout remains a single JSON response.
    with contextlib.redirect_stdout(sys.stderr):
        from hermes_cli.config import load_env
        load_env()
        from agent.auxiliary_client import resolve_provider_client
        result = completion(request, resolve_provider_client)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": type(exc).__name__, "failed_routes": getattr(exc, "failures", [])}), file=sys.stdout)
        sys.exit(1)
