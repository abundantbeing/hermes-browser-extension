import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openSidePanelWithConfirmation } from '../extension/lib/browser-runtime.mjs';

const root = process.cwd();

test('browser-runtime.mjs detects Firefox via UA and browser.sidebarAction', () => {
  const source = readFileSync(new URL('../extension/lib/browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /Firefox/);
  assert.match(source, /browser\?\.sidebarAction/);
});

test('browser-runtime.mjs openNativeSidebar handles sidebarAction.open() for Firefox', () => {
  const source = readFileSync(new URL('../extension/lib/browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /sidebarAction\.open/);
  assert.match(source, /typeof sidebarAction\.open === 'function'/);
});

test('browser-runtime.mjs setActionClickPanelBehavior handles Firefox', () => {
  const source = readFileSync(new URL('../extension/lib/browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /BROWSER_IDS\.FIREFOX/);
});

test('background.js openHermesPanel falls back to popup window for Firefox', () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(source, /browserId === 'opera' \|\| browserId === 'firefox'/);
  assert.match(source, /windows\.create/);
  assert.match(source, /openSidePanelWithConfirmation\(/);
  assert.match(source, /if \(panelOpened\) return/);
});

test('side-panel confirmation accepts an exact onOpened event', async () => {
  let listener = null;
  const sidePanelApi = {
    onOpened: {
      addListener(fn) { listener = fn; },
      removeListener(fn) { if (listener === fn) listener = null; },
    },
    async open(options) {
      listener?.({ tabId: options.tabId, path: 'sidepanel.html?scope=tab&tabId=7' });
    },
  };
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi,
    runtimeApi: { getContexts: async () => [] },
    openOptions: { tabId: 7 },
    panelUrl: 'chrome-extension://id/sidepanel.html?scope=tab&tabId=7',
    pollDelays: [0],
  });
  assert.equal(opened, true);
  assert.equal(listener, null, 'onOpened listener must be removed after the attempt');
});

test('side-panel confirmation accepts the expected SIDE_PANEL context', async () => {
  const panelUrl = 'chrome-extension://id/sidepanel.html?scope=tab&tabId=7';
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi: { open: async () => {} },
    runtimeApi: {
      getContexts: async () => [{ contextType: 'SIDE_PANEL', documentUrl: panelUrl, tabId: 7, windowId: 2 }],
    },
    openOptions: { tabId: 7 },
    panelUrl,
    pollDelays: [0],
  });
  assert.equal(opened, true);
});

test('side-panel confirmation rejects a silent no-op so the caller can use its tab fallback', async () => {
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi: { open: async () => {} },
    runtimeApi: { getContexts: async () => [] },
    openOptions: { windowId: 2 },
    panelUrl: 'chrome-extension://id/sidepanel.html?scope=global',
    pollDelays: [0, 0],
  });
  assert.equal(opened, false);
});

test('background action uses the extension-tab fallback when sidePanel.open silently no-ops', async () => {
  const originalChrome = globalThis.chrome;
  let actionHandler = null;
  const createdTabs = [];
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ side_panel: { default_path: 'sidepanel.html' } }),
      getURL: (value) => `chrome-extension://test/${value}`,
      getContexts: async () => [],
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        get: async () => ({
          hermesBrowserSettings: { panelResidencyMode: 'tab-attached' },
        }),
      },
      onChanged: { addListener() {} },
    },
    action: {
      setPopup: async () => {},
      onClicked: { addListener(handler) { actionHandler = handler; } },
    },
    tabs: {
      query: async () => [{ id: 7, windowId: 8 }],
      create: async (options) => { createdTabs.push(options); },
      onActivated: { addListener() {} },
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      setOptions: async () => {},
      open: async () => {},
      onOpened: {
        addListener() {},
        removeListener() {},
      },
    },
    windows: { create: async () => {} },
  };

  try {
    await import(`../extension/background.js?silent-side-panel=${Date.now()}`);
    assert.equal(typeof actionHandler, 'function');
    await actionHandler({ id: 7, windowId: 8 });
    assert.equal(createdTabs.length, 1);
    assert.equal(createdTabs[0].url, 'chrome-extension://test/sidepanel.html?panel=tab&tabId=7');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('build-firefox.mjs exists and is valid JavaScript', () => {
  const buildScript = path.join(root, 'scripts', 'build-firefox.mjs');
  assert.ok(existsSync(buildScript), 'build-firefox.mjs should exist');
  // Syntax check
  execFileSync('node', ['--check', buildScript], { encoding: 'utf8' });
});

test('build-firefox.mjs strips Chrome-only manifest keys and adds Firefox settings', () => {
  const source = readFileSync(new URL('../scripts/build-firefox.mjs', import.meta.url), 'utf8');
  assert.match(source, /delete sourceManifest\.side_panel/);
  assert.match(source, /delete sourceManifest\.minimum_chrome_version/);
  assert.match(source, /sidePanel.*filter|filter.*sidePanel/);
  assert.match(source, /browser_specific_settings/);
  assert.match(source, /gecko/);
});

test('package.json has build:firefox script', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.scripts['build:firefox'], 'build:firefox script should exist');
  assert.match(pkg.scripts['build:firefox'], /build-firefox\.mjs/);
});

test('manifest.json has sidebar_action for Firefox sidebar support', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.sidebar_action, 'sidebar_action must be in manifest for Firefox');
  assert.ok(manifest.sidebar_action.default_panel, 'sidebar_action.default_panel must be set');
  assert.equal(manifest.sidebar_action.default_panel, manifest.side_panel.default_path, 'sidebar_action default_panel must match side_panel default_path');
});
