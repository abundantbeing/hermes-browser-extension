"""Runtime event names for the Hermes Browser companion plugin."""

RUN_STARTED = "run.started"
RUN_COMPLETED = "run.completed"
TOOL_STARTED = "tool.started"
TOOL_PROGRESS = "tool.progress"
TOOL_FINISHED = "tool.finished"
BROWSER_CONTEXT_UPDATED = "browser.context.updated"
BROWSER_CONTEXT_CLEARED = "browser.context.cleared"

CONTROL_EVENTS_ENABLED = False


def normalize_event_name(name: str) -> str:
    """Normalize a raw event name to a canonical companion event name."""
    raw = str(name or "")
    if "control" in raw.lower():
        return "runtime.unknown"
    if raw == "hermes.tool.progress":
        return TOOL_PROGRESS
    return raw or "runtime.unknown"
