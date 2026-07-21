# Changelog

## [Unreleased]

## [0.2.0] - 2026-07-21

### Added

- Added **Hermes Assist**, a review-first inline drafting surface for 31 supported writing environments including X, GitHub, Gmail, ChatGPT, Claude, Reddit, Slack, Discord, Outlook, Google Chat, and Atlassian surfaces.
- Added site- and composer-aware primary actions such as **Draft a reply**, **Draft a post**, and **Draft a message**, while retaining useful site-specific secondary actions.
- Added explicit current-session, new-session, and background-session routing for Hermes Assist and context-menu actions.
- Added per-site context controls with private-surface defaults, visible context warnings, bounded extraction, and copy-only fallbacks for framework-owned structured editors.
- Added capability-gated model routing for Hermes Assist: gateways that advertise per-session model locking receive the exact selected provider/model and must acknowledge it; released gateways without that contract use the active Hermes Agent model without sending unsupported override fields.
- Added deterministic local text utilities for formatting cleanup, bullets, text statistics, and diffs without a model call.
- Added Browser Context Protocol v2 turn envelopes and owner/session/turn-scoped companion context storage with bounded retention and consume-on-read isolation.

### Changed

- Unified Local, Hermes Cloud Preview, and Remote readiness behind one staged connection controller that does not report ready until its required session-binding gate passes.
- Kept automatic API pairing loopback-only. Remote API connections now require an explicitly configured endpoint and token; dashboard connections continue to use Trusted Dashboard Attach.
- Made non-loopback agent discovery permanently credential-free, even when a probed service self-identifies as Hermes.
- Made rich structured editors preview/copy-first by default; safe direct apply remains limited to reviewed, supported composer integrations.
- Added exact target-specific Chromium and Firefox release packaging with versioned archives, SHA-256 checksums, and a machine-readable release manifest.

### Security

- Bound browser context to typed turns with owner, conversation, session, and turn identity; enforced TTL, size, redirect, URL-scheme, and redaction limits at trust boundaries.
- Kept Cloud/dashboard tickets short-lived, single-use, memory-only, HTTPS-only, and bound to the exact active signed-in tab and origin.
- Prevented stored bearer credentials from being released during non-loopback discovery and prevented automatic pairing with non-loopback API endpoints.
- Preserved Chat-only enforcement for Cloud and ticketed dashboard transports.

### Fixed

- Fixed X reply context capture so Hermes receives the source post instead of an empty inner reply form.
- Fixed X draft insertion to use one framework-owned paste transaction, preventing duplicate or undeletable ghost text.
- De-duplicated inline result application by request id so retries cannot apply the same draft twice.
- Contained keyboard events inside Hermes Assist so host-page shortcuts cannot steal focus, navigate, or react while a user types a custom instruction.
- Preserved remote dashboard conversations across WebSocket replacement by persisting the gateway's durable session identity, resuming it on reconnect, and routing follow-up RPCs through the fresh live session identity.
- Made Chrome 141+ require a real `sidePanel.onOpened` event so Arc's hidden `SIDE_PANEL` contexts cannot suppress the reusable extension-tab fallback, while retaining context confirmation for Chrome 116-140.
- Corrected GPT-5.6 context metadata by provider: OpenAI Codex OAuth models now show the canonical 272k window, direct OpenAI models retain 1.05M, explicit runtime/catalog telemetry remains authoritative, and rows without provider identity no longer inherit the generic 400k GPT-5 guess.

### Contributors

- Folded and hardened the session-identity foundation from [PR #35](https://github.com/abundantbeing/hermes-browser-extension/pull/35) by [@mr-magaia](https://github.com/mr-magaia); the proposed profile selector remains deferred until official Hermes advertises and enforces that gateway capability.
- Credited [@chinnsenn](https://github.com/chinnsenn) for the Arc compatibility report in [issue #37](https://github.com/abundantbeing/hermes-browser-extension/issues/37).

## [0.1.11] - 2026-07-13

### Added

- Added **Hermes Web Alpha**, a full-page browser workspace backed by canonical Hermes sessions, with a session rail, user-right/Hermes-left messages, safe rich Markdown, model/runtime controls, tools, skills, attachments, voice, active-run steering, generated media, and context/activity inspection.
- Added three explicit connection modes: **Local gateway**, **Hermes Cloud Preview**, and **Remote gateway**, with deterministic dispatch, migration, validation, and mode-specific settings copy.
- Added trusted signed-in Hermes Cloud agent-tab attachment through a one-use ticket transport with Chat-only browser context.
- Added nine Light/Dark themes across the side panel and Hermes Web: Nous, Midnight, Ember, Mono, Cyberpunk, Slate, Senter Space, Aphrodite, and Solstice.
- Added generated-image diffusion reveal plus a lightbox with zoom, reset, open, and explicit download controls.
- Added accurate context-window and compaction telemetry, compact context chips, payload breakdowns, capability fallbacks, and session-gated runtime accounting.
- Added Firefox preview packaging through `npm run build:firefox` and Opera sidebar support.
- Added a scoped element picker for explicit page-element context.
- Added refreshed README visual-tour assets for the current side panel, all nine themes, and three Hermes Web states.

### Changed

- Bound model, provider, reasoning effort, skills, and other runtime options to the active browser session rather than mutating Hermes global defaults.
- Preserved the canonical model catalog across partial gateway updates and hardened backend-acknowledged model locking.
- Improved canonical session continuity, source metadata, context persistence, and duplicate-turn retry prevention across side-panel and Hermes Web surfaces.
- Refined the side-panel header, logo, icon placement, composer controls, connection diagnostics, and runtime/context footer.
- Expanded generated-media rendering, artifact discovery, voice-dictation fallback behavior, and final-image completion handling.
- Updated Local, Cloud Preview, Remote, privacy, permission, security, data-flow, compatibility, and troubleshooting documentation.

### Security

- Added one shared decoded credential-URL policy for active, selected, open-tab, pinned-scope, prompt, receipt, and payload-hash surfaces.
- Omitted common API keys, tokens, client secrets, private keys, credentials, signatures, and signed-URL fields even when parameter names are nested or encoded.
- Hardened trusted Cloud dashboard attachment, remote session authentication diagnostics, secret redaction, sealed-token URL handling, and restricted browser-context summaries.
- Kept browser interaction read-only: no click, type, form-submit, checkout, debugger, native-messaging, cookie, history, bookmark, or browser-control permissions.

### Fixed

- Fixed companion-plugin browser-context detection when Hermes user-message content is represented as OpenAI-style content arrays.
- Fixed generated-image completion, session model/context alignment, runtime-option persistence, and duplicate browser-turn retries.
- Fixed element-picker icon consistency and star-history chart URLs with encoded repository paths and sealed tokens.

## [0.1.10] - 2026-07-07

### Release theme
- Supportability and integration bridge release: read-only foundation, Browser Context Protocol receipts, sanitized context cache, session control, and Browser-scoped model selection.

### Companion Plugin MVP
- Activated `companion-plugin/` from skeleton into an optional functional Hermes plugin with four read-only tools: `browser_context_status`, `browser_get_context`, `browser_clear_context`, and `browser_event_log`.
- Registered `pre_llm_call` and `post_tool_call` hooks plus the bundled `hermes-browser` skill.
- Keeps the plugin fail-soft and supplemental: no browser control, no API-server routes, no network calls, no `nativeMessaging`, and no dependency required for normal extension use.

### Browser Context Protocol + sanitized cache
- Preserved the prompt-embedded Browser Context Protocol fallback while adding a companion cache that stores only sanitized metadata: protocol id, payload hash, scope, active-tab origin, section counts/availability, redaction count, truncation state, and bounded event diagnostics.
- Hardened parsing so raw page text, selected text, full tab URLs, token-looking values, and private URL paths do not leak into the plugin cache or event log.
- Kept Browser Context Protocol receipts and hashes visible for trust/debugging without introducing browser-control behavior.

### Truthful `/meta` command + UI polish
- Added `/meta` with `/metadata` and `/head` aliases for captured-page metadata analysis.
- The command is intentionally truthful: it reports only data present in the Browser context and lists metadata classes that were not captured instead of pretending to read raw `<head>` HTML.
- Added loading skeletons, context-meter glow states, tool-activity fade-in, and command-menu stagger polish behind reduced-motion guards.

### Session control + model scope lock
- Added compact session controls for Browser workflows: create/switch sessions, copy session IDs, rename sessions through `PATCH /api/sessions/{id}`, and smart first-message titles.
- Added Browser-scoped model preference and per-session model bindings so Browser model switches do not mutate Hermes global defaults.
- New Browser sessions inherit the last Browser-selected model; existing sessions keep their own model/provider binding.

### Diagnostics, docs, and supportability
- Updated Copy Diagnostics/support surfaces for extension origin redaction, selected model/provider, capability flags, and runtime warning states while excluding tokens, cookies, page text, selected text, full tab URLs, and webpage content.
- Updated README, permissions, privacy, security, and data-flow docs for v0.1.10.
- Bumped package/manifests/plugin metadata to v0.1.10 and prepared release packaging.

### PRs and contributors
- Credited PR #31 — `feat(companion-plugin): activate context cache from skeleton to functional plugin` by @iruzen-dono: https://github.com/abundantbeing/hermes-browser-extension/pull/31
- Credited PR #32 — `feat(commands): /meta command + CSS polish (skeletons, animations)` by @iruzen-dono: https://github.com/abundantbeing/hermes-browser-extension/pull/32
- Release integration, Browser-scoped session/model controls, supportability fixes, docs, packaging, and ad asset by @abundantbeing.
- Reviewed but not shipped in v0.1.10: PR #29 (`feat: add scoped element picker context`) by @bradlishman, PR #30 (`feat: add native sidebar support for Opera browser`) by @barteqpl, and PR #33 (`Security: fix parameter evasion, CWD binary hijacking, and clipboard handling`) by @Doom-pixel-alt.

## v0.1.9 — 2026-07-05

### Browser Context Protocol
- Extracted Browser Context Protocol v1 into `extension/lib/browser-context-protocol.mjs` with a stable `hermes.browser.context.v1` id, deterministic payload hash, chat-only prompt mode, and literal untrusted-data receipt rendering.
- Kept legacy `buildHermesPrompt`, `browserContextPayloadHash`, and `buildContextReceipt` wrappers compatibility-preserving for existing chat/session flows.

### Public support + compatibility
- Bumped source/package/manifests to v0.1.9.
- Added Copy Diagnostics in Settings so users can copy a redacted support report with browser family, extension/build version, gateway origin, connection state, capability flags, selected model/provider, context scope, extractor mode, and last visible error.
- Added a README compatibility matrix for Chrome/Edge/Chromium, Chromium forks, Firefox/Safari preview status, local/remote Gateway modes, Browser Context Protocol, companion plugin prototype status, and explicitly deferred browser-control/Runs/debugger/nativeMessaging surfaces.
- Extended compatibility rows with Browser Context Protocol, browser context upload fallback, and optional Browser Companion Plugin status.
- Added browser family/origin diagnostics for future Firefox/Safari and cross-browser support triage.

### Runtime/tool event naming
- Added stable Browser runtime/tool event names in `extension/lib/runtime-events.mjs` and normalized current Hermes tool-progress aliases into the Tool Activity Strip while keeping browser-control events out of the v0.1.9 surface.

### Private companion prototype
- Added `companion-plugin/` as a fail-soft private skeleton with context store, protocol helpers, tools, hooks, policy, install notes, and skill docs.
- The skeleton does not register API-server routes, does not assume side-channel availability, and does not include browser-control/page-action channels.

### Tests
- Added focused tests for Browser Context Protocol, runtime event naming, support diagnostics redaction, v0.1.9 capability rows, and the private companion skeleton.

## v0.1.8 — 2026-07-04

### Active-run chat steering
- Added active-run chat steering from the composer: while Hermes is running, Enter on a text draft steers the active turn, with explicit Queue/Steer/Stop controls in the busy composer.
- Wired the Browser side panel to `/v1/runs/{run_id}/steer` for local API mode and `session.steer` over the dashboard WebSocket for remote-dashboard mode.
- Added a pure `busyComposerSubmitAction()` helper with regressions: text-only active draft + steer available → steer; attachments or no steer → queue; empty → ignore.
- Added a pure `shouldAutoFlushQueuedTurn()` helper so backend-queued steer fallbacks never auto-send as a normal next prompt.
- Surfaced backend `steer.queued` events: the draft returns to the composer with an explicit "Steer not injected" status instead of pretending the steer was applied or queueing it for after the turn.
- Updated steer success copy to "Steer sent to active run" so the Browser stops overpromising when Hermes has no tool injection point in the current turn.

### Live Tool Activity Strip
- Replaced raw `[tool]` markdown appended to assistant answers with a compact runtime Tool Activity Strip while Hermes streams.
- Added shared tool-activity helpers that categorize file/edit/terminal/browser/web/media/meta tool names, sanitize previews (secrets, long lines), and respect reduced-motion preferences.
- New `toolKind` CSS variants for file/edit/terminal/browser/web/media/meta, plus scan/stitch/cursor/reticle/orbit/pixel/stack keyframes for the strip animation.

### Lean chat mode (token budget)
- Made Fast mode strict opt-in: stored string values such as `"false"`/`"off"` no longer produce `model_options.fast: true` or priority service-tier requests.
- Hardened `buildHermesModelOptions` so `service_tier` and `fast` are only set when the user actually opts in.
- `normalizeFastMode` returns a real boolean, never a truthy string.

### Real runtime meter
- Promoted the runtime payload to a first-class UI meter (Model, Provider, Context, Live 1.24s) in the side panel.
- Added `applyTurnRuntimePayload()` plumbing on the chat path so the runtime meter reflects the actual server reply instead of local estimates.
- Session-list refresh no longer overwrites a just-confirmed runtime model/provider with stale session-history data.

### Model catalog + warnings
- Switched model discovery to prefer the connected Hermes API server's `/api/model/options` catalog before dashboard scraping, with session-history and dashboard fallbacks for older runtimes.
- Added a static context-length fallback for GPT-5.5 across known providers (openai-codex 272K, openrouter 1.05M) so picker context windows no longer say "unknown".
- Hardened `/api/model/options` to never call the slow `get_model_context_length` resolver in the per-model loop; provider-aware fallback only.

### Sharper diagnostics
- Hardened gateway diagnostics so upstream Hermes runtime/tool tracebacks show as connected-with-warning instead of mislabeling the whole Browser connection as unreachable.
- Added explicit classification for the known Python `NoneType`/`int()` traceback class, with guidance to inspect Hermes logs and run `hermes computer-use doctor` when computer-use/cua-driver appears in the stack.
- Wired `gpt-image-2-medium` (Codex auth) for the side panel image generator and refined `pairingFailureMessage` for unsupported runtimes.

### Browser behavior settings
- Folded browser-behavior switches (auto-name sessions, open tabs, page text, selection, panel residency) into intentional settings cards instead of loose checkbox rows.
- Side-panel CSS hardened: long tab labels, active-tab titles/URLs, pinned scope labels, and bottom model/context controls ellipsize inside narrow panels.
- Pinned tab/session titles are clipped before session creation so the API title limit is respected.

### Context scope / Chat only
- Chat only no longer creates a new session or message bucket. It preserves the active conversation scope while disabling page/tab/selection capture for the turn.
- Added a separate `previousConversationScope` so the session binding and the transcript key both follow the original tab, not the capture mode.
- Tab-attached panels still allow Include all tabs / Page only / per-tab IN-OUT prompt selection; Follow active tab and Unlock pinned tab are hidden when not relevant.
- Prompt-tab IN/OUT toggles preserve the internal tab-list `scrollTop` across rerenders.
- Pinning a tab fresh-fetches it via `chrome.tabs.get(id)` so stale tab snapshots can't cause weird pinning behavior.

### Composer / voice / attachments
- Voice dictation is capability-gated: Hermes STT when advertised, Browser speech fallback when supported, visible Hermes Voice Dictation extension tab when the side panel mic prompt is suppressed.
- Microphone permission help links directly to `chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2F<id>%2F`.
- Drag/drop attachments and clipboard image paste keep working with the new composer controls.
- Inline send button moved to the composer right edge next to the voice button; mic is hidden while a run is active.

### Build / packaging / version sync
- Bumped source, package, root manifest, built `dist/` manifest, and `build-info.json` for v0.1.8.
- The `scripts/check-manifest.mjs` verifier now fails if root manifest, `extension/manifest.json`, `dist/manifest.json`, or `package.json` are out of sync, preventing the v0.1.5 stale-version bug.
- Build metadata is stamped into every supported unpacked load root (root, `extension/`, `dist/`) so update checks see the same loaded commit.

### Tests / docs
- 139/139 tests passing in `npm run verify`.
- README refreshed for v0.1.8; remote API setup clarified; troubleshooting covers `/health` reachable + runtime warning, native computer-use, and Connect flow.
- Public release hygiene: docs are public-marketing only; private plans, internal notes, and release-prep docs are gitignored.

### Notes for v0.1.9
- Plan slot: public support and compatibility hardening. Old-Hermes-version guards, GitHub-label/Discord triage, compatibility matrix, copy-diagnostics UX, and a stable public support playbook.

## v0.1.7 — 2026-06-30

- Added tab-attached side panel opening by default, with a settings toggle to keep the panel global across tabs when preferred.
- Preserved tab-attached side panel paths for both supported load-unpacked roots: repo root and `dist/`/`extension/`.
- Added Chat only context scope so Hermes can run without reading the active tab, open tabs, selected text, page metadata, transcript, or page text.
- Made Chat only short-circuit before browser tab queries and isolated its local message cache from page-context conversations.
- Fixed selected-tab context accounting so the context meter and “What Hermes saw” receipt report tabs actually sent to Hermes, not just tabs open in the window.
- Fixed Remote API connection validation so trusted `http://host:8642` API servers work with a token while remote dashboard WebSocket mode stays HTTPS-only.
- Added `/rewrite` and `/action-items` to match the public docs, while keeping `/actions` reserved for listing interactive page elements.
- Preserved attachment context for slash-command turns, so commands like `/summarize` do not drop attached text/files.
- Updated public privacy, permissions, and data-flow docs for v0.1.7’s Chat only and tab-attached behavior.

## v0.1.6 — 2026-06-28

- Added built-in quick commands such as `/summarize`, `/explain`, `/rewrite`, `/tabs`, and `/action-items`, with slash dispatch and command suggestions in the side panel.
- Added a composer-header tab-context control so Hermes can follow the active tab or pin to a specific tab without adding extra lower composer chrome.
- Isolated pinned-tab conversations with per-tab local message caches and per-tab Hermes session bindings.
- Added selected-tab filtering for the open-tabs context list inside the same upward context card, including all/none controls.
- Added Desktop-style busy composer controls: typing during an active run now reveals separate Queue and Steer buttons, and queued messages expose Steer Now/Delete actions.
- Reworked unpacked-build update checks to compare the loaded build commit against GitHub main instead of mislabeling post-release commits as unpulled.
- Stamped build metadata into every supported unpacked load root so repo-root, `extension/`, and `dist/` installs can all verify commit alignment.
- Added privacy redaction for sensitive tab titles/URLs before prompt assembly, including restricted active tabs and open-tab summaries.
- Preserved contributor work from @iruzen-dono's quick-command and multi-tab context PRs, with follow-up hardening and tests.
- Deferred the broad optional-host-permissions migration to a later release so v0.1.6 does not change the permission surface while shipping context-control improvements.

## v0.1.5 — 2026-06-27

- Added a Hermes compatibility panel backed by `/v1/capabilities`, with legacy fallback when older gateways do not advertise feature support.
- Made first-run Connect avoid missing pairing routes: unsupported runtimes now go straight to Manual setup with Gateway URL/token guidance.
- Added capability-gated voice dictation: Hermes STT is used when advertised, otherwise the side panel and visible voice page use Browser speech fallback when available.
- Added token hygiene UI with masked token state, connection mode, last-tested timestamp, and one-click token clearing.
- Added a collapsible “What Hermes saw” receipt after each sent turn so users can inspect tab/context/attachment/redaction payloads.
- Gated image upload and profile APIs behind capabilities so missing routes become clear fallback warnings instead of broken UX.
- Added public permissions, data-flow, and privacy docs for shipped behavior.
- Clarified remote API setup so same-LAN `http://host:8642` works in Remote gateway mode when an API key is present, while dashboard WebSocket mode remains HTTPS-only.
- Documented how to reload/remove/reload unpacked when Chrome still shows an older extension version after update.

## v0.1.4 — 2026-06-26

- Added editable Hermes session titles, including first-message auto-naming for new Browser sessions.
- Reworked connection state so the side panel uses live gateway reachability instead of treating a saved API key as connected.
- Added commit-aware update checks for unpacked builds, including same-version "unpulled commits" guidance.
- Expanded agent discovery to trusted remote hosts while keeping bearer tokens off non-Hermes probe targets.
- Refined the default Nous palette toward the ink-blue/soft-white Desktop look.

## v0.1.1 — 2026-06-24

- Added drag/drop attachments directly into the composer, including PDFs and files.
- Added Stop and Queue Message controls while Hermes is responding.
- Added `/` and `@` skill command autocomplete backed by Hermes skills.
- Added Agent Profile settings section with graceful fallback for gateways without profile APIs.
- Replaced the large Refresh button with a compact refresh icon.
- Improved streaming completion handling so final answers replace partial deltas.

## v0.1.0-alpha — 2026-06-24

- First public alpha preparation for Hermes Browser Extension.
- Chrome/Edge MV3 side panel.
- Local Hermes Gateway/API connection.
- Active page context capture.
- Streaming response support with fallback.
- Read-only browser context model.
- Load-unpacked install path; not yet on the Chrome Web Store.
