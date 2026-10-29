"""Hermes Control tools: the agent acting in the person's own browser.

One tool per browser action the extension can run, named exactly as the wire
action (``browser_click``, ``browser_tabs``, ...). A handler resolves the
controller from the trusted ``session_id`` Hermes passes it (never from the
model's arguments) within this plugin's profile, sends the action over the
broker and returns the extension's answer as a string.

Fail-soft and fail-closed at once. With no controller attached, a controller for
another session, several controllers for this one, an offline browser, a timeout
or a refusal, the handler returns a plain error result the model can act on; it
never raises into the agent and never reaches a browser that is not this
session's. The tools are offered only while some controller is attached
(``check_fn``); the extension, not this module, decides what the person approves.
"""

from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import logging
import os
import re
import secrets
import tempfile
import time
import unicodedata
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Optional

from .context_store import _trusted_identifier
from .control_broker import (
    CONTROL_ACTIONS,
    ControlBroker,
    ControllerCancelled,
    ControllerRejected,
    ControllerTimeout,
    ControllerUnavailable,
    get_control_broker,
)
from .control_schemas import CONTROL_SCHEMAS

logger = logging.getLogger(__name__)

TOOLSET = "hermes-browser-companion"
TOOL_NAMES = CONTROL_ACTIONS

# A screenshot is a PNG the extension caps at 1.5M characters of base64. It goes to
# a file, never into the tool result, so it cannot flood the model's context.
_PNG_PREFIX = "data:image/png;base64,"
_SCREENSHOT_KEEP = 8
_SCREENSHOT_MAX_AGE_SECONDS = 3600

_CLOUD_METADATA_HOSTS = frozenset({"metadata.google.internal", "metadata.goog", "instance-data", "100.100.100.200"})
_CLOUD_METADATA_NETWORKS = (ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fd00:ec2::/32"))
# Key and token shapes that must never leave in a URL a page, or a prompt injection, could read back.
_SECRET_IN_URL = re.compile(
    r"(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
    r"|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}"
    r"|npm_[A-Za-z0-9]{30,}|ya29\.[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
)

_config: dict[str, Any] = {"broker": None, "profile": "default", "screenshot_dir": None}


def configure(*, broker: Optional[ControlBroker] = None, profile: str = "default", screenshot_dir: Any = None) -> None:
    """Point the handlers at a broker, the plugin's profile and a screenshot directory (``None``: the temp dir)."""
    _config["broker"] = broker
    _config["profile"] = str(profile or "default")
    _config["screenshot_dir"] = Path(screenshot_dir) if screenshot_dir else None


def _broker() -> ControlBroker:
    return _config["broker"] or get_control_broker()


def control_available() -> bool:
    """The tools' ``check_fn``: true only while some controller has a live transport."""
    try:
        return _broker().any_connected()
    except Exception:
        return False


def _refresh_tool_listing(_connected: bool) -> None:
    """Hermes memoizes its tool list per toolset and config, not per ``check_fn`` result
    (``model_tools.get_tool_definitions``), so a list built before a controller attached would keep
    the control tools hidden after one does. Drop that memo when control comes or goes; a Hermes
    without the memo has nothing to drop."""
    try:
        import model_tools
    except ImportError:
        return
    clear = getattr(model_tools, "_clear_tool_defs_cache", None)
    if callable(clear):
        clear()


def _failure(code: str, message: str) -> str:
    return json.dumps({"success": False, "error": message, "code": code}, ensure_ascii=False)


# ── Argument and URL checks ───────────────────────────────────────────


_SPECIAL_SCHEMES = frozenset({"http", "https", "ws", "wss", "ftp"})
_NUMERIC_LABEL = re.compile(r"0[xX][0-9a-fA-F]*|[0-9]+")
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


def _ipv4_number(part: str) -> int:
    """One label of a WHATWG IPv4 host: decimal, 0x hex or leading-0 octal."""
    if part[:2] in ("0x", "0X"):
        digits, base = part[2:], 16
    elif len(part) > 1 and part.startswith("0"):
        digits, base = part[1:], 8
    else:
        digits, base = part, 10
    return int(digits, base) if digits else 0


def _numeric_ipv4(host: str) -> Optional[ipaddress.IPv4Address]:
    """The address a browser reads from a host whose last label is a number (``2852039166``,
    ``0xa9fea9fe``, ``0251.0376.0251.0376``, ``169.254.43518``), as the WHATWG URL parser does.
    ``None`` for a host that is a name; ``ValueError`` for a numeric host a browser would refuse."""
    labels = host.split(".")
    if len(labels) > 1 and labels[-1] == "":
        labels.pop()
    if not _NUMERIC_LABEL.fullmatch(labels[-1]):
        return None
    if len(labels) > 4:
        raise ValueError("too many IPv4 parts")
    numbers = [_ipv4_number(label) for label in labels]
    if any(number > 255 for number in numbers[:-1]) or numbers[-1] >= 256 ** (5 - len(numbers)):
        raise ValueError("IPv4 part out of range")
    return ipaddress.IPv4Address(numbers[-1] + sum(number * 256 ** (3 - index) for index, number in enumerate(numbers[:-1])))


def _host_of(url: str) -> str:
    """The host a browser would take from ``url``: whitespace the URL parser drops removed, backslashes read as
    slashes, a special scheme's missing slashes supplied, the host percent-decoded and compatibility-folded
    (full-width digits) and lower-cased. ``""`` when there is none; ``ValueError`` when it cannot be read."""
    text = re.sub(r"[\t\r\n]", "", unicodedata.normalize("NFKC", url.strip())).replace("\\", "/")
    scheme = re.match(r"([A-Za-z][A-Za-z0-9+.\-]*):/*", text)
    if scheme and scheme.group(1).lower() in _SPECIAL_SCHEMES:
        text = f"{scheme.group(1)}://{text[scheme.end():]}"
    host = urllib.parse.urlsplit(text).hostname or ""
    return unicodedata.normalize("NFKC", urllib.parse.unquote(host)).lower().rstrip(".")


def _metadata_address(host: str) -> bool:
    """Whether a normalized host is, in any spelling, a cloud metadata address."""
    if host in _CLOUD_METADATA_HOSTS:
        return True
    if ":" in host:
        address: Any = ipaddress.IPv6Address(host.split("%", 1)[0])
        embedded = address.ipv4_mapped
        if embedded is None and int(address) < 2**32:  # IPv4-compatible (::a.b.c.d)
            embedded = ipaddress.IPv4Address(int(address))
        if embedded is None and address in _NAT64:
            embedded = ipaddress.IPv4Address(int(address) & 0xFFFFFFFF)
        candidates = [address] + ([embedded] if embedded is not None else [])
    else:
        numeric = _numeric_ipv4(host)
        candidates = [numeric] if numeric is not None else []
    return any(candidate in network for candidate in candidates for network in _CLOUD_METADATA_NETWORKS if candidate.version == network.version)


def _blocked_url(url: str) -> Optional[str]:
    """Why a URL must not be opened, or ``None``. The person's own browser may reach local and private
    addresses on purpose; only cloud metadata endpoints and URLs that embed a secret are refused. The host
    is read the way a browser reads it, so a decimal, hex, octal or IPv4-mapped spelling does not get past."""
    if _SECRET_IN_URL.search(url) or _SECRET_IN_URL.search(urllib.parse.unquote(url)):
        return "Blocked: the URL contains what appears to be an API key or token. Secrets must not be sent in URLs."
    try:
        if _metadata_address(_host_of(url)):
            return "Blocked: the URL targets a cloud metadata endpoint."
    except ValueError:
        return "Blocked: the URL's host could not be read safely."
    return None


def _url_refusal(action: str, args: dict[str, Any]) -> Optional[str]:
    """A refusal for an action that opens a URL (navigate, new tab, and each navigate step of a batch)."""
    if action in ("browser_navigate", "browser_tab_create"):
        url = args.get("url")
        return _blocked_url(url) if isinstance(url, str) else None
    if action == "browser_batch" and isinstance(args.get("actions"), list):
        for index, step in enumerate(args["actions"]):
            if isinstance(step, dict) and step.get("action") == "navigate" and isinstance(step.get("url"), str):
                reason = _blocked_url(step["url"])
                if reason:
                    return f"browser_batch: step {index + 1} (navigate): {reason} Nothing was run."
    return None


def _missing_argument(action: str, args: dict[str, Any]) -> Optional[str]:
    """What a call lacks, from the schema's required list (a click needs a ref or both coordinates)."""
    if action == "browser_click":
        if "ref" in args or ("x" in args and "y" in args):
            return None
        return "browser_click needs a ref, or both x and y."
    missing = [name for name in CONTROL_SCHEMAS[action]["parameters"]["required"] if args.get(name) is None]
    return f"{action} needs: {', '.join(missing)}." if missing else None


# ── Results ───────────────────────────────────────────────────────────


def _screenshot_directory() -> Path:
    return _config["screenshot_dir"] or Path(tempfile.gettempdir()) / "hermes-browser-control"


def _prune_screenshots(directory: Path) -> None:
    now = time.time()
    shots = sorted(directory.glob("shot-*.png"), key=lambda path: path.stat().st_mtime, reverse=True)
    for index, path in enumerate(shots):
        try:
            if index >= _SCREENSHOT_KEEP or now - path.stat().st_mtime > _SCREENSHOT_MAX_AGE_SECONDS:
                path.unlink()
        except OSError:
            continue


def _save_screenshot(data_url: str) -> Optional[str]:
    """Write the PNG to a private file and return its path, or ``None`` when it cannot be decoded or saved."""
    if not data_url.startswith(_PNG_PREFIX):
        return None
    try:
        image = base64.b64decode(data_url[len(_PNG_PREFIX):], validate=True)
    except (binascii.Error, ValueError):
        return None
    directory = _screenshot_directory()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"shot-{secrets.token_hex(8)}.png"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(image)
        _prune_screenshots(directory)
    except OSError:
        logger.warning("could not save a Hermes Control screenshot", exc_info=True)
        return None
    return str(path)


def _result_text(action: str, result: Any) -> str:
    if action == "browser_screenshot" and isinstance(result, dict) and "dataUrl" in result:
        path = _save_screenshot(str(result.get("dataUrl") or ""))
        if path is None:
            return _failure("screenshot_unavailable", "The screenshot could not be saved.")
        kept = {key: value for key, value in result.items() if key != "dataUrl"}
        return json.dumps({**kept, "screenshot_path": path, "media": f"MEDIA:{path}"}, ensure_ascii=False)
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False, default=str)


def _rejection(error: ControllerRejected) -> str:
    detail = error.detail
    if isinstance(detail, dict):
        message = str(detail.get("message") or detail.get("code") or "The browser refused the action.")
        return _failure(str(detail.get("code") or "rejected"), message)
    return _failure("rejected", str(detail or "The browser refused the action."))


def _tool_call_id() -> Optional[str]:
    """The id of the tool call being run, when Hermes exposes it; the extension keys a cancel by it."""
    try:
        from tools.approval_context import _approval_tool_call_id

        return _approval_tool_call_id.get() or None
    except Exception:
        return None


# ── Dispatch ──────────────────────────────────────────────────────────


def run_control_action(action: str, args: Any, kwargs: Optional[dict[str, Any]] = None) -> str:
    """Run one action in this session's browser and return the result or a plain error, as a string."""
    values = args if isinstance(args, dict) else {}
    session_id = _trusted_identifier((kwargs or {}).get("session_id"))
    if not session_id:
        return _failure("no_session", "Hermes did not say which session this call belongs to, so no browser can be chosen.")
    problem = _missing_argument(action, values)
    if problem:
        return _failure("invalid_arguments", problem)
    refusal = _url_refusal(action, values)
    if refusal:
        return _failure("url_blocked", refusal)

    broker = _broker()
    scopes = broker.lane_scopes(profile_id=_config["profile"], session_id=session_id)
    if not scopes:
        return _failure(
            "no_browser",
            "No browser is connected for this session. The person has to turn on Hermes Control in the Hermes Browser "
            "extension and attach a tab. Do not look for another browser; answer without acting, or tell them what to switch on.",
        )
    if len(scopes) > 1:
        return _failure(
            "ambiguous_browser",
            "More than one browser is connected for this session, and Hermes will not guess which one to drive. "
            "Ask the person to leave Hermes Control on in only one browser.",
        )
    scope = scopes[0]
    if broker.select(scope, action) is None:
        return _failure(
            "browser_unavailable",
            f"The browser for this session is offline or cannot run {action}. Ask the person to check Hermes Control in the extension.",
        )
    try:
        result = broker.dispatch(scope, action=action, arguments=values, tool_call_id=_tool_call_id())
    except ControllerUnavailable:
        return _failure("browser_unavailable", f"The browser for this session went offline before {action} ran.")
    except ControllerTimeout:
        return _failure(
            "timeout",
            f"The browser did not answer {action} in time. It may still have run: take a snapshot before repeating it.",
        )
    except ControllerCancelled:
        return _failure("cancelled", f"{action} was cancelled: the browser disconnected or the call was stopped.")
    except ControllerRejected as error:
        return _rejection(error)
    except Exception as error:  # never raise into the agent
        logger.exception("Hermes Control %s failed", action)
        return _failure("control_error", f"{action} failed: {type(error).__name__}.")
    return _result_text(action, result)


def make_handler(action: str) -> Callable[..., str]:
    def handler(args: Optional[dict[str, Any]] = None, **kwargs: Any) -> str:
        return run_control_action(action, args, kwargs)

    handler.__name__ = action
    return handler


def register_control_tools(ctx: Any, *, broker: Optional[ControlBroker] = None, profile: str = "default", data_dir: Any = None) -> None:
    """Register every Hermes Control tool. A name another toolset already owns (a Hermes that still has
    extension control in core) is skipped by Hermes with a warning, and that core tool keeps serving it."""
    configure(broker=broker, profile=profile, screenshot_dir=Path(data_dir) / "control-screenshots" if data_dir else None)
    _broker().add_presence_listener(_refresh_tool_listing)
    check_fn: Callable[[], bool] = control_available
    try:
        import tools.registry as hermes_registry

        # The attach state changes with the person's switch, not on a human timescale. A Hermes
        # with runtime_check_fn keys its tool-list memo on the answer; an older one only stops
        # caching the check, and the presence listener above drops its memo instead.
        mark = getattr(hermes_registry, "runtime_check_fn", None) or hermes_registry.no_cache_check_fn
        check_fn = mark(control_available)
    except Exception:
        pass
    for action in CONTROL_ACTIONS:
        schema = CONTROL_SCHEMAS[action]
        ctx.register_tool(
            name=action,
            toolset=TOOLSET,
            schema=schema,
            handler=make_handler(action),
            check_fn=check_fn,
            description=f"Hermes Control: {action} in the person's own browser, through the Hermes Browser extension.",
            emoji="🖱️",
        )
