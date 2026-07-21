# Data Flow

Hermes Browser Extension connects browser context to the Hermes Agent runtime you configure. This document describes the shipped v0.2.0 data flow.

## Connection modes

### Local Hermes API

Default Gateway URL:

```text
http://127.0.0.1:8642
```

In local mode, context is sent from the extension to the Hermes Gateway/API server running on the same machine.

### Hermes Cloud Preview

Cloud Preview requires the exact active, fully loaded, signed-in HTTPS Hermes agent tab. That tab mints a short-lived single-use WebSocket ticket, the extension revalidates the tab and origin, and the ticket stays memory-only. Cloud Preview is Chat-only: page text, selected text, open-tab context, and attachments are not sent through this transport.

### Remote Hermes API

When you configure a remote Gateway URL and API key/browser token, context is sent to that remote Hermes API server. Same-LAN or private VPN hosts can use `http://host:8642`; public/proxied hosts should use `https://`. Set `API_SERVER_ENABLED=true`, `API_SERVER_HOST=0.0.0.0`, `API_SERVER_KEY`, and a narrow `API_SERVER_CORS_ORIGINS=chrome-extension://<extension-id>` on the Hermes host. Do not expose a Hermes API server naked to the public internet.

### Remote dashboard WebSocket

When remote mode has a dashboard URL and no API key, the extension uses the signed-in dashboard tab to mint a single-use WebSocket ticket and connects to the dashboard socket. In this mode, REST-only features such as profile list and image upload can be unavailable.

## What can be sent to Hermes

Depending on context scope, settings, and page availability, a turn can include:

- user message typed into the composer
- active tab title and URL for the followed or pinned context tab
- selected text
- readable page text
- page metadata, headings, form labels, links, buttons, and interactive element labels where available
- open tab titles/URLs when “Include open tabs” is enabled, or selected open-tab summaries when you use the tab picker
- YouTube transcript text when a transcript provider is enabled and available
- attached text files or metadata for non-text files
- pasted/attached images as inline data, or as a local path when the connected Hermes runtime advertises image upload support
- voice transcript text from Hermes STT or Browser speech fallback
- selected model/session/profile/settings metadata needed to route the request
- for a model-backed Hermes Assist action: the current draft plus only the bounded site context enabled for that site

If you choose **Chat only**, the extension sends your message without active tab title/URL, open tabs, selected text, page metadata, YouTube transcript, or page text.

## Hermes Assist review/apply flow

Hermes Assist identifies the focused composer and builds a bounded draft request. The request is sent through the chosen current/new/background session route. If the gateway advertises per-session model locking, Hermes Assist sends the exact selected provider/model and fails closed on a mismatch. Released gateways without that contract receive no provider/model override and use the active model configured in Hermes Agent.

The result returns to a local review panel. The user can copy it or explicitly apply it to a supported focused composer. Structured editors default to preview/copy unless their adapter has a verified safe apply path. Applying never submits the form or message. Deterministic formatting, bullets, statistics, and diff actions run locally and do not enter this network flow.

## Hermes Web full view

Hermes Web uses the same configured Local or Remote API connection and canonical Hermes session history as the side panel. It loads sessions, models, skills, runtime options, generated media, and persisted context telemetry from the configured Hermes gateway. Opening full view does not grant browser-control permissions. Hermes Cloud/dashboard-ticket full-view history remains read-only until a shared ticketed WebSocket coordinator owns that connection.

## Browser Context Protocol and optional companion cache

v0.2.0 emits typed Browser Context Protocol v2 turn envelopes with owner/conversation/session/turn identity while retaining the prompt-embedded v1 compatibility path. It can also expose sanitized context metadata to the optional companion plugin. The plugin cache is process-local, owner-scoped, TTL-bounded, and consume-on-read. It stores safe metadata such as protocol id, payload hash, context scope, active-tab origin, section availability/counts, redaction count, and bounded event diagnostics. It does not store raw page text, selected text, full tab URLs, cookies, tokens, or browser-control channels.

## What Hermes saw receipt

v0.2.0 includes a collapsible “What Hermes saw” receipt after each sent turn. It summarizes:

- context scope, including Chat only when no browser context was attached
- active tab
- pinned tab when applicable
- whether selected text was included
- page text character count
- whether a YouTube transcript was included
- open tab count and the number of tabs actually sent to Hermes
- attachment counts
- redaction count

This receipt is for transparency and debugging. It is generated locally by the extension from the outgoing context.

## Tool activity while streaming

When Hermes reports a tool call during a streaming turn, v0.2.0 renders it as an in-message Tool Activity Strip with a sanitized short preview. Tool names and previews are generated locally from normalized runtime events; sensitive token shapes are redacted before display. Tool activity is UI state only and is not extra browser context sent to Hermes.

## Redaction and untrusted context

Before page text is sent to Hermes, the extension redacts common secret/token shapes such as bearer tokens, provider API keys, private keys, GitHub tokens, Slack tokens, JWTs, and common `key=value` secret assignments.

Before tab titles/URLs are included in the prompt, v0.2.0 redacts restricted categories such as browser internals, banking, crypto wallets, password managers, checkout/payment, health, and government tax/account pages. It also decodes and blocks credential-bearing query/hash parameters—including nested encodings and common signed-URL credentials/signatures—across active, selected, open-tab, pinned-scope, prompt, receipt, and payload-hash surfaces.

Browser page content is wrapped as untrusted context in the prompt. Hermes is instructed not to follow instructions from the page unless the human user explicitly asks.

## Capability detection

The extension reads `/v1/capabilities` when available. If an older Hermes runtime does not expose that endpoint, v0.2.0 enters legacy compatibility mode:

- core chat/session features are attempted when the Gateway is connected and authenticated
- browser-specific routes such as audio transcription, browser pairing, profile list, and image upload stay in fallback/manual mode unless advertised

v0.2.0 also separates gateway reachability from upstream Hermes runtime/tool tracebacks. If the API server is reachable but an upstream Hermes tool/runtime raises a Python traceback, the side panel can show a connected-with-warning diagnostic instead of treating the whole Browser connection as broken. Settings also include Copy Diagnostics, which creates a redacted support block without API keys, bearer tokens, cookies, page text, selected text, tab titles, or full tab URLs.

## Related docs

- [PERMISSIONS.md](PERMISSIONS.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
