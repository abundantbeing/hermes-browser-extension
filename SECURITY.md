# Security Notes

Hermes Browser Extension combines review-first browser context with opt-in live control for tabs you explicitly attach. Browser-bound requests stay on the authenticated extension controller and never fall back to another browser backend.

## Current permission model

The extension requests:

- `sidePanel` to render the Hermes side panel.
- `tabs` and `activeTab` to identify and scope browser tabs after user interaction.
- `scripting` to inject the bounded context and control runtime when needed.
- `debugger` to inspect accessibility metadata and perform control actions only while Hermes Control is enabled for attached tabs.
- `alarms` to maintain bounded service-worker lifecycle timers.
- `contextMenus` for user-invoked Hermes actions.
- `offscreen` for bounded extension-owned wake/listener support. It has no controller authority.
- `storage` for local settings, controller metadata, and the saved API key/browser token.
- `downloads` only when the user explicitly saves generated media or artifacts.
- `http://*/*`, `https://*/*`, loopback hosts, and `file:///*` for normal pages, configured Hermes endpoints, localhost, and explicitly approved local documents.

- `unlimitedStorage` so original file attachments and page-comment data can stay in local extension storage instead of hitting the default quota. It uploads nothing.
- `declarativeNetRequestWithHostAccess` for session network rules on the extension's own requests to the connected Hermes gateway: removing the `Origin` header Hermes would refuse, and adding custom headers you set for a gateway behind an authenticating proxy. They match no page traffic and no other address.

The extension does not request `nativeMessaging`, `webNavigation`, cookies, history, bookmarks or password-manager access. Firefox builds omit `debugger`, `offscreen` and `sidePanel`, and use `sidebar_action` for the sidebar.

## Controller authority

Control is disabled by default. Enabling it registers one authenticated MV3 controller and attaches the selected tabs. Every command is bound to the controller identity, browser profile, attachment owner, tab, frame, and document generation.

- stale refs, stale documents, stale owners, borrowed tabs, and changed origins fail closed;
- stop and detach are terminal latches;
- approvals cannot revive stopped, replaced, or stale work;
- consequential actions pause for exact user approval;
- evaluate and raw CDP require developer mode plus approval and method policy;
- sensitive fields and restricted page categories remain blocked;
- local HTML, browser-rendered PDF, and localhost control requires the local-document approval gate;
- frames are judged again when Hermes acts, not only when the page is read: every frame above a control must still be an ordinary readable page, the frame under a click, hover or drag is checked from the browser just before the pointer moves, and a frame laid over a control, or one Chrome runs in its own process, makes the action fail with `restricted_frame`. The checks use the browser's own view and run no page script. A page can still change between the last check and one delivered input event;
- Firefox ships only the capability-safe subset supported by its platform APIs.

## Prompt injection handling

Extension pages carry a content security policy with `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` and a `frame-src` limited to `http://127.0.0.1:*` and `http://localhost:*`. The one thing framed there is a local gateway's pairing approval page, which only the extension that asked to pair is allowed to frame, in an iframe sandboxed to `allow-forms allow-same-origin`; a gateway that does not offer that opens the page in a tab instead. Response styles do not widen this: Vivid UI blocks are validated JSON drawn by the extension, never HTML, script or network requests, and no block action can send a message, run a Hermes Control command or skip an approval.

The page reader leaves out text a person cannot see before anything is sent: elements hidden by `display`, `visibility`, `[hidden]`, `inert`, `aria-hidden` or zero opacity; each piece of text laid out wholly beyond the top or left edge of the page, or, for text fixed to the window, wholly outside the window (judged by where the text itself lands, so the readable second line of an indented paragraph and a fixed notice inside an off-page wrapper stay); text with zero size or a transparent fill; and text the same colour as the solid background behind it, only when nothing else paints there (a table column, an overlay, a picture or a pseudo-element keeps it). A gradient fill, a shadow or an outline keeps text readable, and text directly in `<body>` is judged like any other. Screen-reader-only text is kept: it is real content for people who use a screen reader. HTML comments are never read.

Page text is wrapped in a block labeled `UNTRUSTED_BROWSER_CONTEXT_START` / `UNTRUSTED_BROWSER_CONTEXT_END`. Webpage text cannot authorize control, alter policy, or grant approvals. Browser actions require a user request plus controller policy, and privileged actions still require the separate approval flow.

`npm run test:e2e:trap` reads a trap page (`tests/fixtures/prompt-injection-trap.html`) in a real headless Chromium with the extension's page reader and fails if any of its hidden instructions (thirteen on the recipe page, one directly in `<body>` on a second page) reaches the model, if readable styled text is dropped, or if its visible fake markers escape the untrusted block. What these defenses cannot do, and a safe setup, are in [guides/security.md](guides/security.md).

## Restricted pages and credentials

The extension blocks browser internals, extension pages, and obvious banking, wallet, password-manager, payment, health, and government-account categories. It decodes credential-bearing URL parameters before classification and redacts restricted tab identity across active, selected, open-tab, pinned-scope, prompt, receipt, and payload-hash surfaces.

## Persistence boundaries

Controller durability and companion diagnostics contain bounded metadata and redacted receipts only. They do not persist raw DOM, page text, selected text, command arguments, typed values, credentials, tickets, screenshots, network response bodies, or artifact bytes.

Artifact exchange is scoped, MIME-bounded, TTL-limited, checksum-verified, provenance-labeled, and atomic consume-on-download. The companion journal is owner-scoped, metadata-only, deterministically rotated, capped at 500 rows, and mode `0600` where supported. Journal data never authorizes live context retrieval or control. The companion plugin keeps only opaque browser metadata, hands its one-shot tool authorization across Hermes' hook worker through a table keyed by the trusted session and task ids (never by anything the model supplies), and correlates owners with a salted hash.

## Rendering and sanitization

All dynamic HTML rendered into extension surfaces passes through DOMPurify. Markdown links are restricted to reviewed schemes, images to HTTPS and raster data URLs, and the output is sanitized again. The build is self-contained, vendored runtime dependencies are pinned, and `eval` / `new Function` are forbidden.

## API key and token storage

The Hermes API key/browser token is stored in `chrome.storage.local`, masked after save, and removable through **Clear stored token**. Automatic pairing remains exact-loopback only. Remote API mode requires an explicit endpoint and token, while dashboard transports use short-lived single-use HTTPS tickets held in memory and sent in the `Sec-WebSocket-Protocol` header, not the URL. A remote connection never uses this computer's dashboard: the local dashboard address, socket and live roster are dropped when the connection becomes remote.

## Hermes Assist boundary

Hermes Assist generates into a review panel first. Safe plain-text composers can receive reviewed text only after the user chooses Apply. Hermes Assist never dispatches Send, Post, Submit, checkout, or other consequential controls by itself.

## Related docs

- [PERMISSIONS.md](PERMISSIONS.md)
- [DATA-FLOW.md](DATA-FLOW.md)
- [PRIVACY.md](PRIVACY.md)
