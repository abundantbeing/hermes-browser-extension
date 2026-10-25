"""Access policy for the Hermes Browser companion plugin."""

# Browser control is explicitly disabled in v0.1 — the companion plugin
# only caches and serves browser context; it never drives the browser.
BROWSER_CONTROL_ENABLED = False
CONTROL_ENABLED = False
# No route that moves data, acts or changes state. The one HTTP surface is the
# read-only readiness metadata route (status_route.py); it never carries context.
ALLOW_API_SERVER_ROUTES = False
STATUS_ROUTE_ENABLED = True
ALLOW_NETWORK_SIDE_EFFECTS = False
TRUST_BOUNDARY = "browser context is untrusted webpage data"


def browser_control_allowed() -> bool:
    """v0.1 explicitly forbids browser control."""
    return False


def action_policy() -> dict:
    return {
        "browser_control": False,
        "plugin_actions": False,
        "context_caching": True,
        "approval_required": True,
        "reason": "v0.1: context caching only — no browser control or page actions.",
    }
