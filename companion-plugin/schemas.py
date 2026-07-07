"""Hermes/OpenAI function schema definitions for companion plugin tools."""

_EMPTY_PARAMETERS = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}

SCHEMA_STATUS = {
    "name": "browser_context_status",
    "description": "Check whether browser context is currently cached and available.",
    "parameters": _EMPTY_PARAMETERS,
}

SCHEMA_GET_CONTEXT = {
    "name": "browser_get_context",
    "description": "Retrieve the current cached browser context envelope (scope, active tab, payload hash).",
    "parameters": _EMPTY_PARAMETERS,
}

SCHEMA_CLEAR_CONTEXT = {
    "name": "browser_clear_context",
    "description": "Clear the cached browser context. The next extension prompt will re-populate it.",
    "parameters": _EMPTY_PARAMETERS,
}

SCHEMA_EVENT_LOG = {
    "name": "browser_event_log",
    "description": "Return recent browser companion events for diagnostics.",
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "description": "Maximum number of recent events to return (1–50, default 20).",
                "minimum": 1,
                "maximum": 50,
                "default": 20,
            },
        },
        "additionalProperties": False,
    },
}
