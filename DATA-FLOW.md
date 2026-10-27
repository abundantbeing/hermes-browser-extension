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

In this mode Bot Mode reads its roster from the gateway's `GET /v1/profiles` and each bot's picture from `GET /v1/profiles/{name}/avatar`, with the same API key, on that gateway only. It never looks for a dashboard on this computer; a gateway without `/v1/profiles` leaves Bot Mode without a roster and says a dashboard companion is needed.

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

- **Projects** (`projects.list`, `projects.tree`, `projects.project_sessions`, `projects.create`, `projects.for_cwd`): the extension asks the gateway for the active profile's projects and receives project names, folder paths on the machine running Hermes, session counts, session titles and last-activity times. When you create a project it sends the name and the folders you added or typed, and when you type a folder to check where a session would land it sends that path. **Generate idea** sends the project name to the gateway's `llm.oneshot`, and the folder picker asks the gateway (`projects.for_cwd`, `projects.discover_repos` and `complete.path`) for the folders it lists on its own machine; the idea text itself is sent only as the message you choose to send in a session. These answers are held in memory under the connection, account and profile they were read for, and are dropped when any of them changes. The only thing stored in the browser is which drawer tab you last used.
- **Moving a session and starting one in a project**: a move is sent as a `session.mutate` workspace change carrying the session id, the folder you chose and the revision the extension last read, and the extension reads the session back afterwards. A new session in a project is created with that folder as its working directory. Nothing about the move is kept in this browser.
- **Live sessions**: while the panel is open and connected over the dashboard WebSocket it polls the gateway's live-session list (ids, titles, sources, status and counts, scoped by the gateway to your account), asks `subagent.list` for a few idle rows, and reads the status and history of a running session you open. Nothing from those answers is sent anywhere else.
- **Context readings**: `session.context_breakdown` and `session.usage` return token counts, category estimates and the names of context files for a session. The last reading per session is kept in extension storage (up to 100 sessions) so it shows when the session opens.
- **Capability probes**: the connection state, `gateway.ready`, `/v1/capabilities` (a bounded read when the context card opens on a REST connection) and the refusals the gateway gives to a method are recorded as capability states with their source and time, in memory only. They decide what the panel offers; a stale or closed-connection answer is shown but never used to start anything. The support report prints the same rows.
- **Compact context**: on a gateway with session authority the extension reads the session, sends one `session.mutate` request with `operation: compress` and, optionally, a focus topic, then reads the session again. The summary is written by Hermes, not by the extension.
- **Replay**: after a reconnect the extension sends the last event sequence number it saw for a session (`session.events.since`) and receives the events it missed.

## Held Hermes Web sign-in

With a gateway that carries the extension-pairing routes, the panel needs to hold nothing: it asks the paired gateway's loopback-only pairing routes (`webapp-ticket` and `webapp-socket-ticket`, with the paired token as `Authorization`) for a one-use ticket, opens a signed-in Hermes Web tab with the ticket in the launch URL's fragment, and dials the Webapp's `/api/ws` with a socket ticket as a WebSocket subprotocol. The tickets expire in seconds and `hermes webapp --sign-out` voids them. A gateway without those routes answers a plain 404, and the panel falls back to the sign-in below. The first signed-in Hermes Web tab in a run of the gateway shows the extension's own "Opening Hermes Web" page while it loads; later tabs in the same run load out of sight and come forward once the Webapp is there. To tell runs apart the background worker asks the paired gateway for `GET /health/detailed` (its process id, with the paired token) when you press Hermes Web, and keeps the gateway address and that id in `chrome.storage.local` (`hermesWebSignedInRuntime`); a gateway that does not answer counts as one run per browser session. Nothing else is stored, and nothing is sent anywhere but your gateway.

The panel can also hold the Hermes Web sign-in in `chrome.storage.session` (browser memory, cleared when the browser closes). It is used only for loopback requests to the Hermes Web address it was captured from (the dashboard-only routes: roster, Projects, speech to text, stored images, image upload, the dashboard WebSocket through one-use tickets), as a header and never in a URL. A Settings toggle turns it off and clears it; `hermes webapp --sign-out` ends it.

**Context windows and the category breakdown.** The panel asks the gateway you are connected to for the viewed session's context (`session.stats`, `session.context_breakdown`, by the session's stored id) over the gateway's session socket, which it opens itself with the paired token's one-use ticket, a Hermes account sign-in or the held Hermes Web sign-in, and never to a third party. The window Hermes reports for each model (and `GET /api/model/info` on the Hermes dashboard on this computer, for your configured model) is kept in `chrome.storage.local` (`hermesBrowserGatewayModelContext`: model id, provider, token count, time) so the model list can show it; uninstalling the extension removes it, and it keeps at most 200 models for 30 days. A pasted image on a REST chat, when the gateway has no upload route, can be staged through `image.attach_bytes` on that same socket: the gateway writes it to its own image cache and answers the file path, nothing leaves your machine.

## Hermes account sign-in

Where a gateway is gated (its public `/api/status` says `auth_required` and lists `native_pkce`), the panel runs the same native sign-in as the Hermes phone app (RFC 8252, PKCE with S256), against that gateway's own address only:

1. `GET /api/auth/providers` names the provider; the sign-in opens `/auth/native/authorize?...redirect_uri=http://127.0.0.1:<random port>/hermes-browser-callback` in a popup window. Nothing listens on that port and the panel never requests it: it only observes the browser being sent there (`webRequest`, with the tab's address as a second witness), reads `code` and `state` from the address, checks the state against the one it generated, and closes the window. A password provider's `/login` form ends on the same redirect.
2. `POST /auth/native/token` redeems the code with the PKCE verifier for `{access_token, refresh_token, expires_at, provider, user_id}`; `GET /api/auth/me` (bearer) reads the display name.
3. The tokens are kept per gateway address in `chrome.storage.local` and refreshed with `POST /auth/native/refresh` (one refresh at a time, a 401 retries once after refreshing, a refresh 401 `session_expired` clears them).
4. `POST /api/auth/ws-ticket` (bearer) mints a 30 second one-use ticket for `/api/ws`, offered as the `hermes-gateway-ticket.<ticket>` WebSocket subprotocol beside `hermes-gateway-v1`; a retry mints a new ticket the same way and a ticket is never put in a URL.

Projects, Session authority, Context compaction, the full bot roster and skills use that socket. The panel prefers the paired gateway's socket ticket on a local gateway, then this sign-in, then the held Hermes Web sign-in, and otherwise says why and offers the button. An ungated loopback gateway offers no account sign-in: its `/api/auth/ws-ticket` needs a session only the sign-in gate creates, so the panel does not offer one there. A remote connection resolves only its own gateway's address, never this computer's. **Sign out** forgets the tokens locally and asks the gateway to revoke nothing.

## Hermes Web full view

Hermes Web uses the same configured Local or Remote API connection and canonical Hermes session history as the side panel. It loads sessions, models, skills, runtime options, generated media, and persisted context telemetry from the configured Hermes gateway. Opening full view does not grant browser-control permissions. Hermes Cloud/dashboard-ticket full-view history remains read-only until a shared ticketed WebSocket coordinator owns that connection.

## Browser Context Protocol and optional companion cache

The extension emits typed `hermes.browser.turn.v2` envelopes with owner/conversation/session/turn identity while retaining the prompt-embedded v1 compatibility path.

## Turns queued on the gateway

On a gateway that owns the turn queue (session authority), the panel lists the turns waiting for the session on screen ("Queued on Hermes") from the gateway's own session snapshots. **Cancel turn** sends `prompt.cancel` for that turn, and **Edit** (offered only where the gateway lists the `replace` control for that turn) sends `prompt.replace_queued` with the edited text, which the gateway admits at the back of the queue in place of the old turn. Both go to the gateway you are connected to, only when you press the button, and a turn leaves the list only when the gateway settles it. A turn lost in a gateway restart offers **Discard** (`prompt.resolve_unknown`). The panel never resends a turn itself.

## Controller and artifact flow

When Hermes Control is enabled, the extension registers one authenticated controller and attaches the selected tabs. Commands are bound to the controller, browser profile, attachment owner, tab, frame, and document generation. Browser-bound turns do not fall back to another browser backend. Sensitive targets and restricted URLs fail closed; consequential and privileged actions pause for explicit approval.

Frames of an attached page are read and judged by the extension through the browser's own debugger protocol, with no script run in the page for that check: a frame on a restricted page is never read, the frame chain above a control is checked again before an action, and a frame that Chrome runs in its own process is neither read nor acted on. A frame's controls reach Hermes only as part of the same redacted page view as the page's own.

Artifact upload/download is scoped, TTL-bounded, checksum-verified, and one-shot. Durable controller and companion records contain metadata and redacted receipts only, not page bytes or raw command payloads. If the optional companion plugin is enabled for the Hermes profile, it also keeps the validated BCP v2 payload of a full-context turn (including the page text, selected text and tab URLs that turn carried) in process memory only, bound to that turn's trusted Hermes session, turn and task identity. The record is TTL-bounded (300 seconds), size-bounded, consume-on-read, and unreadable by another turn, session, subagent or profile; a hash-reference turn stores nothing. Everything the plugin writes to disk or returns as diagnostics (event log, journal, tool receipts) is metadata only: opaque ids, hashes, scope, timestamps and tool names, never page text, selected text, URLs, typed values, credentials or browser-control channels. Browser-supplied scope, context hash, controller and browser-profile identifiers are kept only if they look like an opaque id (a UUID, a hex hash or a short slug without a credential-style prefix); anything else is dropped before it is stored or logged. The plugin opens no network connections and cannot control the browser. Its HTTP surface is four routes on the Hermes API server, all behind the API server's own authentication: a read-only status route (`GET /api/plugins/hermes-browser-companion/status`) that returns only the plugin's name, version, profile, tool names and route list; a context status route (`GET .../context/status`) that returns counts, ages, a context hash and `live: false` for the caller's session; an upload route (`POST .../context`) through which the extension can send the same full-context envelope it would put in a turn, which the plugin validates with the same parser and keeps in memory for the named session until a reference turn for that session names the same hash (300 seconds, one slot per session, then the usual owner-scoped, consume-on-read record); and an actions route (`GET .../actions`) that lists declarative descriptors and runs nothing. None of them returns page text, URLs, titles, session, turn or task ids, or secrets. The extension uploads only when the status route lists the upload route, only for a turn that sends a hash reference instead of the full context, and to the gateway it already sends that context to.

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

The extension reads `/v1/capabilities` when available, and on a dashboard connection it also uses what `gateway.ready` reports. Settings > About & Diagnostics shows each feature's state (available, cached, degraded, blocked, unsupported or unknown), the exact reason, its source and its age. A feature the gateway never advertises is shown as "not advertised", not as unsupported, and the optional companion plugin is the exception to "the extension cannot tell": it answers a metadata-only status route of its own, which the extension reads to show ready, outdated, disabled, not installed or unreachable with the exact reason. The same route lists the paths a copy serves; when it lists the browser-context upload, browser-context status and plugin-actions routes, those three rows read "available via the companion plugin", and otherwise they keep saying that this Hermes version has no such route. Without that probe the extension cannot tell whether the plugin is loaded, because no gateway capability advertises it. If an older Hermes runtime does not expose that endpoint, the extension enters legacy compatibility mode:

- core chat/session features are attempted when the Gateway is connected and authenticated
- browser-specific routes such as audio transcription, browser pairing, profile list, and image upload stay in fallback/manual mode unless advertised (speech, stored images and image upload can still be served by the local Hermes dashboard, and the rows then say so)

The extension also separates gateway reachability from upstream Hermes runtime/tool tracebacks. If the API server is reachable but an upstream Hermes tool/runtime raises a Python traceback, the side panel can show a connected-with-warning diagnostic instead of treating the whole Browser connection as broken. Settings also include Copy Diagnostics, which creates a redacted support block without API keys, bearer tokens, cookies, page text, selected text, tab titles, or full tab URLs.

## Related docs

- [PERMISSIONS.md](PERMISSIONS.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
