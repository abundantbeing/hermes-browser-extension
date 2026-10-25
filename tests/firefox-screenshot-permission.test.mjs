// Firefox needs all-sites access for tabs.captureVisibleTab. The Firefox build declares it as an OPTIONAL host
// permission only, and the panel asks for it from a click. Chromium is unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MANIFEST_PROFILES, MANIFEST_TARGETS } from '../scripts/manifest-profiles.mjs';
import { CONTROL_NOTES } from '../extension/lib/browser-control-ui.mjs';
import {
  FIREFOX_SCREENSHOT_ORIGINS,
  SCREENSHOT_PERMISSION_STATES,
  permissionChangeTouchesScreenshots,
  removeScreenshotPermission,
  requestScreenshotPermission,
  screenshotControlView,
  screenshotPermissionState,
} from '../extension/lib/firefox-screenshot-permission.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const FIREFOX = { id: 'firefox', engine: 'gecko' };
const CHROME = { id: 'chrome', engine: 'chromium' };

test('the Firefox profile alone declares <all_urls> as an optional host permission', () => {
  assert.deepEqual([...MANIFEST_PROFILES[MANIFEST_TARGETS.FIREFOX].optionalHostPermissions], ['<all_urls>']);
  for (const target of Object.values(MANIFEST_TARGETS)) {
    if (target === MANIFEST_TARGETS.FIREFOX) continue;
    assert.equal(MANIFEST_PROFILES[target]?.optionalHostPermissions, undefined, `${target} is unchanged`);
  }
});

test('the source (Chromium) manifest never lists <all_urls>, and nothing makes it an install-time permission', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.ok(!manifest.permissions.includes('<all_urls>'));
  const build = read('scripts/build-firefox.mjs');
  assert.match(build, /sourceManifest\.optional_host_permissions = \[\.\.\.firefoxProfile\.optionalHostPermissions\]/);
  assert.doesNotMatch(build, /host_permissions\.push|host_permissions = \[[^\]]*all_urls/);
  assert.equal(FIREFOX_SCREENSHOT_ORIGINS[0], '<all_urls>');
});

test('only Firefox with a permissions API ever needs to ask', async () => {
  const contains = async () => true;
  assert.equal(await screenshotPermissionState({ browserApi: { permissions: { contains } }, product: CHROME }), SCREENSHOT_PERMISSION_STATES.NOT_APPLICABLE);
  assert.equal(await screenshotPermissionState({ browserApi: {}, product: FIREFOX }), SCREENSHOT_PERMISSION_STATES.NOT_APPLICABLE);
  assert.equal(await screenshotPermissionState({ browserApi: { permissions: { contains } }, product: FIREFOX }), SCREENSHOT_PERMISSION_STATES.GRANTED);
  assert.equal(await screenshotPermissionState({ browserApi: { permissions: { contains: async () => false } }, product: FIREFOX }), SCREENSHOT_PERMISSION_STATES.MISSING);
  assert.equal(await screenshotPermissionState({ browserApi: { permissions: { contains: async () => { throw new Error('x'); } } }, product: FIREFOX }), SCREENSHOT_PERMISSION_STATES.UNKNOWN);
});

test('request and remove ask for exactly <all_urls> and report whether it is held', async () => {
  const calls = [];
  const browserApi = { permissions: {
    request: async (query) => { calls.push(['request', query]); return true; },
    remove: async (query) => { calls.push(['remove', query]); return true; },
  } };
  assert.equal(await requestScreenshotPermission(browserApi), true);
  assert.equal(await removeScreenshotPermission(browserApi), true);
  assert.deepEqual(calls, [['request', { origins: ['<all_urls>'] }], ['remove', { origins: ['<all_urls>'] }]]);
  assert.equal(await requestScreenshotPermission({ permissions: { request: async () => false } }), false);
  await assert.rejects(requestScreenshotPermission({}), /cannot ask/);
});

test('the request is made synchronously inside the click, before any await', () => {
  let called = false;
  const browserApi = { permissions: { request: () => { called = true; return Promise.resolve(true); } } };
  requestScreenshotPermission(browserApi);
  assert.equal(called, true, 'permissions.request runs in the same tick as the click');
  const source = read('extension/sidepanel.js');
  const handler = source.match(/function changeFirefoxScreenshotPermission\(\) \{[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(handler, /const change = granted \? removeScreenshotPermission\(browserApi\) : requestScreenshotPermission\(browserApi\);/);
  assert.doesNotMatch(handler.split('const change')[0], /await/);
});

test('the controls show only on Firefox, and the strip offers the grant only after a refusal while it is missing', () => {
  assert.deepEqual(screenshotControlView({ state: SCREENSHOT_PERMISSION_STATES.NOT_APPLICABLE, refused: true }), { settingsVisible: false, granted: false, stripVisible: false });
  assert.deepEqual(screenshotControlView({ state: SCREENSHOT_PERMISSION_STATES.MISSING, refused: false }), { settingsVisible: true, granted: false, stripVisible: false });
  assert.deepEqual(screenshotControlView({ state: SCREENSHOT_PERMISSION_STATES.MISSING, refused: true }), { settingsVisible: true, granted: false, stripVisible: true });
  assert.deepEqual(screenshotControlView({ state: SCREENSHOT_PERMISSION_STATES.GRANTED, refused: true }), { settingsVisible: true, granted: true, stripVisible: false });
});

test('a permission change in the browser refreshes the controls only when it concerns <all_urls>', () => {
  assert.equal(permissionChangeTouchesScreenshots({ origins: ['<all_urls>'] }), true);
  assert.equal(permissionChangeTouchesScreenshots({ origins: ['https://example.com/*'] }), false);
  assert.equal(permissionChangeTouchesScreenshots({}), false);
});

test('a refused model screenshot leaves a note naming the control, and the worker maps the adapter code to it', () => {
  assert.match(CONTROL_NOTES.screenshot_permission, /Allow screenshots on Firefox/);
  const worker = read('extension/lib/controller-service-worker.mjs');
  assert.match(worker, /if \(code === 'screenshot_unavailable'\) return 'screenshot_permission';/);
});

test('both controls exist in the panel, are hidden until Firefox needs them, and bind from bindEvents', () => {
  const html = read('extension/sidepanel.html');
  assert.match(html, /<div id="firefoxScreenshotSetting"[^>]*hidden>/);
  assert.match(html, /<button id="browserControlScreenshotPermissionButton"[^>]*hidden[^>]*data-i18n="firefox_screenshots\.allow"/);
  const source = read('extension/sidepanel.js');
  assert.match(source, /function bindEvents\(\) \{\s*bindPromptCard\(\);\s*bindFirefoxScreenshotControl\(\);/);
  assert.match(source, /if \(firefoxScreenshotBound \|\| !isFirefoxProduct\(browserProduct\)\) return;/);
});

test('PERMISSIONS.md documents the optional Firefox permission and that it is never asked at install', () => {
  const doc = read('PERMISSIONS.md');
  assert.match(doc, /optional_host_permissions/);
  assert.match(doc, /Allow screenshots on Firefox/);
  assert.match(doc, /never requested at install/);
});
