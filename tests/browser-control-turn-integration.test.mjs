import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidepanel = readFileSync('extension/sidepanel.js', 'utf8');
const sidepanelHtml = readFileSync('extension/sidepanel.html', 'utf8');
const background = readFileSync('extension/background.js', 'utf8');
const common = readFileSync('extension/lib/common.mjs', 'utf8');

test('Browser turns resolve exact extension-controller authority before final typed serialization', () => {
  const ask = sidepanel.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const resolve = sidepanel.match(/async function resolveBrowserControlForTurn\([\s\S]*?\n\}/)?.[0] || '';
  const boundedResolve = sidepanel.match(/async function resolveBrowserControlCandidate\([\s\S]*?\n\}/)?.[0] || '';
  const targetIndex = ask.indexOf('const browserControl = await resolveBrowserControlForTurn');
  const finalConsentIndex = ask.indexOf('userText = String(await turnOptions.resolveUserText()');
  const serializeIndex = ask.indexOf('const prompt = serializeBrowserTurnEnvelope');
  assert.ok(targetIndex >= 0 && targetIndex < finalConsentIndex);
  assert.ok(finalConsentIndex >= 0 && finalConsentIndex < serializeIndex);
  assert.match(ask, /browserControl,/);
  assert.doesNotMatch(ask.slice(finalConsentIndex, serializeIndex), /await resolveBrowserControlForTurn/);
  assert.match(resolve, /resolveBrowserControlCandidate/);
  assert.match(boundedResolve, /document_not_ready/);
  assert.match(boundedResolve, /CONTROL_TARGET_READY_RETRY/);
});

test('right-click background turn resolves target before final consent refresh and serializes with no later async gap', () => {
  const route = sidepanel.match(/async function executeContextMenuRequest\([\s\S]*?\n\}/)?.[0] || '';
  const targetIndex = route.indexOf('const browserControl = await resolveBrowserControlForTurn');
  const consentIndex = route.indexOf('const sendTimeSettings = await refreshContextConsentLedger');
  const serializeIndex = route.indexOf('serializePreparedContextMenuTurn(sendTimeTurn, browserControl)');
  assert.ok(targetIndex >= 0 && targetIndex < consentIndex);
  assert.ok(consentIndex >= 0 && consentIndex < serializeIndex);
  assert.doesNotMatch(route.slice(route.indexOf('\n', consentIndex) + 1, serializeIndex), /\bawait\b/);
});

test('Browser-origin live-tab turns explicitly forbid isolated automation substitution', () => {
  assert.match(common, /browser_control\.isolated_fallback = forbidden/);
  assert.match(common, /Never substitute Chrome DevTools, Browser Use, Playwright, computer use, an isolated QA browser, or another browser profile/);
  // Control-off and chat-only turns must not be told to answer "Tab not found".
  assert.doesNotMatch(common, /Tab not found in your browser/);
  assert.match(sidepanel, /isolatedFallback: 'forbidden'/);
});

test('system prompt gives state-aware guidance for ready, not_requested and unavailable control', () => {
  assert.match(common, /browser_control\.state = "ready"/);
  assert.match(common, /do not call browser_navigate for it/);
  assert.match(common, /refs in browser_control\.control_snapshot/);
  assert.match(common, /do not need browser_snapshot after an action/);
  assert.match(common, /browser_control\.availability = "not_requested"/);
  assert.match(common, /press Attach in Hermes Control/);
  assert.match(common, /browser_control\.availability = "unavailable"/);
});

test('turn preparation asks the worker for the control snapshot and marks control-off turns not requested', () => {
  const resolve = sidepanel.match(/async function resolveBrowserControlForTurn\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(resolve, /HERMES_CONTROLLER_PREPARE_TURN/);
  assert.match(resolve, /availability: 'not_requested'/);
  assert.match(resolve, /reason: 'chat_only'/);
  assert.match(resolve, /reason: 'control_off'/);
  assert.ok(resolve.indexOf("reason: 'control_off'") < resolve.indexOf('browserControlCandidate({ context, scope })'));
});

test('a chat turn tells the worker which chat it is, so control is ready only for that chat', () => {
  const ask = sidepanel.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const resolve = sidepanel.match(/async function resolveBrowserControlForTurn\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(ask, /resolveBrowserControlForTurn\(\{ context, scope: turnContextScope, sessionId: runSessionId \}\)/);
  assert.match(resolve, /\{ \.\.\.candidate, sessionId: turnSessionId \}/);
});

test('a right-click background task tells the worker the chat it just created, so control is ready for that chat', () => {
  const runner = sidepanel.match(/async function runInlineDraftInBackground\([\s\S]*?\n\}/)?.[0] || '';
  const route = sidepanel.match(/async function executeContextMenuRequest\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(runner, /await resolvePrompt\(session\)/);
  assert.match(route, /async \(session\) => \{[\s\S]*?resolveBrowserControlForTurn\(\{[^}]*sessionId: session\.id/);
});

test('a failed attach gives the just-acquired lease back', () => {
  const attach = sidepanel.match(/async function attachBrowserControlToCurrentTab\([\s\S]*?\n\}/)?.[0] || '';
  const acquireIndex = attach.indexOf('HERMES_CONTROLLER_LEASE_ACQUIRE');
  const catchIndex = attach.indexOf('} catch (error) {', acquireIndex);
  assert.ok(catchIndex > acquireIndex);
  const rollback = attach.slice(catchIndex, attach.indexOf('throw error;', catchIndex));
  assert.match(rollback, /HERMES_CONTROLLER_LEASE_RELEASE/);
  assert.match(rollback, /resolvedReplacement\.acquire\.tabIds/);
  assert.match(attach, /t\('browser_control\.attach_not_ready'\)/);
});

test('service worker rechecks the candidate tab through the live browser API', () => {
  assert.match(background, /getTab: \(tabId\) => browserApi\.tabs\.get\(tabId\)/);
  assert.match(sidepanel, /HERMES_CONTROLLER_TARGET_RESOLVE/);
});

test('side panel renders current-tab authority rather than global enabled state', () => {
  const render = sidepanel.match(/function renderBrowserControl\([\s\S]*?\n\}/)?.[0] || '';
  const refresh = sidepanel.match(/async function refreshBrowserControlStatus\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(render, /activeTab: browserControlActiveTab/);
  assert.match(render, /currentTarget: browserControlCurrentTarget/);
  assert.match(refresh, /browserControlActiveTab = await activeTab/);
  assert.match(refresh, /HERMES_CONTROLLER_TARGET_RESOLVE/);
});

test('Attach this tab replaces stale this-tab leases and proves the exact target before success', () => {
  const attach = sidepanel.match(/async function attachBrowserControlToCurrentTab\([\s\S]*?\n\}/)?.[0] || '';
  const releaseIndex = attach.indexOf('HERMES_CONTROLLER_LEASE_RELEASE');
  const acquireIndex = attach.indexOf('HERMES_CONTROLLER_LEASE_ACQUIRE');
  const resolveIndex = attach.indexOf('resolveBrowserControlCandidate');
  assert.match(attach, /currentTabLeaseReplacement/);
  assert.ok(releaseIndex >= 0 && releaseIndex < acquireIndex);
  assert.ok(acquireIndex >= 0 && acquireIndex < resolveIndex);
  assert.match(attach, /availability !== 'available'/);
  assert.match(attach, /leaseOwned !== true/);
  assert.match(sidepanelHtml, /id="browserControlAttachButton"/);
  assert.match(sidepanel, /els\.browserControlAttachButton\.hidden = !view\.canAttach/);
  // Attach only attaches; turning off is a separate action, never the close button.
  assert.match(sidepanelHtml, /id="browserControlOffButton"/);
  assert.match(sidepanel, /\[els\.browserControlDetachButton, els\.browserControlOffButton\]/);
  assert.doesNotMatch(sidepanel, /dataset\.mode === 'detach'/);
});

test('enable and attach fail closed with a session-first message when no Hermes session exists', () => {
  const enable = sidepanel.match(/async function enableBrowserControl\([\s\S]*?\n\}/)?.[0] || '';
  const attach = sidepanel.match(/async function attachBrowserControlToCurrentTab\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(enable, /t\('browser_control\.error_session_enable'\)/);
  assert.match(attach, /missing_session/);
  assert.match(attach, /t\('browser_control\.error_session_attach'\)/);
});

test('unconfigured startup screen offers one-click pairing and test connection pairs when available', () => {
  const render = sidepanel.match(/function renderStartupReadiness\([\s\S]*?\n\}/)?.[0] || '';
  const testConn = sidepanel.match(/async function testConnection\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(sidepanelHtml, /id="startupConnectButton"/);
  assert.match(render, /startupConnectButton\.hidden = view\.phase !== 'setup-needed'/);
  assert.match(render, /startupTestConnectionButton\.hidden = view\.phase === 'setup-needed'/);
  assert.match(sidepanel, /startupConnectButton\?\.addEventListener\('click'/);
  assert.match(testConn, /gatewayCapabilities\.browserPairing && automaticApiPairingAllowed\(settings\)/);
  assert.match(testConn, /await connectApiWithPairing\(\)/);
  assert.match(testConn, /Pairing was not completed/);
});

test('successful pairing re-runs readiness so the startup gate dismisses', () => {
  const pairing = sidepanel.match(/async function connectApiWithPairing\([\s\S]*?\n\}/)?.[0] || '';
  const tokenIndex = pairing.indexOf('settings.tokenSource = \'pairing\'');
  const readinessIndex = pairing.indexOf('runPanelConnectionReadiness({ restoreSettings: false })');
  assert.ok(tokenIndex >= 0 && tokenIndex < readinessIndex);
  assert.doesNotMatch(pairing.slice(readinessIndex), /loadModels\(\{ quiet: true \}\)/);
});
