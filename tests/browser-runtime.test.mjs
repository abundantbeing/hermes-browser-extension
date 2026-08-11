import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  BROWSER_IDS,
  actionIconPathsForBrowser,
  detectBrowserId,
  openSidePanelWithConfirmation,
  setActionClickPanelBehavior,
  setActionIconForBrowser,
} from '../extension/lib/browser-runtime.mjs';

const root = process.cwd();

test('browser-runtime.mjs detects Firefox through the shared WebExtension namespace', () => {
  const source = readFileSync(new URL('../extension/lib/browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /Firefox/);
  assert.match(source, /getBrowserApi\(\)\?\.sidebarAction/);
  assert.doesNotMatch(source, /globalThis\.(?:browser|chrome)\?\./);
});

test('browser-runtime.mjs openNativeSidebar handles sidebarAction.open() for Firefox', () => {
  const source = readFileSync(new URL('../extension/lib/browser-runtime.mjs', import.meta.url), 'utf8');
  assert.match(source, /sidebarAction\.open/);
  assert.match(source, /typeof sidebarAction\.open === 'function'/);
});

test('browser runtime distinguishes Brave from generic Chromium', () => {
  assert.equal(detectBrowserId({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    braveApi: { isBrave() {} },
  }), BROWSER_IDS.BRAVE);
  assert.equal(detectBrowserId({
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    braveApi: null,
  }), BROWSER_IDS.CHROMIUM);
});

test('Brave leaves action clicks with the extension listener', async () => {
  const calls = [];
  await setActionClickPanelBehavior({
    browserId: BROWSER_IDS.BRAVE,
    sidePanelApi: { setPanelBehavior: async (value) => calls.push(value) },
  });
  assert.deepEqual(calls, [{ openPanelOnActionClick: false }]);
});

test('every non-Brave browser keeps native automatic action behavior', async () => {
  for (const browserId of [
    BROWSER_IDS.CHROMIUM,
    BROWSER_IDS.OPERA,
    BROWSER_IDS.FIREFOX,
    BROWSER_IDS.SAFARI,
    BROWSER_IDS.UNKNOWN,
  ]) {
    const calls = [];
    await setActionClickPanelBehavior({
      browserId,
      sidePanelApi: { setPanelBehavior: async (value) => calls.push(value) },
    });
    assert.deepEqual(
      calls,
      [{ openPanelOnActionClick: true }],
      `${browserId} must keep native action-click panel behavior`,
    );
  }
});

test('Brave receives the Nous Girl action icon override', async () => {
  const expected = {
    16: 'assets/icons/brave-nous-girl-16.png',
    32: 'assets/icons/brave-nous-girl-32.png',
    48: 'assets/icons/brave-nous-girl-48.png',
    128: 'assets/icons/brave-nous-girl-128.png',
  };
  assert.deepEqual(actionIconPathsForBrowser(BROWSER_IDS.BRAVE), expected);
  assert.equal(actionIconPathsForBrowser(BROWSER_IDS.CHROMIUM), null);

  const calls = [];
  assert.equal(await setActionIconForBrowser({
    browserId: BROWSER_IDS.BRAVE,
    actionApi: { setIcon: async (value) => calls.push(value) },
  }), true);
  assert.deepEqual(calls, [{ path: expected }]);
});

test('Brave icon application reports failure instead of throwing', async () => {
  assert.equal(await setActionIconForBrowser({
    browserId: BROWSER_IDS.BRAVE,
    actionApi: { setIcon: async () => { throw new Error('setIcon failed'); } },
  }), false);
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
  panelResidencyMode = 'tab-attached',
  runtimeContexts = [],
  sidePanelOpen = async () => {},
  synchronizeFallbackQueries = false,
  contextMenuRemoveAll = async () => {},
  blockStorageGet = false,
} = {}) {
  const activeTab = { id: 7, windowId: 8 };
  const extensionTabs = [];
  const createdTabs = [];
  const updatedTabs = [];
  const focusedWindows = [];
  const sidePanelOpenCalls = [];
  const sidePanelOptions = [];
  const contextMenuCreateCalls = [];
  let contextMenuRemoveAllCalls = 0;
  let actionHandler = null;
  let installedHandler = null;
  let startupHandler = null;
  let contextMenuHandler = null;
  let runtimeMessageHandler = null;
  let releaseStorageGet = null;
  const storageGetGate = blockStorageGet
    ? new Promise((resolve) => { releaseStorageGet = resolve; })
    : Promise.resolve();
  const chromeApi = {
    runtime: {
      getManifest: () => ({ side_panel: { default_path: 'sidepanel.html' } }),
      getURL: (value) => `chrome-extension://test/${value}`,
      getContexts: async () => runtimeContexts,
      onInstalled: { addListener(handler) { installedHandler = handler; } },
      onStartup: { addListener(handler) { startupHandler = handler; } },
      onMessage: { addListener(handler) { runtimeMessageHandler = handler; } },
    },
    storage: {
      local: {
        get: async () => {
          await storageGetGate;
          return { hermesBrowserSettings: { panelResidencyMode } };
        },
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
      setOptions: async (options) => { sidePanelOptions.push(options); },
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
    contextMenus: {
      onClicked: { addListener(handler) { contextMenuHandler = handler; } },
      removeAll: async () => {
        contextMenuRemoveAllCalls += 1;
        return contextMenuRemoveAll(contextMenuRemoveAllCalls);
      },
      create: (options, callback) => {
        contextMenuCreateCalls.push(options);
        callback?.();
      },
    },
  };

  return {
    chromeApi,
    activeTab,
    createdTabs,
    updatedTabs,
    focusedWindows,
    sidePanelOpenCalls,
    sidePanelOptions,
    contextMenuCreateCalls,
    get contextMenuRemoveAllCalls() { return contextMenuRemoveAllCalls; },
    get actionHandler() { return actionHandler; },
    get installedHandler() { return installedHandler; },
    get startupHandler() { return startupHandler; },
    get contextMenuHandler() { return contextMenuHandler; },
    get runtimeMessageHandler() { return runtimeMessageHandler; },
    releaseStorageGet() { releaseStorageGet?.(); },
  };
}

test('background registers MV3 listeners before locale and residency storage hydration completes', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness({ blockStorageGet: true });
  globalThis.chrome = harness.chromeApi;

  try {
    const imported = await Promise.race([
      import(`../extension/background.js?cold-listener-registration=${Date.now()}`),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);
    assert.notEqual(imported, 'timed-out', 'module evaluation must not await storage hydration');
    assert.equal(typeof harness.installedHandler, 'function');
    assert.equal(typeof harness.startupHandler, 'function');
    assert.equal(typeof harness.actionHandler, 'function');
    assert.equal(typeof harness.contextMenuHandler, 'function');
    assert.equal(typeof harness.runtimeMessageHandler, 'function');

    const result = await harness.contextMenuHandler({ menuItemId: 'invalid' }, harness.activeTab);
    assert.deepEqual(result, { ok: false, reason: 'unknown-menu-item' });
  } finally {
    harness.releaseStorageGet();
    globalThis.chrome = originalChrome;
  }
});

test('global residency updates only the default path and preserves existing tab overrides', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness({ panelResidencyMode: 'global' });
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?global-residency=${Date.now()}`);
    assert.equal(typeof harness.installedHandler, 'function');
    await harness.installedHandler();
    assert.deepEqual(harness.sidePanelOptions, [{
      path: 'sidepanel.html?panel=global',
      enabled: true,
    }]);
    assert.equal(
      harness.sidePanelOptions.some((options) => Object.hasOwn(options, 'tabId')),
      false,
      'global mode must not rewrite tabs that already own attached panel documents',
    );
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('background serializes concurrent lifecycle context-menu configuration', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness({
    contextMenuRemoveAll: async () => new Promise((resolve) => setTimeout(resolve, 20)),
  });
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?concurrent-context-menus=${Date.now()}`);
    assert.equal(typeof harness.installedHandler, 'function');
    assert.equal(typeof harness.startupHandler, 'function');
    await Promise.all([harness.installedHandler(), harness.startupHandler()]);
    assert.equal(harness.contextMenuRemoveAllCalls, 1, 'concurrent lifecycle events must share one configuration attempt');
    assert.equal(harness.contextMenuCreateCalls.length, 7, 'one root and six child menus must be created exactly once');
    assert.equal(new Set(harness.contextMenuCreateCalls.map((item) => item.id)).size, 7);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('background retries context-menu configuration after a failed removal', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness({
    contextMenuRemoveAll: async (attempt) => {
      if (attempt === 1) throw new Error('context menu removal failed');
    },
  });
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?retry-context-menus=${Date.now()}`);
    await assert.rejects(harness.installedHandler(), /context menu removal failed/);
    await harness.startupHandler();
    assert.equal(harness.contextMenuRemoveAllCalls, 2, 'a failed attempt must not poison later lifecycle retries');
    assert.equal(harness.contextMenuCreateCalls.length, 7);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('action listener opens the side panel synchronously before storage hydration or setOptions', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness({ blockStorageGet: true });
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?action-open-before-hydration=${Date.now()}`);
    assert.equal(typeof harness.actionHandler, 'function');

    const actionPromise = harness.actionHandler(harness.activeTab);
    // Storage hydration is deliberately blocked: the user-gesture open must
    // already be in flight before any await, setOptions, or native probe.
    assert.deepEqual(
      harness.sidePanelOpenCalls,
      [{ tabId: 7 }],
      'sidePanel.open must be invoked synchronously in the action listener stack',
    );
    assert.deepEqual(
      harness.sidePanelOptions,
      [],
      'setOptions must not run before the synchronous open attempt',
    );

    harness.releaseStorageGet();
    await actionPromise;
    assert.equal(
      harness.createdTabs.length,
      0,
      'a resolved side-panel request must never create a duplicate extension tab',
    );
  } finally {
    harness.releaseStorageGet();
    globalThis.chrome = originalChrome;
  }
});

test('background action never opens a full tab after resolved side-panel requests', async () => {
  const originalChrome = globalThis.chrome;
  const harness = createBackgroundHarness();
  globalThis.chrome = harness.chromeApi;

  try {
    await import(`../extension/background.js?silent-side-panel=${Date.now()}`);
    assert.equal(typeof harness.actionHandler, 'function');
    await harness.actionHandler(harness.activeTab);
    await harness.actionHandler(harness.activeTab);
    assert.equal(harness.createdTabs.length, 0, 'resolved native requests must remain side-panel-only');
    assert.deepEqual(harness.updatedTabs, []);
    assert.deepEqual(harness.focusedWindows, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('background action keeps concurrent resolved side-panel requests tab-free', async () => {
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
    assert.equal(harness.createdTabs.length, 0, 'concurrent resolved requests must not create a full tab');
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('background action does not open a full tab when side-panel visibility confirmation is missed', async () => {
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
    assert.deepEqual(
      harness.sidePanelOpenCalls,
      [{ tabId: 7 }],
      'a gesture open makes one correctly scoped attempt without a window-scope retry',
    );
    assert.deepEqual(harness.createdTabs, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('background action does not re-open the side panel after a failed tab-scoped gesture attempt', async () => {
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
    assert.deepEqual(
      harness.sidePanelOpenCalls,
      [{ tabId: 7 }],
      'a failed gesture attempt must not trigger a second side-panel open',
    );
    assert.equal(harness.createdTabs.length, 1, 'the gesture-free fallback must open exactly one extension tab');
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

test('build-firefox.mjs applies the Firefox manifest profile and adds Gecko settings', () => {
  const source = readFileSync(new URL('../scripts/build-firefox.mjs', import.meta.url), 'utf8');
  assert.match(source, /manifest-profiles\.mjs/);
  assert.match(source, /manifestAssumptionsFor\(MANIFEST_TARGETS\.FIREFOX\)/);
  assert.match(source, /firefoxProfile\.removedManifestKeys/);
  assert.match(source, /firefoxProfile\.removedPermissions/);
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
