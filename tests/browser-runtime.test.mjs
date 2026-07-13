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

test('side-panel confirmation rejects an onOpened event for another panel path', async () => {
  let listener = null;
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi: {
      onOpened: {
        addListener(fn) { listener = fn; },
        removeListener(fn) { if (listener === fn) listener = null; },
      },
      async open(options) {
        listener?.({ tabId: options.tabId, path: 'unrelated-panel.html' });
      },
    },
    runtimeApi: { getContexts: async () => [] },
    openOptions: { tabId: 7 },
    panelUrl: 'chrome-extension://id/sidepanel.html?scope=tab&tabId=7',
    pollDelays: [0],
  });
  assert.equal(opened, false);
  assert.equal(listener, null, 'onOpened listener must be removed after a path mismatch');
});

test('modern side-panel confirmation ignores hidden contexts when onOpened never fires', async () => {
  const panelUrl = 'chrome-extension://id/sidepanel.html?scope=tab&tabId=7';
  let listener = null;
  let contextQueries = 0;
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi: {
      onOpened: {
        addListener(fn) { listener = fn; },
        removeListener(fn) { if (listener === fn) listener = null; },
      },
      open: async () => {},
    },
    runtimeApi: {
      getContexts: async () => {
        contextQueries += 1;
        return [{ contextType: 'SIDE_PANEL', documentUrl: panelUrl, tabId: 7, windowId: 2 }];
      },
    },
    openOptions: { tabId: 7 },
    panelUrl,
    pollDelays: [0],
  });
  assert.equal(opened, false);
  assert.equal(contextQueries, 0, 'modern Chromium must use the real onOpened event, not context existence');
  assert.equal(listener, null, 'onOpened listener must be removed after the attempt');
});

test('modern Chromium ignores hidden contexts even when onOpened is missing', async () => {
  const panelUrl = 'chrome-extension://id/sidepanel.html?scope=tab&tabId=7';
  let contextQueries = 0;
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi: { open: async () => {} },
    runtimeApi: {
      getContexts: async () => {
        contextQueries += 1;
        return [{ contextType: 'SIDE_PANEL', documentUrl: panelUrl, tabId: 7, windowId: 2 }];
      },
    },
    openOptions: { tabId: 7 },
    panelUrl,
    pollDelays: [0],
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
  });
  assert.equal(opened, false);
  assert.equal(contextQueries, 0, 'Chrome 141+ must never use context existence as visibility proof');
});

test('HeadlessChrome 141+ ignores hidden contexts when onOpened is missing', async () => {
  const panelUrl = 'chrome-extension://id/sidepanel.html?scope=tab&tabId=7';
  let contextQueries = 0;
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi: { open: async () => {} },
    runtimeApi: {
      getContexts: async () => {
        contextQueries += 1;
        return [{ contextType: 'SIDE_PANEL', documentUrl: panelUrl, tabId: 7, windowId: 2 }];
      },
    },
    openOptions: { tabId: 7 },
    panelUrl,
    pollDelays: [0],
    userAgent: 'Mozilla/5.0 HeadlessChrome/150.0.0.0 Safari/537.36',
  });
  assert.equal(opened, false);
  assert.equal(contextQueries, 0, 'HeadlessChrome 141+ must use the modern event confirmation gate');
});

test('legacy side-panel confirmation accepts the expected SIDE_PANEL context without onOpened', async () => {
  const panelUrl = 'chrome-extension://id/sidepanel.html?scope=tab&tabId=7';
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi: { open: async () => {} },
    runtimeApi: {
      getContexts: async () => [{ contextType: 'SIDE_PANEL', documentUrl: panelUrl, tabId: 7, windowId: 2 }],
    },
    openOptions: { tabId: 7 },
    panelUrl,
    pollDelays: [0],
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
  });
  assert.equal(opened, true);
});

test('legacy side-panel confirmation rejects contexts with the wrong type or path', async () => {
  const panelUrl = 'chrome-extension://id/sidepanel.html?scope=tab&tabId=7';
  const opened = await openSidePanelWithConfirmation({
    sidePanelApi: { open: async () => {} },
    runtimeApi: {
      getContexts: async () => [
        { contextType: 'OFFSCREEN_DOCUMENT', documentUrl: panelUrl, tabId: 7, windowId: 2 },
        { contextType: 'SIDE_PANEL', documentUrl: 'chrome-extension://id/unrelated.html', tabId: 7, windowId: 2 },
      ],
    },
    openOptions: { tabId: 7 },
    panelUrl,
    pollDelays: [0],
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
  });
  assert.equal(opened, false);
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

function createBackgroundHarness({
  runtimeContexts = [],
  sidePanelOpen = async () => {},
  synchronizeFallbackQueries = false,
} = {}) {
  const activeTab = { id: 7, windowId: 8 };
  const extensionTabs = [];
  const createdTabs = [];
  const updatedTabs = [];
  const focusedWindows = [];
  const sidePanelOpenCalls = [];
  let actionHandler = null;
  const chromeApi = {
    runtime: {
      getManifest: () => ({ side_panel: { default_path: 'sidepanel.html' } }),
      getURL: (value) => `chrome-extension://test/${value}`,
      getContexts: async () => runtimeContexts,
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
      query: async () => {
        const snapshot = [activeTab, ...extensionTabs];
        if (synchronizeFallbackQueries) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return snapshot;
      },
      create: async (options) => {
        createdTabs.push(options);
        const created = { id: 100 + createdTabs.length, windowId: 8, pendingUrl: options.url };
        extensionTabs.push(created);
        return created;
      },
      update: async (tabId, options) => {
        updatedTabs.push({ tabId, options });
        return extensionTabs.find((tab) => tab.id === tabId) || null;
      },
      onActivated: { addListener() {} },
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      setOptions: async () => {},
      open: async (options) => {
        sidePanelOpenCalls.push(options);
        return sidePanelOpen(options);
      },
      onOpened: {
        addListener() {},
        removeListener() {},
      },
    },
    windows: {
      create: async () => {},
      update: async (windowId, options) => { focusedWindows.push({ windowId, options }); },
    },
  };

  return {
    chromeApi,
    activeTab,
    createdTabs,
    updatedTabs,
    focusedWindows,
    sidePanelOpenCalls,
    get actionHandler() { return actionHandler; },
  };
}

test('background action reuses the extension-tab fallback across repeated silent side-panel no-ops', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness();
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?silent-side-panel=${Date.now()}`);
    assert.equal(typeof harness.actionHandler, 'function');
    await harness.actionHandler(harness.activeTab);
    await harness.actionHandler(harness.activeTab);
    assert.equal(harness.createdTabs.length, 1, 'repeated fallback clicks must not create duplicate tabs');
    assert.equal(harness.createdTabs[0].url, 'chrome-extension://test/sidepanel.html?panel=tab&tabId=7');
    assert.deepEqual(harness.updatedTabs, [{ tabId: 101, options: { active: true } }]);
    assert.deepEqual(harness.focusedWindows, [{ windowId: 8, options: { focused: true } }]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('background action coalesces concurrent silent side-panel fallbacks', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness({ synchronizeFallbackQueries: true });
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?concurrent-side-panel=${Date.now()}`);
    assert.equal(typeof harness.actionHandler, 'function');
    await Promise.all([
      harness.actionHandler(harness.activeTab),
      harness.actionHandler(harness.activeTab),
    ]);
    assert.equal(harness.createdTabs.length, 1, 'concurrent fallback clicks must share one tab open');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('background action falls back when a modern browser creates a hidden side-panel context', async () => {
  const originalChrome = globalThis.chrome;
  const panelUrl = 'chrome-extension://test/sidepanel.html?panel=tab&tabId=7';
  const harness = createBackgroundHarness({
    runtimeContexts: [{ contextType: 'SIDE_PANEL', documentUrl: panelUrl, tabId: 7, windowId: 8 }],
  });
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?hidden-side-panel-context=${Date.now()}`);
    assert.equal(typeof harness.actionHandler, 'function');
    await harness.actionHandler(harness.activeTab);
    assert.deepEqual(harness.sidePanelOpenCalls, [{ tabId: 7 }, { windowId: 8 }]);
    assert.deepEqual(harness.createdTabs, [{ url: panelUrl, active: true }]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('background action retries a failed tab-scoped side-panel open at window scope only once', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness({
    sidePanelOpen: async (options) => {
      if ('tabId' in options) throw new Error('tab-scoped side panel unavailable');
    },
  });
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?single-window-retry=${Date.now()}`);
    assert.equal(typeof harness.actionHandler, 'function');
    await harness.actionHandler(harness.activeTab);
    assert.deepEqual(harness.sidePanelOpenCalls, [{ tabId: 7 }, { windowId: 8 }]);
    assert.equal(harness.createdTabs.length, 1);
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
