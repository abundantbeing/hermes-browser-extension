"""Hermes/OpenAI function schemas for the Hermes Control tools.

One tool per browser action the extension can run. On the wire each action keeps its
protocol name (``browser_click``, ``browser_tabs``, ...); the model knows it as a
``tab_*`` tool (``tab_click``, ``tab_list``, ...) because Hermes' Camofox plugin owns
``browser_navigate``, ``browser_click`` and the rest, and two plugins cannot share a
tool name. ``TOOL_NAMES`` maps one to the other; extension/lib/control-tool-names.mjs
holds the same table and a test keeps the two equal. Every description says where
the tool acts: in the person's own browser, through the Hermes Browser Extension, on
the tabs they attached to Hermes or that the agent opened. The tools are separate
from ``browser_exec`` and every other browser tool.
"""

from __future__ import annotations

import copy
from typing import Any

# Wire action -> the tool the model calls.
TOOL_NAMES: dict[str, str] = {
    "browser_back": "tab_back",
    "browser_batch": "tab_batch",
    "browser_click": "tab_click",
    "browser_drag": "tab_drag",
    "browser_fill": "tab_fill",
    "browser_hover": "tab_hover",
    "browser_navigate": "tab_navigate",
    "browser_press": "tab_press",
    "browser_screenshot": "tab_screenshot",
    "browser_scroll": "tab_scroll",
    "browser_scroll_to": "tab_scroll_to",
    "browser_select": "tab_select",
    "browser_snapshot": "tab_snapshot",
    "browser_tab_activate": "tab_activate",
    "browser_tab_close": "tab_close",
    "browser_tab_create": "tab_create",
    "browser_tab_group": "tab_group",
    "browser_tab_ungroup": "tab_ungroup",
    "browser_tabs": "tab_list",
    "browser_type": "tab_type",
}
ACTION_FOR_TOOL: dict[str, str] = {tool: action for action, tool in TOOL_NAMES.items()}

_WHERE = (
    "Hermes Control: acts in the person's own browser through the Hermes Browser Extension, in the tabs they "
    "attached to Hermes or that you opened; it is separate from browser_exec and every other browser tool. "
)
_REFS = "Refs come from the latest snapshot or action result, and belong to the tab they came from."
_BACKGROUND = "ask the person to bring the tab forward (Show tab in the Hermes panel), or use tab_click, tab_type or tab_scroll, which work in background tabs"

_TAB_ID = {
    "type": "integer",
    "minimum": 1,
    "description": "Tab to act in, from tab_list or tab_create (default: the tab of the person's current turn, or the only attached tab). Every result names the tab it ran in.",
}
_REF = {"type": "string", "description": "The element reference from the snapshot (e.g., '@e5')"}
_TAB_IDS = {
    "type": "array",
    "items": {"type": "integer", "minimum": 1},
    "minItems": 1,
    "uniqueItems": True,
    "description": "The ids of the tabs, from tab_list",
}

# The actions that can act on a chosen tab instead of the default one; the extension
# refuses an id it did not attach (lease_not_owned).
TAB_TARGETING = frozenset({
    "browser_back", "browser_batch", "browser_click", "browser_drag", "browser_fill", "browser_hover",
    "browser_navigate", "browser_press", "browser_screenshot", "browser_scroll", "browser_scroll_to",
    "browser_select", "browser_snapshot", "browser_type",
})

_BATCH_STEP = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": ["back", "click", "drag", "fill", "hover", "navigate", "press", "scroll", "scroll_to", "select", "type"],
            "description": "What this step does",
        },
        "ref": {"type": "string", "description": "Element ref (e.g. '@e5'); for drag, the element dragged"},
        "to_ref": {"type": "string", "description": "drag: the element to drop on"},
        "text": {"type": "string", "description": "type: the text"},
        "value": {"type": "string", "description": "fill: the text; select: the option's text or value"},
        "clear": {"type": "boolean", "description": "type: false adds to the field instead of replacing it (default true)"},
        "url": {"type": "string", "description": "navigate: the URL"},
        "key": {"type": "string", "description": "press: the key, e.g. 'Enter' or 'Control+a'"},
        "modifiers": {
            "type": "array",
            "items": {"type": "string", "enum": ["Alt", "Control", "Meta", "Shift"]},
            "description": "press: keys held with the key",
        },
        "direction": {"type": "string", "enum": ["up", "down", "left", "right"], "description": "scroll: which way"},
        "amount": {"type": "integer", "minimum": 100, "maximum": 5000, "description": "scroll: pixels (100-5000)"},
        "x": {"type": "number", "description": "click: x in CSS pixels, with y, instead of ref"},
        "y": {"type": "number", "description": "click: y in CSS pixels, with x, instead of ref"},
    },
    "required": ["action"],
}


def _schema(action: str, description: str, properties: dict[str, Any] | None = None, required: list[str] | None = None) -> dict[str, Any]:
    properties = {key: copy.deepcopy(value) for key, value in (properties or {}).items()}
    if action in TAB_TARGETING:
        properties["tab_id"] = copy.deepcopy(_TAB_ID)
    return {
        "name": TOOL_NAMES[action],
        "description": _WHERE + description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": list(required or []),
            "additionalProperties": False,
        },
    }


# Keyed by tool name (what Hermes registers and the model calls).
CONTROL_SCHEMAS: dict[str, dict[str, Any]] = {
    schema["name"]: schema
    for schema in (
        _schema(
            "browser_navigate",
            "Load a URL in the tab. The page the person attached is already open: call this only to move to a "
            "different URL. Returns a compact snapshot with interactive elements and ref IDs.",
            {"url": {"type": "string", "description": "The URL to navigate to (e.g., 'https://example.com')"}},
            ["url"],
        ),
        _schema(
            "browser_snapshot",
            "Get a text snapshot of the page's accessibility tree: interactive elements with ref IDs (like @e1, @e2) "
            "for tab_click and tab_type. Actions that change the page already return it with fresh refs, so use this "
            "for full=true (complete page content), to read another tab, to re-read a page that changed on its own, or "
            "when the turn carries no snapshot.",
            {"full": {"type": "boolean", "default": False, "description": "If true, returns complete page content. If false (default), a compact view of interactive elements."}},
        ),
        _schema(
            "browser_click",
            "Click an element by its ref ID, or a point given by x and y in CSS pixels from the top-left of the viewport "
            "(only when no ref reaches the target). A new tab that opens meanwhile is not attached, since Hermes cannot "
            "tell who opened it: the result counts it under opened_tabs_not_attached; ask the person to attach it "
            "in Hermes Control if you need it. The person is asked to approve a "
            "coordinate click and a click on a button or link labelled like submit, send, post, publish, delete, remove, "
            "pay, buy, checkout, download or upload; the call waits for the answer, so do not repeat it. Works in a "
            f"background tab. {_REFS}",
            {
                "ref": _REF,
                "x": {"type": "number", "description": "Horizontal position in CSS pixels; use together with y instead of ref"},
                "y": {"type": "number", "description": "Vertical position in CSS pixels; use together with x instead of ref"},
            },
        ),
        _schema(
            "browser_type",
            "Type text into an input field by its ref ID. Clears the field first (unless clear is false), then types. "
            "Password, payment-card, one-time-code and other credential fields, and text that looks like a secret, are "
            f"refused: ask the person to enter those themselves. Works in a background tab. {_REFS}",
            {
                "ref": _REF,
                "text": {"type": "string", "description": "The text to type into the field"},
                "clear": {"type": "boolean", "default": True, "description": "Clear the field before typing (default true). Pass false to add to what is already there."},
            },
            ["ref", "text"],
        ),
        _schema(
            "browser_fill",
            "Set a text field's value in one step: the field is focused, its contents are replaced with value, and the "
            "page is told it changed. Prefer it over tab_type for plain inputs and textareas; use tab_type when the page "
            "needs real keystrokes. Credential and payment fields are refused as for tab_type. Works in a background "
            f"tab. {_REFS}",
            {"ref": _REF, "value": {"type": "string", "description": "The text to put in the field"}},
            ["ref", "value"],
        ),
        _schema(
            "browser_select",
            "Choose an option in a dropdown (a <select> element) by its ref ID. For a custom dropdown that is not a "
            "<select>, click it and click the option instead. Payment and credential fields are refused. Works in a "
            f"background tab. {_REFS}",
            {"ref": _REF, "value": {"type": "string", "description": "The option's visible text or its value"}},
            ["ref", "value"],
        ),
        _schema(
            "browser_scroll",
            "Scroll the page up, down, left or right to reveal content outside the viewport. Without amount a scroll "
            "moves about a screen. Works in a background tab.",
            {
                "direction": {"type": "string", "enum": ["up", "down", "left", "right"], "description": "Direction to scroll"},
                "amount": {"type": "integer", "minimum": 100, "maximum": 5000, "description": "Distance in pixels (100-5000). Omit for about a screen."},
            },
            ["direction"],
        ),
        _schema(
            "browser_scroll_to",
            f"Scroll the page until an element is in view, without moving the pointer. Works in a background tab. {_REFS}",
            {"ref": _REF},
            ["ref"],
        ),
        _schema(
            "browser_hover",
            f"Move the pointer over an element, for menus and tooltips that open on hover. In a background tab it fails "
            f"with tab_hidden: {_BACKGROUND}. {_REFS}",
            {"ref": _REF},
            ["ref"],
        ),
        _schema(
            "browser_drag",
            "Drag one element and drop it on another. The person is asked to approve every drag and the call waits for "
            f"the answer, so do not repeat it. In a background tab it fails with tab_hidden: {_BACKGROUND}. The page is "
            f"not returned after a drag: take a snapshot to see the result. {_REFS}",
            {"ref": {**_REF, "description": "The element to pick up (e.g., '@e5')"}, "to_ref": {**_REF, "description": "The element to drop it on (e.g., '@e9')"}},
            ["ref", "to_ref"],
        ),
        _schema(
            "browser_press",
            "Press a keyboard key, optionally with modifier keys held. Useful for submitting forms (Enter), navigating "
            "(Tab), or shortcuts (Control+a). Enter or Return and paste shortcuts (Control+v, Meta+v, Shift+Insert) need "
            "the person's approval and the call waits for the answer, so do not repeat it. Works in a background tab.",
            {
                "key": {"type": "string", "description": "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown', or a combo such as 'Control+a')"},
                "modifiers": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["Alt", "Control", "Meta", "Shift"]},
                    "description": "Modifier keys held while the key is pressed",
                },
            },
            ["key"],
        ),
        _schema("browser_back", "Go back to the previous page in the tab's history."),
        _schema(
            "browser_screenshot",
            "Take a screenshot of the page, or of one element when ref is given. The image is saved to a file and the "
            "result gives its path (share it with MEDIA:<path>); open it with a vision tool when you need to see it. "
            "The person is not asked before a screenshot of a page Hermes can act in. In a background tab it can fail "
            f"with tab_hidden: ask the person to bring the tab forward (Show tab in the Hermes panel), then retry. {_REFS}",
            {"ref": {**_REF, "description": "Optional element reference to capture instead of the whole page (e.g., '@e5')"}},
        ),
        _schema(
            "browser_batch",
            "Run several actions in one tab, in order, as one call, and get the page back as it is after the last step. "
            "Prefer it when you can predict two or more steps ahead (for example click a field, type, press Enter): each "
            "step saved is a model turn saved. A step takes the arguments of the tool of the same name. A step that "
            "changes the page (a navigation, a form that re-renders) can invalidate the refs later steps use, so end the "
            "batch there. With stop_on_error (default true) the batch stops at the first failing step; it always stops "
            f"when the person declines a step. {_REFS}",
            {
                "actions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 20,
                    "description": "The steps, in order (1-20).",
                    "items": _BATCH_STEP,
                },
                "stop_on_error": {"type": "boolean", "default": True, "description": "Stop at the first failing step (default true); false runs the rest."},
            },
            ["actions"],
        ),
        _schema(
            "browser_tabs",
            "List the tabs you can act in: the ones the person attached to Hermes and the ones you opened (with "
            "tab_create, or by a click that opened a new tab). Each has its id, window, title, URL and whether it is the "
            "active tab of its window. Pass an id as tab_id to any action, or to tab_activate, tab_close and tab_group.",
        ),
        _schema(
            "browser_tab_activate",
            "Bring one of your tabs to the front, its window included. This changes what the person is looking at, so "
            "the extension asks them to approve first, naming the tab, and the call waits for their answer: do not "
            "repeat it while it waits, and treat a refusal as final. You rarely need it: pass tab_id to any action to "
            "act in a tab without bringing it forward.",
            {"tab_id": {**_TAB_ID, "description": "The tab's id from tab_list"}},
            ["tab_id"],
        ),
        _schema(
            "browser_tab_create",
            "Open a URL in a new tab, in the background and in the window of the tab you are working in, and wait for "
            "it to load. Returns the new tab's id: pass it as tab_id to act in that tab (tab_snapshot reads it). "
            "loading: true means the wait ran out and the page may not be ready yet. The person's view never moves; "
            "tab_activate brings the tab forward after they approve.",
            {"url": {"type": "string", "description": "The page to load in the new tab (e.g., 'https://example.com')"}},
            ["url"],
        ),
        _schema(
            "browser_tab_close",
            "Close one of your tabs. The extension asks the person to approve, naming the tab, and the call waits for "
            "their answer, so do not repeat it. A tab id you cannot act in is refused with lease_not_owned.",
            {"tab_id": {**_TAB_ID, "description": "The tab's id from tab_list"}},
            ["tab_id"],
        ),
        _schema(
            "browser_tab_group",
            "Put tabs into one native browser tab group so the person can see them together. The tabs you opened can "
            "be grouped, and so can tabs the person attached as a task set; tabs they attached one by one stay as they "
            "are (lease_not_owned). It never switches the tab the person is looking at and needs no approval. Returns "
            "the group's id. Chromium-based browsers only.",
            {"tab_ids": _TAB_IDS},
            ["tab_ids"],
        ),
        _schema(
            "browser_tab_ungroup",
            "Take tabs out of their native browser tab group and leave them open, the reverse of tab_group. The same "
            "rules apply. It never switches the tab the person is looking at and needs no approval. Chromium-based "
            "browsers only.",
            {"tab_ids": _TAB_IDS},
            ["tab_ids"],
        ),
    )
}
