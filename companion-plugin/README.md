# Hermes Browser Extension: the Hermes plugin

The Hermes side of the [Hermes Browser Extension](https://github.com/abundantbeing/hermes-browser-extension),
the browser extension that connects your own browser to your Hermes Agent. It is
not a separate browser: it works in the browser you already use, in the tabs you
choose to share.

The plugin gives Hermes two things:

- **Hermes Control.** Your agent works in your real browser tabs, the ones you
  attach and the ones it opens, across several tabs at once: it reads pages,
  clicks, types, fills forms, scrolls, opens pages in new background tabs,
  switches between them, closes and groups them. The extension asks you before
  anything consequential (sending, buying, deleting, switching what you are
  looking at), and it never touches password or payment fields.
- **Browser context.** The page, selection and tabs you send with a message
  reach the agent as untrusted reference data, through seven read-only tools.

## What you need

| You need | For |
|---|---|
| **Hermes Agent 0.22 or newer**, with its API server on (`API_SERVER_ENABLED=true`) | Everything |
| **The Hermes Browser Extension**, connected to that Hermes | Everything |
| **This plugin**, installed and enabled for every Hermes profile the extension talks to, then that profile's gateway restarted | Hermes Control on Hermes builds without built-in extension control (canary builds from Oct 24, 2026, and every release after 0.22.5); the browser-context tools on any Hermes |
| **A Chromium-based browser** (Chrome, Edge, Brave, Comet, Arc, ...) | Hermes Control. Firefox gets chat and page context only: it has no debugger API |
| **The extension's address in `API_SERVER_CORS_ORIGINS`** (`chrome-extension://<id>`) | A Hermes that does not pair with the extension by itself. The extension's **Test connection** button shows the exact line to add |

Hermes 0.22.5 and earlier still carry Hermes Control in Hermes itself; there the
extension uses that, and this plugin adds the browser-context tools.

Things to know:

- **Named profiles (bots).** Each profile needs the plugin enabled and its own
  `API_SERVER_KEY`. On a gateway that serves several profiles at one address,
  Hermes Control reaches a named profile's copy of the plugin only on a Hermes
  that routes plugin calls per profile (`/p/<profile>/api/plugins/...`); until
  then it works for the default profile.
- **Hermes Cloud and dashboard connections** are chat-only in the extension, so
  they do not use this plugin.
- **One browser per chat.** Hermes Control drives the browser that attached the
  chat; two browsers on the same chat are refused rather than guessed between.

## Install

```bash
# from the plugin catalog
hermes plugins install hermes-browser-extension --enable
# or straight from the repository
hermes plugins install https://github.com/abundantbeing/hermes-browser-extension.git#companion-plugin --enable

# then restart the gateway, and check
hermes plugins list
```

Add `--profile <name>` to install it for a named profile. Then, in the extension,
open **Settings › About & Diagnostics**: the plugin's row says whether it is
loaded, its version and its tools. To use Hermes Control, turn it on in the
**Hermes Control** panel and attach a tab.

Coming from the plugin's previous name, `hermes-browser-companion`? Remove that
copy first (`hermes plugins remove hermes-browser-companion`): both register the
same context tools. The extension flags an old copy in About & Diagnostics.

[install.md](install.md) has per-profile commands, upgrading, every route and
the full tool reference.

## What it adds to Hermes

- **Twenty Hermes Control tools**, offered only while your browser is attached
  to the chat: `tab_list`, `tab_create`, `tab_activate`, `tab_close`,
  `tab_group`, `tab_ungroup` to manage tabs, and `tab_navigate`, `tab_back`,
  `tab_snapshot`, `tab_screenshot`, `tab_click`, `tab_type`, `tab_fill`,
  `tab_select`, `tab_press`, `tab_hover`, `tab_drag`, `tab_scroll`,
  `tab_scroll_to` and `tab_batch` to act in a page. Every page action takes a
  `tab_id`, so the agent can work in a background tab without moving you, and
  every result says which tab it ran in. They are separate from Hermes'
  `browser_exec` and from other plugins' `browser_*` tools.
- **Seven context tools**: `browser_context_status`, `browser_get_context`,
  `browser_clear_context`, `browser_event_log`, `browser_control_status`,
  `browser_context_journal`, `browser_text_utility`.
- Three hooks (`pre_llm_call`, `pre_tool_call`, `post_tool_call`), one bundled
  skill (`hermes-browser-extension`) and six routes on the API server under
  `/api/plugins/hermes-browser-extension/`, each behind the API server's own
  authentication.

## Disclosure

- **It acts in your browser only through the extension, and only in the tabs you
  attached or it opened.** What needs your approval is decided in the extension.
  Raw CDP, page scripts and file transfer are not part of it, and the plugin
  refuses URLs that point at cloud-metadata addresses or carry an API key.
- **No outbound network calls.** It opens no connection to any host. The extension
  connects to the plugin's routes on your Hermes API server, never the other way.
- **No credentials.** It reads no secret, `.env` file, token store or OAuth state,
  declares no `requires_env` and asks for no privileged capability
  (`capabilities: []`).
- **No shell commands, no background processes, no telemetry.**
- **Page data stays in memory.** Context a turn delivers is held for at most 300
  seconds, bound to that turn, and consumed on read. What it writes to disk is
  metadata only (opaque ids, hashes, tool names, timestamps) under its own profile
  data directory, plus screenshots the agent takes: private files, the eight
  newest kept for an hour at most.
- **Reads outside its own data: none.** The one file it reads is its own
  `plugin.yaml`, for the version it reports.
