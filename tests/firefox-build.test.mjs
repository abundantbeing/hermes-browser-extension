import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../dist/firefox/manifest.json', import.meta.url), 'utf8'));

test('Firefox build uses a module background script fallback instead of a Chromium-only service worker', () => {
  assert.deepEqual(manifest.background, {
    scripts: ['background.js'],
    type: 'module',
  });
});

test('Firefox build removes unsupported Chromium permissions while retaining sidebar support', () => {
  assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.permissions.includes('sidePanel'), false);
  assert.equal(manifest.optional_permissions?.includes('audioCapture') || false, false);
  assert.ok(manifest.sidebar_action);
});

test('Firefox build truthfully declares built-in data consent categories', () => {
  assert.equal(manifest.browser_specific_settings?.gecko?.strict_min_version, '142.0');
  assert.deepEqual(manifest.browser_specific_settings?.gecko?.data_collection_permissions, {
    required: ['websiteContent', 'personalCommunications'],
  });
});
