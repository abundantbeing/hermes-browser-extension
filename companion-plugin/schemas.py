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
    "description": "Consume the current turn's browser context once using its opaque context capability ID.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_id": {
                "type": "string",
                "description": "Opaque Browser context capability ID supplied by the companion context notice.",
                "minLength": 32,
                "maxLength": 32,
                "pattern": "^[a-f0-9]{32}$",
            },
        },
        "required": ["context_id"],
        "additionalProperties": False,
    },
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

SCHEMA_TEXT_UTILITY = {
    "name": "browser_text_utility",
    "description": "Run a bounded deterministic text operation locally without a model or network call.",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["clean_formatting", "make_bullets", "text_stats", "diff"],
                "description": "Local operation to perform.",
            },
            "text": {
                "type": "string",
                "maxLength": 50000,
                "description": "Source text. Limited to 50,000 characters.",
            },
            "compare_text": {
                "type": "string",
                "maxLength": 50000,
                "description": "Revised text for the diff action.",
                "default": "",
            },
        },
        "required": ["action", "text"],
        "additionalProperties": False,
    },
}
