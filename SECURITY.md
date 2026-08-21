# Security Notes

Hermes Browser Extension v0.3.0 combines review-first browser context with opt-in live control for explicitly leased tabs. Browser-bound requests stay on the authenticated extension controller and never fall back to another browser backend.

## Current permission model

The extension requests:

- `sidePanel` to render the Hermes side panel.
- `tabs` and `activeTab` to identify and scope browser tabs after user interaction.
- `scripting` to inject the bounded context and control runtime when needed.
- `debugger` to inspect accessibility metadata and perform control actions only while Hermes Control is enabled for leased tabs.
- `alarms` to maintain bounded service-worker lifecycle timers.
- `contextMenus` for user-invoked Hermes actions.
- `offscreen` for bounded extension-owned wake/listener support. It has no controller authority.
- `storage` for local settings, controller metadata, and the saved API key/browser token.
- `downloads` only when the user explicitly saves generated media or artifacts.
- `http://*/*`, `https://*/*`, loopback hosts, and `file:///*` for normal pages, configured Hermes endpoints, localhost, and explicitly approved local documents.

The extension does not request `nativeMessaging`, `webNavigation`, cookies, history, bookmarks, password-manager access, or `unlimitedStorage`.

## Controller authority

Control is disabled by default. Enabling it registers one authenticated MV3 controller and acquires explicit leases for selected tabs. Every command is bound to the controller identity, browser profile, lease owner, tab, frame, and document generation.

- stale refs, stale documents, stale owners, borrowed tabs, and changed origins fail closed;
- stop and detach are terminal latches;
- approvals cannot revive stopped, replaced, or stale work;
- consequential actions pause for exact user approval;
- evaluate and raw CDP require developer mode plus approval and method policy;
- sensitive fields and restricted page categories remain blocked;
- local HTML, browser-rendered PDF, and localhost control requires the local-document approval gate;
- Firefox ships only the capability-safe subset supported by its platform APIs.

## Prompt injection handling

Page text is wrapped in a block labeled `UNTRUSTED_BROWSER_CONTEXT_START` / `UNTRUSTED_BROWSER_CONTEXT_END`. Webpage text cannot authorize control, alter policy, or grant approvals. Browser actions require a user request plus controller policy, and privileged actions still require the separate approval flow.

## Restricted pages and credentials

v0.3.0 blocks browser internals, extension pages, and obvious banking, wallet, password-manager, payment, health, and government-account categories. It decodes credential-bearing URL parameters before classification and redacts restricted tab identity across active, selected, open-tab, pinned-scope, prompt, receipt, and payload-hash surfaces.

## Persistence boundaries

Controller durability and companion diagnostics contain bounded metadata and redacted receipts only. They do not persist raw DOM, page text, selected text, command arguments, typed values, credentials, tickets, screenshots, network response bodies, or artifact bytes.

Artifact exchange is scoped, MIME-bounded, TTL-limited, checksum-verified, provenance-labeled, and atomic consume-on-download. The companion journal is owner-scoped, metadata-only, deterministically rotated, capped at 500 rows, and mode `0600` where supported. Journal data never authorizes live context retrieval or control.

## Rendering and sanitization

All dynamic HTML rendered into extension surfaces passes through DOMPurify. Markdown links are restricted to reviewed schemes, images to HTTPS and raster data URLs, and the output is sanitized again. The build is self-contained, vendored runtime dependencies are pinned, and `eval` / `new Function` are forbidden.

## API key and token storage

The Hermes API key/browser token is stored in `chrome.storage.local`, masked after save, and removable through **Clear stored token**. Automatic pairing remains exact-loopback only. Remote API mode requires an explicit endpoint and token, while dashboard transports use short-lived single-use HTTPS tickets held in memory.

## Hermes Assist boundary

Hermes Assist generates into a review panel first. Safe plain-text composers can receive reviewed text only after the user chooses Apply. Hermes Assist never dispatches Send, Post, Submit, checkout, or other consequential controls by itself.

## Related docs

- [PERMISSIONS.md](PERMISSIONS.md)
- [DATA-FLOW.md](DATA-FLOW.md)
- [PRIVACY.md](PRIVACY.md)
