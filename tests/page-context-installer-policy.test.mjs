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
  assert.match(block, /ensurePageContextGateAndRefresh\(tabId, scriptTarget\)/);
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
  assert.match(block, /pageContextInjectionDecision\(tab\.url, settings\)/);
  assert.match(block, /showOperationToast\(/);
  assert.match(block, /Element pick failed/);
});

test('ensurePageContextGateAndRefresh awaits async policy refresh inside the target', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function ensurePageContextGateAndRefresh'),
    source.indexOf('function pageContextPermissionControlDirty'),
  );
  assert.match(block, /func: async \(\) =>/);
  assert.match(block, /await refresh\(\)/);
});

test('sidepanel installer enforces pageContextInjectionDecision before scripting fallback', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function sendContentMessageWithInstallFallback'),
    source.indexOf('function collectPageContextWithSharedExtractor'),
  );
  assert.match(block, /pageContextInjectionDecision\(url, settings\)/);
  assert.match(block, /pageContextPolicySkipError/);
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
