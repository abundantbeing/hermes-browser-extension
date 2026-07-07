# Hermes Browser Companion Plugin

Optional companion plugin for [Hermes Agent](https://hermes-agent.nousresearch.com).
Caches browser context from the Hermes Browser Extension and exposes it
to the agent via tools and lifecycle hooks.

## Status

- **v0.1.10** — functional context cache with tool and hook support.
- Fail-soft: gracefully unavailable when the extension is not connected.
- No browser control, no API server routes, no `nativeMessaging`.
- The Browser Extension keeps its prompt-embedded fallback — this plugin
  is supplemental, not required.

## Manual Install

```bash
# 1. Copy the plugin to your Hermes profile plugins directory
cp -r companion-plugin ~/.hermes/plugins/hermes-browser-companion

# 2. Enable it
hermes plugins enable hermes-browser-companion

# 3. Verify
hermes plugins list
```

## What it does

1. The Browser Extension sends page context embedded in prompts (as it
   always has — no extension changes needed).
2. The companion plugin's `pre_llm_call` hook automatically detects and
   caches that context.
3. The agent can query the cached context via:
   - `browser_context_status` — is context available?
   - `browser_get_context` — return the full context envelope
   - `browser_clear_context` — reset the cache
   - `browser_event_log` — recent events for diagnostics
4. The bundled `hermes-browser` skill teaches the agent when to use
   these tools.

## Requirements

- Hermes Agent 0.17+
- Hermes Browser Extension v0.1.10+
