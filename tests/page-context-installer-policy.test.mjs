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

test('sidepanel installer enforces pageContextInjectionDecision before scripting fallback', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function sendContentMessageWithInstallFallback'),
    source.indexOf('function collectPageContextWithSharedExtractor'),
  );
  assert.match(block, /pageContextInjectionDecision\(url, settings\)/);
  assert.match(block, /hermesPageContextSkipped/);
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
});
