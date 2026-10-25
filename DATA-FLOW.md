# Data Flow

Hermes Browser Extension connects browser context to the Hermes Agent runtime you configure. This document describes the data flow of the current release.

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

## Projects, live sessions, context readings and compaction

These screens use the connection you already configured and add no new destination. They need the Hermes dashboard WebSocket; a REST-only connection does not send any of these requests.

- **Projects** (`projects.list`, `projects.tree`, `projects.project_sessions`, `projects.create`, `projects.for_cwd`): the extension asks the gateway for the active profile's projects and receives project names, folder paths on the machine running Hermes, session counts, session titles and last-activity times. When you create a project it sends the name and the folder path you typed, and when you type a folder to check where a session would land it sends that path. These answers are held in memory under the connection, account and profile they were read for, and are dropped when any of them changes. The only thing stored in the browser is which drawer tab you last used.
- **Moving a session and starting one in a project**: a move is sent as a `session.mutate` workspace change carrying the session id, the folder you chose and the revision the extension last read, and the extension reads the session back afterwards. A new session in a project is created with that folder as its working directory. Nothing about the move is kept in this browser.
- **Live sessions**: while the panel is open and connected over the dashboard WebSocket it polls the gateway's live-session list (ids, titles, sources, status and counts, scoped by the gateway to your account), asks `subagent.list` for a few idle rows, and reads the status and history of a running session you open. Nothing from those answers is sent anywhere else.
- **Context readings**: `session.context_breakdown` and `session.usage` return token counts, category estimates and the names of context files for a session. The last reading per session is kept in extension storage (up to 100 sessions) so it shows when the session opens.
- **Capability probes**: the connection state, `gateway.ready`, `/v1/capabilities` (a bounded read when the context card opens on a REST connection) and the refusals the gateway gives to a method are recorded as capability states with their source and time, in memory only. They decide what the panel offers; a stale or closed-connection answer is shown but never used to start anything. The support report prints the same rows.
- **Compact context**: on a gateway with session authority the extension reads the session, sends one `session.mutate` request with `operation: compress` and, optionally, a focus topic, then reads the session again. The summary is written by Hermes, not by the extension.
- **Replay**: after a reconnect the extension sends the last event sequence number it saw for a session (`session.events.since`) and receives the events it missed.

## Hermes Web full view

Hermes Web uses the same configured Local or Remote API connection and canonical Hermes session history as the side panel. It loads sessions, models, skills, runtime options, generated media, and persisted context telemetry from the configured Hermes gateway. Opening full view does not grant browser-control permissions. Hermes Cloud/dashboard-ticket full-view history remains read-only until a shared ticketed WebSocket coordinator owns that connection.

## Browser Context Protocol and optional companion cache

The extension emits typed `hermes.browser.turn.v2` envelopes with owner/conversation/session/turn identity while retaining the prompt-embedded v1 compatibility path.

## Controller and artifact flow

When Hermes Control is enabled, the extension registers one authenticated controller and attaches the selected tabs. Commands are bound to the controller, browser profile, attachment owner, tab, frame, and document generation. Browser-bound turns do not fall back to another browser backend. Sensitive targets and restricted URLs fail closed; consequential and privileged actions pause for explicit approval.

Frames of an attached page are read and judged by the extension through the browser's own debugger protocol, with no script run in the page for that check: a frame on a restricted page is never read, the frame chain above a control is checked again before an action, and a frame that Chrome runs in its own process is neither read nor acted on. A frame's controls reach Hermes only as part of the same redacted page view as the page's own.

Artifact upload/download is scoped, TTL-bounded, checksum-verified, and one-shot. Durable controller and companion records contain metadata and redacted receipts only, not page bytes or raw command payloads. If the optional companion plugin is enabled for the Hermes profile, it also keeps the validated BCP v2 payload of a full-context turn (including the page text, selected text and tab URLs that turn carried) in process memory only, bound to that turn's trusted Hermes session, turn and task identity. The record is TTL-bounded (300 seconds), size-bounded, consume-on-read, and unreadable by another turn, session, subagent or profile; a hash-reference turn stores nothing. Everything the plugin writes to disk or returns as diagnostics (event log, journal, tool receipts) is metadata only: opaque ids, hashes, scope, timestamps and tool names, never page text, selected text, URLs, typed values, credentials or browser-control channels. Browser-supplied scope, context hash, controller and browser-profile identifiers are kept only if they look like an opaque id (a UUID, a hex hash or a short slug without a credential-style prefix); anything else is dropped before it is stored or logged. The plugin opens no network connections and cannot control the browser. Its one HTTP surface is a read-only status route on the Hermes API server (`GET /api/plugins/hermes-browser-companion/status`, the API server's own authentication) that returns only the plugin's name, version, profile and tool names, never context, ids or secrets.

## What Hermes saw receipt

The panel includes a collapsible “What Hermes saw” receipt after each sent turn. It summarizes:

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

When Hermes reports a tool call during a streaming turn, the panel renders it as an in-message Tool Activity Strip with a sanitized short preview. Tool names and previews are generated locally from normalized runtime events; sensitive token shapes are redacted before display. Tool activity is UI state only and is not extra browser context sent to Hermes.

## Redaction and untrusted context

Before page text is sent to Hermes, the extension redacts common secret/token shapes such as bearer tokens, provider API keys, private keys, GitHub tokens, Slack tokens, JWTs, and common `key=value` secret assignments.

Before tab titles/URLs are included in the prompt, the extension redacts restricted categories such as browser internals, banking, crypto wallets, password managers, checkout/payment, health, and government tax/account pages. It also decodes and blocks credential-bearing query/hash parameters—including nested encodings and common signed-URL credentials/signatures—across active, selected, open-tab, pinned-scope, prompt, receipt, and payload-hash surfaces.

Browser page content is wrapped as untrusted context in the prompt. Hermes is instructed not to follow instructions from the page unless the human user explicitly asks.

## Capability detection

The extension reads `/v1/capabilities` when available, and on a dashboard connection it also uses what `gateway.ready` reports. Settings > About & Diagnostics shows each feature's state (available, cached, degraded, blocked, unsupported or unknown), the exact reason, its source and its age. A feature the gateway never advertises is shown as "not advertised", not as unsupported, and the optional companion plugin is the exception to "the extension cannot tell": it answers a metadata-only status route of its own, which the extension reads to show ready, outdated, disabled, not installed or unreachable with the exact reason. Without that probe the extension cannot tell whether the plugin is loaded, because no gateway capability advertises it. If an older Hermes runtime does not expose that endpoint, the extension enters legacy compatibility mode:

- core chat/session features are attempted when the Gateway is connected and authenticated
- browser-specific routes such as audio transcription, browser pairing, profile list, and image upload stay in fallback/manual mode unless advertised

The extension also separates gateway reachability from upstream Hermes runtime/tool tracebacks. If the API server is reachable but an upstream Hermes tool/runtime raises a Python traceback, the side panel can show a connected-with-warning diagnostic instead of treating the whole Browser connection as broken. Settings also include Copy Diagnostics, which creates a redacted support block without API keys, bearer tokens, cookies, page text, selected text, tab titles, or full tab URLs.

## Related docs

- [PERMISSIONS.md](PERMISSIONS.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
