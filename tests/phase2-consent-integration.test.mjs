import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const sidepanelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const fulltab = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
const fulltabHtml = readFileSync(new URL('../extension/app.html', import.meta.url), 'utf8');
const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const common = readFileSync(new URL('../extension/lib/common.mjs', import.meta.url), 'utf8');

test('Side Panel and Hermes Web expose one scoped browser-context consent control', () => {
  for (const html of [sidepanelHtml, fulltabHtml]) {
    assert.match(html, /id="browserContextConsentControl"/);
    assert.match(html, /id="browserContextConsentInput"/);
    assert.match(html, /id="browserContextConsentIdentity"/);
    assert.match(html, /Share page context with this connection/);
    assert.match(html, /Chat only until you approve this exact connection/);
  }
  for (const source of [sidepanel, fulltab]) {
    assert.match(source, /context-consent\.mjs/);
    assert.match(source, /browserContextConsentLedger/);
    assert.match(source, /currentContextConsentIdentity/);
    assert.match(source, /persistContextConsentDecision/);
    assert.match(source, /CONTEXT_CONSENT_STORAGE_KEY/);
  }
  assert.match(common, /browserContextConsentLedger/);
  assert.doesNotMatch(sidepanel, /shareBrowserContext/);
  assert.doesNotMatch(fulltab, /shareBrowserContext/);
});

test('the Side Panel applies the final consent gate after every turn-time scope override', () => {
  const sender = sidepanel.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const refresher = sidepanel.match(/async function refreshContext\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(sidepanel, /function effectiveContextGate/);
  assert.match(sender, /contextOverride\?\.contextScope \|\| contextScope/);
  assert.match(sender, /effectiveContextGate\(/);
  assert.ok(sender.indexOf('effectiveContextGate(') < sender.indexOf('refreshContext('), 'final consent must resolve before capture');
  assert.match(refresher, /effectiveContextGate\(contextScope\)/);
  assert.match(sender, /turnContextScope\.mode === CONTEXT_SCOPE_MODES\.CHAT_ONLY/);
  assert.match(sender, /const gatedContextOverride = contextGate\.allowed \? contextOverride : null/);
});

test('non-loopback Remote API is consent-gated as strictly as Cloud and dashboard transport', () => {
  const renderer = sidepanel.match(/function renderBrowserContextConsentControl\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(renderer, /consentRequiredForConnection/);
  assert.doesNotMatch(renderer, /connectionMode === 'cloud' \|\|/);
  assert.match(sidepanel, /fingerprintContextCredential/);
  assert.match(sidepanel, /dashboardPrincipalFromMe/);
  assert.match(sidepanel, /ticket\.principal/);
});

test('identity, endpoint, profile, and credential switches re-evaluate consent instead of inheriting a global bit', () => {
  for (const source of [sidepanel, fulltab]) {
    assert.match(source, /contextConsentIdentity\(\{/);
    assert.match(source, /activeProfile/);
    assert.match(source, /connectionTransport/);
    assert.match(source, /browserApi\.runtime\.id/);
  }
  assert.match(sidepanel, /refreshContextConsentPrincipal/);
  assert.match(fulltab, /refreshContextConsentPrincipal/);
});

test('inline and right-click background paths apply the final consent gate at transmission-time serialization', () => {
  const resolver = sidepanel.match(/async function resolveInlineDraftPrompt\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(resolver, /const sendTimeSettings = await refreshContextConsentLedger\(consentSettings\)/);
  assert.match(resolver, /buildInlineDraftPrompt\(inlineDraftRequestForEffectiveContext\(request, sendTimeSettings\)\)/);
  const inlineGate = sidepanel.match(/function inlineDraftRequestForEffectiveContext\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(inlineGate, /pageContext: ''/);
  assert.match(inlineGate, /pageUrl: ''/);
  assert.match(inlineGate, /fieldLabel: ''/);
  const currentRoute = sidepanel.match(/async function runInlineDraftInCurrentSession\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(currentRoute.indexOf('await ensureHermesSession()') < currentRoute.indexOf('await resolveInlineDraftPrompt(request)'));
  assert.match(sidepanel, /runInlineDraftInBackground\(request, \(\) => resolveInlineDraftPrompt\(request\)\)/);
  assert.match(sidepanel, /resolveUserText:\s*\(\) => resolveInlineDraftPrompt\(request\)/);
  const sender = sidepanel.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const resolverIndex = sender.indexOf('await turnOptions.resolveUserText()');
  const submitIndex = sender.indexOf('answer = await streamSessionChat', resolverIndex);
  const modelLockIndex = sender.indexOf('await ensureActiveSessionModelLockOrThrow()');
  const remoteSessionIndex = sender.indexOf('await ensureRemoteWsSession(consentConnection)');
  const introIndex = sender.indexOf('await persistBrowserIntroSeen()');
  assert.ok(modelLockIndex >= 0 && modelLockIndex < resolverIndex);
  assert.ok(remoteSessionIndex >= 0 && remoteSessionIndex < resolverIndex);
  assert.ok(introIndex >= 0 && introIndex < resolverIndex);
  assert.ok(resolverIndex >= 0 && resolverIndex < submitIndex);
  assert.doesNotMatch(sender.slice(sender.indexOf('\n', resolverIndex) + 1, submitIndex), /\bawait\b/);
  assert.match(sidepanel, /function contextMenuTurnForEffectiveContext[\s\S]*pageContext: null/);
  assert.match(sidepanel, /initialTurn\.capturePage && gate\.scope\.mode !== CONTEXT_SCOPE_MODES\.CHAT_ONLY/);
  assert.match(sidepanel, /serializePreparedContextMenuTurn\(turn, browserControl\)/);
});

test('consent decisions are stored separately and synchronized across both surfaces', () => {
  for (const source of [sidepanel, fulltab]) {
    assert.match(source, /CONTEXT_CONSENT_STORAGE_KEY/);
    assert.match(source, /persistContextConsentDecision/);
    assert.match(source, /browserApi\.storage\.onChanged/);
  }
});

test('service-worker background and new-session inline drafts re-read the dedicated consent ledger immediately before chat submit', () => {
  assert.match(background, /inline-draft-consent\.mjs/);
  assert.match(background, /CONTEXT_CONSENT_STORAGE_KEY/);
  assert.match(background, /gateInlineDraftRequestContext/);
  const runner = background.match(/async function runInlineDraftInServiceWorker\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(runner, /browserApi\.storage\.local\.get\(\[CONTEXT_CONSENT_STORAGE_KEY\]\)/);
  assert.match(runner, /ledger: consentStored\[CONTEXT_CONSENT_STORAGE_KEY\] \|\| null/);
  assert.match(runner, /const gatedRequest = await gateInlineDraftRequestContext\(/);
  assert.ok(runner.indexOf('const gatedRequest = await gateInlineDraftRequestContext(') < runner.indexOf('message: buildInlineDraftPrompt(gatedRequest.request)'));
  assert.doesNotMatch(runner, /message: buildInlineDraftPrompt\(request\)/);
});

test('right-click background route re-reads consent after session creation and re-gates against the same connection snapshot before prompt submission', () => {
  const runner = sidepanel.match(/async function runInlineDraftInBackground\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(runner, /const session = await createInlineBackgroundSession\(request\)/);
  assert.match(runner, /await resolvePrompt\(\)/);
  assert.ok(runner.indexOf('const session = await createInlineBackgroundSession(request)') < runner.indexOf('await resolvePrompt()'));
  const route = sidepanel.match(/async function executeContextMenuRequest\([\s\S]*?\n\}/)?.[0] || '';
  const refresh = sidepanel.match(/async function refreshContextConsentLedger\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(route, /const consentSettings = \{ \.\.\.settings \};/);
  assert.match(route, /const sendTimeSettings = await refreshContextConsentLedger\(consentSettings\);/);
  assert.match(route, /contextMenuTurnForEffectiveContext\(turn, sendTimeSettings\)/);
  assert.match(route, /serializePreparedContextMenuTurn/);
  assert.ok(route.indexOf('const consentSettings = { ...settings };') < route.indexOf('runInlineDraftInBackground('));
  assert.ok(route.indexOf('const sendTimeSettings = await refreshContextConsentLedger(consentSettings);') < route.indexOf('serializePreparedContextMenuTurn(sendTimeTurn, browserControl)'));
  assert.match(refresh, /browserApi\.storage\.local\.get\(\[CONTEXT_CONSENT_STORAGE_KEY\]\)/);
  assert.doesNotMatch(refresh, /hermesBrowserSettings/);
  assert.doesNotMatch(refresh, /\n\s*settings\s*=/);
});
