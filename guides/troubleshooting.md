# Troubleshooting

### The side panel shows a runtime warning but still says connected

v0.3.0 introduced separate connection and runtime warnings. When a gateway answers a request with a runtime error, the Browser stays connected and shows a warning instead of labeling the gateway unreachable. Check the Hermes Agent logs for the failing dependency or component.

For tracebacks like `int() argument must be a string, a bytes-like object or a real number, not 'NoneType'`, check the Hermes Agent logs on the machine running the gateway. If the traceback mentions `computer_use` or `cua-driver`, run:

```bash
hermes computer-use doctor
```

That diagnostic belongs to the Hermes runtime/tool layer, not to Browser extension packaging or Chrome permissions.

### Profiles, skills, or voice dictation fail after a Hermes update

Current Hermes can serve profiles and skills through API routes when no dashboard is available. If those routes are missing, the extension keeps the last loaded profile details and tries the older dashboard path. It does not clear a working roster because one discovery route changed. Profiles, skills, and transcription each need their own advertised route, so a connection that loads one of them may still be missing another.

Pictures attached to a message are stored on the machine running Hermes. Reopening the session shows them when that gateway serves stored files, and the panel keeps the previews it still holds when it does not. A session that is open keeps refreshing while its reply runs; reopening it from the session list is no longer needed to see new output.

Voice dictation uses the API transcription route first, then the dashboard route, then browser speech. A dashboard that does not provide its session token is skipped. Browser speech can still fail independently when the browser has not finished installing its language pack or does not support the requested recognition mode.

### The Projects tab says projects are not available

Projects and Move need the Hermes dashboard WebSocket and a gateway that advertises session authority. The tab names which of these is missing: a REST-only connection, a gateway that did not report session authority (update Hermes), a connection that has not finished connecting, or a gateway that answered "method not found" for a projects call. Recents keeps working in every case. A project's folder is a path on the machine running Hermes, so type it; a browser cannot browse that machine's folders. If a move says it was not confirmed, or that the connection dropped, open the move again and check the session's folder before relying on it.

### Compact context is disabled, or says it did nothing

The button is disabled with its reason when the connection is REST-only, the gateway has no session authority, Hermes answered "method not found", or a turn is running (stop it first). "Nothing to compact" means the session is already short enough. If the answer was lost, nothing is sent twice: check the session, then press Compact again. Compaction waits up to three minutes for the summary.

### A capability row reads Cached, Unknown or "Not advertised by this gateway"

Cached means the answer is old or its connection has closed; it is shown for information and never used to start anything. Reconnect and open Settings again to renew it. "Not advertised" means the gateway did not say, which is different from unsupported. The Browser Companion Plugin row reads this way only until the extension has asked the plugin itself (a read-only status route on the API server, with `/v1/toolsets` as a cross-check); after that it says ready, outdated, disabled, not installed or unreachable with the exact reason. "Not installed" means not loaded on that gateway: not installed, not enabled for the profile, or the gateway was not restarted since. `node scripts/enable-bot-companion-tools.mjs --list` on the Hermes machine shows where the plugin is installed for each profile.

### My message says it was not delivered, refused, busy, or the session is gone

Your draft is kept and the reason appears in a toast. A busy session is another window or client running a turn in it, and the gateway stays connected. A refused message is sent once, never in a loop. "Not delivered" means Hermes has no record of the message and the session is idle; nothing is resent automatically, so send it again yourself, but check the history first if Hermes stores messages in a form this panel might not recognise. "Session gone" means the gateway no longer has the session, and no new session is created under it.

### Hermes Control refuses with `restricted_frame`

A frame on the attached page is on a restricted address, has moved to one since the page was read, or is laid over the control, or the click would land in a frame from another site that Chrome runs in its own process. Those frames are not read or acted on. Ask Hermes for a fresh view of the page, or act on the control yourself.

### Companion plugin tools say "unavailable"

A copy of the plugin staged before the hook-worker fix cannot hand its authorization to its tools under Hermes' hook worker, so every owner-gated tool reports unavailable. Compare the `version` in the installed `plugin.yaml` with this repository's (`node scripts/enable-bot-companion-tools.mjs --list` does it for every profile), reinstall with `hermes plugins install ... --force` (or move an old nested copy out first) and restart that profile's gateway. See [companion-plugin/install.md](../companion-plugin/install.md).

### Native Hermes computer use is not working

Hermes Browser Extension does not control your desktop. Chromium builds request the `debugger` permission only for opt-in Hermes Control, which drives tabs you attach; Firefox builds omit it. Native desktop control is separate and comes from Hermes Agent's `computer_use` toolset via `cua-driver`.

On the machine running Hermes, verify computer use directly:

```bash
hermes tools list
hermes computer-use status
hermes computer-use doctor
```

If `doctor` says the driver is missing:

```bash
hermes computer-use install
```

Then start a fresh Hermes session with the toolset enabled:

```bash
hermes -t computer_use chat
```

Common blockers from the Hermes docs:

- Windows over SSH runs in Session 0 and cannot see the interactive desktop; use the console/RDP session or the cua-driver Windows autostart pattern.
- Elevated/admin windows cannot be driven by a normal-integrity Hermes process on Windows.
- macOS needs Accessibility + Screen Recording permissions.
- Linux needs a reachable X11/Wayland display and AT-SPI.

