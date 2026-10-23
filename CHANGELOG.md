# Changelog

## [Unreleased]

### Added

- Hermes Control reaches controls inside the frames of an attached page, such as a live stream's chat box, an embedded player or a comment box, so Hermes can read the chat, click Send and type into the composer. The page view lists them after the page's own, with refs like `@f1e12` that keep their number when another frame comes or goes, and part of the view is reserved for them so a long page cannot push the chat out. Frames follow the page's rules: a frame on a restricted page (a checkout or banking page inside an allowed page) is never read, and nothing is read once you detach the debugger, press Pause or Stop, turn control off or release the tab. A frame from another site that Chrome runs in its own process is not read, and at most 8 frames of 400 controls each are read.
- Hermes Control checks the frame again when it acts, not only when it reads. A frame that moved to a restricted address after the page was read (a checkout path pushed into its history, for example), or a restricted frame laid over a control, makes the action fail with `restricted_frame` instead of running. The check covers every frame above the control, and the same check runs again just before a click, hover or drag moves the pointer. A click that lands on a frame Chrome runs in its own process is refused, so controls inside a cross-site frame cannot be acted on at all. A page can still change between the last check and the browser delivering one input event, which Chrome gives the extension no way to prevent. Frame control needs Chromium; Firefox has no debugger access, no trusted input and no frame control.
- First-time setup fills the whole panel the first time you open it, before your first message. It steps through theme (with Light, Dark or System), font, response style and chat layout, then **Connect to Hermes** last, with pairing, **Manual setup** and **Connect later**. A small sample conversation redraws as you choose, every step has Skip, Back and Next, and a panel that is already paired skips the Connect step. Choosing a theme or style saves it at once. Anyone who has already used the panel skips setup, and **Settings > Appearance & Themes > Run first-time setup again** brings it back. When setup ends, a **Summarise this page** chip appears above the composer. It fills the box, never sends, and goes away once used or when you send your first message. **Connect later** lasts for that panel session; an unpaired panel still shows the "Not paired" startup screen the next time it opens.
- Connect to Hermes is a pop-up over the panel instead of a card at the top of the chat. It closes with its X, Escape or a click outside, comes back when a connection drops or a token stops working, and opens from **Connect first** in the composer or when you send while unpaired. It never covers the startup screen or first-time setup.
- Response styles and chat layouts. **Response style** is Vivid UI (cards, tables and charts when they help), Rich text (formatted Markdown, as before) or Plain text. **Chat layout** is bubbles on both sides or a bubble for your messages only. Both are picture cards in Settings > Appearance & Themes under Theme, and in first-time setup. Rich text and bubbles on both sides are what you had before; setup preselects Vivid UI, and nobody is moved to it. With Vivid UI, every side panel turn carries a fixed instruction (about 3,400 characters, kept in the session history) asking Hermes to answer in `hermes-ui` blocks, because the dashboard socket has no system message to carry it. Hermes can still ignore it: a reply with no blocks is drawn in the Vivid style from its Markdown, nothing is invented, and a broken or cut-off block shows its words, never raw JSON. Blocks are validated and drawn by the extension, never run as HTML or script, and none of them can send a message or skip an approval. The protocol is in [guides/haui-v1.md](guides/haui-v1.md). The full tab draws styles and layouts but does not send the Vivid instruction.
- Projects in the sessions drawer. A **Recents | Projects** strip lists the Hermes projects of the active profile, grouped as Projects, Detected folders and Home, with folder, session count and last activity. Open a project to see its sessions, start a **New session in this project** (it runs in the project's folder), create a project from a name and a folder path on the machine running Hermes (a browser cannot open that machine's folder picker, so you type the path), or **Move** a session from Recents or a project to another project or folder. A move changes the session's working folder, so the confirmation says so. It says "Moved" only after Hermes reports the new folder back, asks before moving a session with a turn running, and Hermes can still refuse. A project is a folder on the Hermes host; nothing about projects is stored in this browser except which tab you last used. Projects and Move need a dashboard connection to a gateway that advertises session authority. On a REST-only connection, an older gateway or one that does not serve the project methods, the Projects tab says why and Recents keeps working. These screens were exercised against a test gateway, not yet against a released Hermes, so expect rough edges on real gateways.
- Capability states in Settings > About & Diagnostics and in the support report. Each feature row shows Available, Cached, Degraded, Blocked, Unsupported or Unknown, the exact reason, where the answer came from and how old it is. A positive answer that is old, or whose connection has closed, shows as Cached and is never used to start anything. A feature the gateway never advertises reads "Not advertised by this gateway", which is not the same as unsupported. The Browser Companion Plugin row says the extension cannot tell whether the plugin is loaded, so that row does not mean the plugin is missing. Copy Diagnostics prints the same rows. Ages are as of the last time the page was drawn, not a live clock.
- **Compact context** on gateways with session authority. The Context window's Compact button asks Hermes to replace older messages with a summary, then reads the session back and says "Compacted" only if the read-back agrees. It refuses while a turn is running, waits up to three minutes for the summary, and when it cannot run the button is disabled with the exact reason (REST-only connection, no session authority, refused by Hermes). If the answer is lost, nothing is sent twice and the result says so. A compaction that moves Hermes to a new stored segment keeps the session's id. Gateways without session authority keep the compaction they had. The automatic recovery from a full context window still starts a new session on session-authority gateways, because compacting unattended would change a session without being asked. This has been exercised against a test gateway, not a released Hermes.
- The context window card shows each session's own context. Opening a session paints its last known reading at once, then asks the gateway for a fresh one: used and maximum tokens, percent full, compressions, a bar split into the gateway's own category estimates, and warnings at 80 and 95 percent. It lives in Settings > Sessions & Context (with the session's runtime and next-prompt rows under Details) and as a ring with its percent in the composer, which opens the same card. Over a plain REST connection Hermes sends no context numbers, and the card says so and labels the panel's own estimate. **Refresh** in the card and the `/refresh` command capture the page again and re-send the whole page context with your next message. Switching tabs and loading pages now refresh only the preview's tab list and titles, without capturing page text.
- A model-lock mismatch is shown. When Hermes accepts a model lock but the runtime reports a different provider or model, the panel says "Model mismatch" instead of "model lock accepted". A runtime that names only the model or only the provider has not confirmed the pair, and is not shown as confirmed.
- Approval and question cards also work on session-authority gateways, using their prompt events and resume snapshot.
- A note under a long paste says how much is sent as a head and tail excerpt and how much stays on this device (#94). Thanks to @Isneezekittens and @MingChunWing (#95).
- A one-time note when a session passes 100 messages, since long shared sessions can fall out of sync with other Hermes clients. Thanks to @iamformlesslol (#76) and @RawNuke (#70).
- Dashboard connections that advertise a heartbeat are pinged every 30 seconds, and a socket silent for 45 seconds is closed so the panel can reconnect.
- Approval and clarify requests from Hermes appear as a card above the composer in the side panel and the full view: Approve once, Session, Always or Reject (Reject is focused by default), the command or file-edit diff, and a countdown. Clarify questions take options, multi-select, free text or Skip. A flagged command no longer stalls a turn for up to 300 seconds, and nothing is approved automatically. Thanks to @Alex130988 (#122).
- The dashboard WebSocket answers Hermes server requests, closes a card when Hermes cancels it, and shows requests that are still open after a reconnect.
- A batched browser-control action runs up to 20 steps as one command, each through the same safety checks and approvals as a single action, with one page snapshot at the end. It stays inactive until Hermes adds a matching tool.
- Hermes Control keeps one debugger session per attached tab instead of attaching around every action. It detaches after 60 seconds idle, when the tab is released or paused, and on Turn off, and re-attaches once if Chrome reports the session was lost. Chrome shows its debugging banner while a tab is attached.
- Hermes Control returns the updated page with every action. Click, type, press, scroll, navigate, back, fill, select, scroll-to, and hover settle briefly and return a compact, redacted list of actionable elements with fresh refs, so Hermes can chain actions without a snapshot in between. `browser_snapshot` returns the same view.
- When Hermes Control is attached, each turn tells the model the tab is ready and lists its interactive elements with refs, so the first click works without a navigate or snapshot call. With several attached tabs, commands default to the tab of the latest turn. The controller advertises fill and select.
- Sessions highlights running chats and follows live replies and tool activity on supported gateways, including chats started outside the browser panel.
- Tool calls are grouped behind a compact disclosure. Individual calls can be expanded, and live refreshes keep the list open and preserve its scroll position. Thinking stays in its message card and cycles through compact expressions.
- Everforest, Classic Hermes, and Anti-Nous themes, each with light and dark palettes. Anti-Nous combines crimson and berry accents with navy reading panels and fine gold trim; its light palette uses white panels and crimson controls.
- Settings now opens to a category grid. Each category has its own view and Back navigation, edited categories are marked, and related controls open the section they belong to. Models has a runtime summary and opens the model picker above Settings.
- A Tab screenshot action in the attachment menu captures the current tab only when you ask, and Bot Mode group turns on a local Hermes connection can include approved, redacted page context. Chat-only and remote group turns never capture page context.
- `scripts/enable-bot-companion-tools.mjs` previews, and with `--apply` enables, the optional companion tools for a profile you choose.
- Voice dictation has a glow that rises from the bottom edge of the message box while you speak. It follows your voice, takes its colours from your theme, and a light sweeps along the edge while Hermes transcribes. Nothing runs while you are not dictating, and on a slower computer the glow lowers its own resolution instead of slowing the panel down. With reduced motion on it holds still, and it is hidden in high contrast mode.
- Live voice chat with GPT-Live. When your Hermes profile sets the voice chat mode to GPT-Live and the Hermes host has an OpenAI API key, a live voice button appears next to the mic. Talk naturally and interrupt whenever you like; when you ask for real work, Hermes does it with your selected model, tools and memory, and the voice tells you the answer. Your request and the reply also appear in the chat. Say "stop" or press the button again to end. The key stays on the Hermes host, OpenAI bills the voice by the minute, and nothing loads until you start a session. Needs a local connection and Hermes v2026.9.14 or newer.
- Code blocks in messages are now syntax highlighted for common languages (Python, JavaScript, TypeScript, JSON, YAML, SQL, Bash, C#, CSS, HTML and Markdown) in the side panel and the full tab, in light and dark themes. Languages Hermes does not recognize stay plain. Thanks to @kidclone3 (#91).

### Changed

- Hermes Control's Follow Hermes and Stay on my tab choices are gone, and a Show tab button next to Turn off and Pause brings the tab Hermes is using to the front when you press it. Hermes never changes which tab you are looking at on its own: it asks before switching your tab, tabs it opens start in the background, and a link Hermes clicks that opens a new tab opens it in the background too.
- Hermes Control has one name across the panel, settings and docs, says "attached tabs" instead of "leased tabs", explains scope choices in visible text, and lists tabs it cannot control as disabled rows with the reason. Its toasts, errors and the composer send button are translated.
- Remote connections, whether a remote API server or a remote dashboard, no longer look for a Hermes Dashboard on this computer, and switching to one closes any local dashboard socket and live roster the panel had open. Profiles and Bot Mode say a dashboard companion is not configured (#103). Thanks to @kidclone3.
- Connect to Hermes uses a Gateway URL typed in Settings even before Save (#82). Thanks to @JonesGit4.
- Ordinary gateway requests give up after 60 seconds. Streams, uploads, transcription, compaction and agent turns are not limited.
- The real-browser e2e checks run headless on Linux and macOS, drive Inline Assist with trusted input, report Hermes Control latency and debugger attach counts, and cover the approval and question cards (`npm run test:e2e:prompt-cards`).
- While Hermes waits on you, the status line reads "Waiting for your approval" or "Waiting for your answer" instead of "Still waiting on the model".
- Hermes Control approvals are bound to the exact element and value they were requested for, so an approval for one target cannot be used for another with the same label.
- Dashboard WebSocket tickets travel in the Sec-WebSocket-Protocol header instead of the URL, with a one-time fallback for older dashboards. Extension pages set a stricter content security policy.
- The README intro now says Hermes runs in a Chromium side panel or Firefox sidebar and that tab control is Chromium-only, and has a short Hermes Control section. AMO links no longer hard-code `/en-US/`. Thanks to @Gitoffthelawn (#121).
- README, troubleshooting, and PERMISSIONS.md now say that Chromium builds request `debugger` for opt-in Hermes Control and Firefox builds omit it. PERMISSIONS.md lists `unlimitedStorage` and `declarativeNetRequestWithHostAccess`, and no longer lists an `audioCapture` permission the extension never requests.
- Nous Light uses a white shell with Nous Blue (#0000F2) text, borders and buttons. The background art stays as a faint watermark, and the start screen is white with a blue logo.
- Light-theme user messages are a soft tint of the theme colour with a clear outline, so "What Hermes saw" and code stay readable in every light theme. System notices sit on a solid surface.
- The README is shorter: version-by-version notes point to the changelog and releases, and remote setup plus extended troubleshooting moved to guides/connection-guide.md and guides/troubleshooting.md. The visual tour has fresh Mono Dark screenshots, including Bot Mode group chats and profile editing.
- The composer's DOM preview and Attached-tab controls share one row, and a slim handle on the composer border hides or shows them. The choice is remembered, the DOM preview always reopens closed, and hovering DOM explains what it is.
- The chat intro banner now matches the Settings banner's spacing and keeps white text on blue in Nous Light.
- The Voice Dictation tab, which opens when the side panel cannot use the microphone, now looks like the side panel: the Hermes banner, a dictation timer, the same glow, and a short status instead of paragraphs of setup notes. It uses your theme, including custom themes.
- The dictation meter beside the message box updates without recalculating the panel layout.
- Settings says what Save did. The header explains what Save is for, then reports "saved and connected", "saved, but Hermes could not be reached" with the reason, or "not saved" with the reason, and a failed reconnect after the values were written no longer leaves an Unsaved marker. Controls that save themselves (Appearance, Agents, the permission and Gmail switches, model options, language) show Saving, then Saved, and no longer count as unsaved edits. Save refuses agent ports with no valid number and model source addresses that are not http or https, naming them instead of dropping them, and pressing Enter in a box that saves itself no longer submits Settings. The Test button is a signal glyph that shows the live connection state, the connection light left the top bar, and Settings theme cards follow Light or Dark mode.
- Page context depth (Minimal, Normal, Full) and the YouTube transcript source (Automatic, Off, Custom, with an address field only for Custom) are choice cards in Sessions & Context. The stored values are unchanged.
- The composer shows the model as a chip inside the message field and the context window as a ring with its percent; the commands button became an icon beside Hermes Control. Pop-ups open just above the composer card and re-measure when it resizes. The row under the composer is gone.
- Interface icons are pixel glyphs from pixelarticons 2.4.2 (MIT licence, kept in `extension/assets/icons/pixel/`). The startup screen is redrawn as a border that fills as the readiness checks finish, with a new extension icon and the Hermes wing mark in the top bar.
- Setup and the Connect pop-up use the panel's own scrollbar, and setup's Back and Next are icon tiles in the border band.
- Firefox is unchanged in scope: the sidebar comes from `sidebar_action`, and Firefox builds omit `debugger`, `offscreen` and `sidePanel`. The new setup, Projects, capability and compaction screens use no Chromium-only API, but they were not exercised in the Firefox sidebar for this release.

### Fixed

- New side-panel chats work again on current Hermes. Since about October 6, Hermes runs an API-server turn only on a session stored as `api_server` or `bot_room` and refuses to relabel one, so a chat the side panel created as `hermes_browser` answered every message with "permission denied". The side panel, Hermes Assist and Hermes Control now create API-server sessions as `api_server`, and the Browser still knows its own sessions by their id. Chats created before this fix keep being refused until Hermes accepts the Browser's label.
- Hermes Control clicks and scrolls no longer hang on a background tab. Hover and drag of a hidden tab fail at once with `tab_hidden`, a screenshot of a hidden tab fails with `tab_hidden` after a short wait, and Hermes asks you to bring the tab forward with Show tab in Hermes Control.
- Stop on a dashboard connection confirms from the gateway's own status instead of waiting 30 seconds. A Stop pressed before Hermes has a run id stays held, with a Release button, and the reads before an interrupt no longer delay it.
- Cards from a connection the panel closed are withdrawn, a refused WebSocket handshake retries with a fresh ticket, and an approval raised during a slow status read is no longer closed as answered elsewhere.
- The approval card focuses Reject when it appears, and a failed turn keeps its "Streaming failed" notice instead of the thinking indicator.
- Pausing Hermes Control ends a running batched action before its next step.
- Redaction keeps JSON valid, catches credentials inside escaped JSON, and no longer treats ordinary links such as `?state=CA&code=US` or `?ticket=1234` as credential-bearing.
- Dashboard session lists keep paging while the server reports more sessions (#9). Thanks to @AIalliAI (#2) and @KeyArgo (#10).
- A session request refused by the API server's CORS gate names the exact extension origin and the `API_SERVER_CORS_ORIGINS` line to add, and keeps your draft and connection (#89). Thanks to @mck156.
- A failed automatic pairing start opens manual setup instead of an error (#116). Thanks to @davidgoh16-collab.
- Fields a gateway refuses are remembered per gateway instead of being resent on every list load and turn, and dashboard videos play without a token in the URL.
- Stop no longer says "Hermes stopped" before Hermes has confirmed it. A turn without a confirmed run id is held as unconfirmed, with your draft and queued messages kept (#69).
- Stop on dashboard and attached sessions sends the execution generation Hermes requires, falls back to stopping the run by id, and cancels pending Hermes Control commands (#69). Hermes Web stops the same way. Stop now carries the generation of the run it was started for: if Hermes says that generation is stale, the run had already ended, nothing is interrupted, and Stop does not retry onto a newer run (a queued message that auto-sent, or another window's turn). Where the generation is not known, as on older gateways, Stop reads the current one first and is labelled best effort.
- Context compaction works over the dashboard WebSocket instead of always starting a new session.
- Approval decisions are sent with request_id and execution_generation, which current Hermes requires.
- Redaction catches prefixed and suffixed secret names, more token shapes, Basic authorization headers and passwords in connection URLs, and keeps quoted JSON intact. Page text can no longer close the untrusted-context block early.
- Gateway-derived values in side panel markup are escaped, and the HTML sanitizer fails closed when no DOM is available.
- The full view asks before opening a returned file with your computer's default app, and never hands programs or scripts to it.
- Clear stored token also clears the legacy token, and the companion journal file is created readable only by you.
- Hermes Web no longer fails to list sessions on current Hermes: `session.list` was sent with an `offset` that Hermes rejects.
- Hermes Control no longer leaves Chrome's debugging banner behind: releasing a tab, and a periodic sweep, now detach a debugger session that a restarted or suspended service worker had forgotten. Cancelling the banner during a command is no longer silently undone by a re-attach, and two commands that hit the same stale session share one re-attach instead of one of them failing.
- Hermes Control results are safer and more reliable: a navigation that lands on a restricted page (banking, checkout, and so on) no longer reports that page's title, text typed into a field is never part of the page text, a slow navigation is read after it finishes loading (not half way), the page is read back only until 28 seconds into a command so the Hermes gateway's 30-second timeout cannot turn a completed action into a failure, and navigating to a different `#/route` of the same app is no longer skipped as "already open".
- Browser control over Hermes Cloud registers again: the cloud registration no longer sends a `product` field that Hermes rejects. Local and remote API registration still send it.
- Tool rows finish instead of duplicating on current Hermes streams: `tool.completed` and `tool.failed` now mark the call completed or failed.
- Hermes Assist can no longer be driven by the page you are on. Its panel is now sealed from page scripts and only reacts to your own clicks and key presses, so a page cannot open it, send instructions to your chat, or read the reply or chat title.
- Messages that only the extension's own pages send (wake word, context menus, theme marketplace, loopback fetch, Hermes Web, YouTube transcripts) are refused from content scripts. The wake word message can only change wake settings, not the Gateway URL, API key, or Hermes Control.
- Hermes Control no longer shows as unavailable when a turn simply did not request it (`not_requested` in the companion plugin's context store).
- Current Hermes connections load profiles, avatars, group chats, and saved bot history through the API routes the unified gateway exposes. When the dashboard is unavailable, existing profile details stay visible and named profiles still try their own skill catalogs. A gateway that does not advertise a route keeps the last loaded details instead of clearing them.
- Images attached to an earlier message show again when a session is reopened, including turns stored as a JSON envelope followed by attached-image lines. On a gateway that serves stored files, the pictures load through the API credential the panel already holds; otherwise the panel keeps the previews it still has and shows the file names.
- An open session keeps updating while a reply is running, even on a plain API connection with no dashboard socket. The panel checks the session's message count and re-reads the chat when it changes, instead of waiting for the session to be reopened.
- Closing the Voice Dictation tab no longer closes the side panel on the tab you return to.
- The Voice Dictation tab's microphone settings and start buttons sit side by side on one row.
- Older chats can be continued after current Hermes accepts API turns only for supported session sources. The panel keeps the composer available when another session is running, and explains a long wait instead of leaving it looking stalled.
- Voice dictation checks the available transcription route before recording and falls back when the dashboard route cannot be used. A slow browser speech download no longer leaves the microphone click waiting indefinitely.
- Session lists follow the gateway's page boundaries and no longer repeat pinned sessions.
- Reopening a working session restores streamed text and tool activity instead of leaving an empty or detached view. Followed live sessions offer Steer, Queue, and Stop, with controls aimed at that session.
- Expanded tool lists use the themed scrollbar with room between the scrollbar and completion labels.
- Live history refreshes keep the same assistant card without restarting its fade-in, and a completion wait no longer adds a duplicate thinking card. Steers sent from another client appear in the followed transcript.
- Steer, Stop, queued messages and late errors stay with the session that owns the run. Navigation during a pending action cannot redirect it to another chat, and refused queued sends retain a restorable draft.
- The model footer uses readable model names without changing the selected model or provider.
- The background picture no longer changes every time you switch tabs and come back. Each Hermes panel picks one when it opens and keeps it until you close it, and panels open in different tabs at the same time each get a different picture.
- In Firefox, the Hermes toolbar button now closes the sidebar when it is already open, so one click puts it away on every tab. Firefox keeps an add-on sidebar open across all tabs in a window, so Settings now says that instead of offering a per-tab choice that Firefox cannot apply.
- New tabs keep the model you picked in the side panel, including Gateway default, instead of switching to the first model in the list, which could be a provider with no credits left. A saved model the list does not show yet stays selected with its provider, and on dashboard and remote connections Gateway default starts chats on your profile's own default model. Thanks to @Prediction6767 for the report and root cause (#119).
- The message box grows as you type, and once it is as tall as it can get your latest text stays in view above the commands button instead of sliding under it. The same happens after voice dictation.
- Scrolling back up through a long draft shows the lines passing under the composer controls through a tinted glass band instead of a hard cutoff. The band only appears while text sits below the visible area, the controls stay solid, and the message box can still be dragged taller.
- Open on computer now reveals the original file in its folder on a local connection instead of downloading a second copy, and refuses on remote connections. Save remains a separate download.
- A file mentioned more than once in the same reply shows a single file card; later replies can still show it.
- Media files report their full size when the server answers with a ranged response.
- Hermes signature chat headlines now use the signature display face, the same condensed face shown on the font menu, instead of a serif stand-in. Code and monospace use Aeonik Fono when that face is installed, and fall back to the bundled mono face otherwise.
- Leaving Bot Mode while a group chat is still replying no longer waits for every member to finish. Regular Sessions opens immediately, and that group chat keeps running in the background.
- Subagents started from a browser chat now show up in the live dock while they work. You can steer or stop them from that session, including on a local API connection.

- The reasoning effort control is now a slider with tick marks and a Slider or Buttons choice that is remembered. Max and Ultra glow while selected. In a group chat, each bot shows and saves its own effort, so changing one never changes the others.
- Model menus use the same square on/off switch as Settings, and hovering a control in any theme keeps its label readable.
- Anti-Nous reds are brighter in both modes, and the effort slider in Anti-Nous Dark is red instead of pink. Light themes keep paper banners with faint artwork, and the Anti-Nous Dark top bar title is white.
- Approving local-document access on a tab that is still loading no longer leaks an uncaught error. Hermes Control shows a "Control not attached" notice instead. Thanks to @LeahyCC (#97).

- Choosing Pin current tab or Follow active tab on a remote connection that has not approved page context sharing now explains why and offers an Open Settings button that goes straight to the approval switch, instead of silently staying on Chat only. Approval is never granted automatically. Thanks to @jdot-dev (#92, #93).
- A prompt Hermes refuses is submitted once. A session authority reports every refusal with the same code, so the panel treated each as a stale session id and resubmitted without limit (a busy session looped). Now only a bare refusal or a not-found reason triggers one re-resume and one resubmit per turn. A session the gateway no longer has ends the turn as "session gone" instead of clearing the stored id and starting a different session under the transcript on screen. Every refusal keeps your draft and raises a toast for 14 seconds with the reason.
- A prompt Hermes never recorded is no longer shown as answered with the previous turn's reply after a dropped connection. When the history has no row for your message and the session is idle, the turn ends as "not delivered", your draft comes back and nothing is resent. If Hermes stores your message in a form the panel does not recognise while the answer has already finished, it can read as not delivered too; it never resends on its own, so check the history before sending again.
- A busy session no longer marks the gateway unreachable. Sending into a session another window or client is running is refused as that session's condition, the gateway stays reported as connected, and your draft is kept.
- Saving Settings keeps the session you are viewing, a running one included. The session is re-established only when the gateway URL, mode, transport, API key or profile changed.
- Live sessions started elsewhere appear in the sessions drawer. On a session-authority gateway, a running chat from the CLI, Desktop or another window that is not in the loaded page of history is listed with the live badge, provided the connection was made under the profile that is active now. A session shows as running while it is starting or while only its subagents run, one failed status poll no longer blanks the badges, and the composer follows the status when the session you are viewing starts or stops. Opening a running session on a session-authority gateway attaches to it, shows its history and offers Stop. Gateways without session authority list nothing extra, since their live lists name no profile. This was exercised against a test gateway, not yet against a released Hermes.
- A remote connection never uses this computer's dashboard. The local dashboard address, its socket and its live roster are dropped whenever the connection becomes remote, so no reader can reach 127.0.0.1 from a remote profile.
- After a connection drops and comes back, the panel asks Hermes for the events it missed. Replay positions now outlive the connection (kept per gateway, up to 8 gateways and 64 sessions, in session storage, and dropped when Hermes reports a different replay epoch). When Hermes says the missed history was truncated, the panel says "History was truncated, reloading" and reloads the viewed session from stored history. A session this panel is running a turn in reloads when that turn ends.
- On a dashboard connection without session authority, compacting a session moves the viewed session to its successor id and keeps the chat, draft and bindings with it, and an automatic compaction seen in the live list does the same while the panel is not running a turn. On session-authority gateways the id never changes, so nothing is moved.
- A finished run clears the approval and question cards of its own session, not those of the session on screen. A session's subagents all show when it opens, instead of only the ones that spoke since.
- Opening or creating a regular session no longer cancels a group turn that is still running. The turn is detached, keeps running, and is reattached when its room is opened again; only Stop cancels it.
- A panel no longer adopts another panel's session. Panels in different tabs share one settings record, and a reconnecting panel could resume, and then write into, the session another tab had open. Running panels now keep their own binding; a new panel still starts from the one last written.
- Hermes Assist chats that are reopened stay the Browser's own, so the first follow-up is no longer held behind "Continue in API".
- Hermes replies show their time like your own messages, and chats in the full tab stamp send and reply times as they happen. Show message times still hides them all.
- The companion plugin's tools work under Hermes' hook worker. The plugin handed its tool authorization to the tool through a context variable, which the worker thread that runs the hook does not share, so owner-gated tools (`browser_context_status`, `browser_clear_context`, `browser_event_log`, `browser_control_status`, `browser_context_journal`) reported "unavailable" and `browser_get_context` consumed the cached context without returning it. Authorization is now also kept in a small lock-protected table keyed by the trusted session and task ids, valid for 300 seconds, newest grant first. Model-supplied arguments never name an owner. Redeploy the plugin to get this; a staged copy keeps its old behaviour until then. This was tested with a stand-in for the worker, not yet in a live turn on a real gateway.
- The companion plugin keeps only opaque browser metadata. Scope, context hash, controller id and browser profile id are kept only when they are a UUID, a hex hash or a short slug without a credential-style prefix, and anything else is dropped before it reaches status output, the event log, receipts or the journal. The event log's owner correlation value is a salted hash that cannot be brute-forced from a guessable session id.
- `scripts/enable-bot-companion-tools.mjs` is safer. `--list` shows every profile, whether the plugin is staged there (flat or nested, as Hermes discovers it) and its version against this repository's, and writes nothing. It acts on exactly one profile named with `--profile` (lists, `all` and wildcards are refused), maps `default` to the Hermes root, refuses to enable a staged copy whose version differs from this repository's unless `--allow-stale` is given, and still defaults to a dry run.

## [0.3.4] - 2026-10-03

### Added

- Message action rails appear on hover, focus or click. Completed messages offer Copy with success/failure feedback; supported side-panel user turns also offer inline Edit and Restore checkpoint.
- Editing a supported user turn reruns from that point with refreshed browser context. Restore checkpoint confirms before removing later turns from the branch. Rooms and transports without safe rewind addressing do not offer these actions.
- User-message times in 1:1 chat use age-aware formatting and full-date tooltips; unknown timestamps stay unknown. Ordinary 1:1 assistant replies do not gain timestamps. Room messages have their own times.
- Day dividers, consecutive-message grouping, dark-mode glass bubbles, opaque light-mode bubbles and restrained new-message motion improve transcript readability. The Settings timestamp toggle leaves actions and dividers intact.
- Room replies carry a bot avatar, coloured name, accent bar and subtle tint. Consecutive replies from the same member collapse repeated identity headers; room avatars can be chosen from the bundled gallery.
- Room presence shows queued, working, typing, tool-use, done, pass and failure states, with a readable summary of the active member and waiting members.
- A streaming room bubble settles into the final reply in place. Mentions target selected members; Reply prepares a mention for the author of a bot message.
- Per-room model controls show confirmed model/provider, change one member's model without changing its profile default, and reset that override to the default.
- Required model-change/reset confirmations offer Confirm and Cancel, and retry the operation only after confirmation. An unverified pinned model blocks its member turn rather than silently using an unchecked model.
- Model-change, reset, pass and failure notices persist across room reopening as display-only history.
- Browser Control opens from a state-marked composer launcher. This tab, Selected tabs and Task set can be chosen directly in its dialog.
- Scope choices have localized hover/focus explanations and accessible descriptions. A task set groups explicitly chosen tabs under a shared task identity, not every open tab.
- Original-file attachments retain bytes locally, display bounded previews, and offer Open/Download cards in supported live and restored conversations. Browser-local retention does not promise cross-device storage or parsing of every Office/media format.
- Supported session-upload gateways must acknowledge file storage before submission references the file. Missing capabilities, rejected uploads and unconfirmed responses preserve the draft and block the turn.
- Large pastes are handled separately from the inline message limit with explicit retention and excerpt warnings; sending a pasted-text excerpt is not the same as uploading the original file.
- Signature typography falls back to bundled Hermes display and UI faces before unrelated system fonts on installs without the licensed faces. Font assets are included in build verification.
- Signature settings show an honest bundled-fallback note based on registered font loading. Switching away from Signature invalidates an in-flight probe so an old result cannot restore the note.
- The model picker's provider strip scrolls sideways with the mouse wheel: wheel down moves right, wheel up moves left, and the page scrolls normally once the strip reaches either end.

### Changed

- Control actions explain their effects on hover/focus. Apply fills its row, the selected-tabs list uses the branded arrow-free scrollbar, and selected/hovered/focused scope options stay readable in light and dark.
- Context receipts distinguish delivered tabs from the full selection when the turn budget applies, such as 12 of 20, while keeping the complete open-window count separate.
- Newly added scope, message and room strings are maintained across all 21 locale catalogs.
- MV3 startup regression coverage checks listener registration before pending hydration deterministically instead of using a short wall-clock timeout.

### Fixed

- Newly created rooms synchronize members at creation and read the result back. Failed synchronization no longer leaves a room that looks ready but never starts a member turn.
- Room badges report Synced, Not synced or Sync failed from verified state, with retry behaviour. Projection persistence no longer gates member replies.
- Open group rooms stay visible during an in-place roster synchronization.
- Gateway failures explain the actual error and preserve drafts when turn delivery is uncertain (#115).
- A gateway still running pre-update code after a Hermes update is now named plainly ("Hermes was updated, restart it") instead of a generic rejection, and the draft is kept. The message offers a confirmed **Restart Hermes** action with a two-step confirmation, live stopping and starting progress, and a finished state that replaces the prompt once the new process is running.
- The restart prompt follows a restart done elsewhere, such as a terminal, and resolves itself when Hermes is back. It waits long enough for a multi-profile gateway to reconnect, offers **Check again** rather than a second restart if it is slow, and never reports success until a new process is actually running.
- Steering messages show the user's words with a steer label rather than the runtime wrapper, including after history reload.
- Profile-roster readiness reflects the authenticated roster actually loaded instead of stale or optimistic readiness (#113).
- Windows setup respects HERMES_HOME when resolving the Hermes data directory, with clearer configuration-location documentation (#111, thanks @chrisworksai).
- The model picker includes the Space Bunny Alpha context window.
- GPT 6.1 Sol context windows resolve from Hermes Agent rules. Live catalog/session limits take precedence; display labels no longer silently opt a base model into a larger window.
- Context fallback rules synchronize automatically from Hermes Agent at build/model refresh time, with bounded public metadata fetching and offline caching, rather than requiring individual Browser patches for each new model.
- Local distribution signing keys are ignored by source control (#109, thanks @xxkingstuggle).
- Hermes cores with a strict `prompt.submit` contract no longer reject chat messages with an "invalid params ... display_text" error. The turn is retried once without the optional display text and the extension stops sending it for that session.

## [0.3.3] - 2026-09-24

### Added

- A controller that still needs its one-time credential now says so on its own surface. The control strip reads **Browser control needs one authorization from Hermes before it can operate tabs.** and offers a single **Authorize control** action that opens the local approval page, attaches the current tab once approved, and disappears afterwards. A reader who is already connected never sees the first-run setup card again, and the panel no longer borrows **Connect to Hermes** for a control-only repair or asks for a second approval after control is live.
- The update card now closes the reload loop for load-unpacked installs. The side panel remembers the build it booted from, re-reads its own `build-info.json` off disk with `cache: 'no-store'` (at boot, again shortly after boot, on focus/visibility, every 60 seconds, and the moment a turn started from the update prompt finishes) and, when that identity changes, shows a persistent **A newer build is on disk (built <time>). Reload to run it.** line with a **Reload now** button that calls `runtime.reload()`; a rebuilt `dist/` is never run behind your back — only your click reloads the extension.
- The in-place update is honest about what it needs. The update dialog's install note states that the guarded agent turn requires a local checkout of the repository on this machine and offers **Download the latest release**, the prepared update prompt stops and hands over that same releases link (instead of cloning a checkout) when no local checkout exists, and the reload handoff asks you to press the panel's **Reload now** control instead of depending on computer-use. The dirty-checkout stop, the `npm run build` step, and the verify-before-claiming-success rule are unchanged.
- The update card also runs a silent check of its own, at most once every 24 hours: when the cached result in extension storage is older than a day, the panel runs the same version-and-commit check the Check button runs (no dialog, no toast, silent on failure), writes the status line, caches the result and timestamp, and marks the **Update** button as the primary action when this build is behind main.
- Returned files are now one-click cards instead of a bare path. When a turn produces a file, the transcript shows a card with the file name, a type badge, and the actions that actually work: **Open** for kinds a browser can render (PDF, HTML, image, text, CSV, JSON, Markdown, video, audio) fetches the bytes over the extension's authenticated dashboard download route and shows them in a new tab, **Open on computer** runs `downloads.download` then `downloads.open` so the OS default app (Excel, Word, Acrobat) launches it, and **Save** keeps a copy through the browser's save dialog. Kinds a browser cannot preview — xlsx, docx, pptx, zip — offer Open on computer and Save only, and every kind is offered for a path written as ordinary text or as a `MEDIA:` tag. A file the dashboard refuses to read keeps its buttons disabled, draws a dashed boundary, and states the exact reason (HTTP status, unreachable dashboard, empty file), and the existing honest filename chip for unreadable media paths is unchanged.
- The model menu shows each model's Hermes Agent context window. Named models keep the window Hermes Agent already uses, including the 872k large Codex window and the 500k Grok 4.5, 4.6, and 4.7 windows. A model Hermes Agent has not named yet still gets Hermes Agent's 256k default. The menu no longer prints "requestable".
- Settings section titles are readable at 18px. Hermes Control uses the selected display face for its title and the readable UI face for Operate leased tabs, the field labels, and the Stay, Follow, and Enable buttons. The Off and On mark is a status chip with a dot, not a tiny boxed stamp.
- Bot Mode buttons follow the selected font. Agents, Group Chats, Edit Profile, New Agent, Open Bot Chat, and the other Bot Mode and group-chat buttons use the readable UI face instead of a hardcoded typewriter face.
- The local sidecar card on the start screen rotates its background illustration: every time the side panel opens it picks a different image from the extension's bundled art set (fourteen images, and never the same one twice in a row), and the same artwork follows through to the matching card in appearance settings. The card's responsive scaling is untouched and the small corner badge keeps its own fixed image.
- `/btw` side questions now ride the gateway's native side-question flow over the dashboard socket (REST completions stays as the fallback for API-key connections) and land in a full-width result card at the end of the transcript: the card appears while Hermes is thinking, then fills in with the answer, a Copy action, a snapshot timing line, and a dismiss control instead of vanishing with the 5.2-second operation toast. The card stays out of the saved conversation and clears when you switch sessions.
- The "Capture visible Gmail thread" button can be dismissed with a small ✕ that is remembered across reloads, and it can be turned back on any time under Settings → Right-click actions.
- Live subagent roster in the composer dock: queued/running children appear in a SUBAGENTS stack next to TASKS, with model, current tool, elapsed time, and a selected-row steer/stop control. Snapshot hydrate uses `subagent.list`; missing RPCs fail closed.
- Fenced code blocks in chat get a hover copy-to-clipboard control, without overflowing the message card.
- Telegram and Desktop session images hydrate from Hermes cache paths (`image_url:` / `@image:` / `MEDIA:`) through the dashboard `/api/media` route. Local videos render as a player when `/api/files/stream` can serve them, otherwise as an honest file card. Pixels that were never stored in Hermes (only in Telegram itself) cannot be invented.
- Composer text and attachments restore after you close and reopen the side panel in the same browser session. Images are saved to disk when attached so the draft stores a path instead of a huge image blob.
- Classic shapes take a colour as well as a face. The classic tiles offer twelve profile swatches, six per row, plus a **Match the name** row that derives the colour from whatever you type. The tile, the avatar preview, the roster avatar, and the saved profile all read the same value, so the colour you pick is the colour you keep.
- A model switch that would drop the prompt cache now asks first. Switching the session model while the transcript holds context opens the same kind of confirmation the Bot Mode exits use, with a kicker, a title naming the model, the context size it would re-read, and **Switch anyway** and **Cancel**. Cancel leaves the model untouched, and switching model for Hermes Assist still bypasses the prompt.

### Fixed

- Composer skill suggestions no longer go empty when `GET /v1/skills` fails. Local connections recover the catalog from the dashboard profile snapshot (`profiles.describe`), including after a named-profile switch. Named profiles never inherit the default REST catalog.
- Switching profiles in Settings or Bot Mode reloads that profile's model catalog and pins the live default model from `/api/model/options?profile=` instead of keeping the previous agent's selection.
- Browser and tab control connect again, and stay connectable without reloading the extension. Four defects kept the controller from ever registering: the settings rebind dropped credential updates silently (a missing revision was read as revision 0, so the background storage rebind was discarded once the panel had sent its first explicit refresh), a completed pairing never told the controller to rebind, the draft-session materialization reused a fixed title the gateway refuses as a duplicate (`invalid_title`), and the auth classifier matched words like "credential", "api key", or "token" anywhere in a failure, so it wiped a perfectly good pairing token on failures that were not auth failures at all — and the strip then blamed the gateway for a token that was never saved.
- Tab control works when chat is already connected over the local Desktop dashboard transport. That socket authenticates chat but cannot register a controller, so in that state enabling or attaching control now acquires its credential itself (the approval page stays the consent gate) instead of failing the lease and flipping control back off. The Attach toggle hides while authorization is missing, the panel adopts credential writes from the controller so a wiped token immediately shows the repair action, and a gateway that has no browser-control API key says exactly that instead of suggesting the reader's token was rejected.
- Every string the panel ships is i18n-owned again, so `npm run check:manifest` passes: the subagent roster title, its two accessible labels, and the update dialog's no-local-checkout line now carry their own messages, translated across all 21 locale packs.
- The Hermes Assist launcher no longer sits on top of what you are typing in a full-width composer. Every inline site now prefers a placement outside the focused field and keeps the inside-the-field position as a last resort, and a placement that would still cover the field is rejected, so facebook.com and messenger.com no longer hide the end of the draft (#96).
- Buttons no longer disappear on hover in light themes. Hovers that repainted a control with a hardcoded white or a pale accent now invert to the theme's action surface and redraw the outline in the label colour, so every control keeps a visible boundary on every palette. Hovered label contrast measures 7.9:1 at worst across the nine themes (14.2:1 in Nous Light). The enabled Save, Test, and close controls in the settings header no longer read as disabled (9.57:1 text, 6.86:1 border in Nous Light), and full-tab settings rules that referenced primary-colour tokens which no CSS file ever defined now carry real fallbacks.
- Generated images now actually appear in the side panel: the image-generation animation dissolves into the real picture, every picture a tool call produced gets its own card (primary plus alternates, not just the first), and each one opens in the zoomable lightbox with a Download action. Local Hermes cache paths are resolved through the dashboard media route instead of being silently dropped, which is what let the old animation run forever and then vanish. Paths outside the Hermes media roots still fall back to the honest filename chip.
- Pasted screenshots now reach the agent on the local Desktop dashboard transport: Browser uploads each image to the live session over the gateway's `image.attach_bytes` RPC (the same contract Hermes Desktop uses) before the prompt submits, so vision opens the real file instead of hunting for a path that never arrived. The turn envelope now carries the gateway's saved image path for every attached image.
- Explicit Gmail thread capture now reads the entire open thread instead of only the expanded messages: every message node is captured in document order with its sender and date, collapsed-but-rendered bodies are included, repeated messages are no longer de-duplicated away, the subject leads the capture, and output truncates at a message boundary when a thread exceeds the context budget. Compose drafts, textareas, inputs, and contenteditable reply fields are still never captured.
- Steering now surfaces in the transcript itself: a dashed STEER QUEUED row ("arrives after the next tool call") with the steered text pins under the live turn the moment a steer is queued, and clears when the steered message lands in history or the turn settles. A steer the runtime rejects keeps the draft in the composer instead of clearing silently.
- After a background subagent batch finishes, the transcript keeps the live thinking indicator until the gateway's parent completion reply lands, so the child-to-parent handoff never shows a dead moment.
- The Chat only context chip hides in chat-only mode; the scope button already names the mode, so the chip row no longer wastes composer space.
- The side-panel model picker can no longer open partly above the viewport: bottom-anchored popovers reserve the live composer dock height instead of a fixed guess, and the model list and runtime options shrink and scroll so the search box and provider selector stay reachable (ported from #101, thanks @qinxianhahaha).
- Subagent completions now surface the parent completion reply even after the dashboard runtime reaps the stale live session id: Browser resumes the durable session before fetching history and keeps polling until the reply is actually in the transcript. Completed children leave the live roster and their timers stop.
- Background completion replies now stream into the transcript with the same progressive reveal live turns use instead of popping in fully formed.
- Local Desktop dashboard transport now advertises and routes Steer (`session.steer`) so Comet is not stuck with a hidden/dead steer control while Hermes is working.
- Side-panel voice dictation records until you stop, with a Dictating timer and live audio meter. Hermes speech-to-text runs after stop (same as Desktop). A microphone that delivers no audio still escalates to the Voice Dictation tab.
- Side-panel mic that starts but never captures speech now errors and opens the Hermes Voice Dictation tab instead of staying fake-ON.
- If the Browser socket goes quiet or drops while Hermes Desktop is still running the turn, Browser reconnects and keeps listening instead of showing "Could not reach the Hermes dashboard."
- Mapped Codex ChatGPT 6 context windows: 272k for the base model and 872k for the large window, matching Hermes Agent. A stale 900k advertisement is repaired to 872k.
- Bot Mode reads the full roster: authenticated `profiles.list` supplies display names, avatars, last-activity stamps, group-chat projections, and canonical Bot Chat identity. Public status/health names are discovery only and no longer replace a rich roster.
- Opening a bot resumes the confirmed existing Bot Chat and fails closed on lookup errors instead of creating a duplicate chat.
- Dashboard discovery uses explicit URLs, cached URLs, open loopback tabs, sidecar candidate ports, and documented default ports. It no longer scans arbitrary ephemeral port ranges or treats gateway health names as a complete roster.
- Disabled the broad loopback CORS header rewrite. Loopback GET discovery can still proxy through the service worker without rewriting every localhost response.
- Fixed Local gateway Bot Mode profile discovery when Dashboard authentication replaces the token-bearing root page with sign-in HTML; public status now identifies the dashboard, while the existing explicitly trusted signed-in tab and one-use WebSocket ticket flow authenticates the usable profile roster (#99).
- The profile switcher pins its two modes. **Browser chat** and **Bot chat** are a fixed header and only the agent rows scroll, so the way you switch modes can no longer scroll out of reach, and the popup shell itself never scrolls.
- The pet avatar picker works end to end again. Thumbnails paint the first screenful immediately and fill in as you scroll instead of waiting on a lazy observer that never fired inside a closed picker, the gateway thumbnail call is capped at 12 seconds and a failed thumbnail is never cached, and a pet can be chosen for a brand-new agent before it has a name, exactly like a classic face. A thumbnail that cannot load resets the tile and says so instead of leaving a tile that looks picked while the avatar never changes.
- Leaving a Bot Mode group chat no longer leaves the composer avatar in a wide empty box. The group cluster's leftover sizing is cleared when the panel returns to a regular session, so the avatar sits as one button again.
- Settings headlines keep their weight with the Hermes signature face. Rules Gothic Compressed has a much smaller optical size than the other families, so the signature profile scales its display headlines up (both **Bots & Bot Mode** and **Browser updates**) to read as headlines at the same size the other fonts read at.
- The model switch guard prints its title in one font instead of mixing the display face with a monospace segment.
- Every runtime string the panel prints is i18n-owned in all 21 locale packs, including the pet picker's loading and empty states and the model switch guard, so no raw key and no hardcoded English can reach the panel.

### Changed

- The old full-page workspace is retired. The side panel is the supported browser surface, and the old full-view button no longer opens that workspace.
- The Bot Mode roster no longer stacks an active-now chip strip above the agent rows. Each row's own presence dot is the only activity signal, so a working agent is marked once instead of twice.

Contributors: [@kidclone3](https://github.com/kidclone3) for authenticated profile discovery ([#100](https://github.com/abundantbeing/hermes-browser-extension/pull/100)), [@qinxianhahaha](https://github.com/qinxianhahaha) for the model-picker viewport fix ([#101](https://github.com/abundantbeing/hermes-browser-extension/pull/101)), and [@khoalx18](https://github.com/khoalx18) for reporting the Assist composer overlap ([#96](https://github.com/abundantbeing/hermes-browser-extension/issues/96)).

## [0.3.2] - 2026-09-05

### Added

- Added Hermes Bot Mode: dedicated multi-agent roster with seamless profile switching across default and named user profiles, lazy model loading, and instant agent opening.
- Added live Group Chat & Threads support: multi-agent room projections, collaborative thread tracking, and synchronized conversation histories without blank chat states.
- Added AI Tab Triage command (`/sort-tabs`, `/organize-tabs`, `/clean-tabs`, `/categorize-tabs`, `/triage-tabs`): automatically analyzes all open tabs in the window, clusters them into logical categories (Projects, Research, Social, Productivity, Stale/Duplicates), identifies redundant URLs, and generates an actionable removal checklist.
- Added a full-width **Page only** action button and side-by-side **Include all tabs** and **AI Triage Tabs** controls with hover tooltip descriptions.
- Added multi-keyword tab search supporting whitespace-separated query tokens matching across tab titles and URLs with an active match count badge and keyboard navigation (`Enter` to toggle, `Escape` to clear).

### Fixed

- Fixed 40-second connection delay by implementing dynamic loopback Desktop dashboard discovery across ephemeral ports (1297, 22784, etc.) with bounded racing and strict endpoint abort timeouts.
- Fixed `dashboard-sessions-422` session loading failure: updated session pagination to respect the dashboard's max query limit (`limit <= 100`) across sequential pages, restoring full access to Hermes Browser Extension, Desktop, and API sessions without gateway errors.
- Fixed startup loading freeze: restored sequential readiness step reporting with strict timeouts preventing loopback gateway endpoint hangs.
- Fixed false "Invalid gateway API key API_SERVER_KEY" error banners on named profiles by enabling loopback browser pairing token authorization and direct dashboard WebSocket transport fallback.
- Fixed tab context scope regression: "Page only" mode now truthfully displays `1/N` tabs in prompt, marks the active page `IN`, marks all other tabs `OUT`, and strictly isolates prompt payload tabs so the AI model never receives unselected browser tabs.

## [0.3.1] - 2026-08-27

### Fixed

- Fixed repeated `Uncaught SyntaxError: Identifier 'browserApi' has already been declared` in Vivaldi/Chromium by scoping the entire content-script bridge inside an idempotent IIFE; cross-run coordination stays on the existing globalThis sentinels with listener cleanup before rebinding (#86).
- Hardened the scripting install fallback to probe the content-script re-entry sentinel and inject only missing scripts instead of blindly re-executing all manifest scripts into an initialized frame (#86).
- Fixed automatic pairing never reaching its approval window on gateways that keep `/v1/capabilities` behind authentication: a fresh install now makes one bootstrap pair/start attempt when the capability advertisement is unreadable (HTTP 401) on a loopback local gateway, falling back to manual setup only when that genuinely fails. Verified live end-to-end on Firefox 154 / Windows 11 against an auth-hardened gateway: pair start, Approve Connection page, token grant, and full readiness chain (#85 investigation).

### Added

- Added startup latency instrumentation (observer-only performance marks exposed via `window.__HBE_BOOT_MARKS`) covering body start, i18n, settings restore, per-stage readiness settles, message paint, and composer interactive.
- Added `scripts/bench-startup.mjs` (`npm run bench:startup`): cold/warm/restart startup benchmark with an embedded fixture gateway, hard sample-count assertions, p50/p90 reporting, and a gateway-down scenario.

### Changed

- Internal-only: added the Python tooling namespace under `scripts/pytools/` (gateway log forensics, capability/route diffing, release consistency auditing, Bot Mode contract diffing, controller trace timelines) with stdlib unittest suites wired as `npm run test:pytools`.

## [0.3.0] - 2026-08-22

### Added

- Added opt-in live browser control through an authenticated MV3 service-worker controller with exact per-tab leases, document-generation checks, lifecycle recovery, and no fallback for Browser-bound requests.
- Added Chromium control actions for snapshots, refs, clicks, typing, form fill/select, navigation, scrolling, screenshots, tab operations, console/network inspection, PDF generation, uploads, dialogs, evaluate, and policy-bounded raw CDP.
- Added explicit approval gates for consequential and privileged actions, with developer-mode enforcement for evaluate and raw CDP.
- Added approved local HTML, browser-rendered PDF, and localhost context/control support on Windows and macOS, including click refs for interactive images and custom controls.
- Added scoped one-shot artifact upload/download with MIME limits, TTL, SHA-256 checksums, provenance receipts, and atomic consume-on-download behavior.
- Added reviewed workflow-to-skill draft generation from completed redacted receipts, with fixture-only dry runs and explicit approval before save.
- Added a bounded metadata-only companion journal and adversarial privacy matrix.
- Added Mozilla signing support and a stable Firefox add-on ID for Mozilla-hosted updates.

### Changed

- Added sticky settings controls and theme-aware operation notifications for control enable, attach, pause, approval, and detach states.
- Expanded the compatibility, privacy, permissions, data-flow, and README documentation for live control and local documents.
- Hardened controller reconnect, stale owner, approval, terminal latch, and exact-target authority behavior.
- Wired capability-derived Developer Mode and authenticated one-shot artifact routes into the live extension runtime instead of leaving them as isolated executor modules.
- Prevented rapid content-script reinjection from leaving duplicate inline Assist hosts, and aligned launcher geometry with the rendered 36px control.
- Aligned Codex OAuth context-window fallback and accounting behavior with explicit provider identity while preserving authoritative runtime telemetry.

### Security

- Browser-bound requests never fall back to another browser backend.
- Controller durability and companion diagnostics persist metadata and redacted receipts only, never raw DOM, page text, command arguments, typed values, credentials, screenshots, or response bodies.
- Sensitive fields, restricted schemes, credential-bearing URLs, stale refs, stale documents, borrowed tabs, cross-domain mutation races, oversized artifacts, and replayed approvals fail closed.

### Fixed

- Fixed the side panel `/commands` menu covering long prompts ([issue #73](https://github.com/abundantbeing/hermes-browser-extension/issues/73)): the commands picker now opens upward into the free space above the `ASK HERMES` composer with a 6px gap, so multiline drafts stay fully visible, the textarea is never compressed, and command filtering, keyboard navigation, selection, and close behavior are unchanged.
- Added a **Save** action to the Settings header next to **Test connection** with a hover tooltip, replacing the former bottom-left **Save settings** footer button so settings can be saved without scrolling; it shares the same accent-outline style, mono type, and hover behavior as the other header controls.
- Replaced the Settings header **CLOSE** label with a compact close icon button, tightening the header row while keeping the same click target, keyboard focus, and accessible **Close settings** label.
- Fixed **Clear stored token** button text alignment so the label sits centered inside the button, and made **Clear stored token** and **Copy Diagnostics** span the full width of their cards with centered labels.
- Fixed the **Scan agents** button sizing and text placement so it renders with proper card metrics (matching the ↻ Profiles button) while staying left-aligned in its card, with the ↻ glyph and label vertically centered.
- Kept the Settings sticky-header divider full-width and aligned the header content to the panel edges so the title and close button land on the divider's end points.
- Removed the redundant **HERMES BROWSER** eyebrow above the Settings title so the dialog header reads as one clean row.
- Added an in-chat **Detach** action: the Browser control strip button now toggles between **Attach** (when the current tab is not leased) and **Detach** (when it is), so you can detach straight from the chat interface instead of opening Settings.
- Changed the composer **/commands** button from a pill to a rectangle (using the shared radius token) and re-centered the `/` and **commands** label inside it.
- Removed the "Enter sends. Shift+Enter adds a new line..." helper line under the composer.
- Shortened the startup screen's error line so a disconnected gateway no longer stacks the full diagnostic under the logo and pushes the readiness cards and buttons down; the full detail stays in the status card below where it belongs.
- Centered the text in the Browser control **Attach / Pause / Stop** action buttons.
- Added a dismiss ✕ to the Browser control strip that detaches control completely (removes the box) from the chat interface, and a white ✕ in the top-right of the **Local sidecar / Chrome panel** intro card so users can close it on sight.
- Removed the **Hermes Assist** and **Right-click actions** sections from the Hermes Web settings dialog; both remain configurable in the side panel Settings, and Hermes Web keeps the stored preferences unchanged.
- Converted the control strip **Pause** and **Stop** buttons to compact icon glyphs (pause/play and stop square) with hover tooltips, and the Stop button now only appears while an action is running or queued instead of sitting disabled. The pause button swaps to a play glyph while paused (fixed an SVG `hidden`-reflection bug in Chromium so the swap actually renders).

### Contributors

- Reproduced and scoped [issue #73](https://github.com/abundantbeing/hermes-browser-extension/issues/73) from the report by [@kidclone3](https://github.com/kidclone3).

### Verification

- Canonical JavaScript, manifest, locale, Chromium, Firefox, controller, companion, artifact, workflow, adversarial, and privacy suites are required to pass before publication.
- Chrome-for-Testing reconnect/control journeys and the manual Comet control gate are required for release approval.

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
