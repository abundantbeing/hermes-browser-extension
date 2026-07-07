"""Hermes Browser companion plugin — context cache for Hermes Agent.

Registers tools and lifecycle hooks that let the Hermes agent query the
current browser context captured from the Hermes Browser Extension. The
plugin is fail-soft: when the extension is not connected or no context
has been captured, all tools gracefully report unavailable.

This plugin does NOT control the browser, register API routes, or assume
any side channel exists. It passively caches browser context from
conversation messages (embedded by the extension as Browser Context
Protocol prompt blocks) and from explicit tool calls.
"""

from __future__ import annotations

from pathlib import Path

from . import hooks, tools
from .context_store import BrowserContextStore

# Global store — shared between tools and hooks.
STORE = BrowserContextStore()


def register(ctx) -> None:
    """Register companion plugin tools, hooks, and bundled skill."""
    # Tell tools which store to use
    tools.set_store(STORE)
    hooks.set_store(STORE)

    # ── Tools ──────────────────────────────────────────────────────────
    ctx.register_tool(
        name="browser_context_status",
        toolset="hermes-browser-companion",
        schema=tools.SCHEMA_STATUS,
        handler=tools.browser_context_status,
        description="Check whether browser context is currently cached and available.",
        emoji="🌐",
    )

    ctx.register_tool(
        name="browser_get_context",
        toolset="hermes-browser-companion",
        schema=tools.SCHEMA_GET_CONTEXT,
        handler=tools.browser_get_context,
        description="Retrieve the current cached browser context envelope (scope, active tab, payload hash).",
        emoji="📄",
    )

    ctx.register_tool(
        name="browser_clear_context",
        toolset="hermes-browser-companion",
        schema=tools.SCHEMA_CLEAR_CONTEXT,
        handler=tools.browser_clear_context,
        description="Clear the cached browser context. The next extension prompt will re-populate it.",
        emoji="🗑️",
    )

    ctx.register_tool(
        name="browser_event_log",
        toolset="hermes-browser-companion",
        schema=tools.SCHEMA_EVENT_LOG,
        handler=tools.browser_event_log,
        description="Return recent browser companion events for diagnostics.",
        emoji="📋",
    )

    # ── Hooks ──────────────────────────────────────────────────────────
    ctx.register_hook("pre_llm_call", hooks.pre_llm_call)
    ctx.register_hook("post_tool_call", hooks.post_tool_call)

    # ── Bundled skill ──────────────────────────────────────────────────
    skills_dir = Path(__file__).resolve().parent / "skills"
    skill_md = skills_dir / "hermes-browser" / "SKILL.md"
    if skill_md.is_file():
        ctx.register_skill("hermes-browser", skill_md)
