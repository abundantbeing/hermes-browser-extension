# Hermes Browser Companion

A Hermes Agent plugin for the [Hermes Browser extension](https://github.com/abundantbeing/hermes-browser-extension).
It keeps the browser context the extension sends with a turn (page text, a
selection, tab URLs) in memory for a few minutes, bound to that turn, and gives
the agent seven tools to look at it. It is optional: the extension works
without it, and removing or disabling it changes nothing for the extension.

```bash
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable
# restart the profile's gateway, then
hermes plugins list
```

Per-profile commands, upgrading and the full tool table are in
[install.md](install.md).

## What it registers

- Seven tools in the `hermes-browser-companion` toolset: `browser_context_status`,
  `browser_get_context`, `browser_clear_context`, `browser_event_log`,
  `browser_control_status`, `browser_context_journal`, `browser_text_utility`.
- Three hooks: `pre_llm_call`, `pre_tool_call`, `post_tool_call`.
- One bundled skill, `hermes-browser`.
- Four routes on the API server, all authenticated by the API server's own check:
  the read-only `GET /api/plugins/hermes-browser-companion/status` (name,
  version, profile, tool names and the route list), and the browser-context side
  channel: `GET .../context/status` (counts, ages and a hash for the caller's
  session, never page text), `POST .../context` (parks one validated
  full-context envelope for its session until a reference turn adopts it) and
  `GET .../actions` (declarative descriptors of the safe actions; nothing runs).

## Disclosure

- **No network calls.** It opens no connection to any host. The status route
  only answers a request the Hermes API server already accepted; the one upload
  route stores a validated envelope in memory and returns metadata.
- **No credentials.** It reads no secret, `.env` file, token store or OAuth
  state, and declares no `requires_env`. It asks for no privileged capability
  (`capabilities: []`).
- **No shell commands, no background processes, no telemetry.**
- **Page data stays in memory.** The context cache holds the validated payload of
  a full-context turn for 300 seconds, size-bounded and consume-on-read, bound to
  the trusted session, turn and task of the turn that delivered it. Everything it
  writes to disk or returns as diagnostics (event log, journal, tool receipts) is
  metadata only: opaque ids, hashes, tool names and timestamps. The journal and
  receipts live under the plugin's own profile data directory.
- **It cannot control the browser.** `browser_control_status` reports historical
  metadata and is always `live: false`.
- **Reads outside its own data: none.** The one file it reads is its own
  `plugin.yaml`, for the version in the status route.
