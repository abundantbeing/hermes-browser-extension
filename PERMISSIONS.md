# Permissions

Hermes Browser Extension is a Chrome/Edge/Chromium MV3 side panel for connecting the active browser page to your configured Hermes Agent runtime.

This document describes the shipped v0.3.0 permission model.

## Required extension permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Lets the extension inspect the currently active tab after the user opens/uses the side panel. |
| `alarms` | Maintains bounded service-worker lifecycle and wake/reconnect timers. |
| `contextMenus` | Provides user-invoked Hermes actions from the browser context menu. |
| `debugger` | Enables opt-in, leased-tab browser control through the Chromium DevTools Protocol. The controller attaches only while control is enabled and detaches when control stops or the lease ends. |
| `downloads` | Saves generated images or artifacts only after the user explicitly chooses Download. It is not used to inspect download history. |
| `offscreen` | Hosts bounded extension-owned wake/listener support where Chromium requires an offscreen document. It has no browser-control authority. |
| `scripting` | Lets the extension inject its bounded context collector and Hermes Assist runtime into approved `http://`, `https://`, and local-file pages when the content script is missing/stale. |
| `sidePanel` | Provides the browser side-panel UI. |
| `storage` | Stores local extension settings such as Gateway URL, selected session/model/profile, appearance, and the saved API key/browser token. |
| `tabs` | Reads tab titles/URLs for the active-tab state, context refreshes, tab summaries, and remote dashboard WebSocket ticket flow. |

## Optional permissions

| Permission | Why it is optional |
| --- | --- |
| `audioCapture` | Requested only when voice dictation needs microphone capture from an extension page. If Hermes audio transcription is unavailable, v0.3.0 can use Browser speech fallback when Chromium exposes Web Speech. |

## Host permissions

The current alpha manifest includes:

```json
[
  "http://127.0.0.1/*",
  "http://localhost/*",
  "http://*/*",
  "https://*/*",
  "file:///*"
]
```

These host permissions let the side panel read context from normal web pages and connect to local or remote Hermes Gateway/API servers.

`file:///*` supports local HTML presentations and browser-rendered local documents after the user enables file URL access in the browser and approves the document inside Hermes Browser.

The extension still blocks browser-internal and sensitive categories in code, including:

- `chrome://`, `edge://`, `devtools://`, extension pages, and similar browser/internal schemes.
- unapproved local files. Approved `file://` documents use a separate explicit gate and remain bound to the exact leased tab/document.
- obvious banking, crypto wallet, password manager, checkout/payment, health, and government tax/account URLs.

## Permissions not requested

Hermes Browser Extension v0.3.0 does **not** request:

- `nativeMessaging`
- `cookies`
- `history`
- `bookmarks`
- password-manager permissions

Browser control is disabled by default. When enabled, it applies only to explicitly leased tabs, uses exact document-generation checks, blocks sensitive fields and restricted pages, and pauses consequential or privileged actions for explicit approval. Hermes Assist remains review-first and never submits a draft by itself.

## Related docs

- [DATA-FLOW.md](DATA-FLOW.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
