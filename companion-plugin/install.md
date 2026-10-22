# Hermes Browser Companion Plugin

Optional companion plugin for [Hermes Agent](https://hermes-agent.nousresearch.com).
It stores the Browser Context Protocol (BCP) v2 context that the Hermes Browser
Extension sends with a turn, and lets the agent look at that context through a
few tools. The plugin version is the `version` in `plugin.yaml`.

## What it is, and is not

- Metadata-only diagnostics plus a short-lived, owner-scoped context cache. It is
  fail-soft: when no context was delivered, every tool reports "unavailable".
- It registers **seven tools**, three lifecycle hooks (`pre_llm_call`,
  `pre_tool_call`, `post_tool_call`) and one bundled skill (`hermes-browser`).
- It does **not** control the browser, register API-server routes, open network
  connections or use `nativeMessaging`. It cannot be reached over HTTP, so the
  extension cannot detect it through a status route.
- The extension keeps its inline prompt path. The plugin is supplemental, never
  required, and removing or disabling it changes nothing for the extension.

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
metadata only.

## Install (per profile)

Hermes discovers user plugins under the profile's own plugin directory, so the
plugin is installed and enabled for each profile that should use it.

```bash
# 1. Copy the plugin into the profile's plugins directory
#    default profile:  ~/.hermes/plugins/hermes-browser-companion
#    named profile:    ~/.hermes/profiles/<profile>/plugins/hermes-browser-companion
cp -r companion-plugin ~/.hermes/profiles/<profile>/plugins/hermes-browser-companion

# 2. Preview, then enable for exactly one profile
node scripts/enable-bot-companion-tools.mjs --list
node scripts/enable-bot-companion-tools.mjs --profile <profile>            # dry run
node scripts/enable-bot-companion-tools.mjs --apply --profile <profile>    # applies

# or directly
hermes plugins enable hermes-browser-companion --profile <profile>

# 3. Restart that profile's gateway, then verify
hermes plugins list --profile <profile>
```

Enabling the plugin in one profile never changes another profile's config.

## Upgrading

Replace the staged directory with the new copy and restart the profile's
gateway. A stale copy keeps its old tools and hooks until then; compare the
`version` in `plugin.yaml` with the repository copy.

## Requirements

- Hermes Agent with plugin manifest v2 and the `pre_llm_call`, `pre_tool_call`
  and `post_tool_call` hooks (the installed 0.22.x runtime is the tested one).
- Hermes Browser Extension 0.3.0 or newer (BCP v2 turn envelopes).
