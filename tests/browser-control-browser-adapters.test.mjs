import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROLLER_ADAPTER_IDS } from '../extension/lib/browser-controller-adapter.mjs';

async function adaptersModule() {
  try {
    return await import('../extension/lib/browser-control-browser-adapters.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser adapters module is required: ${error?.message || error}`);
  }
}

function chromiumApis({ failMethod = '' } = {}) {
  const calls = [];
  const detachListeners = [];
  const tabs = new Map([
    [7, { id: 7, windowId: 4, active: true, title: 'Example', url: 'https://example.test/start' }],
    [8, { id: 8, windowId: 4, active: false, title: 'Other', url: 'https://other.test/' }],
  ]);
  const api = {
    debugger: {
      attach: async (target, version) => { calls.push(['attach', target, version]); },
      detach: async (target) => { calls.push(['detach', target]); },
      onDetach: {
        addListener(listener) { detachListeners.push(listener); },
        removeListener(listener) {
          const index = detachListeners.indexOf(listener);
          if (index >= 0) detachListeners.splice(index, 1);
        },
      },
      sendCommand: async (target, method, params = {}) => {
        calls.push(['command', target, method, params]);
        if (method === failMethod) throw new Error(`forced ${method} failure`);
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { nodeId: '1', backendDOMNodeId: 44, role: { value: 'button' }, name: { value: 'Search' }, ignored: false },
              { nodeId: '2', backendDOMNodeId: 45, role: { value: 'textbox' }, name: { value: 'Password' }, properties: [{ name: 'editable', value: { value: 'plaintext' } }], ignored: false },
              { nodeId: '3', role: { value: 'StaticText' }, name: { value: 'Public page text' }, ignored: false },
            ],
          };
        }
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
        }
        if (method === 'Page.getNavigationHistory') {
          return { currentIndex: 1, entries: [{ id: 2, url: 'https://example.test/old' }, { id: 3, url: 'https://example.test/start' }] };
        }
        if (method === 'Page.captureScreenshot') return { data: 'ZmFrZS1wbmc=' };
        return {};
      },
    },
    tabs: {
      get: async (tabId) => ({ ...tabs.get(tabId) }),
      query: async () => [...tabs.values()].map((tab) => ({ ...tab })),
      update: async (tabId, changes) => {
        calls.push(['tabs.update', tabId, changes]);
        const next = { ...tabs.get(tabId), ...changes };
        tabs.set(tabId, next);
        return { ...next };
      },
      create: async (details) => {
        calls.push(['tabs.create', details]);
        const id = Math.max(...tabs.keys()) + 1;
        const next = { id, windowId: details.windowId || 4, active: details.active !== false, url: details.url };
        tabs.set(id, next);
        return { ...next };
      },
      remove: async (tabId) => {
        calls.push(['tabs.remove', tabId]);
        tabs.delete(Number(tabId));
      },
      group: async (details) => { calls.push(['tabs.group', details]); return 91; },
      ungroup: async (tabIds) => { calls.push(['tabs.ungroup', tabIds]); },
    },
    scripting: {
      executeScript: async (details) => {
        calls.push(['executeScript', details.target]);
        return [{ result: { hasUnsavedContent: false } }];
      },
    },
  };
  return {
    api,
    calls,
    emitDetach(tabId, reason) {
      for (const listener of [...detachListeners]) listener({ tabId }, reason);
    },
    detachListeners,
  };
}

function firefoxApis() {
  const calls = [];
  const tabs = new Map([
    [7, { id: 7, windowId: 4, active: true, title: 'Example', url: 'https://example.test/start' }],
    [8, { id: 8, windowId: 4, active: false, title: 'Other', url: 'https://other.test/' }],
  ]);
  const api = {
    tabs: {
      get: async (tabId) => ({ ...tabs.get(tabId) }),
      query: async () => [...tabs.values()].map((tab) => ({ ...tab })),
      update: async (tabId, changes) => {
        calls.push(['tabs.update', tabId, changes]);
        const next = { ...tabs.get(tabId), ...changes };
        tabs.set(tabId, next);
        return { ...next };
      },
      goBack: async (tabId) => { calls.push(['tabs.goBack', tabId]); },
      captureVisibleTab: async (windowId, options) => {
        calls.push(['captureVisibleTab', windowId, options]);
        return 'data:image/png;base64,ZmFrZQ==';
      },
      create: async (details) => {
        calls.push(['tabs.create', details]);
        const id = Math.max(...tabs.keys()) + 1;
        const next = { id, windowId: details.windowId || 4, active: details.active !== false, url: details.url };
        tabs.set(id, next);
        return { ...next };
      },
      remove: async (tabId) => {
        calls.push(['tabs.remove', tabId]);
        tabs.delete(Number(tabId));
      },
    },
    scripting: {
      executeScript: async (details) => {
        calls.push(['executeScript', details.target]);
        if (Array.isArray(details.args) && details.args.includes('snapshot')) {
          return [{ result: {
            title: 'Example',
            url: 'https://example.test/start',
            text: 'Public page text',
            nodes: [{ role: 'button', name: 'Search', selector: '[data-hermes-ref="1"]' }],
          } }];
        }
        return [{ result: { ok: true, hasUnsavedContent: false } }];
      },
    },
  };
  return { api, calls };
}

const scope = Object.freeze({ tabId: 7, frameId: 0 });

test('Chromium Phase 6 adapter snapshots AX refs through CDP and always detaches', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  assert.equal(adapter.contract.id, CONTROLLER_ADAPTER_IDS.CHROMIUM_CDP);
  const snapshot = await adapter.execute('browser_snapshot', {}, { scope, signal: new AbortController().signal });
  assert.equal(snapshot.title, 'Example');
  assert.equal(snapshot.url, 'https://example.test/start');
  assert.match(snapshot.text, /Public page text/);
  assert.deepEqual(snapshot.nodes.map((node) => [node.role, node.name, node.backendDOMNodeId]), [
    ['button', 'Search', 44],
    ['textbox', 'Password', 45],
  ]);
  assert.deepEqual(calls.map((call) => call[0] === 'command' ? `${call[0]}:${call[2]}` : call[0]), [
    'attach',
    'command:Accessibility.enable',
    'command:Accessibility.getFullAXTree',
    'detach',
  ]);
});

test('Chromium Phase 6 adapter emits trusted click, type, press, scroll, navigation, back, and screenshot sequences', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const signal = new AbortController().signal;
  const target = { backendDOMNodeId: 44 };

  await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal, target });
  await adapter.execute('browser_type', { ref: '@e1', text: 'hello' }, { scope, signal, target });
  await adapter.execute('browser_press', { key: 'Enter' }, { scope, signal });
  await adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal });
  await adapter.execute('browser_navigate', { url: 'https://example.test/next' }, { scope, signal });
  await adapter.execute('browser_back', {}, { scope, signal });
  const screenshot = await adapter.execute('browser_screenshot', {}, { scope, signal });

  const methods = calls.filter((call) => call[0] === 'command').map((call) => call[2]);
  assert.deepEqual(methods, [
    'DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
    'DOM.focus', 'Input.insertText', 'DOM.resolveNode',
    'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
    'Runtime.evaluate',
    'Page.navigate',
    'Page.getNavigationHistory', 'Page.navigateToHistoryEntry',
    'Page.captureScreenshot',
  ]);
  const mouse = calls.find((call) => call[0] === 'command' && call[2] === 'Input.dispatchMouseEvent' && call[3].type === 'mousePressed');
  assert.deepEqual({ x: mouse[3].x, y: mouse[3].y, button: mouse[3].button }, { x: 20, y: 30, button: 'left' });
  const typed = calls.find((call) => call[0] === 'command' && call[2] === 'Input.insertText');
  assert.equal(typed[3].text, 'hello');
  const scroll = calls.find((call) => call[0] === 'command' && call[2] === 'Runtime.evaluate');
  assert.match(scroll[3].expression, /window\.scrollBy/);
  assert.match(scroll[3].expression, /top:600/);
  assert.doesNotMatch(scroll[3].expression, /down|args|direction|javascript:/i);
  assert.equal(screenshot.dataUrl, 'data:image/png;base64,ZmFrZS1wbmc=');
  assert.equal(calls.filter((call) => call[0] === 'attach').length, 7);
  assert.equal(calls.filter((call) => call[0] === 'detach').length, 7);
});

test('Chromium parity primitives hover drag scroll-to modifiers clipped screenshots and reactive typing', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.api.debugger.sendCommand = async (target, method, params = {}) => {
    chromium.calls.push(['command', target, method, params]);
    if (method === 'DOM.getBoxModel') return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-44' } };
    if (method === 'Page.captureScreenshot') return { data: 'ZmFrZS1wbmc=' };
    return {};
  };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const signal = new AbortController().signal;
  const source = { backendDOMNodeId: 44 };
  const destination = { backendDOMNodeId: 46 };

  await adapter.execute('browser_hover', { ref: '@e1' }, { scope, signal, target: source });
  await adapter.execute('browser_drag', { ref: '@e1', to_ref: '@e2' }, { scope, signal, target: source, destination });
  await adapter.execute('browser_scroll_to', { ref: '@e1' }, { scope, signal, target: source });
  await adapter.execute('browser_press', { key: 'k', modifiers: ['ctrl', 'shift'] }, { scope, signal });
  await adapter.execute('browser_type', { ref: '@e1', text: 'reactive fixture' }, { scope, signal, target: source });
  const screenshot = await adapter.execute('browser_screenshot', { ref: '@e1', zoom: 2 }, { scope, signal, target: source });
  await adapter.execute('browser_click', { x: 25, y: 35 }, { scope, signal });

  const commands = chromium.calls.filter((call) => call[0] === 'command');
  const mouse = commands.filter((call) => call[2] === 'Input.dispatchMouseEvent').map((call) => call[3]);
  assert.deepEqual(mouse.map(({ type, button }) => [type, button || 'none']), [
    ['mouseMoved', 'none'],
    ['mouseMoved', 'none'], ['mousePressed', 'left'], ['mouseMoved', 'left'], ['mouseReleased', 'left'],
    ['mousePressed', 'left'], ['mouseReleased', 'left'],
  ]);
  const keyDown = commands.find((call) => call[2] === 'Input.dispatchKeyEvent' && call[3].type === 'rawKeyDown');
  assert.equal(keyDown[3].modifiers, 10);
  assert.equal(commands.some((call) => call[2] === 'DOM.scrollIntoViewIfNeeded'), true);
  const reactive = commands.find((call) => call[2] === 'Runtime.callFunctionOn');
  assert.equal(reactive[3].objectId, 'object-44');
  assert.match(reactive[3].functionDeclaration, /input/);
  assert.match(reactive[3].functionDeclaration, /change/);
  assert.doesNotMatch(reactive[3].functionDeclaration, /reactive fixture/);
  const capture = commands.find((call) => call[2] === 'Page.captureScreenshot');
  assert.deepEqual(capture[3].clip, { x: 10, y: 20, width: 20, height: 20, scale: 2 });
  assert.equal(screenshot.dataUrl, 'data:image/png;base64,ZmFrZS1wbmc=');
});

test('Chromium Phase 6 adapter detaches after CDP failure and aborts before later commands', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis({ failMethod: 'DOM.getBoxModel' });
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  await assert.rejects(
    adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: new AbortController().signal, target: { backendDOMNodeId: 44 } }),
    /forced DOM\.getBoxModel failure/,
  );
  assert.equal(calls.at(-1)[0], 'detach');

  const aborted = new AbortController();
  aborted.abort(new Error('cancelled'));
  const before = calls.length;
  await assert.rejects(adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal: aborted.signal }), /cancelled/i);
  assert.equal(calls.length, before);
});

test('Chromium adapter reports external debugger detach reasons but suppresses its own command cleanup', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    onDebuggerDetach: (event) => events.push(event),
  });

  chromium.api.debugger.detach = async (target) => {
    chromium.calls.push(['detach', target]);
    chromium.emitDetach(target.tabId, 'canceled_by_user');
  };
  await adapter.execute('browser_snapshot', {}, { scope, signal: new AbortController().signal });
  assert.deepEqual(events, [], 'extension cleanup must not pause its own lease');

  chromium.emitDetach(7, 'replaced_with_devtools');
  chromium.emitDetach(7, 'target_closed');
  assert.deepEqual(events, [
    { tabId: 7, reason: 'replaced_with_devtools', recoverable: false },
    { tabId: 7, reason: 'target_closed', recoverable: false },
  ]);
  adapter.dispose();
  assert.equal(chromium.detachListeners.length, 0);
});

test('Chromium adapter reports another-debugger conflicts truthfully and never issues CDP commands', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.api.debugger.attach = async () => {
    throw new Error('Another debugger is already attached to the tab');
  };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  await assert.rejects(
    adapter.execute('browser_snapshot', {}, { scope, signal: new AbortController().signal }),
    (error) => error?.code === 'debugger_conflict' && /another debugger/i.test(error.message),
  );
  assert.equal(chromium.calls.some((call) => call[0] === 'command'), false);
});

test('Phase 6 screenshot adapters reject oversize inline payloads instead of returning corrupt truncation', async () => {
  const { createChromiumCdpAdapter, createFirefoxWebExtensionAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.api.debugger.sendCommand = async (_target, method) => {
    chromium.calls.push(['command', _target, method]);
    if (method === 'Page.captureScreenshot') return { data: 'A'.repeat(1_500_001) };
    return {};
  };
  await assert.rejects(
    createChromiumCdpAdapter({ browserApi: chromium.api }).execute(
      'browser_screenshot', {}, { scope, signal: new AbortController().signal },
    ),
    /screenshot_too_large/,
  );

  const firefox = firefoxApis();
  firefox.api.tabs.captureVisibleTab = async () => `data:image/png;base64,${'A'.repeat(1_500_001)}`;
  await assert.rejects(
    createFirefoxWebExtensionAdapter({ browserApi: firefox.api }).execute(
      'browser_screenshot', {}, { scope, signal: new AbortController().signal },
    ),
    /screenshot_too_large/,
  );
});

test('Phase 6 tab listing redacts restricted leased-tab metadata', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api } = chromiumApis();
  api.tabs.query = async () => [{
    id: 7,
    windowId: 4,
    active: true,
    title: 'Private wallet',
    url: 'https://example.test/account/wallet',
    favIconUrl: 'https://example.test/private.ico',
  }];
  const result = await createChromiumCdpAdapter({ browserApi: api }).execute(
    'browser_tabs', {}, { scope, leasedTabIds: [7], signal: new AbortController().signal },
  );
  assert.deepEqual(result.tabs, [{
    id: 7,
    active: true,
    pinned: false,
    audible: false,
    title: '(restricted tab)',
    url: '(omitted by privacy guard)',
    favIconUrl: '',
  }]);
});

test('Phase 6 adapters create and close owned tabs while Chromium alone groups task tabs', async () => {
  const { createChromiumCdpAdapter, createFirefoxWebExtensionAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const chrome = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, leasedTabIds: [7, 8], ownedTabIds: [7, 8], signal: new AbortController().signal };
  assert.deepEqual(await chrome.execute('browser_tab_create', { url: 'https://example.test/new', active: false }, context), {
    tab: { id: 9, windowId: 4, active: false, url: 'https://example.test/new' },
  });
  await chrome.execute('browser_tab_group', { tab_ids: [7, 8] }, context);
  await chrome.execute('browser_tab_ungroup', { tab_ids: [7, 8] }, context);
  await chrome.execute('browser_tab_close', { tab_id: 8 }, context);
  assert.deepEqual(chromium.calls.filter((call) => call[0].startsWith('tabs.')), [
    ['tabs.create', { url: 'https://example.test/new', active: false, windowId: 4 }],
    ['tabs.group', { tabIds: [7, 8] }],
    ['tabs.ungroup', [7, 8]],
    ['tabs.remove', 8],
  ]);
  await assert.rejects(chrome.execute('browser_tab_close', { tab_id: 99 }, context), /owned/i);

  const firefox = firefoxApis();
  const fox = createFirefoxWebExtensionAdapter({ browserApi: firefox.api });
  const foxCreated = await fox.execute('browser_tab_create', { url: 'https://example.test/new', active: true }, context);
  assert.equal(foxCreated.tab.id, 9);
  await fox.execute('browser_tab_close', { tab_id: 8 }, context);
  await assert.rejects(fox.execute('browser_tab_group', { tab_ids: [7, 8] }, context), /not supported/i);
});

test('Phase 6 inspection does not inject a page probe into restricted surfaces', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api, calls } = firefoxApis();
  api.tabs.get = async () => ({ id: 7, url: 'https://example.test/account/wallet' });
  const inspected = await createFirefoxWebExtensionAdapter({ browserApi: api }).inspect({
    tabId: 7,
    frameId: 0,
    signal: new AbortController().signal,
  });
  assert.deepEqual(inspected, {
    currentUrl: 'https://example.test/account/wallet',
    hasUnsavedContent: false,
  });
  assert.equal(calls.some((call) => call[0] === 'executeScript'), false);
});

test('Firefox Phase 6 adapter runs only the truthful safe WebExtension subset', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api, calls } = firefoxApis();
  const adapter = createFirefoxWebExtensionAdapter({ browserApi: api });
  assert.equal(adapter.contract.id, CONTROLLER_ADAPTER_IDS.FIREFOX_WEBEXTENSION);
  assert.equal(adapter.contract.actions.includes('browser_click'), false);

  const snapshot = await adapter.execute('browser_snapshot', {}, { scope, signal: new AbortController().signal });
  assert.equal(snapshot.nodes[0].name, 'Search');
  await adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal: new AbortController().signal });
  await adapter.execute('browser_navigate', { url: 'https://example.test/next' }, { scope, signal: new AbortController().signal });
  await adapter.execute('browser_back', {}, { scope, signal: new AbortController().signal });
  const screenshot = await adapter.execute('browser_screenshot', {}, { scope, signal: new AbortController().signal });
  const tabs = await adapter.execute('browser_tabs', {}, { scope, leasedTabIds: [7, 8], signal: new AbortController().signal });
  await adapter.execute('browser_tab_activate', { tab_id: 8 }, { scope, signal: new AbortController().signal });

  assert.equal(screenshot.dataUrl, 'data:image/png;base64,ZmFrZQ==');
  assert.equal(tabs.tabs.length, 2);
  assert.deepEqual(calls.map((call) => call[0]), [
    'executeScript', 'executeScript', 'tabs.update', 'tabs.goBack', 'captureVisibleTab', 'tabs.update',
  ]);
  await assert.rejects(
    adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: new AbortController().signal }),
    /not supported/i,
  );
});
