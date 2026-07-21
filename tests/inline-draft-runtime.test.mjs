import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');

test('both manifests load the inline helper after extractor and content bridge', async () => {
  const [packaged, repository] = await Promise.all([
    read('extension/manifest.json').then(JSON.parse),
    read('manifest.json').then(JSON.parse),
  ]);
  assert.deepEqual(packaged.content_scripts[0].js, ['content-extractor.js', 'content.js', 'content-inline-helper.js']);
  assert.deepEqual(repository.content_scripts[0].js, ['extension/content-extractor.js', 'extension/content.js', 'extension/content-inline-helper.js']);
});

test('inline helper uses approved Hermes branding, routes sessions, and supports safe apply and undo', async () => {
  const source = await read('extension/content-inline-helper.js');
  assert.match(source, /const policy = globalThis\.HermesInlineDraft/);
  assert.match(source, /hermes-browser-extension-icon-ink\.png/);
  assert.doesNotMatch(source, /logoUrl[\s\S]{0,180}hermes-browser-extension-icon-box-white\.png/);
  assert.doesNotMatch(source, /nous-girl-solo-logo\.png/);
  assert.match(source, /maskImage|webkitMaskImage/);
  assert.doesNotMatch(source, /box-shadow\s*:/);
  assert.match(source, /width:32px; height:32px/);
  assert.match(source, /\.launcher \{[^}]*padding:0;/s);
  assert.match(source, /\.launcher-logo \{ width:30px; height:30px; \}/);
  assert.match(source, /\.brand-logo \{ width:42px; height:42px; \}/);
  assert.match(source, /--hb-logo', tokens\.logo/);
  assert.match(source, /chrome\.storage\.local\.get/);
  assert.match(source, /chrome\.storage\.onChanged/);
  assert.match(source, /inlineAssistEnabled/);
  assert.match(source, /inlineAssistDefaultRoute/);
  assert.match(source, /Use this choice next time/);
  assert.match(source, /change it anytime in Settings/i);
  assert.match(source, /Draft for this field/);
  assert.match(source, /isTargetVisible/);
  assert.match(source, /policy\.inlineLauncherPosition/);
  assert.match(source, /new globalThis\.ResizeObserver/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /visualViewport/);
  assert.match(source, /function onLauncherPointerDown\([^)]*\)\s*\{[\s\S]{0,240}preventDefault\(\)[\s\S]{0,120}stopPropagation\(\)/);
  assert.match(source, /function togglePanel\([^)]*\)\s*\{[\s\S]{0,360}panel\.hidden[\s\S]{0,180}hidePanel\(\)[\s\S]{0,180}openPanel\(\)/);
  assert.match(source, /launcher\.addEventListener\('pointerdown', onLauncherPointerDown\)/);
  assert.match(source, /launcher\.addEventListener\('click', togglePanel\)/);
  assert.match(source, /shadow\.addEventListener\('pointerdown', containAssistInteraction\)/);
  assert.match(source, /shadow\.addEventListener\('click', containAssistInteraction\)/);
  for (const keyboardEvent of ['keydown', 'keypress', 'keyup']) {
    assert.match(source, new RegExp(`shadow\\.addEventListener\\('${keyboardEvent}', containAssistInteraction\\)`));
  }
  const containmentBody = source.match(/function containAssistInteraction\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] || '';
  assert.match(containmentBody, /stopPropagation\(\)/);
  assert.doesNotMatch(containmentBody, /preventDefault\(\)/);
  assert.doesNotMatch(source, /launcher\.addEventListener\('click', openPanel\)/);
  assert.match(source, /\.launcher \{[^}]*z-index:2;/s);
  assert.match(source, /\.panel \{[^}]*z-index:1;/s);
  assert.match(source, /leftOfLauncher/);
  assert.match(source, /panelScrollSuspended/);
  assert.match(source, /panel\.style\.visibility\s*=\s*'hidden'/);
  assert.match(source, /hasUnresolvedInteraction/);
  assert.doesNotMatch(source, /if \(!panel\.hidden\) hidePanel\(\);/);
  assert.doesNotMatch(source, /Math\.max\(safe, Math\.min\(viewportHeight - 54, rect\.top/);
  assert.doesNotMatch(source, /launcher\.textContent\s*=\s*['"]H['"]/);
  assert.match(source, /Hermes Assist/);
  assert.match(source, /Continue current chat/);
  assert.match(source, /Start new Assist session/);
  assert.match(source, /Run in background/);
  assert.match(source, /HERMES_INLINE_SESSION_STATUS/);
  assert.match(source, /policy\.applyResult/);
  assert.match(source, /policy\.undoResult/);
  assert.match(source, /Keep replacement/);
  assert.match(source, /inlineDraftPrimaryActionLabel/);
  assert.match(source, /Open session/);
  assert.match(source, /Automatic replacement/);
  const sidepanelHtml = await read('extension/sidepanel.html');
  const appHtml = await read('extension/app.html');
  for (const html of [sidepanelHtml, appHtml]) {
    assert.match(html, /inlineAssistEnabled/);
    assert.match(html, /inlineAssistDefaultRoute/);
    assert.match(html, /id="inlineAssistModelButton"[^>]*\sdisabled(?:\s|>)/);
    assert.match(html, /Choose Assist model/);
    assert.match(html, /assistModelCapabilityHint/);
    assert.doesNotMatch(html, /inlineAssistRuntimeOptions/);
    assert.doesNotMatch(html, /<select id="inlineAssistModel"/);
    assert.match(html, /inlineAssistSessionRetention/);
    assert.match(html, /Delete after the draft returns/);
    assert.match(html, /Ask every time/);
    assert.match(html, /Run in background/);
  }
  assert.match(source, /current\.text\s*!==\s*pending\.draftText/);
  assert.doesNotMatch(source, /\.submit\s*\(|requestSubmit\s*\(/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});

test('settings surfaces preserve Assist model controls and explain exact-routing fallback', async () => {
  const [sidepanel, app] = await Promise.all([
    read('extension/sidepanel.js'),
    read('extension/app.js'),
  ]);
  for (const source of [sidepanel, app]) {
    assert.match(source, /assistModelRoutingSupported/);
    assert.match(source, /gateway default/i);
    assert.match(source, /inlineAssistModelButton\.disabled\s*=\s*false/);
    assert.doesNotMatch(source, /inlineAssistModelButton\.disabled\s*=\s*true/);
  }
});

test('Sidecar intro is panel-open-only and new session cannot reveal it again', async () => {
  const [html, source] = await Promise.all([
    read('extension/sidepanel.html'),
    read('extension/sidepanel.js'),
  ]);
  assert.match(html, /id="browserIntroHero"[^>]*aria-label="Hermes Browser intro"/);
  assert.match(source, /function renderBrowserIntroVisibility\(/);
  assert.match(source, /browserIntroHero/);
  assert.match(source, /newSessionButton\.addEventListener[\s\S]{0,500}await persistBrowserIntroSeen\(\);[\s\S]{0,300}await beginHermesBrowserDraft\(\);/);
  assert.match(source, /createSessionButton\.addEventListener[\s\S]{0,400}await persistBrowserIntroSeen\(\);[\s\S]{0,300}await beginHermesBrowserDraft\(\);/);
});

test('background queues sender-bound requests, exposes session status, and registers branded context menus', async () => {
  const source = await read('extension/background.js');
  const [packaged, repository] = await Promise.all([
    read('extension/manifest.json').then(JSON.parse),
    read('manifest.json').then(JSON.parse),
  ]);
  assert.match(source, /HERMES_INLINE_DRAFT_REQUEST/);
  assert.match(source, /HERMES_INLINE_SESSION_STATUS/);
  assert.match(source, /sender\?\.tab\?\.id/);
  assert.match(source, /runInlineDraftInServiceWorker/);
  assert.match(source, /\[INLINE_DRAFT_ROUTES\.BACKGROUND, INLINE_DRAFT_ROUTES\.NEW\]\.includes\(request\.route\)/);
  assert.match(source, /source: HERMES_ASSIST_SOURCE/);
  assert.match(source, /buildAssistModelRouteRequest/);
  assert.match(source, /normalizeGatewayCapabilities/);
  assert.match(source, /\/v1\/capabilities/);
  assert.match(source, /assertAssistModelSelectionAcknowledged/);
  assert.doesNotMatch(source, /createResponse\.status !== 409/);
  assert.match(source, /deleteUnacknowledgedAssistSession/);
  assert.match(source, /Cleanup also failed/);
  assert.match(source, /\.\.\.attemptRouteRequest/);
  assert.match(source, /assistModelFallbackNotice/);
  assert.match(source, /modelNotice/);
  assert.match(source, /inlineAssistSessionRetention === 'delete'/);
  assert.match(source, /new Date\(\)\.toISOString/);
  assert.match(source, /chrome\.storage\.session/);
  assert.match(source, /openHermesPanel\(sender\.tab\)/);
  assert.match(source, /expiresAt/);
  assert.match(source, /chrome\.contextMenus\.create/);
  assert.match(source, /Ask Hermes about this selection/);
  assert.match(source, /Improve selected text/);
  assert.match(source, /openHermesPanel\(tab, \{ allowFallback: false \}\)/);
  assert.match(source, /Strict side-panel open failed; refusing to open a fallback tab/);
  assert.match(source, /contextMenuDefaultRoute/);
  assert.match(source, /Explain selection/);
  assert.ok(packaged.permissions.includes('contextMenus'));
  assert.ok(repository.permissions.includes('contextMenus'));
});

test('sidepanel claims queued requests, honors current/new/background routing, and returns session metadata', async () => {
  const source = await read('extension/sidepanel.js');
  assert.match(source, /buildInlineDraftPrompt/);
  assert.match(source, /sanitizeInlineDraftResult/);
  assert.match(source, /request\.route\s*===\s*INLINE_DRAFT_ROUTES\.BACKGROUND/);
  assert.match(source, /request\.route\s*===\s*INLINE_DRAFT_ROUTES\.NEW/);
  assert.match(source, /createInlineBackgroundSession/);
  assert.match(source, /\{ ok: true, text, sessionId/);
  assert.match(source, /forceChatOnly:\s*true/);
  assert.match(source, /Hermes Assist options/);
  assert.match(source, /executeContextMenuRequest/);
  assert.match(source, /handleContextMenuRouteChoice/);
  assert.match(source, /askHermes\(userText/);
  assert.doesNotMatch(source, /Review the selected text and prompt, then send when ready/);
  assert.match(source, /HERMES_INLINE_DRAFT_RESULT/);
  assert.match(source, /documentId/);
  assert.match(source, /requestId/);
  assert.doesNotMatch(source, /HERMES_INLINE_DRAFT_RESULT[\s\S]{0,600}(?:tabs\.executeScript|scripting\.executeScript)/);
});

test('inline runtime wires semantic site profiles, persisted context controls, and obstacle-aware placement', async () => {
  const source = await read('extension/content-inline-helper.js');
  assert.match(source, /inspectInlineSite\?\.\(document,\s*candidate/);
  assert.match(source, /captureInlineSiteContext\?\.\(document,\s*target,\s*captureProfile\)/);
  assert.match(source, /hermesInlineSiteContextPreferences/);
  assert.match(source, /inlineLauncherPlacement/);
  assert.match(source, /obstacleRects/);
  assert.match(source, /launcher\.dataset\.placement/);
  assert.match(source, /DRAFT ONLY/);
  assert.match(source, /BOUNDED/);
  assert.match(source, /Preview \+ copy only/);
  assert.match(source, /applyMode:\s*supportsSafeApply\s*\?\s*['"]safe-apply['"]\s*:\s*['"]copy-only['"]/);
});

test('inline helper consumes each matching result request at most once', async () => {
  const source = await read('extension/content-inline-helper.js');
  assert.match(source, /let handledResultRequestId = ''/);
  assert.match(source, /message\.requestId === handledResultRequestId/);
  assert.match(source, /handledResultRequestId = message\.requestId/);
});

test('Hermes Assist scroll surfaces use the canonical sharp themed scrollbar', async () => {
  const source = await read('extension/content-inline-helper.js');
  assert.match(source, /\.panel, \.preview, \.custom \{ scrollbar-gutter:stable; \}/);
  assert.match(source, /\.panel::-webkit-scrollbar, \.preview::-webkit-scrollbar, \.custom::-webkit-scrollbar \{ width:8px; \}/);
  assert.match(source, /\.panel::-webkit-scrollbar-thumb, \.preview::-webkit-scrollbar-thumb, \.custom::-webkit-scrollbar-thumb \{ background:rgba\(var\(--hermes-fg-rgb\),0\.45\); border:1px solid var\(--hermes-line-strong\); \}/);
  assert.match(source, /--hermes-fg-rgb/);
  assert.match(source, /--hermes-line-strong/);
  const scrollbarBlock = source.match(/\.panel, \.preview, \.custom \{ scrollbar-gutter:stable; \}[\s\S]*?\.head \{/)?.[0] || '';
  assert.doesNotMatch(scrollbarBlock, /::-webkit-scrollbar-(?:track|button|corner)/);
  assert.doesNotMatch(scrollbarBlock, /scrollbar-(?:width|color)/);
  assert.doesNotMatch(scrollbarBlock, /border-radius/);
});
