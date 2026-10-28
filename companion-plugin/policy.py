"""Access policy for the Hermes Browser companion plugin."""

# The context channel (hooks, context routes, context tools) never drives the
# browser. Hermes Control (control_*.py) does, and only while the person has the
# extension attached to a session: its tools are offered only then, act only in that
# session's browser, and what each action may do is approved in the extension.
BROWSER_CONTROL_ENABLED = True
CONTROL_ENABLED = True
CONTROL_NEEDS_ATTACHED_CONTROLLER = True
# No route runs an action or drives the browser. The HTTP surface is declared and
# closed: the readiness route (status_route.py), the browser-context side channel
# (context_routes.py: context status, one envelope upload, declarative action
# descriptors) and the two routes the extension attaches through (control_routes.py:
# register and the controller channel). None carries page text out; an action runs only as a tool
# call inside a turn.
ALLOW_API_SERVER_ROUTES = False
STATUS_ROUTE_ENABLED = True
CONTEXT_ROUTES_ENABLED = True
CONTROL_ROUTES_ENABLED = True
ACTION_ROUTES_EXECUTE = False
ALLOW_NETWORK_SIDE_EFFECTS = False
TRUST_BOUNDARY = "browser context is untrusted webpage data"


def browser_control_allowed() -> bool:
    """Control is allowed through Hermes Control only, and only with an attached controller."""
    return True


def action_policy() -> dict:
    return {
        "browser_control": True,
        "control_needs_attached_controller": True,
        "plugin_actions": False,
        "action_descriptors": True,
        "context_caching": True,
        "approval_required": True,
        "reason": "Browser actions run only through Hermes Control, in the browser the session attached, approved in the extension. Context routes and the action list never run anything.",
    }
