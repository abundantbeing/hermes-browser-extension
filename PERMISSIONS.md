# Permissions

Hermes Browser Extension is a Chrome/Edge/Chromium MV3 side panel (and a Firefox sidebar) for connecting the active browser page to your configured Hermes Agent runtime.

This document describes the permission model of the current release. Chromium builds request every permission below. Firefox builds omit `debugger`, `offscreen`, and `sidePanel`.

## Required extension permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Lets the extension inspect the currently active tab after the user opens/uses the side panel. |
| `alarms` | Maintains bounded service-worker lifecycle and wake/reconnect timers. |
| `contextMenus` | Provides user-invoked Hermes actions from the browser context menu. |
| `debugger` | Enables opt-in Hermes Control through the Chromium DevTools Protocol. The controller attaches only while control is enabled, keeps one session per attached tab while it is in use, and detaches when the tab is detached, when control pauses or stops, or after 60 seconds without a command. |
| `declarativeNetRequestWithHostAccess` | Lets the extension manage session network rules for loopback Hermes servers, which are cross-origin to extension pages. It is limited to the host permissions below and does not read or block page traffic; the extension currently installs no active rules, and loopback dashboard requests go through the service worker instead. |
| `downloads` | Saves or opens returned files only after the user explicitly picks an action on a returned-file card: Save opens the browser's save dialog, and Open on computer downloads the file and hands it to the OS default application. It is not used to inspect download history. |
| `offscreen` | Hosts bounded extension-owned wake/listener support where Chromium requires an offscreen document. It has no browser-control authority. |
| `scripting` | Lets the extension inject its bounded context collector and Hermes Assist runtime into approved `http://`, `https://`, and local-file pages when the content script is missing/stale. |
| `sidePanel` | Provides the browser side-panel UI. |
| `storage` | Stores local extension settings such as Gateway URL, selected session/model/profile, appearance, and the saved API key/browser token. |
| `tabs` | Reads tab titles/URLs for the active-tab state, context refreshes, tab summaries, and remote dashboard WebSocket ticket flow. |
| `unlimitedStorage` | Lifts the browser's default quota for local extension storage so original file attachments (up to 25 MB each, kept in IndexedDB) and page-comment data stay on your device. The permission uploads nothing; attachments leave the browser only when you send a message that includes them. |

The Projects tab, Move, Compact context, capability states and first-time setup need no extra permission: they use the connection to the Hermes gateway you configured. Reading controls inside frames of an attached page uses the same `debugger` permission and the same attached tabs as the rest of Hermes Control.

## Optional permissions

The extension declares no optional permissions. Voice dictation uses the browser's normal microphone prompt, not an extension permission.

## Host permissions

The manifest requests these host permissions:

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
- unapproved local files. Approved `file://` documents use a separate explicit gate and remain bound to the exact attached tab and document.
- obvious banking, crypto wallet, password manager, checkout/payment, health, and government tax/account URLs.

## Permissions not requested

Hermes Browser Extension does **not** request:

- `nativeMessaging`
- `cookies`
- `history`
- `bookmarks`
- password-manager permissions

Hermes Control is off by default. When on, it applies only to tabs you explicitly attach, uses exact document-generation checks, blocks sensitive fields and restricted pages, and pauses consequential or privileged actions for explicit approval. Hermes Assist remains review-first and never submits a draft by itself.

## Related docs

- [DATA-FLOW.md](DATA-FLOW.md)
- [PRIVACY.md](PRIVACY.md)
- [SECURITY.md](SECURITY.md)
