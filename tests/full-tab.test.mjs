import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('full-tab extension surface has a dedicated shell without copied sidepanel code', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = read('extension/app.css');
  const tokens = read('extension/lib/design-tokens.css');
  const visualCss = `${tokens}\n${css}`;

  assert.match(html, /<title>Hermes Web<\/title>/);
  assert.match(html, /id="sessionRail"/);
  assert.match(html, /id="conversationView"/);
  assert.match(html, /id="inspector"/);
  assert.match(html, /id="fullTabComposer"/);
  assert.match(html, /type="module" src="app\.js"/);
  assert.match(css, /--fulltab-left-rail/);
  assert.match(visualCss, /#0000f2/i);
  assert.match(html, /assets\/img\/hermes-web-logo-white-dark\.svg/);
  assert.match(visualCss, /Collapse-Regular\.woff2/);
  assert.match(visualCss, /Sigurd-Variable\.woff2/);
  assert.match(visualCss, /CourierPrime-Regular\.woff2/);
  assert.match(visualCss, /hermes-browser-web-horizon-ink\.png/);
  assert.match(visualCss, /hermes-browser-mark\.svg/);
  assert.match(css, /@media \(max-width: 1023px\)/);
  assert.match(css, /\.web-shell,\s*\.web-shell\.inspector-closed\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(js, /createHermesClient/);
  assert.match(js, /function initializeResponsiveShell/);
  assert.match(js, /function setNavigationOpen/);
  assert.doesNotMatch(js, /async function askHermes/);
  assert.doesNotMatch(js, /function streamSessionChat/);
  assert.doesNotMatch(html, /class="web-brand-mark"[^>]*>H<\/span>/);
});

test('side panel exposes an explicit full-view handoff', () => {
  const html = read('extension/sidepanel.html');
  const js = read('extension/sidepanel.js');
  const css = read('extension/sidepanel.css');
  assert.match(html, /id="openFullViewButton"/);
  assert.match(html, /<button id="openFullViewButton"[^>]*type="button"/);
  assert.match(html, /id="openFullViewButton"[\s\S]*class="web-view-icon"/);
  assert.match(html, /id="newSessionButton"[\s\S]*id="openFullViewButton"[\s\S]*id="settingsButton"[\s\S]*id="connectionPill"/);
  assert.match(js, /buildFullTabHandoffUrl/);
  assert.match(js, /openHermesFullView/);
  assert.match(read('extension/background.js'), /HERMES_OPEN_FULL_VIEW/);
  assert.match(read('extension/background.js'), /chrome\.tabs\.create/);
  assert.match(css, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto auto auto/);
  assert.doesNotMatch(css, /\.session-menu-button\s*\{[^}]*max-width:/s);
  assert.match(js, /newChat:\s*true/);
});

test('Extension Web icon opens a clean Hermes Web draft instead of restoring a Browser session', () => {
  const js = read('extension/app.js');
  const html = read('extension/app.html');
  assert.match(js, /handoff\.newChat\s*\?\s*''\s*:\s*\(activeSessionId\s*\|\|\s*settings\.webSessionId/);
  assert.match(js, /if\s*\(handoff\.newChat\)\s*await beginHermesWebDraft/);
  assert.doesNotMatch(js, /activeSessionId\s*\|\|=\s*settings\.sessionId/);
  assert.match(html, /This draft will create a new Hermes Web session when you send\./);
  assert.doesNotMatch(html, /This full view is attached to the same session as the side panel\./);
});

test('Hermes Web loading stays visible across themes and does not serialize independent startup work', () => {
  const css = read('extension/app.css');
  const js = read('extension/app.js');
  const loadApp = js.match(/async function loadApp\(\)\s*\{([\s\S]*?)\n\}\n\nfunction setInspectorTab/)?.[1] || '';
  const beginDraft = js.match(/async function beginHermesWebDraft\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(css, /\.loading-rail span\s*\{[^}]*background:\s*var\(--hermes-ink\);[^}]*animation:\s*web-loading-scan/s);
  assert.match(css, /@keyframes\s+web-loading-scan/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.loading-rail span\s*\{[^}]*animation:\s*none;/s);
  assert.match(loadApp, /const metadataPromise = Promise\.all\(\[/);
  assert.ok(
    loadApp.indexOf("if (handoff.newChat) await beginHermesWebDraft();") < loadApp.indexOf('await metadataPromise;'),
    'a clean Web handoff should paint its draft before waiting for model, skill, and session metadata',
  );
  assert.match(beginDraft, /const persistDraft = chrome\.storage\.local\.set/);
  assert.ok(
    beginDraft.indexOf('els.loadingState.hidden = true;') < beginDraft.indexOf('await persistDraft;'),
    'draft UI should paint before local settings persistence completes',
  );
});

test('side-panel context chip stays compact while the menu owns accurate compaction details', () => {
  const html = read('extension/sidepanel.html');
  const js = read('extension/sidepanel.js');
  const render = js.match(/function renderContextWindow\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(html, /id="contextRuntimeBreakdown"/);
  assert.match(render, /contextRuntimeBreakdown\.innerHTML/);
  assert.match(render, /compaction\.compressionCountKnown\s*\?\s*formatNumber\(compaction\.compressionCount\)\s*:\s*'Not reported by Hermes'/);
  assert.match(render, /contextAccountingSnapshot\(\{[\s\S]*?session,/);
  assert.match(render, /const runtime = activeSessionRuntime\.sessionId === settings\.sessionId/);
  assert.match(render, /contextCompactionState\(\{ accounting, runtime, session \}\)/);
  assert.ok(
    render.indexOf('const session = availableSessions') < render.indexOf('const accounting = contextAccountingSnapshot'),
    'persisted session telemetry must be resolved before context accounting',
  );
  assert.match(render, /contextCompactLabel\.textContent\s*=\s*meter\.compactLabel/);
  assert.doesNotMatch(render, /contextCompactLabel\.textContent[^;]*compacts/);
  assert.match(render, /contextCompactButton\.hidden\s*=\s*!controls\.canCompact/);
  assert.match(render, /Auto-compact trigger/);
  assert.match(render, /Compactions/);
  assert.match(render, /Telemetry source/);
});

test('full-tab rail centers a theme-aware spinning globe while the Nous girl lives in the top brand cell', () => {
  const html = read('extension/app.html');
  const css = read('extension/app.css');
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.match(html, /class="rail-globe-viewport"[\s\S]*class="rail-brand-video"/);
  assert.match(html, /assets\/video\/nous-hand-world\.webm/);
  assert.match(html, /class="web-brand-girl"[^>]*assets\/img\/hermes-badge\.webp/);
  assert.doesNotMatch(html, /class="rail-girl-badge"/);
  assert.match(html, /autoplay muted loop playsinline/);
  assert.match(css, /\.rail-globe-viewport\s*\{[^}]*left:\s*50%;[^}]*height:\s*76px;[^}]*overflow:\s*hidden;[^}]*translateX\(-50%\)/s);
  assert.match(css, /\.rail-brand-video\s*\{[^}]*width:\s*110px;[^}]*height:\s*auto/s);
  assert.match(css, /\.session-rail::before\s*\{[^}]*hermes-browser-web-horizon-ink\.png[^}]*mix-blend-mode:\s*normal;/s);
  assert.match(read('extension/fulltab-themes.css'), /data-hermes-theme="ember"[^}]*rail-brand-video[^}]*filter:/s);
  assert.match(manifest.content_security_policy.extension_pages, /media-src 'self'/);
});

test('full-tab scroll surfaces reuse the side-panel custom scrollbar treatment', () => {
  const css = `${read('extension/app.css')}\n${read('extension/app-parity.css')}`;
  assert.match(css, /\.session-list[\s\S]*\.conversation-scroll[\s\S]*\.inspector[\s\S]*::-webkit-scrollbar\s*\{\s*width:\s*8px/);
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*rgba\(var\(--hermes-fg-rgb\),\s*0\.45\)[^}]*border:\s*1px solid var\(--hermes-line-strong\)/s);
  assert.match(css, /scrollbar-gutter:\s*stable/);
  assert.doesNotMatch(css, /::-webkit-scrollbar-track/);
});

test('full-tab Hermes Web is writable and exposes model, stream, tool, and image runtime surfaces', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = read('extension/app.css');
  assert.match(html, /id="modelPickerButton"/);
  assert.match(html, /id="modelPicker"/);
  assert.match(html, /id="fullTabPrompt"[^>]*placeholder="Ask Hermes/);
  assert.doesNotMatch(html, /id="fullTabPrompt"[^>]*disabled/);
  assert.match(html, /id="fullTabSend"/);
  assert.match(html, /id="toolActivityList"/);
  assert.match(js, /\/chat\/stream/);
  assert.match(read('extension/lib/model-discovery.mjs'), /\/api\/model\/options/);
  assert.match(js, /\/model/);
  assert.match(js, /readHermesSse/);
  assert.match(js, /extractMediaTags/);
  assert.doesNotMatch(css, /\.fulltab-composer\s*\{[^}]*box-shadow:/s);
});

test('full-tab chat hierarchy is compact and exposes useful Hermes controls instead of dead cards', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = read('extension/app.css');
  assert.doesNotMatch(html, /class="conversation-header"/);
  assert.match(html, /class="truth-control static session-truth"/);
  assert.match(html, /id="copySessionId"/);
  assert.match(html, /id="settingsButton"/);
  assert.match(html, /id="settingsDialog"/);
  assert.match(html, /id="quickAttach"/);
  assert.match(html, /id="quickVoice"/);
  assert.match(html, /id="quickModel"/);
  assert.doesNotMatch(html, /COMING NEXT/);
  assert.match(html, /id="attachmentInput"/);
  assert.match(html, /id="attachmentList"/);
  assert.match(html, /id="voiceButton"/);
  assert.match(html, /id="queueDraft"/);
  assert.match(html, /id="steerDraft"/);
  assert.match(js, /\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}\/steer/);
  assert.match(js, /onRun:\s*\(runId\)/);
  assert.match(js, /VOICE_DRAFT_STORAGE_KEY/);
  assert.match(js, /settings\.webAppearanceTheme\s*\|\|\s*'nous'/);
  assert.match(js, /settings\.webColorMode\s*\|\|\s*'light'/);
  assert.match(js, /function applyAndPersistAppearance\(\)/);
  assert.match(js, /applyAndPersistAppearance\(\)/);
  assert.match(js, /innerWidth <= 1439[\s\S]*inspector-closed/);
  assert.match(html, /href="fulltab-themes\.css"/);
  assert.match(html, /id="settingsThemeGrid"/);
  assert.match(html, /class="rail-globe-viewport"/);
  assert.doesNotMatch(html, /Hermes Blue|Monochrome/);
  assert.match(css, /\.empty-state h2\s*\{[^}]*clamp\([^;]*56px/s);
  assert.match(css, /\.quick-actions\s*\{[^}]*margin-bottom:\s*clamp\(24px/s);
});

test('supplied Hermes Web and Agent vector logos are wired to their respective surfaces', () => {
  const app = read('extension/app.html');
  const panel = read('extension/sidepanel.html');
  const panelCss = read('extension/sidepanel.css');
  assert.match(app, /assets\/img\/hermes-web-logo-white-dark\.svg/);
  assert.match(panel, /class="brand-mini-mark"/);
  assert.match(panelCss, /hermes-agent-logo\.svg/);
  assert.match(app, /class="web-brand-girl"/);
  assert.doesNotMatch(read('extension/assets/img/ray-field.svg'), />HERMES<\/text>/);
});

test('full-tab uses extension-style grouped model, attachment, collapsible sessions, and voice-return controls', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = read('extension/app.css');
  const voicePage = read('extension/voice-dictation.js');

  assert.match(html, /id="modelProviderList"/);
  assert.match(js, /selectedModelProvider/);
  assert.match(js, /function groupModelsForPicker/);
  assert.match(html, /id="attachMenu"/);
  assert.match(html, /id="imageAttachmentInput"/);
  assert.match(html, /data-attach="paste-image"/);
  assert.match(js, /function toggleAttachMenu/);
  assert.match(html, /id="railVisibilityToggle"/);
  assert.doesNotMatch(html, /id="railPrivacyToggle"/);
  assert.doesNotMatch(js, /webSessionsRedacted|Private session/);
  assert.match(js, /webSessionsVisible/);
  assert.match(css, /\.web-shell\.sessions-hidden/);
  assert.match(html, /class="composer-icon composer-mic"/);
  assert.match(js, /function consumePendingVoiceDraft/);
  assert.match(voicePage, /await chrome\.storage\.local\.set\(\{ \[VOICE_DRAFT_STORAGE_KEY\]: payload \}\)/);
});

test('full-tab sessions use canonical source groups and a gateway-backed rename action', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = `${read('extension/app.css')}\n${read('extension/app-parity.css')}`;

  assert.match(js, /groupSessionsForMenu/);
  assert.match(js, /shouldAutoOpenSessionGroup/);
  assert.match(js, /const openSessionGroups = new Set\(\)/);
  assert.match(js, /function renameHermesWebSessionTitle/);
  assert.match(js, /method:\s*'PATCH'/);
  assert.match(js, /HERMES_WEB_SESSION_SOURCE\s*=\s*'hermes_web'/);
  assert.match(js, /source:\s*HERMES_WEB_SESSION_SOURCE/);
  assert.match(js, /className = `session-group-toggle/);
  assert.match(css, /\.session-group-toggle/);
  assert.match(html, /id="copySessionId"[^>]*aria-label="Session actions"/);
  assert.match(js, /function toggleSessionActionsMenu/);
});

test('full-tab composer has Web-native commands, no dead preview state, and native image or file paste/drop', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = `${read('extension/app.css')}\n${read('extension/app-parity.css')}`;

  assert.match(html, /id="commandMenuButton"/);
  assert.match(html, /id="skillMenu"/);
  assert.doesNotMatch(html, /id="draftPreview"/);
  assert.doesNotMatch(html, />\s*Preview\s*</i);
  assert.doesNotMatch(html, />\s*Ready\s*</i);
  assert.match(js, /\/v1\/skills/);
  assert.match(js, /skillSuggestionsForInput/);
  assert.match(js, /WEB_COMMANDS/);
  assert.match(js, /webComposerSuggestionMode/);
  assert.match(js, /mode === 'commands'/);
  assert.match(js, /mode === 'typed'/);
  assert.match(js, /runWebCommand/);
  assert.match(js, /visibleSkills/);
  assert.match(js, /handleComposerPaste/);
  assert.match(js, /handleComposerDrop/);
  assert.match(js, /dataTransfer/);
  assert.match(css, /\.skill-menu/);
  assert.match(css, /\.fulltab-composer\.drop-active/);
});

test('full-tab keeps live run state out of the transcript until Hermes has content, with context and artifact surfaces', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = `${read('extension/app.css')}\n${read('extension/app-parity.css')}`;

  assert.match(html, /id="contextWindowMeter"/);
  assert.match(html, /id="contextWindowDetail"/);
  assert.match(js, /contextAccountingSnapshot/);
  assert.match(js, /contextMeterDisplay/);
  assert.match(js, /createDiffusionCanvas/);
  assert.match(js, /function renderLiveRun/);
  assert.match(js, /thinkingIndicatorMarkup/);
  assert.match(js, /function renderArtifactCard/);
  assert.match(js, /filename:\s*artifact\.name/);
  assert.doesNotMatch(js, /\(empty message\)/i);
  assert.match(css, /\.web-live-run/);
  assert.match(css, /\.web-live-run \.thinking-indicator/);
  assert.match(css, /\.artifact-card/);
});

test('full-tab keeps model and message controls readable and visibly responsive on every theme', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = `${read('extension/app.css')}\n${read('extension/app-parity.css')}\n${read('extension/fulltab-themes.css')}`;

  assert.match(html, /class="rail-agent-avatar"/);
  assert.match(css, /mask-image:\s*url\("assets\/img\/nous-girl-solo-logo\.png"\)/);
  assert.match(css, /\.model-provider-list::-webkit-scrollbar/);
  assert.match(css, /\.model-list::-webkit-scrollbar/);
  assert.match(css, /\.model-refreshing/);
  assert.match(js, /setModelRefreshState/);
  assert.match(js, /settingsDialog\.addEventListener\('click'/);
  assert.match(css, /\.web-message\.user\s*\{[^}]*align-self:\s*flex-end/s);
  assert.match(css, /\.web-message\.user\s*\{[^}]*border-color:\s*var\(--hermes-white\)/s);
  assert.match(css, /\.web-message\.assistant\s*\{[^}]*align-self:\s*flex-start/s);
  assert.match(css, /\.fulltab-composer textarea::placeholder\s*\{[^}]*color:/s);
  assert.doesNotMatch(html, /<span>\s*Model\s*<\/span>/i);
  assert.match(css, /\.composer-runtime-control\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.doesNotMatch(css, /\.composer-runtime-control\s*>\s*span/);
  assert.match(css, /--fulltab-content-size:\s*19px/);
  assert.match(css, /font:\s*var\(--fulltab-content-size\)\/1\.62/);
  assert.doesNotMatch(read('extension/fulltab-themes.css'), /html\[data-hermes-theme\]\[data-hermes-mode\]\s*\{[^}]*--fulltab-content-size/);
  assert.doesNotMatch(css, /(?:^|[;{\s])zoom\s*:/m);
  assert.match(read('extension/app-parity.css'), /\.rail-agent-card > \.rail-agent-avatar\s*\{[^}]*background:\s*var\(--hermes-white\)/s);
});

test('full-tab applies provider-specific logo accents and terminal cyberpunk typography', () => {
  const css = read('extension/fulltab-themes.css');
  const appCss = read('extension/app.css');
  const parityCss = read('extension/app-parity.css');
  const markup = read('extension/app.html');
  const sharedLogo = read('extension/assets/img/hermes-web-logo-white-dark.svg');
  const nousLightLogoPath = path.join(root, 'extension/assets/img/hermes-web-logo-nous-light.svg');
  const nousLightLogo = fs.existsSync(nousLightLogoPath) ? fs.readFileSync(nousLightLogoPath, 'utf8') : '';
  const cyberpunkLightLogoPath = path.join(root, 'extension/assets/img/hermes-web-logo-cyberpunk-light.svg');
  const cyberpunkLightLogo = fs.existsSync(cyberpunkLightLogoPath) ? fs.readFileSync(cyberpunkLightLogoPath, 'utf8') : '';
  assert.match(css, /--hermes-logo-filter/);
  assert.match(css, /html\[data-hermes-theme="mono"\]\s*\{\s*--hermes-logo-filter:\s*grayscale\(1\) brightness\(10\) contrast\(1\.3\);/);
  assert.doesNotMatch(css, /web-brand-logo-mono/);
  assert.doesNotMatch(markup, /web-brand-logo-mono/);
  assert.match(sharedLogo, /\.cls-5\s*\{\s*fill:\s*#0000f2;/);
  assert.match(sharedLogo, /\.cls-3\s*\{\s*fill:\s*#0000d3;/);
  assert.match(sharedLogo, /\.cls-2\s*\{\s*fill:\s*#0000a8;/);
  assert.match(sharedLogo, /\.cls-6\s*\{\s*fill:\s*#000089;/);
  assert.match(sharedLogo, /\.cls-4\s*\{\s*fill:\s*#000060;/);
  assert.ok(fs.existsSync(nousLightLogoPath));
  assert.match(markup, /<img class="web-brand-logo web-brand-logo-nous-light" src="assets\/img\/hermes-web-logo-nous-light\.svg" alt="" aria-hidden="true" \/>/);
  assert.match(css, /\.web-brand-logo-nous-light\s*\{\s*display:\s*none;/);
  assert.match(css, /html\[data-hermes-theme="nous"\]\[data-hermes-mode="light"\]\s+\.web-brand-logo-base\s*\{\s*display:\s*none;/);
  assert.match(css, /html\[data-hermes-theme="nous"\]\[data-hermes-mode="light"\]\s+\.web-brand-logo-nous-light\s*\{\s*display:\s*block;\s*filter:\s*none;/);
  assert.match(nousLightLogo, /\.cls-5\s*\{\s*fill:\s*#000060;/);
  assert.match(nousLightLogo, /\.cls-3\s*\{\s*fill:\s*#000089;/);
  assert.match(nousLightLogo, /\.cls-2\s*\{\s*fill:\s*#0000a8;/);
  assert.match(nousLightLogo, /\.cls-6\s*\{\s*fill:\s*#0000d3;/);
  assert.match(nousLightLogo, /\.cls-4\s*\{\s*fill:\s*#0000f2;/);
  assert.ok(fs.existsSync(cyberpunkLightLogoPath));
  assert.match(markup, /<img class="web-brand-logo web-brand-logo-cyberpunk-light" src="assets\/img\/hermes-web-logo-cyberpunk-light\.svg" alt="" aria-hidden="true" \/>/);
  assert.match(css, /\.web-brand-logo-cyberpunk-light\s*\{\s*display:\s*none;/);
  assert.match(css, /html\[data-hermes-theme="cyberpunk"\]\[data-hermes-mode="light"\]\s+\.web-brand-logo-base\s*\{\s*display:\s*none;/);
  assert.match(css, /html\[data-hermes-theme="cyberpunk"\]\[data-hermes-mode="light"\]\s+\.web-brand-logo-cyberpunk-light\s*\{\s*display:\s*block;\s*filter:\s*none;/);
  assert.match(cyberpunkLightLogo, /\.logo-text\s*\{\s*fill:\s*#003d1f;/);
  assert.match(cyberpunkLightLogo, /\.cls-5\s*\{\s*fill:\s*#075b2d;/);
  assert.match(cyberpunkLightLogo, /\.cls-3\s*\{\s*fill:\s*#159447;/);
  assert.match(cyberpunkLightLogo, /\.cls-2\s*\{\s*fill:\s*#39c96b;/);
  assert.match(cyberpunkLightLogo, /\.cls-6\s*\{\s*fill:\s*#72e39a;/);
  assert.match(cyberpunkLightLogo, /\.cls-4\s*\{\s*fill:\s*#b5f5c8;/);
  assert.doesNotMatch(parityCss, /web-brand-logo-bars/);
  assert.doesNotMatch(markup, /web-brand-logo-bars/);
  assert.match(css, /data-hermes-theme="cyberpunk"[\s\S]*--hermes-font-display/);
  assert.match(css, /html\[data-hermes-theme="cyberpunk"\]\s*\{[^}]*--hermes-logo-filter:\s*hue-rotate\(240deg\) saturate\(1\.7\)/s);
  assert.match(css, /data-hermes-theme="cyberpunk"[\s\S]*\.web-message-content/);
  assert.match(appCss, /\.web-brand-logo\s*\{[^}]*filter:\s*var\(--hermes-logo-filter/s);
});

test('background worker opens only the extension-owned Hermes Web URL', async () => {
  const previousChrome = globalThis.chrome;
  let messageListener = null;
  let createdUrl = '';
  const event = (capture) => ({ addListener(listener) { capture?.(listener); } });
  globalThis.chrome = {
    runtime: {
      getURL: (assetPath) => `chrome-extension://hermes-test/${assetPath}`,
      getManifest: () => ({ side_panel: { default_path: 'sidepanel.html' } }),
      onInstalled: event(),
      onStartup: event(),
      onMessage: event((listener) => { messageListener = listener; }),
    },
    action: { onClicked: event(), setPopup: async () => {} },
    tabs: {
      create: async ({ url }) => { createdUrl = url; },
      query: async () => [],
      onActivated: event(),
    },
    storage: { local: { get: async () => ({}) }, onChanged: event() },
    sidePanel: {},
  };

  try {
    await import(`../extension/background.js?fulltab-open=${Date.now()}`);
    assert.equal(typeof messageListener, 'function');
    const response = await new Promise((resolve) => {
      const asyncResponse = messageListener({
        type: 'HERMES_OPEN_FULL_VIEW',
        url: 'chrome-extension://hermes-test/app.html?sessionId=session-1',
      }, {}, resolve);
      assert.equal(asyncResponse, true);
    });
    assert.deepEqual(response, { ok: true });
    assert.equal(createdUrl, 'chrome-extension://hermes-test/app.html?sessionId=session-1');

    const rejected = await new Promise((resolve) => {
      messageListener({ type: 'HERMES_OPEN_FULL_VIEW', url: 'https://example.com/app.html' }, {}, resolve);
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /Refused to open/);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test('full-tab app adds only the downloads permission required for explicit artifact delivery', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.chrome_url_overrides, undefined);
  assert.equal(manifest.permissions.includes('downloads'), true);
  assert.equal(manifest.permissions.includes('debugger'), false);
  assert.equal(manifest.permissions.includes('nativeMessaging'), false);
  assert.equal(manifest.permissions.includes('cookies'), false);
});

test('verification and build scripts include the full-tab modules', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['check:js'], /extension\/app\.js/);
  assert.match(packageJson.scripts['check:js'], /surface-protocol\.mjs/);
  assert.match(packageJson.scripts['check:js'], /hermes-client\.mjs/);
  assert.match(packageJson.scripts['check:js'], /web-commands\.mjs/);
  assert.match(packageJson.scripts['check:js'], /web-artifacts\.mjs/);
});

test('Hermes Web keeps model and runtime controls in the composer and defers empty chats until their first turn', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = read('extension/app.css');

  assert.match(html, /id="composerModelControl"/, 'the active model needs a visible composer control');
  assert.match(html, /id="composerModelName"/, 'the composer control needs a model label');
  assert.match(html, /id="composerRuntimeMeta"/, 'the composer control needs a reasoning/fast summary');
  assert.match(js, /function toggleModelPicker\(/, 'all model controls should toggle the one canonical picker');
  assert.match(js, /els\.composerModelControl\?\.addEventListener\('click', \(\) => toggleModelPicker\(\)\)/, 'a second composer click should close the picker');
  assert.match(js, /function beginHermesWebDraft\(/, 'New Chat must start locally without persisting a blank session');
  assert.match(js, /els\.newChatButton\.addEventListener\('click', \(\) => beginHermesWebDraft\(/, 'New Chat should create a draft, not a server row');
  assert.doesNotMatch(js, /els\.newChatButton\.addEventListener\('click', \(\) => createSession\(/, 'New Chat must not create an empty server session');
  assert.match(css, /\.composer-runtime-control/, 'the composer control needs dedicated on-brand styling');
});

test('composer places its smaller online indicator beside CHAT and keeps model details legible', () => {
  const html = read('extension/app.html');
  const css = read('extension/app.css');

  assert.match(html, /class="composer-chat-label"[\s\S]*class="read-only-indicator online"[\s\S]*CHAT/, 'the composer status dot should live beside CHAT');
  assert.doesNotMatch(html, /class="composer-state">\s*<span class="read-only-indicator/, 'the status dot should not compete with the model control');
  assert.match(css, /\.read-only-indicator\s*\{[^}]*width:\s*5px;[^}]*height:\s*5px;/s, 'the relocated dot should be smaller');
  assert.match(css, /\.composer-runtime-control strong\s*\{[^}]*font:\s*(?:[^;]*\s)?11px\//s, 'the model name should use a readable 11px line');
  assert.match(css, /\.composer-runtime-control small\s*\{[^}]*font:\s*(?:[^;]*\s)?9px\//s, 'runtime metadata should use a readable 9px line');
});

test('Hermes Web keeps status beside the model, preserves light Cyberpunk, and uses theme-safe model search fields', () => {
  const html = read('extension/app.html');
  const js = read('extension/app.js');
  const css = `${read('extension/app.css')}\n${read('extension/app-parity.css')}`;
  const themes = read('extension/fulltab-themes.css');

  assert.match(html, /class="composer-state"[\s\S]*id="composerStatus"[\s\S]*id="composerModelControl"[\s\S]*id="voiceButton"/, 'transient status should sit immediately before the model control');
  assert.doesNotMatch(js, /theme\s*===\s*'cyberpunk'[^\n]*colorMode\s*=\s*'dark'/, 'Cyberpunk must preserve the selected color mode');
  assert.match(themes, /html\[data-hermes-theme="cyberpunk"\]\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-blue:\s*#eaffef[^}]*--hermes-ink:\s*#005e25[^}]*--hermes-font-ui:\s*"JetBrainsMono"/s, 'Cyberpunk Light should match the Extension phosphor-paper palette and terminal typography');
  assert.match(themes, /html\[data-hermes-theme="cyberpunk"\]\[data-hermes-mode="dark"\]\s*\{[^}]*--hermes-blue:\s*#001004[^}]*--hermes-paper:\s*#001b08[^}]*--hermes-ink:\s*#12ff68/s, 'approved Cyberpunk Dark tokens must stay unchanged');
  assert.match(css, /\.model-picker input\s*\{[^}]*background:\s*var\(--hermes-field-bg\)[^}]*color:\s*var\(--hermes-field-fg\)/s);
  assert.match(css, /\.model-picker input::placeholder\s*\{[^}]*color:\s*var\(--hermes-field-placeholder\)/s);
  assert.match(js, /models loaded and synced/, 'refresh feedback should include the actual loaded model count');
});

test('Hermes Web hydrates context telemetry per selected session and does not leak the previous session runtime', () => {
  const js = read('extension/app.js');
  assert.match(js, /runtimeTelemetryForSession\(session\)/);
  assert.match(js, /latestRuntime\s*=\s*runtimeTelemetryForSession\(session\)/);
  assert.match(js, /contextCompactionState\(/);
  assert.match(js, /thresholdTokens/);
  assert.match(js, /compressionCount/);
});

test('sidepanel primary Connect and Test use one explicit connection-mode dispatch contract', () => {
  const js = read('extension/sidepanel.js');
  const html = read('extension/sidepanel.html');
  assert.match(js, /connectionActionForSettings\(settings\)/);
  assert.match(js, /CLOUD_ACTIVE_TAB_ATTACH/);
  assert.match(js, /connectTicketTransport\(\{\s*cloud:\s*true\s*\}\)/);
  assert.match(html, /Hermes Cloud Preview/);
  assert.match(js, /async function connectApiWithPairing\(\)[\s\S]*?transportUsesDashboardTicket\(settings\.connectionTransport\)/, 'the Local/Remote API connector must reject ticket transports before URL normalization');
  assert.match(js, /sanitizeGatewayUrlForConnectionMode\(/, 'Cloud persistence must remove loopback and inherited Local URLs');
});
