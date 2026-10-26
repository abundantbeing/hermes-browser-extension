# Privacy

Hermes Browser Extension is a load-unpacked public alpha that sends browser context to the Hermes Agent runtime you configure.

This document describes the shipped behavior of the current release.

## No analytics

Hermes Browser Extension does not include analytics, telemetry, ads, tracking pixels, or third-party reporting SDKs.

## Local storage

The extension stores settings in `chrome.storage.local`, including:

- Gateway mode and Gateway URL
- API key/browser token, if you save one
- selected session/model/profile settings, including Browser-scoped preferred model and per-session model bindings
- context settings such as include-tabs/page-text/selected-text, selected prompt tabs, and Chat only/follow/pinned scope
- panel opening preference for tab-attached or global side panels
- appearance settings, including the response style and chat layout you chose and whether first-time setup has been completed
- Hermes Assist model/provider/reasoning preferences (used only when the connected gateway advertises per-session model locking), session-route, and per-site context preferences
- local side-panel message history cache
- each session's last known context-window reading (token counts, the gateway's category estimates and the names of context files it reports, for up to 100 sessions), so a session shows its context the moment it opens
- replay positions (event sequence numbers and the gateway's replay epoch, no message text) for up to 8 gateways and 64 sessions each, kept in session storage so a reconnect can ask Hermes for the events it missed
- which sessions-drawer tab (Recents or Projects) you last used
- Hermes Web appearance, session rail, and canonical session handoff settings
- per-tab local message caches and per-tab Hermes session bindings when the panel is tab-attached or you pin a browser tab
- bounded controller identity, tab attachment metadata, paused state, document-generation counters, and redacted terminal receipts required to recover safely across MV3 service-worker suspension

Saved tokens are masked in the UI after save. The settings panel includes **Clear stored token** to remove the API key/browser token from extension storage.

## Browser data not accessed

The extension does not request or read:

- cookies
- browsing history
- bookmarks
- existing download history; the extension only initiates a save when the user explicitly downloads a generated image or artifact
- browser password manager data
- debugger protocol data unless the user explicitly enables Hermes Control for tabs they attach

It reads page context from the active/current browser surface for the purpose of asking Hermes about what you are viewing, unless you choose **Chat only** mode.

The extension can also attach the side panel to a specific tab or pin context to a specific tab. In tab-attached or pinned mode, the extension keeps that tab's local chat cache separate from the follow-active chat cache. In Chat only mode, it does not attach active tab title/URL, open tabs, selected text, page metadata, YouTube transcript, or page text to the prompt. Sensitive and credential-bearing tab URLs are omitted before prompt assembly, including decoded/nested parameters and signed-URL credentials/signatures.

## Live Hermes Control

Hermes Control is opt-in and limited to tabs you explicitly attach. The extension may use Chromium debugger APIs to inspect accessibility metadata and perform approved browser actions on those tabs. It does not persist raw DOM, page text, typed values, command arguments, credentials, screenshots, or response bodies in controller durability or companion diagnostics. Consequential actions pause for explicit approval, and developer-only evaluate/raw-CDP actions require both developer mode and approval.

Local HTML, browser-rendered PDF, and localhost pages use the same model. A local file is not exposed until the browser permits file URL access and the user approves local-document access inside the extension.

## Projects and session management

The Projects tab of the sessions drawer, Move, Compact context and the capability rows talk to the Hermes gateway you configured, over the dashboard connection, and nowhere else. Project names, folder paths on the Hermes host, session titles and counts are read from the gateway and kept in memory only. A project name and folder path you type, and the folder you choose for a move, are sent to that gateway. Nothing about projects or moves is stored in the browser, and none of it is sent to any third party. Capability states are derived in memory from the connection and are included in the support report as state, source, age and reason only.

## Local vs remote privacy boundary

### Local API mode

If the Gateway URL is `http://127.0.0.1:8642` or `http://localhost:8642`, browser context is sent to your local Hermes process.

Hermes itself may then call models/tools/providers according to your Hermes configuration. That behavior is controlled by Hermes Agent, not by the extension.

### Remote API/dashboard mode

If you configure a remote Hermes URL, browser context is sent to that remote Hermes runtime. Only configure remote endpoints you control and trust. A remote connection never contacts a Hermes Dashboard on this computer.

## Hermes Assist privacy

Model-backed Hermes Assist actions send the current draft and the explicitly enabled bounded site context to the configured Hermes runtime. Private surfaces use conservative per-site context defaults and show a warning before surrounding page context is included. Disabling context for a site keeps the request draft-only.

Formatting cleanup, bullets, text statistics, and diffs are deterministic local utilities and do not call a model. Generated drafts stay in the local review panel until the user copies or explicitly applies them. Applying a reviewed draft does not submit the surrounding form or message.

## Voice privacy

The extension supports two voice modes:

- **Hermes STT**: audio is captured in the extension page and sent once to the configured Hermes audio transcription endpoint when you stop recording.
- **Browser speech fallback**: when Hermes STT is unavailable and Chromium exposes Web Speech, speech recognition runs in the browser and only transcript text is returned to the side panel.

No audio is intentionally saved by the voice dictation page.

## Hermes Web sign-in

With a gateway that carries the extension-pairing routes, **Open Hermes Web** needs no sign-in step and nothing is kept: the panel asks the paired gateway on this computer for a one-use ticket (the paired token is sent to that gateway only, as it already is for chat) and the new tab is signed in with it. Hermes Web grants access to host files and a shell, so approve a pairing only for an extension you trust.

Otherwise, when you sign in to Hermes Web (the gateway's own web app, `hermes webapp`), the panel can keep that sign-in so Projects, the bot roster, speech and image upload keep working after the Hermes Web tab is closed. It is held in `chrome.storage.session` only (memory, cleared when the browser closes, never synced, never written to disk), sent only as a request header to the loopback Hermes Web address it came from, and never put in a URL. Settings has a **Keep Hermes Web signed in from the panel** toggle; turning it off clears what is held. `hermes webapp --sign-out` ends the sign-in itself.

## Hermes account sign-in

On a gateway that asks for sign-in (a remote gateway, or a local one behind sign-in), Settings > Connections has a **Hermes account** row: **Sign in with your Hermes account**, the same sign-in the Hermes phone app uses. It opens a sign-in window on the gateway's own address (the provider's page, or the gateway's own login form), and the gateway hands the panel a one-time code that the panel redeems for an access token and a refresh token. Those tokens, the provider name and your account's id, display name and email as the gateway reports them are kept per gateway address in `chrome.storage.local`, so you stay signed in across browser restarts like the phone does. They are sent only to that gateway, as a request header, and never put in a URL, shown or logged; the short-lived ticket they mint for the Hermes socket travels in the WebSocket's subprotocol header only. **Sign out** forgets them on this browser at once (it asks the gateway to revoke nothing); they are also cleared when the gateway refuses the refresh token (the session ended), and when you change the gateway or connection mode. A remote connection never signs in on, or sends tokens to, this computer. The browser asks once for the optional `webRequest` permission from the Sign in click, only to see where the sign-in window ends (see [PERMISSIONS.md](PERMISSIONS.md)).

## Runtime activity visibility

The panel displays live tool activity reported by Hermes during streaming turns. Tool labels/previews are sanitized locally before display and are not analytics, telemetry, or extra data collection. They reflect runtime events from the configured Hermes session.

## Attachments

Text files can be included as text. Images can be included inline; when the connected Hermes runtime advertises image upload support, the extension can save image attachments through Hermes so the agent receives a local path-backed image reference.

When the gateway API has no upload route (Hermes 0.22.5 has none), the extension uses the local Hermes dashboard's image route on this computer. If neither is available, the extension keeps images inline and shows a fallback warning. Generated images can be opened in a local lightbox and downloaded only after an explicit user action.

## Remove extension data

To clear extension data:

1. Open the Hermes Browser Extension side panel.
2. Open Settings.
3. Click **Clear stored token**.
4. Optionally remove the extension from `chrome://extensions` / `edge://extensions` to delete all extension-local storage.

## Related docs

- [PERMISSIONS.md](PERMISSIONS.md)
- [DATA-FLOW.md](DATA-FLOW.md)
- [SECURITY.md](SECURITY.md)
