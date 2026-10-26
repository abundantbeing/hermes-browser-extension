"""Access policy for the Hermes Browser companion plugin."""

# Browser control is explicitly disabled in v0.1 — the companion plugin
# only caches and serves browser context; it never drives the browser.
BROWSER_CONTROL_ENABLED = False
CONTROL_ENABLED = False
# No route that acts, drives the browser or runs anything. The HTTP surface is
# declared and closed: the readiness route (status_route.py) and the browser-context
# side channel (context_routes.py: context status, one envelope upload, declarative
# action descriptors). None of them executes an action or carries page text out.
ALLOW_API_SERVER_ROUTES = False
STATUS_ROUTE_ENABLED = True
CONTEXT_ROUTES_ENABLED = True
ACTION_ROUTES_EXECUTE = False
ALLOW_NETWORK_SIDE_EFFECTS = False
TRUST_BOUNDARY = "browser context is untrusted webpage data"


def browser_control_allowed() -> bool:
    """v0.1 explicitly forbids browser control."""
    return False


def action_policy() -> dict:
    return {
        "browser_control": False,
        "plugin_actions": False,
        "action_descriptors": True,
        "context_caching": True,
        "approval_required": True,
        "reason": "Context caching only: no browser control or page actions. Actions are listed as descriptors and never run by a route.",
    }
