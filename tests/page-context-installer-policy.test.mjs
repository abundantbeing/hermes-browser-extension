import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  pageContextInjectionDecision,
  pageContextSkipMessageKey,
} from '../extension/lib/page-script-host-policy.mjs';

test('shared installer path refuses injection when policy blocks the tab URL', () => {
  const settings = { pageContextOnPrivateNetworks: false };
  const privateUrl = 'https://192.168.1.10/dashboard';
  const decision = pageContextInjectionDecision(privateUrl, settings);
  assert.equal(decision.inject, false);
  assert.equal(pageContextSkipMessageKey(decision.reason), 'status.page_context_skipped_private');
});

test('manual installs refresh in-tab page-script policy before messaging', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function sendContentMessageWithInstallFallback'),
    source.indexOf('function collectPageContextWithSharedExtractor'),
  );
  assert.match(block, /ensurePageContextGateAndRefresh\(tabId, installBinding\)/);
  assert.match(block, /verifyPageContextInstallBinding/);
  assert.match(block, /resolveScriptTargetUrlForPageScriptPolicy/);
  assert.match(block, /if \(!refreshed\) throw pageContextPolicySkipError/);
  assert.match(block, /if \(!allowed\) throw pageContextPolicySkipError/);
});

test('page context permissions save instantly from data-settings-live controls', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /pageContextOnPrivateNetworksInput\?\.addEventListener\('change'/);
  assert.match(source, /persistPageContextPermissions/);
  assert.match(source, /trackInstantSave\('permissions', persistPageContextPermissions\('private'\)\)/);
  assert.match(source, /trackInstantSave\('permissions', persistPageContextPermissions\('excluded'\)\)/);
});

test('element pick failures surface in the operation toast', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function startElementPick'),
    source.indexOf('function applyPickedElementResult'),
  );
  assert.match(block, /if \(elementPickActiveForTab\(tab\)\)/);
  const cancelAt = block.indexOf('ELEMENT_PICK_MESSAGES.CANCEL');
  const policyAt = block.indexOf('pageContextInjectionDecision(tab.url, settings)');
  assert.ok(cancelAt >= 0 && policyAt > cancelAt, 'cancel active pick before policy refusal');
  assert.match(block, /status\.element_pick_unavailable/);
  assert.match(block, /showOperationToast\(/);
  assert.match(block, /Element pick failed/);
});

test('Firefox gate ensure never injects gate scripts without runPageContextBundleRestart', async () => {
  const runner = await readFile(new URL('../extension/lib/page-context-bundle-restart.mjs', import.meta.url), 'utf8');
  assert.match(runner, /await runPageContextBundleRestart\(executeScript, binding, \[gateFile\]/);
  assert.doesNotMatch(runner, /await executeScript\(\{ target, files: \[gateFile\] \}\)/);
});

test('ensurePageContextGateAndRefresh awaits async policy refresh inside the target', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../extension/lib/page-context-bundle-restart.mjs', import.meta.url), 'utf8');
  assert.match(runner, /func: async \(\) =>/);
  assert.match(runner, /await refresh\(\)/);
  assert.match(runner, /readPageScriptDocumentAnchor/);
  assert.match(source, /createPageContextGateEnsureRunner/);
  assert.match(source, /createPageContextGateEnsureCoalescer/);
  assert.match(source, /ensurePageContextGateAndRefresh/);
});

test('sidepanel installer enforces pageContextInjectionDecision before scripting fallback', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function sendContentMessageWithInstallFallback'),
    source.indexOf('function collectPageContextWithSharedExtractor'),
  );
  assert.match(block, /pageContextInjectionDecision\(url, settings\)/);
  assert.match(block, /pageContextPolicySkipError/);
  assert.match(block, /acquirePageContextInstallBinding/);
  assert.match(block, /pageContextScriptInjectionTarget/);
  assert.match(block, /contentMessageDeliveryOptions\(installBinding/);
  assert.match(block, /pageContextBundleRestartFiles\(\)/);
  assert.match(block, /verifyPageContextInstallBinding/);
  assert.match(block, /return await browserApi\.tabs\.sendMessage\(tabId, outboundMessage, messageOptions\)/);
  assert.match(block, /captureRequestAnchorToken = installBinding\.captureRequestAnchorToken \|\| installBinding\.anchorToken/);
  assert.match(block, /if \(!bridgeInjected\)/);
  assert.match(block, /if \(!gateInjected\)/);
  assert.match(block, /if \(!retryExtractorInjected\)/);
  assert.doesNotMatch(block, /runBundleRestart:[\s\S]*throw pageContextPolicySkipError/);
});

test('overlapping page-context actions share one bundle restart per tab frame', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /createPageContextBundleRestartCoalescer/);
  assert.match(source, /reinstallPageContextBundleEntries/);
  assert.match(source, /awaitPageContextBundleRestart/);
  const sendBlock = source.slice(
    source.indexOf('async function sendContentMessageWithInstallFallback'),
    source.indexOf('function collectPageContextWithSharedExtractor'),
  );
  assert.match(sendBlock, /await awaitPageContextBundleRestart\(tabId, installBinding\)/);
  const extractorBlock = source.slice(
    source.indexOf('async function getPageContextViaScripting'),
    source.indexOf('async function getPageContext('),
  );
  assert.match(extractorBlock, /await awaitPageContextBundleRestart\(tabId, installBinding\)/);
});

test('opt-in bundle reinstall runs bundle entries after gate in dependency order', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('function pageContextBundleRestartFiles'),
    source.indexOf('function pageContextScriptTarget'),
  );
  assert.match(block, /pageContextBundleRestartFilesFromManifest/);
  assert.match(await readFile(new URL('../extension/lib/page-context-bundle-restart.mjs', import.meta.url), 'utf8'), /page-context-bundle-gate/);
  const runner = await readFile(new URL('../extension/lib/page-context-bundle-restart.mjs', import.meta.url), 'utf8');
  assert.match(runner, /reinstallPageContextBundleEntries/);
  assert.match(runner, /probePageContextBundleRestartNeeded/);
  assert.match(runner, /page-context-bundle-gate/);
});

test('adoptHermesBrowserSettingsStorageChange tracks page-context settings fields', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function adoptHermesBrowserSettingsStorageChange'),
    source.indexOf('function reloadForSavedConnection'),
  );
  assert.match(block, /pageContextOnPrivateNetworks/);
  assert.match(block, /pageContextExcludedOrigins/);
  assert.match(block, /pageContextSettingsChanged/);
  assert.match(block, /adoptPageContextPermissionControlsFromStorage\(next\)/);
});
