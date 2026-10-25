import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('check:js syntax-checks the custom theme and VS Code converter modules', () => {
  const packageJson = JSON.parse(read('package.json'));
  const checkJs = packageJson.scripts?.['check:js'] || '';
  for (const modulePath of [
    'extension/lib/custom-themes.mjs',
    'extension/lib/custom-theme-store.mjs',
    'extension/lib/agent-theme-authoring.mjs',
    'extension/lib/vscode-theme-convert.mjs',
    'extension/lib/vsix-theme-extractor.mjs',
    'extension/lib/vscode-marketplace.mjs',
    'extension/lib/theme-marketplace-controller.mjs',
  ]) {
    assert.match(checkJs, new RegExp(`node --check ${modulePath.replaceAll('.', '\\.')}(?:\\s|$)`), `${modulePath} must be part of check:js`);
  }
});

test('side panel exposes an explicit full-view handoff', () => {
  const html = read('extension/sidepanel.html');
  const js = read('extension/sidepanel.js');
  const css = read('extension/sidepanel.css');
  assert.match(html, /id="openFullViewButton"/);
  assert.match(html, /<button id="openFullViewButton"[^>]*type="button"/);
  assert.match(html, /id="openFullViewButton"[\s\S]*class="web-view-icon"/);
  assert.match(html, /id="newSessionButton"[\s\S]*id="openFullViewButton"[\s\S]*id="settingsButton"/);
  assert.doesNotMatch(html, /connectionPill|topbar-status/, 'the top bar carries no connection light; Settings owns connection state');
  // The button opens the Webapp the user's gateway serves (see hermes-webapp-panel.test.mjs), not the
  // extension's own full tab, and says so in a dialog when it is not running.
  assert.match(html, /id="webappDialog"/);
  assert.match(html, /webapp\.open_title/);
  assert.match(js, /openFullViewButton\?\.addEventListener\('click', \(\) => \{\s*void openHermesWeb\(\);/);
  assert.doesNotMatch(js, /buildFullTabHandoffUrl|openHermesFullView/);
  // The extension's own full tab has no opener left in the background worker.
  assert.doesNotMatch(read('extension/background.js'), /HERMES_OPEN_FULL_VIEW|openHermesFullView|app\.html/);
  assert.match(css, /\.topbar\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;/s, 'topbar must lay out as a single-row flex bar');
  assert.match(css, /\.topbar \.session-menu-button\s*\{\s*flex:\s*1 1 auto;\s*min-width:\s*0;\s*\}/, 'session name must take the remaining topbar space');
  assert.doesNotMatch(css, /topbar-status|connection-pill/, 'the connection light and its styles are gone from the top bar');
  assert.doesNotMatch(css, /\.session-menu-button\s*\{[^}]*max-width:/s);
});

test('side panel keeps Browser onboarding, refresh feedback, updates, and message translucency intentional', () => {
  const html = read('extension/sidepanel.html');
  const css = read('extension/sidepanel.css');
  const js = read('extension/sidepanel.js');
  const updateFlow = read('extension/lib/update-flow.mjs');
  const buildScript = read('scripts/build.mjs');
  const refreshModels = js.match(/async function refreshModelsFromMenu\(\)[\s\S]*?\n\}/)?.[0] || '';
  const refreshSessions = js.match(/async function refreshSessionsFromMenu\(\)[\s\S]*?\n\}/)?.[0] || '';
  const checkUpdates = js.match(/async function checkForUpdates\([^)]*\)[\s\S]*?\n\}/)?.[0] || '';
  const renderEmpty = js.match(/function renderEmptyState\(\)[\s\S]*?\n\}/)?.[0] || '';

  assert.match(css, /\.message\.user\s*\{[^}]*color-mix\([^}]*var\(--hermes-bubble-user-alpha\),\s*transparent/s);
  assert.match(css, /\.message\.assistant\s*\{[^}]*color-mix\([^}]*var\(--hermes-bubble-assistant-alpha\),\s*transparent/s);
  assert.match(css, /--hermes-bubble-user-alpha:\s*100%/);
  assert.match(css, /--hermes-bubble-assistant-alpha:\s*100%/);
  assert.match(css, /backdrop-filter:\s*blur\(/);
  assert.match(html, /class="release-sidecar"/);
  assert.match(html, /LOCAL SIDECAR \/ CHROME PANEL/);
  assert.match(html, /id="reviewUpdateButton"/);
  assert.match(html, /id="updateDialog"/);
  assert.match(html, /class="update-dialog-mark"\s+aria-hidden="true"/);
  assert.match(html, /id="operationToast"/);
  assert.match(html, /id="sessionRefreshIcon"/);
  assert.match(html, /id="refreshSessionsLabel"/);
  assert.match(css, /\.update-dialog/);
  assert.match(css, /\.update-dialog-mark\s*\{[^}]*hermes-browser-extension-icon-box-white\.png[^}]*background:\s*var\(--hermes-fg\)/s);
  assert.match(css, /html\[data-hermes-theme="nous"\]\[data-hermes-mode="light"\]\s+\.update-dialog-mark\s*\{[^}]*background:\s*var\(--hermes-ink\)/s);
  assert.equal(fs.existsSync(path.join(root, 'extension/assets/img/hermes-browser-extension-icon-box-white.png')), true);
  assert.match(css, /\.operation-toast/);
  assert.match(css, /\.release-sidecar\s*\{[^}]*background-blend-mode:\s*normal,\s*luminosity,\s*normal/s);
  assert.doesNotMatch(css, /\.release-sidecar::before/);
  assert.match(css, /\.operation-toast\s*\{(?=[^}]*left:\s*50%)(?=[^}]*right:\s*auto)(?=[^}]*transform:\s*translateX\(-50%\))[^}]*\}/s);
  assert.match(css, /@keyframes operationToastIn\s*\{[\s\S]*translate\(-50%,\s*-10px\)[\s\S]*translate\(-50%,\s*0\)/);
  assert.match(css, /#refreshSessionsButton\.is-refreshing\s+\.session-refresh-icon\s*\{[^}]*animation:/s);
  assert.match(refreshModels, /showOperationToast\(/);
  assert.match(refreshSessions, /showOperationToast\(/);
  assert.match(checkUpdates, /renderVersionInfo\(status\)/);
  assert.doesNotMatch(checkUpdates, /showOperationToast\(/);
  assert.match(buildScript, /sourceBlobs/);
  assert.match(buildScript, /createHash\(['"]sha1['"]\)/);
  assert.match(buildScript, /hash-object/);
  assert.match(buildScript, /--filters/);
  assert.match(buildScript, /--path=/);
  assert.match(js, /async function fetchMainSourceBlobs/);
  assert.match(checkUpdates, /sourceBlobMapsMatch/);
  assert.match(checkUpdates, /buildInfo\?\.dirty/);
  assert.match(checkUpdates, /sourceMatchesMain/);
  assert.match(js, /payload\.behind_by/);
  assert.match(checkUpdates, /commitsAhead:\s*comparison\.commitsAhead/);
  assert.match(checkUpdates, /alignment:\s*comparison\.alignment/);
  assert.match(js, /review\.emptyMessage/);
  assert.match(js, /maybeLaterButton\.textContent\s*=\s*translateUiText\(review\.available/);
  assert.match(refreshSessions, /sessionsRefreshing\s*=\s*true/);
  assert.doesNotMatch(js, /positionOperationToast/);
  assert.match(js, /HERMES_BROWSER_INTRO_SEEN_STORAGE_KEY/);
  // The old first-run block is gone; an empty chat hands over to the setup flow.
  assert.doesNotMatch(renderEmpty, /THE PAGE IS THE PROMPT/);
  assert.match(renderEmpty, /maybeOpenOnboarding\(\)/);
  assert.match(js, /await persistBrowserIntroSeen\(\)/);
  assert.match(js, /function launchBrowserUpdateWithHermes/);
  assert.match(js, /function currentHermesBrowserSystemPrompt\(\)/);
  assert.ok((js.match(/currentHermesBrowserSystemPrompt\(\)/g) || []).length >= 6);
  // The prepared update prompt lives in lib/update-flow.mjs so the unit tests
  // assert the exact string the panel hands to the agent.
  assert.match(js, /buildUpdateAgentPrompt\(\{ review \}\)/);
  assert.match(updateFlow, /If the checkout has uncommitted changes, stop and report them/);
  assert.match(updateFlow, /run npm run build/);
  assert.match(js, /els\.composer\.requestSubmit\(\)/);
});

test('opening an old session paints an in-chat history loader before storage or network work', () => {
  const sidepanel = read('extension/sidepanel.js');
  const sidepanelCss = read('extension/sidepanel.css');
  const sidepanelOpen = sidepanel.match(/async function openHermesSession\(selectedSession\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

  assert.match(sidepanel, /function renderSessionHistoryLoading/);
  assert.match(sidepanelCss, /\.session-history-loading/);
  assert.match(sidepanelOpen, /const requestId = \+\+sessionLoadRequestId/);
  assert.ok(
    sidepanelOpen.indexOf('renderSessionHistoryLoading(session)') < sidepanelOpen.indexOf('await loadSessionMessages'),
    'the side panel should replace the previous transcript before session history starts loading',
  );
});

test('side-panel context chip stays compact while Settings owns accurate compaction details', () => {
  const html = read('extension/sidepanel.html');
  const js = read('extension/sidepanel.js');
  const render = js.match(/function renderContextWindow\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';

  // The popover is just the context card; the runtime rows sit under Settings > Details.
  assert.match(html, /<details class="context-window-details">[\s\S]*?id="settingsContextRuntime"/);
  assert.match(render, /renderContextDefinitionRows\(els\.settingsContextRuntime, runtimeRows\)/);
  assert.match(render, /compaction\.compressionCountKnown\s*\?\s*formatNumber\(compaction\.compressionCount\)\s*:\s*translateUiText\('Not reported by Hermes'\)/);
  assert.match(render, /contextAccountingSnapshot\(\{[\s\S]*?session,/);
  assert.match(render, /const runtime = activeSessionRuntime\.sessionId === settings\.sessionId/);
  assert.match(render, /contextCompactionState\(\{ accounting, runtime, session \}\)/);
  assert.ok(
    render.indexOf('const session = availableSessions') < render.indexOf('const accounting = contextAccountingSnapshot'),
    'persisted session telemetry must be resolved before context accounting',
  );
  assert.match(render, /contextCompactLabel\.textContent\s*=\s*meter\.compactLabel/);
  assert.doesNotMatch(render, /contextCompactLabel\.textContent[^;]*compacts/);
  // The control is drawn from the capability ledger, not hidden by a boolean: a disabled
  // button states the exact reason (REST-only, no authority, cached, ...).
  assert.match(render, /renderCompactControl\(\)/);
  const compactControl = js.match(/function renderCompactControl\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(compactControl, /capabilityRuntime\.verdict\('sessionCompress', \{ sessionId: settings\.sessionId \}\)/);
  assert.match(compactControl, /contextCompactButton\.disabled\s*=\s*view\.disabled/);
  assert.doesNotMatch(compactControl, /contextCompactButton\.hidden\s*=\s*!/);
  assert.match(render, /Auto-compact trigger/);
  assert.match(render, /Compactions/);
  assert.match(render, /Telemetry source/);
});

test('the supplied vector logo is wired to the side panel', () => {
  const panel = read('extension/sidepanel.html');
  const panelCss = read('extension/sidepanel.css');
  assert.match(panel, /class="brand-mini-mark"/);
  assert.match(panelCss, /hermes-wing-mark\.svg/);
  assert.doesNotMatch(read('extension/assets/img/ray-field.svg'), />HERMES<\/text>/);
});

test('the package declares only justified artifact and controller permissions', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.chrome_url_overrides, undefined);
  assert.equal(manifest.permissions.includes('downloads'), true);
  assert.equal(manifest.permissions.includes('debugger'), true);
  assert.equal(manifest.permissions.includes('nativeMessaging'), false);
  assert.equal(manifest.permissions.includes('cookies'), false);
});

test('check:js covers the shared surface, client, and appearance modules', () => {
  const packageJson = JSON.parse(read('package.json'));
  assert.match(packageJson.scripts['check:js'], /surface-protocol\.mjs/);
  assert.match(packageJson.scripts['check:js'], /hermes-client\.mjs/);
  assert.match(packageJson.scripts['check:js'], /appearance-preferences\.mjs/);
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
