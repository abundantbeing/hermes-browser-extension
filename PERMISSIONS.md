# Permissions

Hermes Browser Extension is a Chrome/Edge/Chromium MV3 side panel for connecting the active browser page to your configured Hermes Agent runtime.

This document describes the shipped v0.1.10 permission model.

## Required extension permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Lets the extension inspect the currently active tab after the user opens/uses the side panel. |
| `scripting` | Lets the extension inject its read-only context collector into normal `http://` and `https://` pages when the content script is missing/stale. |
| `sidePanel` | Provides the browser side-panel UI. |
| `storage` | Stores local extension settings such as Gateway URL, selected session/model/profile, appearance, and the saved API key/browser token. |
| `tabs` | Reads tab titles/URLs for the active-tab state, context refreshes, tab summaries, and remote dashboard WebSocket ticket flow. |

## Optional permissions

| Permission | Why it is optional |
| --- | --- |
| `audioCapture` | Requested only when voice dictation needs microphone capture from an extension page. If Hermes audio transcription is unavailable, v0.1.10 can use Browser speech fallback when Chromium exposes Web Speech. |

## Host permissions

The current alpha manifest includes:

```json
[
  "http://127.0.0.1/*",
  "http://localhost/*",
  "http://*/*",
  "https://*/*"
]
```

These host permissions let the side panel read context from normal web pages and connect to local or remote Hermes Gateway/API servers.

v0.1.10 keeps this host-permission surface unchanged while adding runtime visibility through the Tool Activity Strip, connected-with-warning diagnostics, and redacted Copy Diagnostics support reports. A narrower optional-host-permissions migration is intentionally deferred until it can be shipped without breaking load-unpacked context capture.

The extension still blocks browser-internal and sensitive categories in code, including:

- `chrome://`, `edge://`, `devtools://`, extension pages, `file://`, and similar browser/internal schemes.
- obvious banking, crypto wallet, password manager, checkout/payment, health, and government tax/account URLs.

## Permissions not requested

Hermes Browser Extension v0.1.10 does **not** request:

- `debugger`
- `nativeMessaging`
- `cookies`
- `history`
- `downloads`
- `bookmarks`
- browser-control permissions for click/type/form-submit automation

It is read-only in the browser: it collects context and sends prompts to Hermes; it does not click, type, submit forms, buy things, delete things, or control pages.

## Related docs

- [DATA-FLOW.md](DATA-FLOW.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
