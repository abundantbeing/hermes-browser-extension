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
    durable_receipts = ctx.get_config("durable_receipts", default=True)
    receipt_limit = ctx.get_config("receipt_limit", default=8)
    STORE.configure_durable_state(
        ctx.state,
        enabled=durable_receipts is True,
        receipt_limit=receipt_limit,
    )
    # Phase 8 Task 31: metadata-only rotation journal, persisted under the
    # plugin's profile-scoped data dir (mode 0600 where supported) when one
    # exists, memory-only otherwise.
    try:
        data_dir = getattr(ctx.state, "data_dir", None)
    except Exception:
        data_dir = None
    STORE.configure_journal(data_dir)
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

    ctx.register_tool(
        name="browser_control_status",
        toolset="hermes-browser-companion",
        schema=tools.SCHEMA_CONTROL_STATUS,
        handler=tools.browser_control_status,
        description="Return historical owner-scoped Browser control metadata; never live authority.",
        emoji="🧭",
    )

    ctx.register_tool(
        name="browser_context_journal",
        toolset="hermes-browser-companion",
        schema=tools.SCHEMA_JOURNAL,
        handler=tools.browser_context_journal,
        description="Return the metadata-only owner-scoped journal of stored browser-context deliveries; never page data.",
        emoji="📒",
    )

    ctx.register_tool(
        name="browser_text_utility",
        toolset="hermes-browser-companion",
        schema=tools.SCHEMA_TEXT_UTILITY,
        handler=tools.browser_text_utility,
        description="Run bounded deterministic text cleanup, bullets, stats, or diff without a model call.",
        emoji="⚙️",
    )

    # ── Hooks ──────────────────────────────────────────────────────────
    ctx.register_hook("pre_llm_call", hooks.pre_llm_call)
    ctx.register_hook("pre_tool_call", hooks.pre_tool_call)
    ctx.register_hook("post_tool_call", hooks.post_tool_call)

    # ── Bundled skill ──────────────────────────────────────────────────
    skills_dir = Path(__file__).resolve().parent / "skills"
    skill_md = skills_dir / "hermes-browser" / "SKILL.md"
    if skill_md.is_file():
        ctx.register_skill("hermes-browser", skill_md)
