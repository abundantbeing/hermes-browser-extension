import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// Skip when the Firefox build artifact is absent (dev env without a prior
// `npm run build:firefox`). When the manifest is present, every subtest runs
// the full validation suite unmodified.
const manifestPath = new URL('../dist/firefox/manifest.json', import.meta.url);

function loadManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

const skipReason = existsSync(manifestPath)
  ? undefined
  : 'Run npm run build:firefox to generate dist/firefox/';

test('Firefox build uses a module background script fallback instead of a Chromium-only service worker', { skip: skipReason }, () => {
  const manifest = loadManifest();
  assert.deepEqual(manifest.background, {
    scripts: ['background.js'],
    type: 'module',
  });
});

test('Firefox build removes unsupported Chromium permissions while retaining sidebar support', { skip: skipReason }, () => {
  const manifest = loadManifest();
  assert.equal(manifest.side_panel, undefined);
  assert.equal(manifest.permissions.includes('sidePanel'), false);
  assert.equal(manifest.optional_permissions?.includes('audioCapture') || false, false);
  assert.ok(manifest.sidebar_action);
});

test('Firefox build truthfully declares built-in data consent categories', { skip: skipReason }, () => {
  const manifest = loadManifest();
  assert.equal(manifest.browser_specific_settings?.gecko?.strict_min_version, '142.0');
  assert.deepEqual(manifest.browser_specific_settings?.gecko?.data_collection_permissions, {
    required: ['websiteContent', 'personalCommunications'],
  });
});
