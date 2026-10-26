# Hermes Browser Companion Plugin

Optional companion plugin for [Hermes Agent](https://hermes-agent.nousresearch.com).
It stores the Browser Context Protocol (BCP) v2 context that the Hermes Browser
Extension sends with a turn, and lets the agent look at that context through a
few tools. The plugin version is the `version` in `plugin.yaml`.

## What it is, and is not

- Metadata-only diagnostics plus a short-lived, owner-scoped context cache. It is
  fail-soft: when no context was delivered, every tool reports "unavailable".
- It registers **seven tools**, three lifecycle hooks (`pre_llm_call`,
  `pre_tool_call`, `post_tool_call`), one bundled skill (`hermes-browser`) and
  four routes on the API server (below).
- It does **not** control the browser, open network connections, read
  credentials or use `nativeMessaging`. It asks for no privileged host
  capability (`capabilities: []`), so installing it shows no consent screen.
- The extension keeps its inline prompt path. The plugin is supplemental, never
  required, and removing or disabling it changes nothing for the extension.

## Install (per profile)

Hermes installs plugins per profile, from Git, with its own installer: it
clones, runs its security scan, installs atomically and records where the copy
came from. The plugin lives in the `companion-plugin/` subdirectory of this
repository, which the installer accepts as `<git url>#<subdir>`.

```bash
# default profile
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable

# a named profile (repeat per profile that should have it)
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable --profile <profile>

# then restart that profile's gateway, and check
hermes plugins list --profile <profile>
```

`--enable` adds the plugin to that profile's `plugins.enabled` and nothing
else; leave it off to install disabled and run
`hermes plugins enable hermes-browser-companion --profile <profile>` later.
Installing or enabling in one profile never changes another profile's config.
The plugin loads when the gateway starts, so restart the profile's gateway: its
tools, hooks and routes are all wired at start, and a plugin loaded into
a running gateway is not wired into the API server's router.

To pin an exact commit, add `--ref <40-character sha>`. To see what would run
without running it, the repository's wrapper previews the same command:

```bash
node scripts/enable-bot-companion-tools.mjs --list                          # read-only: every profile, version, layout, enabled or not
node scripts/enable-bot-companion-tools.mjs --profile <profile>             # dry run: prints the hermes command
node scripts/enable-bot-companion-tools.mjs --apply --profile <profile>     # runs it
```

The wrapper acts on exactly one profile per run (lists, `all` and wildcards are
refused), treats `default` as the Hermes root, never edits config files itself
and never moves or deletes anything. It refuses while an older nested copy is
present (see Upgrading).

## Upgrading

```bash
hermes plugins update hermes-browser-companion --profile <profile>
# or, for a copy that has no install record, or to move to another commit:
hermes plugins install <the same url> --enable --force [--ref <sha>] --profile <profile>
```

Then restart that profile's gateway. A stale copy keeps its old tools and
hooks until then; `hermes plugins list` and `--list` above show the installed
version next to this repository's.

### Replacing a copy made by hand (the old way)

Earlier versions were copied into `plugins/` by hand, often inside a clone of
this repository (`plugins/hermes-browser-extension/companion-plugin`). That
layout still loads, but `hermes plugins` does not manage it, and it must be
moved out **before** the standard install: both copies match the enabled name
`hermes-browser-companion`, so both would load and register every tool twice.
Moving the directory does not touch `plugins.enabled`.

```bash
# 1. keep the old copy (PowerShell shown; use mv on macOS/Linux)
New-Item -ItemType Directory -Force ~/.hermes/plugins-backup | Out-Null
Move-Item ~/.hermes/plugins/hermes-browser-extension/companion-plugin ~/.hermes/plugins-backup/companion-plugin-<old-version>

# 2. install the standard way and restart the gateway
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable
```

Do not use `hermes plugins remove hermes-browser-extension/companion-plugin` for
this: it also drops `hermes-browser-companion` from `plugins.enabled` (the same
manifest name), so the new copy would then show "not enabled". The plugin's data
directory is keyed by plugin id, so the new copy starts with fresh receipts; the
old ones are metadata only and are left where they are.

Copies from before the hook-worker fix cannot pass a tool's authorization
across Hermes' bounded hook worker, so their owner-gated tools answer
"unavailable" and `browser_get_context` can use up the cached context without
returning it. Reinstalling fixes that.

## The status route

So the extension can tell the plugin is loaded, the plugin wires one route into
the API server (the listener the extension already pairs with, normally
`127.0.0.1:8642`):

```text
GET /api/plugins/hermes-browser-companion/status
{ "object": "hermes.browser_companion.status", "plugin": "hermes-browser-companion",
  "version": "0.4.0", "profile": "default", "tools": [...], "hooks": [...],
  "routes": ["/api/plugins/hermes-browser-companion/actions",
             "/api/plugins/hermes-browser-companion/context",
             "/api/plugins/hermes-browser-companion/context/status",
             "/api/plugins/hermes-browser-companion/status"], "live": false }
```

`routes` lists every path this copy serves, so a client can tell an older copy
(only the status route) from one with the browser-context routes below.

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
- Dashboard plugin routes (`/api/plugins/<name>/...` on the dashboard port) need
  the Webapp credential and a dashboard manifest, so the plugin does not use them.

## The browser-context routes

Three more routes, wired by the same factory and authenticated the same way
(the paired loopback token or the API key; 401 otherwise). They give the
extension a side channel that Hermes itself does not have. Context status and
upload name the caller's session with the `X-Hermes-Session-Id` header (or
`?session_id=`), the id the API server uses for a chat.

```text
GET  /api/plugins/hermes-browser-companion/context/status
     -> { "object": "hermes.browser_companion.context_status", "held": 1,
          "consumed": 0, "payload_hash": "...", "scope": "...",
          "newest_age_ms": 4000, "oldest_age_ms": 4000, "expires_in_ms": 296000,
          "pending_upload": { "present": false }, "live": false }
POST /api/plugins/hermes-browser-companion/context        (the envelope as the body)
     -> { "object": "hermes.browser_companion.context_upload", "stored": true,
          "payload_hash": "...", "scope": "...", "adopts": "reference-turn", ... }
GET  /api/plugins/hermes-browser-companion/actions
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

The extension's About & Diagnostics row reads the status route as one of: ready, outdated,
disabled (its toolset is switched off for the API server), not installed (not
loaded on this gateway: not installed, not enabled for the profile, or the
gateway was not restarted), or unreachable, each with its exact reason.

## Tools

| Tool | What it returns |
|---|---|
| `browser_context_status` | Whether a context is cached for this exact turn (metadata only) |
| `browser_get_context` | The cached BCP payload for a `context_id`, **once** (consume-on-read) |
| `browser_clear_context` | Clears this turn's cached context |
| `browser_event_log` | Recent redacted companion events for this owner |
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

## Requirements

- Hermes Agent 0.22 or newer (`requires_hermes: ">=0.22"`): plugin manifest v2
  and the `pre_llm_call`, `pre_tool_call` and `post_tool_call` hooks. 0.22.x is
  the tested runtime.
- Hermes Browser Extension 0.3.0 or newer (BCP v2 turn envelopes).
- Nothing to install beyond the plugin: it declares no Python dependencies.
