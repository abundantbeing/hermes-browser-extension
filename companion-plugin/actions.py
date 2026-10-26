"""Declarative descriptors of the companion plugin's safe actions.

An action here is a description, never an entry point: the list route returns
these dictionaries and nothing in the plugin executes an action on behalf of an
HTTP caller. The agent runs the listed tool itself, inside a turn, under
Hermes' normal tool approval.

Only tools that are safe to describe to a client are listed: bounded, local,
deterministic, no model call, no network, no browser, no stored context. The
owner-gated context tools (status, get, clear, event log, control status,
journal) answer only inside the turn that owns the context, so they are not
actions a client can use and are not listed.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from .schemas import SCHEMA_TEXT_UTILITY

# name -> (schema, human title)
_SAFE_ACTIONS = (("browser_text_utility", SCHEMA_TEXT_UTILITY, "Text utilities"),)

SAFE_ACTION_NAMES = tuple(name for name, _schema, _title in _SAFE_ACTIONS)


def descriptors() -> list[dict[str, Any]]:
    """Fresh descriptor dictionaries, safe for the caller to keep or mutate."""
    rows: list[dict[str, Any]] = []
    for name, schema, title in _SAFE_ACTIONS:
        rows.append(
            {
                "name": name,
                "title": title,
                "description": str(schema.get("description", "")),
                "kind": "agent-tool",
                "safe": True,
                "read_only": True,
                "uses_model": False,
                "uses_network": False,
                "needs_browser_context": False,
                "parameters": deepcopy(schema.get("parameters", {})),
            }
        )
    return rows
