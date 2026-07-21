# Permissions

Hermes Browser Extension is a Chrome/Edge/Chromium MV3 side panel for connecting the active browser page to your configured Hermes Agent runtime.

This document describes the shipped v0.2.0 permission model.

## Required extension permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Lets the extension inspect the currently active tab after the user opens/uses the side panel. |
| `downloads` | Saves generated images or artifacts only after the user explicitly chooses Download. It is not used to inspect download history. |
| `scripting` | Lets the extension inject its bounded context collector and Hermes Assist runtime into normal `http://` and `https://` pages when the content script is missing/stale. |
| `sidePanel` | Provides the browser side-panel UI. |
| `storage` | Stores local extension settings such as Gateway URL, selected session/model/profile, appearance, and the saved API key/browser token. |
| `tabs` | Reads tab titles/URLs for the active-tab state, context refreshes, tab summaries, and remote dashboard WebSocket ticket flow. |

## Optional permissions

| Permission | Why it is optional |
| --- | --- |
| `audioCapture` | Requested only when voice dictation needs microphone capture from an extension page. If Hermes audio transcription is unavailable, v0.2.0 can use Browser speech fallback when Chromium exposes Web Speech. |

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

v0.2.0 keeps this host-permission surface unchanged while adding site-aware Hermes Assist, typed context delivery, Hermes Web, runtime visibility, and redacted Copy Diagnostics support reports. A narrower optional-host-permissions migration is intentionally deferred until it can be shipped without breaking load-unpacked context capture.

The extension still blocks browser-internal and sensitive categories in code, including:

- `chrome://`, `edge://`, `devtools://`, extension pages, `file://`, and similar browser/internal schemes.
- obvious banking, crypto wallet, password manager, checkout/payment, health, and government tax/account URLs.

## Permissions not requested

Hermes Browser Extension v0.2.0 does **not** request:

- `debugger`
- `nativeMessaging`
- `cookies`
- `history`
- `bookmarks`
- browser-control permissions for autonomous click/type/form-submit automation

Browser context collection remains read-only. Hermes Assist can insert reviewed text into the currently focused supported composer only after an explicit user action; it never clicks Send/Post/Submit, navigates, buys, deletes, or autonomously controls pages. This constrained apply path uses the existing page script and does not add `debugger` or broad browser-control permissions.

## Related docs

- [DATA-FLOW.md](DATA-FLOW.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
