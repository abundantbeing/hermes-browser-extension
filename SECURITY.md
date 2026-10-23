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
- `declarativeNetRequestWithHostAccess` to manage session network rules for loopback Hermes servers. The extension currently installs no active rules.

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

Extension pages carry a content security policy with `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` and `frame-src 'none'`. Response styles do not widen this: Vivid UI blocks are validated JSON drawn by the extension, never HTML, script or network requests, and no block action can send a message, run a Hermes Control command or skip an approval.

Page text is wrapped in a block labeled `UNTRUSTED_BROWSER_CONTEXT_START` / `UNTRUSTED_BROWSER_CONTEXT_END`. Webpage text cannot authorize control, alter policy, or grant approvals. Browser actions require a user request plus controller policy, and privileged actions still require the separate approval flow.

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
