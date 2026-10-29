"""Hermes Browser Extension plugin — context cache for Hermes Agent.

Registers tools and lifecycle hooks that let the Hermes agent query the
current browser context captured from the Hermes Browser Extension. The
plugin is fail-soft: when the extension is not connected or no context
has been captured, all tools gracefully report unavailable.

It passively caches browser context from conversation messages (embedded by
the extension as Browser Context Protocol prompt blocks) and from explicit
tool calls. Its HTTP surface is six routes on the API server: a read-only
readiness route (name, version, profile, tool names; status_route.py), the
browser-context side channel (context status, context upload, declarative action
descriptors; context_routes.py) and the two Hermes Control routes the extension
attaches through (control_routes.py).

It also carries Hermes Control for a Hermes whose core has no extension control:
one tool per browser action (control_tools.py), served by a broker
(control_broker.py) the extension registers with. The tools act only in the
browser of the session that attached it, and only while it is attached.
"""

from __future__ import annotations

from pathlib import Path

from . import context_routes, control_routes, control_tools, hooks, status_route, tools
from .context_store import BrowserContextStore
from .control_broker import get_control_broker

# Global store — shared between tools and hooks.
STORE = BrowserContextStore()

# What register() installs; the readiness route reports exactly these names and
# a test keeps them equal to plugin.yaml and to the real registrations.
TOOL_NAMES = (
    "browser_context_status",
    "browser_get_context",
    "browser_clear_context",
    "browser_event_log",
    "browser_control_status",
    "browser_context_journal",
    "browser_text_utility",
    *control_tools.TOOL_NAMES,
)
HOOK_NAMES = ("pre_llm_call", "pre_tool_call", "post_tool_call")


def _chain(*wires):
    """One ``wire_extra`` that runs each given one; the status route's factory takes a single hook."""

    def wire(router, adapter) -> None:
        for wire_one in wires:
            wire_one(router, adapter)

    return wire


def register(ctx) -> None:
    """Register companion plugin tools, hooks, and bundled skill."""
    durable_receipts = ctx.get_config("durable_receipts", default=True)
    receipt_limit = ctx.get_config("receipt_limit", default=8)
    # The live PluginContext always has `state`; the catalog validator's
    # recording context does not, so a missing one means memory-only receipts.
    state = getattr(ctx, "state", None)
    if state is not None:
        STORE.configure_durable_state(
            state,
            enabled=durable_receipts is True,
            receipt_limit=receipt_limit,
        )
    # Phase 8 Task 31: metadata-only rotation journal, persisted under the
    # plugin's profile-scoped data dir (mode 0600 where supported) when one
    # exists, memory-only otherwise.
    try:
        data_dir = getattr(state, "data_dir", None)
    except Exception:
        data_dir = None
    STORE.configure_journal(data_dir)
    # Tell tools which store to use
    tools.set_store(STORE)
    hooks.set_store(STORE)

    # ── Tools ──────────────────────────────────────────────────────────
    ctx.register_tool(
        name="browser_context_status",
        toolset="hermes-browser-extension",
        schema=tools.SCHEMA_STATUS,
        handler=tools.browser_context_status,
        description="Check whether browser context is currently cached and available.",
        emoji="🌐",
    )

    ctx.register_tool(
        name="browser_get_context",
        toolset="hermes-browser-extension",
        schema=tools.SCHEMA_GET_CONTEXT,
        handler=tools.browser_get_context,
        description="Consume this turn's cached browser context once, using its opaque context_id.",
        emoji="📄",
    )

    ctx.register_tool(
        name="browser_clear_context",
        toolset="hermes-browser-extension",
        schema=tools.SCHEMA_CLEAR_CONTEXT,
        handler=tools.browser_clear_context,
        description="Clear the cached browser context. The next extension prompt will re-populate it.",
        emoji="🗑️",
    )

    ctx.register_tool(
        name="browser_event_log",
        toolset="hermes-browser-extension",
        schema=tools.SCHEMA_EVENT_LOG,
        handler=tools.browser_event_log,
        description="Return recent browser companion events for diagnostics.",
        emoji="📋",
    )

    ctx.register_tool(
        name="browser_control_status",
        toolset="hermes-browser-extension",
        schema=tools.SCHEMA_CONTROL_STATUS,
        handler=tools.browser_control_status,
        description="Return historical owner-scoped Browser control metadata; never live authority.",
        emoji="🧭",
    )

    ctx.register_tool(
        name="browser_context_journal",
        toolset="hermes-browser-extension",
        schema=tools.SCHEMA_JOURNAL,
        handler=tools.browser_context_journal,
        description="Return the metadata-only owner-scoped journal of stored browser-context deliveries; never page data.",
        emoji="📒",
    )

    ctx.register_tool(
        name="browser_text_utility",
        toolset="hermes-browser-extension",
        schema=tools.SCHEMA_TEXT_UTILITY,
        handler=tools.browser_text_utility,
        description="Run bounded deterministic text cleanup, bullets, stats, or diff without a model call.",
        emoji="⚙️",
    )

    # ── Hermes Control tools ───────────────────────────────────────────
    # Offered only while a controller is attached; a name another toolset owns
    # (a Hermes that still has control in core) is skipped by Hermes.
    try:
        profile = getattr(ctx, "profile_name", "default")
    except Exception:
        profile = "default"
    control_tools.register_control_tools(ctx, broker=get_control_broker(), profile=profile, data_dir=data_dir)

    # ── Hooks ──────────────────────────────────────────────────────────
    ctx.register_hook("pre_llm_call", hooks.pre_llm_call)
    ctx.register_hook("pre_tool_call", hooks.pre_tool_call)
    ctx.register_hook("post_tool_call", hooks.post_tool_call)

    # ── Routes ─────────────────────────────────────────────────────────
    # The readiness route, the browser-context side channel (context status,
    # context upload, declarative actions) and the Hermes Control routes, all
    # authenticated by the API server's own check and wired by one factory;
    # skipped (never fatal) where Hermes refuses the seam. See status_route.py,
    # context_routes.py and control_routes.py.
    version = status_route.plugin_version()
    status_route.register_status_route(
        ctx,
        tools=TOOL_NAMES,
        hooks=HOOK_NAMES,
        version=version,
        wire_extra=_chain(
            context_routes.make_wire_extra(STORE, version=version),
            control_routes.make_wire_extra(get_control_broker(), profile=profile),
        ),
        routes=(*status_route.ROUTE_PATHS, *control_routes.ROUTE_PATHS),
    )

    # ── Bundled skill ──────────────────────────────────────────────────
    skills_dir = Path(__file__).resolve().parent / "skills"
    skill_md = skills_dir / "hermes-browser-extension" / "SKILL.md"
    if skill_md.is_file():
        ctx.register_skill("hermes-browser-extension", skill_md)
