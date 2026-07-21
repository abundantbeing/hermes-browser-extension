# Privacy

Hermes Browser Extension is a load-unpacked public alpha that sends browser context to the Hermes Agent runtime you configure.

This document describes shipped v0.2.0 behavior.

## No analytics

Hermes Browser Extension v0.2.0 does not include analytics, telemetry, ads, tracking pixels, or third-party reporting SDKs.

## Local storage

The extension stores settings in `chrome.storage.local`, including:

- Gateway mode and Gateway URL
- API key/browser token, if you save one
- selected session/model/profile settings, including Browser-scoped preferred model and per-session model bindings
- context settings such as include-tabs/page-text/selected-text, selected prompt tabs, and Chat only/follow/pinned scope
- panel opening preference for tab-attached or global side panels
- appearance settings
- Hermes Assist model/provider/reasoning preferences (used only when the connected gateway advertises per-session model locking), session-route, and per-site context preferences
- local side-panel message history cache
- Hermes Web appearance, session rail, and canonical session handoff settings
- per-tab local message caches and per-tab Hermes session bindings when the panel is tab-attached or you pin a browser tab

Saved tokens are masked in the UI after save. The settings panel includes **Clear stored token** to remove the API key/browser token from extension storage.

## Browser data not accessed

The extension does not request or read:

- cookies
- browsing history
- bookmarks
- existing download history; the extension only initiates a save when the user explicitly downloads a generated image or artifact
- browser password manager data
- debugger protocol data

It reads page context from the active/current browser surface for the purpose of asking Hermes about what you are viewing, unless you choose **Chat only** mode.

v0.2.0 can also attach the side panel to a specific tab or pin context to a specific tab. In tab-attached or pinned mode, the extension keeps that tab's local chat cache separate from the follow-active chat cache. In Chat only mode, it does not attach active tab title/URL, open tabs, selected text, page metadata, YouTube transcript, or page text to the prompt. Sensitive and credential-bearing tab URLs are omitted before prompt assembly, including decoded/nested parameters and signed-URL credentials/signatures.

## Local vs remote privacy boundary

### Local API mode

If the Gateway URL is `http://127.0.0.1:8642` or `http://localhost:8642`, browser context is sent to your local Hermes process.

Hermes itself may then call models/tools/providers according to your Hermes configuration. That behavior is controlled by Hermes Agent, not by the extension.

### Remote API/dashboard mode

If you configure a remote Hermes URL, browser context is sent to that remote Hermes runtime. Only configure remote endpoints you control and trust.

## Hermes Assist privacy

Model-backed Hermes Assist actions send the current draft and the explicitly enabled bounded site context to the configured Hermes runtime. Private surfaces use conservative per-site context defaults and show a warning before surrounding page context is included. Disabling context for a site keeps the request draft-only.

Formatting cleanup, bullets, text statistics, and diffs are deterministic local utilities and do not call a model. Generated drafts stay in the local review panel until the user copies or explicitly applies them. Applying a reviewed draft does not submit the surrounding form or message.

## Voice privacy

v0.2.0 supports two voice modes:

- **Hermes STT**: audio is captured in the extension page and sent once to the configured Hermes audio transcription endpoint when you stop recording.
- **Browser speech fallback**: when Hermes STT is unavailable and Chromium exposes Web Speech, speech recognition runs in the browser and only transcript text is returned to the side panel.

No audio is intentionally saved by the voice dictation page.

## Runtime activity visibility

v0.2.0 displays live tool activity reported by Hermes during streaming turns. Tool labels/previews are sanitized locally before display and are not analytics, telemetry, or extra data collection. They reflect runtime events from the configured Hermes session.

## Attachments

Text files can be included as text. Images can be included inline; when the connected Hermes runtime advertises image upload support, the extension can save image attachments through Hermes so the agent receives a local path-backed image reference.

If image upload is unavailable, v0.2.0 keeps images inline and shows a fallback warning. Generated images can be opened in a local lightbox and downloaded only after an explicit user action.

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
