# Hermes Browser Extension plugin (`hermes-browser-extension`)

The [Hermes Agent](https://hermes-agent.nousresearch.com) plugin of the Hermes
Browser Extension. It carries Hermes Control, the agent working in the person's
own browser tabs through the extension, and stores the Browser Context Protocol
(BCP) v2 context the extension sends with a turn so the agent can look at it
through a few tools. The plugin version is the `version` in `plugin.yaml`.

## What it is, and is not

- It registers **seven context tools**, three lifecycle hooks (`pre_llm_call`,
  `pre_tool_call`, `post_tool_call`), one bundled skill (`hermes-browser-extension`),
  the context and readiness routes, and read-only profile roster and avatar routes.
  It also carries Hermes Control: **twenty Hermes Control tools** and two more
  routes (see Hermes Control below).
- The context tools do **not** control the browser. They are metadata-only
  diagnostics plus a short-lived, owner-scoped context cache, and fail-soft: when
  no context was delivered, every one reports "unavailable".
- The plugin opens no outbound network connection, does not expose or persist API
  credentials, and does not use `nativeMessaging`. It asks for no privileged host capability
  (`capabilities: []`), so installing it shows no consent screen.
- Hermes Control acts in the person's own browser, but only while the extension is
  attached to a session; see below for what that means.
- The extension keeps its inline prompt path. Without the plugin the extension
  still chats and sends page context; Hermes Control needs either this plugin or a
  Hermes that still carries extension control itself (0.22.5 and earlier).

## Requirements

- Hermes Agent 0.22 or newer (`requires_hermes: ">=0.22"`): plugin manifest v2,
  the `pre_llm_call`, `pre_tool_call` and `post_tool_call` hooks and
  `register_platform_handler("api_server", ...)`. 0.22.x is the tested runtime.
- The Hermes API server on (`API_SERVER_ENABLED=true`) for the profile, with its
  own `API_SERVER_KEY` (Hermes refuses a named profile without one).
- The Hermes Browser Extension 0.3.0 or newer (BCP v2 turn envelopes); 0.4.0 or
  newer for Hermes Control through this plugin. Hermes Control runs in
  Chromium-based browsers only.
- The extension's origin (`chrome-extension://<id>`) in `API_SERVER_CORS_ORIGINS`
  on a Hermes that does not pair with the extension itself; the extension's
  **Test connection** names the exact line.
- Nothing to install beyond the plugin: it declares no Python dependencies.

## Install (per profile)

Hermes installs plugins per profile, with its own installer: it clones, runs its
security scan, installs atomically and records where the copy came from.

```bash
# default profile, from this repository (the plugin is its companion-plugin/ subdirectory;
# the Hermes plugin catalog has no entry for it yet)
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable

# a named profile (repeat per profile that should have it)
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable --profile <profile>

# then restart that profile's gateway, and check
hermes plugins list --profile <profile>
```

`--enable` adds the plugin to that profile's `plugins.enabled` and nothing
else; leave it off to install disabled and run
`hermes plugins enable hermes-browser-extension --profile <profile>` later.
Installing or enabling in one profile never changes another profile's config.
The plugin loads when the gateway starts, so restart the profile's gateway: its
tools, hooks and routes are all wired at start, and a plugin loaded into a running
gateway is not wired into the API server's router.

To pin an exact commit of the repository install, add `--ref <40-character sha>`.
To see what would run without running it, the repository's wrapper previews the
same command:

```bash
node scripts/enable-bot-companion-tools.mjs --list                          # read-only: every profile, version, layout, enabled or not
node scripts/enable-bot-companion-tools.mjs --profile <profile>             # dry run: prints the hermes command
node scripts/enable-bot-companion-tools.mjs --apply --profile <profile>     # runs it
```

The wrapper acts on exactly one profile per run (lists, `all` and wildcards are
refused), treats `default` as the Hermes root, never edits config files itself
and never moves or deletes anything. It refuses while an older nested copy or a
copy under the plugin's old name is present (see Upgrading).

## Bot roster without a Dashboard

On a gateway that lacks `/v1/profiles`, the extension tries the plugin's
`GET /api/plugins/hermes-browser-extension/profiles` and its
`/profiles/{name}/avatar` route on the same gateway. These GET-only routes use
the listener's configured API key and list only profiles the listener serves.
They expose bot presentation fields, not filesystem paths, credentials, or
sessions. They are not registered for profile-prefixed keys.

The plugin must be installed and enabled on the gateway, and the gateway must
be restarted to register its routes. Plugin host isolation or an older runtime
without the profile inventory/handler seam can make the routes unavailable;
the extension then keeps its existing degraded fallback. A remote connection
requires the plugin on the remote host. The roster does not grant access to
other profile keys, and does not supply group-room or Dashboard WebSocket
capabilities. Those may still require a Dashboard and separate authorization.

## Upgrading

```bash
hermes plugins update hermes-browser-extension --profile <profile>
# or, for a copy that has no install record, or to move to another commit:
hermes plugins install <the same source> --enable --force [--ref <sha>] --profile <profile>
```

Then restart that profile's gateway. A stale copy keeps its old tools and
hooks until then; `hermes plugins list` and `--list` above show the installed
version next to this repository's.

### From the old name, `hermes-browser-companion`

Before 0.4.0 the plugin was called `hermes-browser-companion` and its Hermes
Control tools were named `browser_*`. Those names collide with Hermes' own
Camofox plugin, so they are now `tab_*` and the plugin is
`hermes-browser-extension`. The two copies register the same context tools, so
remove the old one before installing the new one:

```bash
hermes plugins remove hermes-browser-companion --profile <profile>
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable --profile <profile>
# restart that profile's gateway
```

The extension's About & Diagnostics row reports an old-name copy as outdated, with
these commands. The new copy starts with fresh receipts; the old ones are metadata
only.

### Replacing a copy made by hand (the old way)

Earlier versions were copied into `plugins/` by hand, often inside a clone of
this repository (`plugins/hermes-browser-extension/companion-plugin`). That layout
still loads, but `hermes plugins` does not manage it, and it must be moved out
**before** the standard install: both copies match the enabled name, so both
would load and register every tool twice. Moving the directory does not touch
`plugins.enabled`.

```bash
# 1. keep the old copy (PowerShell shown; use mv on macOS/Linux)
New-Item -ItemType Directory -Force ~/.hermes/plugins-backup | Out-Null
Move-Item ~/.hermes/plugins/hermes-browser-extension/companion-plugin ~/.hermes/plugins-backup/companion-plugin-<old-version>

# 2. install the standard way and restart the gateway
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable
```

Copies from before the hook-worker fix cannot pass a tool's authorization
across Hermes' bounded hook worker, so their owner-gated tools answer
"unavailable" and `browser_get_context` can use up the cached context without
returning it. Reinstalling fixes that.

## The status route

So the extension can tell the plugin is loaded, the plugin wires one route into
the API server (the listener the extension already pairs with, normally
`127.0.0.1:8642`):

```text
GET /api/plugins/hermes-browser-extension/status
{ "object": "hermes.browser_companion.status", "plugin": "hermes-browser-extension",
  "version": "0.4.0", "profile": "default", "tools": [...], "hooks": [...],
  "routes": ["/api/plugins/hermes-browser-extension/actions",
             "/api/plugins/hermes-browser-extension/context",
             "/api/plugins/hermes-browser-extension/context/status",
             "/api/plugins/hermes-browser-extension/control/register",
             "/api/plugins/hermes-browser-extension/control/ws",
             "/api/plugins/hermes-browser-extension/profiles",
             "/api/plugins/hermes-browser-extension/profiles/{name}/avatar",
             "/api/plugins/hermes-browser-extension/status"], "live": false }
```

`routes` lists every path this copy serves, so a client can tell an older copy
(only the status route) from one with the browser-context and control routes.

- **Read-only, metadata only.** Names, a version and the profile. It never
  reads the context cache, a session, a turn, a task id or a secret.
- **Authenticated by the API server's own check**: the paired loopback token
  or the API key, as for every other API route. If that check is unavailable
  the route answers 401; it never answers anonymously.
- It is wired through Hermes' documented `register_platform_handler("api_server", ...)`
  seam. With `plugins.isolation: host` Hermes refuses that seam; the plugin then
  loads without the route (tools and hooks are unaffected) and the extension
  falls back to the gateway's `/v1/toolsets` list to tell "loaded" from "not
  loaded".
- On a gateway that serves several profiles at one address, a named profile's
  routes carry its prefix (`/p/<profile>/api/plugins/hermes-browser-extension/status`
  and the rest). Hermes routes
  those to that profile's own copy of the plugin only once it supports plugin
  routes per profile; until then they answer 404 and the extension reports the
  plugin as not loaded for that profile.
- Dashboard plugin routes (`/api/plugins/<name>/...` on the dashboard port) need
  the Webapp credential and a dashboard manifest, so the plugin does not use them.

## The browser-context routes

Three more routes, wired by the same factory and authenticated the same way
(the paired loopback token or the API key; 401 otherwise). They give the
extension a side channel that Hermes itself does not have. Context status and
upload name the caller's session with the `X-Hermes-Session-Id` header (or
`?session_id=`), the id the API server uses for a chat.

```text
GET  /api/plugins/hermes-browser-extension/context/status
     -> { "object": "hermes.browser_companion.context_status", "held": 1,
          "consumed": 0, "payload_hash": "...", "scope": "...",
          "newest_age_ms": 4000, "oldest_age_ms": 4000, "expires_in_ms": 296000,
          "pending_upload": { "present": false }, "live": false }
POST /api/plugins/hermes-browser-extension/context        (the envelope as the body)
     -> { "object": "hermes.browser_companion.context_upload", "stored": true,
          "payload_hash": "...", "scope": "...", "adopts": "reference-turn", ... }
GET  /api/plugins/hermes-browser-extension/actions
     -> { "object": "hermes.browser_companion.actions", "execution": "none",
          "actions": [ { "name": "browser_text_utility", "kind": "agent-tool", ... } ] }
```

- **Status is metadata only**: counts, ages, the newest context hash and scope,
  whether an upload is waiting, and `live: false`. Never page text, URLs, titles
  or a session, turn or task id.
- **Upload takes the same envelope the `pre_llm_call` hook accepts**: a full
  `hermes.browser.turn.v2` turn, checked by the same parser and the same size
  bound (anything else is refused with 422, an oversized body with 413). It does
  not become readable on arrival. An upload names a session, not an owner, so it
  waits (one slot per session, 300 seconds) until a trusted hook sees a
  *reference* turn for that session that names the same context hash; only then
  is it bound to that turn's session, turn and task and given an opaque context
  id. After that the usual rules apply: owner-scoped, consume-on-read, unreadable
  by another turn, session or profile, and reachable only through
  `browser_get_context` and its one-shot lease. A chat-only turn, a different
  hash or another session adopts nothing.
- **Actions are descriptors, never execution.** The list names the plugin's safe
  actions (today `browser_text_utility`: bounded, local, no model, no network)
  with their parameter schema. No route runs one; the agent calls the tool inside
  a turn, under Hermes' own tool approval. The owner-gated context tools are not
  actions and are not listed.

The extension's About & Diagnostics row reads the status route as one of: ready,
outdated (an older version, missing tools, or a copy under the old name),
disabled (its toolset is switched off for the API server), not installed (not
loaded on this gateway: not installed, not enabled for the profile, or the
gateway was not restarted), or unreachable, each with its exact reason.

## Context tools

| Tool | What it returns |
|---|---|
| `browser_context_status` | Whether a context is cached for this exact turn (metadata only) |
| `browser_get_context` | The cached BCP payload for a `context_id`, **once** (consume-on-read) |
| `browser_clear_context` | Clears this turn's cached context |
| `browser_event_log` | Recent redacted plugin events for this owner |
| `browser_control_status` | Historical Browser control metadata from the turn envelope (`live: false`, never authority) |
| `browser_context_journal` | Metadata-only journal rows for this owner; never page data |
| `browser_text_utility` | Local text cleanup, bullets, stats or diff; no model or network call |

Context is bound to the trusted Hermes `session_id`, `turn_id` and `task_id`
of the turn that delivered it. A later turn, a new session, a delegated
subagent, a sibling task or another profile cannot read it, and a hash
reference turn (`delivery: "reference"`) carries no payload to store. The cache
is in memory only (300 seconds, bounded); the journal and receipts hold
metadata only. Browser-supplied scope, context hash, controller and
browser-profile ids are kept only when they look like opaque ids (a UUID, a hex
hash or a short slug without a credential-style prefix); anything else is
dropped.

## Hermes Control

The agent works in the person's own browser through the extension. Two more
routes, wired by the same factory and answered only after the API server's own
check (register) or a one-shot ticket (the live channel):

```text
POST /api/plugins/hermes-browser-extension/control/register
     -> 201 { "protocol_version": 1, "ticket": "...", "ticket_expires_in_seconds": 30,
              "ws_path": "/api/plugins/hermes-browser-extension/control/ws", "scope": {...} }
GET  /api/plugins/hermes-browser-extension/control/ws   (WebSocket; the ticket rides in Sec-WebSocket-Protocol)
```

| Tool | Acts in the person's browser to |
|---|---|
| `tab_list`, `tab_create`, `tab_activate`, `tab_close`, `tab_group`, `tab_ungroup` | list the tabs Hermes can use (with each one's window), open a page in a new background tab and wait for it, bring a tab to the front, close one, group the tabs Hermes opened |
| `tab_navigate`, `tab_back`, `tab_snapshot`, `tab_screenshot` | load a URL, go back, read the page, capture it |
| `tab_click`, `tab_type`, `tab_fill`, `tab_select`, `tab_press`, `tab_hover`, `tab_drag` | act on an element by its ref |
| `tab_scroll`, `tab_scroll_to`, `tab_batch` | scroll, bring an element into view, run up to 20 steps in one call |

- **Several tabs at once.** Every page action takes `tab_id` and works in a
  background tab without changing what the person sees (hover, drag and
  screenshots need the tab in front). Each result names the tab it ran in, and a
  tab that opens during a click is not attached (Hermes cannot tell whether the
  click or the person opened it): the result counts it under
  `opened_tabs_not_attached`, and the person attaches it if needed. Refs
  belong to the tab they came from.
- **Offered only while attached.** The tools appear only while some controller is
  attached, and a call reaches only the controller registered for its own Hermes
  session and profile; another session's, none, or more than one answer a plain
  error. The agent is told to say so, never to look for another browser.
- **One credential per session.** A session is bound to the credential that first
  attached its controller, through a dropped connection and for a short grace
  after (until an explicit detach). Another credential is refused (409) at
  register and at attach, never swapped in, and registration is refused (503)
  whenever the gateway's session store cannot confirm the session exists.
- **The extension decides.** Which tabs, which actions and which approvals
  (submit-like clicks, Enter, drags, switching or closing tabs) are the
  extension's, and a refusal comes back as the answer. The plugin adds only a
  block on cloud-metadata addresses and on URLs that embed an API key or token.
- **Screenshots go to a file**, not into the model's context: a private file under
  the plugin's data directory (the temp directory without one), the eight newest kept
  for an hour at most.
- Raw CDP, page evaluation and artifact upload or download are not part of this.
- **Why `tab_*`.** Hermes' Camofox plugin owns `browser_navigate`, `browser_click`
  and the other `browser_*` names, and Hermes refuses a second plugin's tool under
  a name already taken, so these tools have their own names. A Hermes that still
  carries extension control itself (0.22.5 and earlier) offers its own `browser_*`
  control tools; the extension then attaches to that, and these stay hidden.
- The routes exist only after the gateway restarts with the plugin enabled, and not
  under `plugins.isolation: host`. The Cloud and dashboard transport is not covered.
