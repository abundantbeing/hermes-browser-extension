import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { CONTROLLER_ADAPTER_IDS } from '../extension/lib/browser-controller-adapter.mjs';

async function adaptersModule() {
  try {
    return await import('../extension/lib/browser-control-browser-adapters.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser adapters module is required: ${error?.message || error}`);
  }
}

// Deterministic time for load waits and settle: sleeping advances the clock.
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
  };
}

function chromiumApis({ failMethod = '' } = {}) {
  const calls = [];
  const detachListeners = [];
  const eventListeners = [];
  // Per-method overrides: handlers[method] = (params) => result (may throw).
  const handlers = {};
  const tabs = new Map([
    [7, { id: 7, windowId: 4, active: true, status: 'complete', title: 'Example', url: 'https://example.test/start' }],
    [8, { id: 8, windowId: 4, active: false, status: 'complete', title: 'Other', url: 'https://other.test/' }],
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
      onEvent: {
        addListener(listener) { eventListeners.push(listener); },
        removeListener(listener) {
          const index = eventListeners.indexOf(listener);
          if (index >= 0) eventListeners.splice(index, 1);
        },
      },
      sendCommand: async (target, method, params = {}) => {
        calls.push(['command', target, method, params]);
        if (method === failMethod) throw new Error(`forced ${method} failure`);
        if (handlers[method]) return handlers[method](params, target);
        if (method === 'Page.navigate') {
          tabs.set(target.tabId, { ...tabs.get(target.tabId), url: params.url, title: 'Next page' });
          return { frameId: 'main-frame', loaderId: 'loader-1' };
        }
        if (method === 'Page.navigateToHistoryEntry') {
          tabs.set(target.tabId, { ...tabs.get(target.tabId), url: 'https://example.test/old', title: 'Old page' });
          return {};
        }
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
        if (method === 'Page.getFrameTree') {
          // A tab with no child frames unless a test says otherwise.
          return { frameTree: { frame: { id: 'MAIN' } } };
        }
        if (method === 'Accessibility.getFullAXTree') {
          // A child frame is described by its own tree. The shared mock has
          // nothing to say about one, so it stays empty.
          if (params.frameId) return { nodes: [] };
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
    tabs,
    handlers,
    emitDetach(tabId, reason) {
      for (const listener of [...detachListeners]) listener({ tabId }, reason);
    },
    emitEvent(tabId, method, params = {}) {
      for (const listener of [...eventListeners]) listener({ tabId }, method, params);
    },
    detachListeners,
    eventListeners,
  };
}

const commandMethods = (calls) => calls.filter((call) => call[0] === 'command').map((call) => call[2]);
const countCalls = (calls, name) => calls.filter((call) => call[0] === name).length;
const openSignal = () => new AbortController().signal;
const clickTarget = { backendDOMNodeId: 44 };
// The model-facing advice for a background tab. Hover and drag are the only input
// that cannot run there; a screenshot of a background tab can still succeed.
const HIDDEN_TAB_MESSAGE = "This tab is in the background, so hover and drag can't run there. Ask the user to bring it to the front with Show tab in Hermes Control, or use click, type or scroll, which work in background tabs.";
const HIDDEN_SCREENSHOT_MESSAGE = 'This tab is in the background, so the screenshot did not finish. Ask the user to bring it to the front with Show tab in Hermes Control, then try again.';

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

test('Chromium Phase 6 adapter snapshots AX refs through one persistent session and detaches on release', async () => {
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
    'command:Page.enable',
    'command:Page.getFrameTree',
    'command:Accessibility.getFullAXTree',
  ]);
  assert.equal(await adapter.releaseTab(7), true);
  assert.equal(calls.at(-1)[0], 'detach');
  // Chrome refuses to detach a tab that is not attached, which is what makes releasing an unattached tab a no-op.
  api.debugger.detach = async () => { throw new Error('Debugger is not attached to the tab with id: 7.'); };
  assert.equal(await adapter.releaseTab(7), false, 'releasing an unattached tab is a no-op');
});

test('Chromium snapshot includes a child frame so framed UI is reachable, and skips a frame that cannot be read', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls, handlers } = chromiumApis();
  // A live chat is its own frame: the main frame never holds the composer.
  handlers['Page.getFrameTree'] = () => ({
    frameTree: {
      frame: { id: 'MAIN' },
      childFrames: [{ frame: { id: 'CHAT' } }, { frame: { id: 'DEAD' } }],
    },
  });
  handlers['Accessibility.getFullAXTree'] = (params) => {
    if (params?.frameId === 'CHAT') {
      return {
        nodes: [
          { nodeId: '1', backendDOMNodeId: 46, role: { value: 'textbox' }, name: { value: 'Chat message' }, properties: [{ name: 'editable', value: { value: 'plaintext' } }], ignored: false },
          { nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Live chat text' }, ignored: false },
        ],
      };
    }
    if (params?.frameId === 'DEAD') throw new Error('Session with given id not found');
    return {
      nodes: [
        { nodeId: '1', backendDOMNodeId: 44, role: { value: 'button' }, name: { value: 'Search' }, ignored: false },
        { nodeId: '2', role: { value: 'StaticText' }, name: { value: 'Public page text' }, ignored: false },
      ],
    };
  };

  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const snapshot = await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });

  assert.match(snapshot.text, /Public page text/);
  assert.match(snapshot.text, /Live chat text/, 'the child frame text reaches the page view');
  assert.deepEqual(snapshot.nodes.map((node) => [node.role, node.name, node.backendDOMNodeId, node.frameId || '']), [
    ['button', 'Search', 44, ''],
    ['textbox', 'Chat message', 46, '1'],
  ], 'a child-frame node is ref-able and keeps the frame it came from');
  const axCalls = calls.filter((call) => call[0] === 'command' && call[2] === 'Accessibility.getFullAXTree');
  assert.deepEqual(axCalls.map((call) => call[3]?.frameId || ''), ['', 'CHAT', 'DEAD'],
    'the main frame and every child frame are described, and an unreadable frame does not fail the snapshot');
});

test('Chromium Phase 6 adapter emits trusted click, type, press, scroll, navigation, back, and screenshot sequences on one attach', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api, ...fakeClock() });
  const signal = new AbortController().signal;
  const target = { backendDOMNodeId: 44 };

  await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal, target });
  await adapter.execute('browser_type', { ref: '@e1', text: 'hello' }, { scope, signal, target });
  await adapter.execute('browser_press', { key: 'Enter' }, { scope, signal });
  await adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal });
  await adapter.execute('browser_navigate', { url: 'https://example.test/next' }, { scope, signal });
  await adapter.execute('browser_back', {}, { scope, signal });
  const screenshot = await adapter.execute('browser_screenshot', {}, { scope, signal });

  assert.deepEqual(commandMethods(calls), [
    'DOM.enable', 'DOM.scrollIntoViewIfNeeded', 'DOM.getBoxModel', 'DOM.getNodeForLocation', 'DOM.resolveNode',
    'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent',
    'DOM.focus', 'DOM.resolveNode', 'Input.insertText',
    'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
    'Page.getLayoutMetrics', 'Runtime.evaluate', 'Input.dispatchMouseEvent', 'Runtime.evaluate',
    'Page.enable', 'Page.navigate',
    'Page.getNavigationHistory', 'Page.navigateToHistoryEntry',
    'Runtime.evaluate', 'Page.captureScreenshot',
  ]);
  const mouse = calls.find((call) => call[0] === 'command' && call[2] === 'Input.dispatchMouseEvent' && call[3].type === 'mousePressed');
  assert.deepEqual({ x: mouse[3].x, y: mouse[3].y, button: mouse[3].button }, { x: 20, y: 30, button: 'left' });
  const typed = calls.find((call) => call[0] === 'command' && call[2] === 'Input.insertText');
  assert.equal(typed[3].text, 'hello');
  assert.equal(screenshot.dataUrl, 'data:image/png;base64,ZmFrZS1wbmc=');
  assert.equal(countCalls(calls, 'attach'), 1, 'one attach serves every operation on the tab');
  assert.equal(countCalls(calls, 'detach'), 0);
  assert.deepEqual(calls.find((call) => call[0] === 'attach').slice(1), [{ tabId: 7 }, '1.3']);
});

test('Chromium adapter attaches once for many operations and concurrent first use, enabling each domain once', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const context = { scope, signal: openSignal() };
  await Promise.all(Array.from({ length: 5 }, () => adapter.execute('browser_snapshot', {}, context)));
  for (let index = 0; index < 4; index += 1) await adapter.execute('browser_snapshot', {}, context);
  await adapter.execute('browser_click', { ref: '@e1' }, { ...context, target: clickTarget });
  await adapter.execute('browser_click', { ref: '@e1' }, { ...context, target: clickTarget });
  assert.equal(countCalls(calls, 'attach'), 1);
  assert.equal(countCalls(calls, 'detach'), 0);
  const methods = commandMethods(calls);
  assert.equal(methods.filter((method) => method === 'Accessibility.enable').length, 1);
  assert.equal(methods.filter((method) => method === 'DOM.enable').length, 1);
});

test('Chromium adapter targetBounds reuses the action session instead of attaching again', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const rect = await adapter.targetBounds({ scope, signal: openSignal(), target: clickTarget });
  assert.deepEqual(rect, { x: 10, y: 20, width: 20, height: 20 });
  await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget });
  assert.equal(countCalls(calls, 'attach'), 1);
  assert.equal(await adapter.targetBounds({ scope, signal: openSignal(), target: null }), null);
});

test('Chromium adapter detaches an idle session after the idle window and re-attaches on demand', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const timers = [];
  const cleared = new Set();
  const adapter = createChromiumCdpAdapter({
    browserApi: api,
    idleMs: 60_000,
    setTimer: (callback, ms) => { const handle = { callback, ms }; timers.push(handle); return handle; },
    clearTimer: (handle) => { cleared.add(handle); },
  });
  const context = { scope, signal: openSignal() };
  await adapter.execute('browser_snapshot', {}, context);
  const idleTimers = () => timers.filter((handle) => !cleared.has(handle) && handle.ms === 60_000);
  assert.equal(idleTimers().length, 1);
  await adapter.execute('browser_snapshot', {}, context);
  assert.equal(idleTimers().length, 1, 'each command restarts the single idle timer');
  assert.equal(countCalls(calls, 'detach'), 0);

  idleTimers()[0].callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(countCalls(calls, 'detach'), 1);
  await adapter.execute('browser_snapshot', {}, context);
  assert.equal(countCalls(calls, 'attach'), 2);
  assert.equal(commandMethods(calls).filter((method) => method === 'Accessibility.enable').length, 2, 'domains are re-enabled per session');
});

test('Chromium adapter does not idle-detach while a command is still running', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const timers = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    idleMs: 1_000,
    setTimer: (callback, ms) => { const handle = { callback, ms }; timers.push(handle); return handle; },
    clearTimer: () => {},
  });
  await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  const firstIdleTimer = timers.at(-1);
  let finish;
  chromium.handlers['Accessibility.getFullAXTree'] = (params) => (
    params?.frameId
      ? { nodes: [{ nodeId: '1', role: { value: 'StaticText' }, name: { value: 'Frame page text' }, ignored: false }] }
      : new Promise((resolve) => { finish = resolve; })
  );
  const pending = adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = timers.length;
  firstIdleTimer.callback();
  assert.equal(countCalls(chromium.calls, 'detach'), 0, 'a busy session is never detached');
  assert.equal(timers.length, before + 1, 'the idle timer is re-armed instead');
  finish({ nodes: [] });
  await pending;
});

test('Chromium adapter re-attaches once and retries when a command reports the debugger is not attached', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, signal: openSignal() };
  await adapter.execute('browser_snapshot', {}, context);

  let failures = 1;
  chromium.handlers['Accessibility.getFullAXTree'] = () => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('Debugger is not attached to the tab with id: 7.');
    }
    return { nodes: [] };
  };
  const snapshot = await adapter.execute('browser_snapshot', {}, context);
  assert.deepEqual(snapshot.nodes, []);
  assert.equal(countCalls(chromium.calls, 'attach'), 2);
  assert.equal(commandMethods(chromium.calls).filter((method) => method === 'Accessibility.enable').length, 2, 'the retry re-enables domains');

  failures = 2;
  await assert.rejects(adapter.execute('browser_snapshot', {}, context), /not attached/i);
  assert.equal(countCalls(chromium.calls, 'attach'), 3, 'one re-attach per failed command, never a loop');

  chromium.handlers['Accessibility.getFullAXTree'] = () => {
    throw new Error('Detached while handling command.');
  };
  await assert.rejects(adapter.execute('browser_snapshot', {}, context), /detached while handling/i);
});

test('Chromium adapter does not silently re-attach after an external detach already dropped the session', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, onDebuggerDetach: (event) => events.push(event) });
  const context = { scope, signal: openSignal() };
  await adapter.execute('browser_snapshot', {}, context);
  chromium.handlers['Accessibility.getFullAXTree'] = () => {
    chromium.emitDetach(7, 'canceled_by_user');
    throw new Error('Detached while handling command.');
  };
  await assert.rejects(adapter.execute('browser_snapshot', {}, context), /detached while handling/i);
  assert.equal(countCalls(chromium.calls, 'attach'), 1);
  assert.deepEqual(events, [{ tabId: 7, reason: 'canceled_by_user', recoverable: false }]);
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
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
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
    ['mouseMoved', 'none'], ['mousePressed', 'left'], ['mouseReleased', 'left'],
  ]);
  assert.deepEqual(mouse.slice(2, 5).map(({ buttons }) => buttons), [1, 1, 0], 'drag holds the left button while moving');
  const keyDown = commands.find((call) => call[2] === 'Input.dispatchKeyEvent' && call[3].type === 'rawKeyDown');
  assert.equal(keyDown[3].modifiers, 10);
  assert.equal(commands.some((call) => call[2] === 'DOM.scrollIntoViewIfNeeded'), true);
  const callFunctions = commands.filter((call) => call[2] === 'Runtime.callFunctionOn');
  assert.match(callFunctions[0][3].functionDeclaration, /select\(\)/, 'typing selects existing content first');
  const reactive = callFunctions.at(-1);
  assert.equal(reactive[3].objectId, 'object-44');
  assert.match(reactive[3].functionDeclaration, /input/);
  assert.match(reactive[3].functionDeclaration, /change/);
  assert.doesNotMatch(JSON.stringify(callFunctions), /reactive fixture/);
  const capture = commands.find((call) => call[2] === 'Page.captureScreenshot');
  assert.deepEqual(capture[3].clip, { x: 10, y: 20, width: 20, height: 20, scale: 2 });
  assert.equal(screenshot.dataUrl, 'data:image/png;base64,ZmFrZS1wbmc=');
});

test('Chromium Phase 6 adapter keeps its session after a CDP failure and aborts before later commands', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis({ failMethod: 'DOM.getBoxModel' });
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  await assert.rejects(
    adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: new AbortController().signal, target: { backendDOMNodeId: 44 } }),
    /forced DOM\.getBoxModel failure/,
  );
  assert.equal(countCalls(calls, 'detach'), 0, 'a failed command is not a reason to drop the session');

  const aborted = new AbortController();
  aborted.abort(new Error('cancelled'));
  const before = calls.length;
  await assert.rejects(adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal: aborted.signal }), /cancelled/i);
  assert.equal(calls.length, before);
  await adapter.releaseTab(7);
  assert.equal(calls.at(-1)[0], 'detach');
});

test('Chromium adapter reports external debugger detach reasons but never its own detaches', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    onDebuggerDetach: (event) => events.push(event),
  });
  const context = { scope, signal: openSignal() };

  // Chrome emits onDetach synchronously inside our own detach().
  chromium.api.debugger.detach = async (target) => {
    chromium.calls.push(['detach', target]);
    chromium.emitDetach(target.tabId, 'canceled_by_user');
  };
  await adapter.execute('browser_snapshot', {}, context);
  await adapter.releaseTab(7);
  assert.deepEqual(events, [], 'extension cleanup must not pause its own lease');

  // Chrome emits onDetach after the detach() promise already resolved.
  await adapter.execute('browser_snapshot', {}, context);
  chromium.api.debugger.detach = async (target) => { chromium.calls.push(['detach', target]); };
  await adapter.releaseTab(7);
  chromium.emitDetach(7, 'canceled_by_user');
  assert.deepEqual(events, [], 'a late event for our own detach is still expected');

  // The expectation is consumed: a later real detach is external and drops the session.
  await adapter.execute('browser_snapshot', {}, context);
  const attachesBefore = countCalls(chromium.calls, 'attach');
  chromium.emitDetach(7, 'replaced_with_devtools');
  chromium.emitDetach(7, 'target_closed');
  assert.deepEqual(events, [
    { tabId: 7, reason: 'replaced_with_devtools', recoverable: false },
    { tabId: 7, reason: 'target_closed', recoverable: false },
  ]);
  await adapter.execute('browser_snapshot', {}, context);
  assert.equal(countCalls(chromium.calls, 'attach'), attachesBefore + 1, 'the dropped session is re-created on the next command');
  await adapter.dispose();
  assert.equal(chromium.detachListeners.length, 0);
  assert.equal(chromium.eventListeners.length, 0);
});

test('Chromium adapter clears the expected-detach marker when no onDetach event follows', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const timers = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    onDebuggerDetach: (event) => events.push(event),
    setTimer: (callback, ms) => { const handle = { callback, ms }; timers.push(handle); return handle; },
    clearTimer: () => {},
  });
  await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  await adapter.releaseTab(7);
  const grace = timers.find((handle) => handle.ms === 1_000);
  assert.ok(grace, 'a bounded grace timer cleans up the marker');
  grace.callback();
  chromium.emitDetach(7, 'canceled_by_user');
  assert.deepEqual(events, [{ tabId: 7, reason: 'canceled_by_user', recoverable: false }]);
});

test('Chromium adapter recovers its own stale attachment but still reports a real debugger conflict', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const stale = chromiumApis();
  let attaches = 0;
  stale.api.debugger.attach = async (target, version) => {
    stale.calls.push(['attach', target, version]);
    attaches += 1;
    if (attaches === 1) throw new Error('Another debugger is already attached to the tab with id: 7.');
  };
  const events = [];
  const adapter = createChromiumCdpAdapter({ browserApi: stale.api, onDebuggerDetach: (event) => events.push(event) });
  const snapshot = await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  assert.equal(snapshot.title, 'Example');
  assert.deepEqual(stale.calls.slice(0, 3).map((call) => call[0]), ['attach', 'detach', 'attach']);
  assert.deepEqual(events, [], 'the recovery detach is ours, not an external one');

  const foreign = chromiumApis();
  foreign.api.debugger.attach = async () => { throw new Error('Another debugger is already attached to the tab with id: 7.'); };
  foreign.api.debugger.detach = async () => { throw new Error('Debugger is not attached to the tab with id: 7.'); };
  await assert.rejects(
    createChromiumCdpAdapter({ browserApi: foreign.api }).execute('browser_snapshot', {}, { scope, signal: openSignal() }),
    (error) => error?.code === 'debugger_conflict',
  );
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
  // The agent asking for a foreground tab changes nothing: the new tab opens in the background.
  assert.deepEqual(await chrome.execute('browser_tab_create', { url: 'https://example.test/new', active: true }, context), {
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
  assert.equal(foxCreated.tab.active, false);
  assert.deepEqual(firefox.calls.filter((call) => call[0] === 'tabs.create'), [
    ['tabs.create', { url: 'https://example.test/new', active: false, windowId: 4 }],
  ]);
  await fox.execute('browser_tab_close', { tab_id: 8 }, context);
  await assert.rejects(fox.execute('browser_tab_group', { tab_ids: [7, 8] }, context), /not supported/i);
});

test('Phase 6 inspection does not inject a page probe into restricted surfaces', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api, calls } = firefoxApis();
  api.tabs.get = async () => ({ id: 7, url: 'https://example.test/account/wallet', title: 'Wallet balance' });
  const inspected = await createFirefoxWebExtensionAdapter({ browserApi: api }).inspect({
    tabId: 7,
    frameId: 0,
    signal: new AbortController().signal,
  });
  // A restricted page's title is withheld everywhere, approval wording included.
  assert.deepEqual(inspected, {
    currentUrl: 'https://example.test/account/wallet',
    hasUnsavedContent: false,
    title: '',
  });
  assert.equal(calls.some((call) => call[0] === 'executeScript'), false);
});

test('Phase 2 light inspection reads only the tab URL and skips the page probe', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api, calls } = firefoxApis();
  api.tabs.get = async () => ({ id: 7, url: 'https://example.test/list', title: 'Reading list' });
  const adapter = createFirefoxWebExtensionAdapter({ browserApi: api });
  const light = await adapter.inspect({ tabId: 7, frameId: 0, signal: openSignal(), light: true });
  assert.deepEqual(light, { currentUrl: 'https://example.test/list', hasUnsavedContent: false, title: 'Reading list' });
  assert.equal(calls.some((call) => call[0] === 'executeScript'), false);
  await adapter.inspect({ tabId: 7, frameId: 0, signal: openSignal() });
  assert.equal(calls.some((call) => call[0] === 'executeScript'), true, 'the default probe still checks for unsaved content');
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

function mouseEvents(calls) {
  return calls
    .filter((call) => call[0] === 'command' && call[2] === 'Input.dispatchMouseEvent')
    .map((call) => call[3]);
}

test('Chromium click moves the pointer first and presses with the left button held', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const result = await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget });
  assert.deepEqual(result, { status: 'clicked' });
  assert.deepEqual(mouseEvents(calls), [
    { type: 'mouseMoved', x: 20, y: 30, button: 'none', buttons: 0 },
    { type: 'mousePressed', x: 20, y: 30, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 20, y: 30, button: 'left', buttons: 0, clickCount: 1 },
  ]);
  const hitTest = calls.find((call) => call[2] === 'DOM.getNodeForLocation');
  assert.deepEqual(hitTest[3], { x: 20, y: 30, includeUserAgentShadowDOM: true });
  assert.ok(commandMethods(calls).indexOf('DOM.getNodeForLocation') < commandMethods(calls).indexOf('Input.dispatchMouseEvent'));
});

test('Chromium click reports obscured when another element covers the point and still clicks', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['DOM.getNodeForLocation'] = () => ({ backendNodeId: 99 });
  chromium.handlers['DOM.resolveNode'] = ({ backendNodeId }) => ({ object: { objectId: `object-${backendNodeId}` } });
  let contained = false;
  chromium.handlers['Runtime.callFunctionOn'] = () => ({ result: { value: contained } });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, signal: openSignal(), target: clickTarget };

  assert.deepEqual(await adapter.execute('browser_click', { ref: '@e1' }, context), { status: 'clicked', obscured: true });
  assert.equal(mouseEvents(chromium.calls).map((event) => event.type).join(), 'mouseMoved,mousePressed,mouseReleased');
  const contains = chromium.calls.find((call) => call[2] === 'Runtime.callFunctionOn');
  assert.equal(contains[3].objectId, 'object-44');
  assert.deepEqual(contains[3].arguments, [{ objectId: 'object-99' }]);
  assert.match(contains[3].functionDeclaration, /contains/);

  contained = true;
  assert.deepEqual(await adapter.execute('browser_click', { ref: '@e1' }, context), { status: 'clicked' }, 'a child of the target is not an obstruction');

  chromium.handlers['DOM.getNodeForLocation'] = () => ({ backendNodeId: 44 });
  assert.deepEqual(await adapter.execute('browser_click', { ref: '@e1' }, context), { status: 'clicked' });
});

test('Chromium click never fails because the hit test failed', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['DOM.getNodeForLocation'] = () => { throw new Error('hit test unavailable'); };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const result = await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget });
  assert.deepEqual(result, { status: 'clicked' });
  assert.equal(mouseEvents(chromium.calls).length, 3);
});

test('Chromium coordinate clicks report no obscured state; their one hit test only looks for a new-tab link', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const result = await createChromiumCdpAdapter({ browserApi: api }).execute('browser_click', { x: 25.4, y: 35 }, { scope, signal: openSignal() });
  assert.deepEqual(result, { status: 'clicked' });
  assert.equal(calls.filter((call) => call[2] === 'DOM.getNodeForLocation').length, 1);
  assert.deepEqual(mouseEvents(calls).map(({ type, buttons }) => [type, buttons]), [
    ['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0],
  ]);
});

// A minimal element: the reads clickTargetOpensNewTab makes.
function fakeElement(tag, attributes = {}, parentElement = null, extra = {}) {
  const values = new Map(Object.entries(attributes));
  return {
    nodeType: 1,
    localName: tag,
    parentElement,
    getAttribute: (name) => (values.has(name) ? values.get(name) : null),
    ...extra,
  };
}

test('the background-tab modifier is Cmd on macOS and Ctrl on Windows and Linux', async () => {
  const { backgroundTabModifierFor } = await adaptersModule();
  // CDP modifier bits: Ctrl is 2, Meta (Cmd) is 4.
  assert.equal(backgroundTabModifierFor('macOS'), 4);
  assert.equal(backgroundTabModifierFor('MacIntel'), 4, 'navigator.platform on a Mac');
  for (const platform of ['Windows', 'Win32', 'Linux', 'Linux x86_64', 'Chrome OS', '']) {
    assert.equal(backgroundTabModifierFor(platform), 2, `${platform || 'an unknown platform'} uses Ctrl`);
  }
});

test('a click counts as opening a new tab when the link or submit it lands on targets another browsing context', async () => {
  const { clickTargetOpensNewTab } = await adaptersModule();
  const blankLink = fakeElement('a', { target: '_blank', href: '/next' });
  assert.equal(clickTargetOpensNewTab(blankLink), true);
  assert.equal(clickTargetOpensNewTab(fakeElement('span', {}, blankLink)), true, 'a click on the link text');
  assert.equal(clickTargetOpensNewTab({ nodeType: 3, parentElement: blankLink }), true, 'a text node inside the link');
  assert.equal(clickTargetOpensNewTab(fakeElement('a', { target: '_BLANK' })), true, 'target names are case-insensitive');
  assert.equal(clickTargetOpensNewTab(fakeElement('a', { target: 'reports' })), true, 'a named window');
  for (const target of ['_self', '_top', '_parent', '  ']) {
    assert.equal(clickTargetOpensNewTab(fakeElement('a', { target })), false, `target "${target}" stays in the tab`);
  }
  assert.equal(clickTargetOpensNewTab(fakeElement('a', { href: '/next' })), false, 'a link without a target');
  assert.equal(clickTargetOpensNewTab(fakeElement('div', { target: '_blank' })), false, 'only links and submits count');
  assert.equal(clickTargetOpensNewTab(null), false);

  const newTabForm = { getAttribute: (name) => (name === 'target' ? '_blank' : null) };
  const sameTabForm = { getAttribute: () => null };
  assert.equal(clickTargetOpensNewTab(fakeElement('button', {}, null, { form: newTabForm })), true, 'a button submits by default');
  assert.equal(clickTargetOpensNewTab(fakeElement('button', { type: 'submit' }, null, { form: newTabForm })), true);
  assert.equal(clickTargetOpensNewTab(fakeElement('input', { type: 'submit' }, null, { form: newTabForm })), true);
  assert.equal(clickTargetOpensNewTab(fakeElement('input', { type: 'image' }, null, { form: newTabForm })), true);
  assert.equal(clickTargetOpensNewTab(fakeElement('button', { formtarget: '_blank' }, null, { form: sameTabForm })), true, 'a formtarget on the button');
  assert.equal(clickTargetOpensNewTab(fakeElement('button', { formtarget: '_self' }, null, { form: newTabForm })), false, 'a formtarget overrides the form');
  assert.equal(clickTargetOpensNewTab(fakeElement('button', { type: 'button' }, null, { form: newTabForm })), false, 'a button that does not submit');
  assert.equal(clickTargetOpensNewTab(fakeElement('input', { type: 'text' }, null, { form: newTabForm })), false);
  assert.equal(clickTargetOpensNewTab(fakeElement('button', {}, null, { form: null })), false, 'nothing is submitted without a form');
  assert.equal(clickTargetOpensNewTab(fakeElement('button', {}, null, { form: sameTabForm })), false);
});

test('the in-page check is self-contained: its serialized source answers the same in an empty context', async () => {
  const { clickTargetOpensNewTab } = await adaptersModule();
  // The click path sends this source to the page, where no module binding exists: evaluate it in an empty context.
  const inPage = vm.runInNewContext(`(${clickTargetOpensNewTab.toString()})`, {});
  const link = fakeElement('a', { target: '_blank' });
  assert.equal(inPage(fakeElement('span', {}, link)), true);
  assert.equal(inPage(fakeElement('a', { target: '_self' })), false);
  // The base-target lookup and the shadow-root walk need no module scope either.
  assert.equal(inPage(fakeElement('a', { href: '/next' }, null, { ownerDocument: { querySelector: () => ({ getAttribute: () => '_blank' }) } })), true);
  assert.equal(inPage(fakeElement('span', {}, null, { getRootNode: () => ({ nodeType: 11, host: link }) })), true);
});

test('a click on a link that opens a new tab carries the modifier for the host platform; other clicks do not', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  // Node 44 is a link that opens a new tab; node 45 is an ordinary button.
  chromium.handlers['DOM.resolveNode'] = ({ backendNodeId }) => ({ object: { objectId: `object-${backendNodeId}` } });
  chromium.handlers['Runtime.callFunctionOn'] = ({ objectId }) => ({ result: { value: objectId === 'object-44' } });
  const signal = openSignal();
  const linux = createChromiumCdpAdapter({ browserApi: chromium.api, hostPlatform: 'Linux x86_64' });
  await linux.execute('browser_click', { ref: '@e1' }, { scope, signal, target: { backendDOMNodeId: 44 } });
  await linux.execute('browser_click', { ref: '@e2' }, { scope, signal, target: { backendDOMNodeId: 45 } });
  const mac = createChromiumCdpAdapter({ browserApi: chromium.api, hostPlatform: 'macOS' });
  await mac.execute('browser_click', { ref: '@e1' }, { scope, signal, target: { backendDOMNodeId: 44 } });
  const events = mouseEvents(chromium.calls);
  const modifiersOf = (type) => events.filter((event) => event.type === type).map((event) => event.modifiers ?? null);
  assert.deepEqual(modifiersOf('mousePressed'), [2, null, 4]);
  assert.deepEqual(modifiersOf('mouseReleased'), [2, null, 4], 'the release matches the press, so it is one ctrl-click');
  assert.ok(events.filter((event) => event.type === 'mouseMoved').every((event) => !('modifiers' in event)));
});

test('a coordinate click that lands on a new-tab link is sent with the modifier too', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['DOM.getNodeForLocation'] = () => ({ backendNodeId: 44 });
  chromium.handlers['DOM.resolveNode'] = () => ({ object: { objectId: 'object-44' } });
  chromium.handlers['Runtime.callFunctionOn'] = () => ({ result: { value: true } });
  await createChromiumCdpAdapter({ browserApi: chromium.api, hostPlatform: 'Windows' })
    .execute('browser_click', { x: 25, y: 35 }, { scope, signal: openSignal() });
  const press = mouseEvents(chromium.calls).find((event) => event.type === 'mousePressed');
  assert.equal(press.modifiers, 2);
});

test('a new-tab check that fails never blocks the click, which goes out as a plain click', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['DOM.resolveNode'] = () => ({ object: { objectId: 'object-44' } });
  chromium.handlers['Runtime.callFunctionOn'] = () => { throw new Error('Execution context was destroyed.'); };
  const result = await createChromiumCdpAdapter({ browserApi: chromium.api, hostPlatform: 'Linux' })
    .execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: { backendDOMNodeId: 44 } });
  assert.deepEqual(result, { status: 'clicked' });
  assert.deepEqual(mouseEvents(chromium.calls).map((event) => [event.type, 'modifiers' in event]), [
    ['mouseMoved', false], ['mousePressed', false], ['mouseReleased', false],
  ]);
});

test('a ref click whose centre is covered by a new-tab link is sent with the modifier, since the click lands on the link', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  // Node 44 is the image the ref names; node 46, a link to a new tab, covers its centre.
  chromium.handlers['DOM.getNodeForLocation'] = () => ({ backendNodeId: 46 });
  chromium.handlers['DOM.resolveNode'] = ({ backendNodeId }) => ({ object: { objectId: `object-${backendNodeId}` } });
  // The containment check passes an argument; the new-tab check asks about one node only.
  chromium.handlers['Runtime.callFunctionOn'] = ({ objectId, arguments: args }) => ({ result: { value: !args && objectId === 'object-46' } });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, hostPlatform: 'Linux' });
  assert.deepEqual(await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget }), { status: 'clicked', obscured: true });
  assert.equal(chromium.calls.filter((call) => call[2] === 'DOM.getNodeForLocation').length, 1, 'one hit test serves both the obscured check and the new-tab check');
  assert.deepEqual(mouseEvents(chromium.calls).map((event) => [event.type, event.modifiers ?? null]), [
    ['mouseMoved', null], ['mousePressed', 2], ['mouseReleased', 2],
  ]);

  // A covering element that is not a link leaves the click as it was.
  chromium.handlers['DOM.getNodeForLocation'] = () => ({ backendNodeId: 47 });
  const before = chromium.calls.length;
  await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget });
  assert.deepEqual(mouseEvents(chromium.calls.slice(before)).map((event) => 'modifiers' in event), [false, false, false]);
});

test('a link or form with no target attribute takes the target of the document base element', async () => {
  const { clickTargetOpensNewTab } = await adaptersModule();
  // A document with a <base target> of the given value, or no base element at all.
  const documentWithBase = (target) => ({
    querySelector: (selector) => (target !== undefined && selector === 'base[target]'
      ? { getAttribute: (name) => (name === 'target' ? target : null) }
      : null),
  });
  const blankBase = documentWithBase('_blank');
  const link = fakeElement('a', { href: '/next' }, null, { ownerDocument: blankBase });
  assert.equal(clickTargetOpensNewTab(link), true, 'a link without a target follows the base');
  assert.equal(clickTargetOpensNewTab(fakeElement('span', {}, link, { ownerDocument: blankBase })), true, 'a click on its text');
  assert.equal(clickTargetOpensNewTab(fakeElement('a', { target: '_self' }, null, { ownerDocument: blankBase })), false, 'the link\'s own target wins over the base');
  assert.equal(clickTargetOpensNewTab(fakeElement('a', { href: '/next' }, null, { ownerDocument: documentWithBase('_self') })), false, 'a base that keeps the tab');
  assert.equal(clickTargetOpensNewTab(fakeElement('a', { href: '/next' }, null, { ownerDocument: documentWithBase() })), false, 'no base element');
  assert.equal(clickTargetOpensNewTab(fakeElement('a', { href: '/next' })), false, 'a node without an owner document');

  const formWithoutTarget = { getAttribute: () => null };
  assert.equal(clickTargetOpensNewTab(fakeElement('button', {}, null, { form: formWithoutTarget, ownerDocument: blankBase })), true, 'a submit button in a form with no target follows the base');
  const formWithTarget = { getAttribute: (name) => (name === 'target' ? '_self' : null) };
  assert.equal(clickTargetOpensNewTab(fakeElement('button', {}, null, { form: formWithTarget, ownerDocument: blankBase })), false, 'the form\'s own target wins over the base');
});

test('the new-tab check walks out of a shadow root through its host, so a node in a shadow tree inside a new-tab link counts', async () => {
  const { clickTargetOpensNewTab } = await adaptersModule();
  const link = fakeElement('a', { target: '_blank', href: '/next' });
  // A custom element in the light DOM of the link hosts a shadow root. The clicked node sits inside that root, where parentElement is null.
  const inShadowRoot = (host) => ({ getRootNode: () => ({ nodeType: 11, host }) });
  assert.equal(clickTargetOpensNewTab(fakeElement('span', {}, null, inShadowRoot(fakeElement('x-card', {}, link)))), true);
  assert.equal(clickTargetOpensNewTab({ nodeType: 3, parentElement: null, ...inShadowRoot(fakeElement('x-card', {}, link)) }), true, 'a text node directly in the shadow root');
  const sameTabLink = fakeElement('a', { target: '_self', href: '/next' });
  assert.equal(clickTargetOpensNewTab(fakeElement('span', {}, null, inShadowRoot(fakeElement('x-card', {}, sameTabLink)))), false, 'a host in a link that stays in its tab');
  assert.equal(clickTargetOpensNewTab(fakeElement('span', {}, null, { getRootNode: () => ({ nodeType: 9 }) })), false, 'a node under the document has no host to walk to');
  assert.equal(clickTargetOpensNewTab(fakeElement('span', {}, null, { getRootNode: () => ({ nodeType: 11 }) })), false, 'a fragment root without a host');
});

test('an area with an href counts as a link, with its own target or the base target', async () => {
  const { clickTargetOpensNewTab } = await adaptersModule();
  assert.equal(clickTargetOpensNewTab(fakeElement('area', { href: '/next', target: '_blank' })), true);
  assert.equal(clickTargetOpensNewTab(fakeElement('area', { href: '/next', target: '_self' })), false);
  assert.equal(clickTargetOpensNewTab(fakeElement('area', { href: '/next' })), false, 'no target and no base');
  assert.equal(clickTargetOpensNewTab(fakeElement('area', { target: '_blank' })), false, 'an area without an href is not a link');
  const blankBase = { querySelector: (selector) => (selector === 'base[target]' ? { getAttribute: () => '_blank' } : null) };
  assert.equal(clickTargetOpensNewTab(fakeElement('area', { href: '/next' }, null, { ownerDocument: blankBase })), true, 'an area with no target follows the base');
});

test('Chromium type clears the field by default and appends only when clear is false', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['DOM.resolveNode'] = () => ({ object: { objectId: 'object-44' } });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, signal: openSignal(), target: clickTarget };

  assert.deepEqual(await adapter.execute('browser_type', { ref: '@e1', text: 'replacement' }, context), { status: 'typed' });
  assert.deepEqual(commandMethods(chromium.calls).filter((method) => method !== 'DOM.enable'), [
    'DOM.focus', 'DOM.resolveNode', 'Runtime.callFunctionOn', 'Input.insertText', 'Runtime.callFunctionOn',
  ]);
  const [clear, , events] = chromium.calls.filter((call) => call[2] === 'Runtime.callFunctionOn' || call[2] === 'Input.insertText');
  assert.match(clear[3].functionDeclaration, /\.select\(\)/);
  assert.match(clear[3].functionDeclaration, /isContentEditable/);
  assert.match(clear[3].functionDeclaration, /selectNodeContents/);
  assert.match(events[3].functionDeclaration, /"input"/);

  chromium.calls.length = 0;
  await adapter.execute('browser_type', { ref: '@e1', text: 'more', clear: false }, context);
  assert.deepEqual(commandMethods(chromium.calls), ['DOM.focus', 'DOM.resolveNode', 'Input.insertText', 'Runtime.callFunctionOn']);
  const last = chromium.calls.at(-1);
  assert.match(last[3].functionDeclaration, /"input"/);
  assert.doesNotMatch(JSON.stringify(chromium.calls), /select\(\)/);
  assert.equal(chromium.calls.find((call) => call[2] === 'Input.insertText')[3].text, 'more');
});

function keyEventsFrom(calls) {
  return calls.filter((call) => call[2] === 'Input.dispatchKeyEvent').map((call) => call[3]);
}

test('Chromium Enter sends a carriage-return text so implicit form submission fires', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  await adapter.execute('browser_press', { key: 'Enter' }, { scope, signal: openSignal() });
  await adapter.execute('browser_press', { key: 'Return' }, { scope, signal: openSignal() });
  await adapter.execute('browser_press', { key: 'Escape' }, { scope, signal: openSignal() });
  const events = keyEventsFrom(calls);
  assert.deepEqual(events[0], {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r',
  });
  assert.deepEqual(events[1], { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 });
  assert.equal(events[2].text, '\r', 'Return is Enter');
  assert.equal(events[4].type, 'rawKeyDown', 'keys without text use rawKeyDown');
  assert.equal('text' in events[4], false);
});

test('Chromium press accepts modifier combos in the key and keeps the modifiers option', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const press = (args) => adapter.execute('browser_press', args, { scope, signal: openSignal() });

  await press({ key: 'Control+a' });
  await press({ key: 'Meta+a' });
  await press({ key: 'Shift+Tab' });
  await press({ key: 'a' });
  await press({ key: 'Shift+a' });
  await press({ key: 'k', modifiers: ['ctrl', 'shift'] });
  await press({ key: 'Control+Shift+ArrowLeft' });
  await press({ key: 'Control++' });
  await press({ key: ' ' });
  const downs = keyEventsFrom(calls).filter((event) => event.type !== 'keyUp');

  assert.deepEqual(downs[0], { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  assert.deepEqual(downs[1], {
    type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'],
  });
  assert.deepEqual(downs[2], { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  assert.deepEqual(downs[3], {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a', unmodifiedText: 'a',
  });
  assert.equal(downs[4].text, 'A');
  assert.equal(downs[4].modifiers, 8);
  assert.equal(downs[5].modifiers, 10);
  assert.equal(downs[5].type, 'rawKeyDown');
  assert.equal(downs[6].key, 'ArrowLeft');
  assert.equal(downs[6].modifiers, 10);
  assert.equal(downs[7].key, '+');
  assert.equal(downs[7].modifiers, 2);
  assert.equal(downs[8].key, ' ');
  assert.equal(downs[8].text, ' ');
  await assert.rejects(press({ key: 'Hyper+a' }), /Unsupported key modifier/);
});

test('Chromium scroll sends a wheel event at the viewport centre and returns the new position', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const position = { scrollX: 0, scrollY: 680, maxY: 4_000, atTop: false, atBottom: false };
  chromium.handlers['Runtime.evaluate'] = () => ({ result: { value: position } });
  const waits = [];
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, sleep: async (ms) => { waits.push(ms); } });
  const context = { scope, signal: openSignal() };

  const down = await adapter.execute('browser_scroll', { direction: 'down' }, context);
  assert.deepEqual(down, { status: 'scrolled', position });
  assert.deepEqual(mouseEvents(chromium.calls), [{ type: 'mouseWheel', x: 500, y: 400, deltaX: 0, deltaY: 680 }]);
  assert.deepEqual(waits, [120], 'a short settle delay precedes the position read');
  assert.ok(commandMethods(chromium.calls).indexOf('Input.dispatchMouseEvent') < commandMethods(chromium.calls).lastIndexOf('Runtime.evaluate'));
  assert.match(chromium.calls.at(-1)[3].expression, /scrollY/);

  chromium.calls.length = 0;
  await adapter.execute('browser_scroll', { direction: 'up' }, context);
  await adapter.execute('browser_scroll', { direction: 'right', amount: 300 }, context);
  await adapter.execute('browser_scroll', { direction: 'page_down', amount: 50 }, context);
  await adapter.execute('browser_scroll', { direction: 'left', amount: 99_999 }, context);
  await adapter.execute('browser_scroll', { direction: 'down', amount: 'lots' }, context);
  assert.deepEqual(mouseEvents(chromium.calls).map(({ deltaX, deltaY }) => [deltaX, deltaY]), [
    [0, -680], [300, 0], [0, 100], [-5_000, 0], [0, 680],
  ]);
  await assert.rejects(adapter.execute('browser_scroll', { direction: 'sideways' }, context), /Unsupported scroll direction/);
});

test('Chromium scroll falls back to window.scrollBy when the wheel event fails and omits an unreadable position', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Input.dispatchMouseEvent'] = () => { throw new Error('wheel unsupported'); };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  const result = await adapter.execute('browser_scroll', { direction: 'down', amount: 400 }, { scope, signal: openSignal() });
  assert.deepEqual(result, { status: 'scrolled' });
  const evaluations = chromium.calls.filter((call) => call[2] === 'Runtime.evaluate');
  assert.match(evaluations[0][3].expression, /visibilityState/);
  assert.match(evaluations[1][3].expression, /window\.scrollBy\(\{left:0,top:400,behavior:'auto'\}\)/);
  assert.doesNotMatch(evaluations[1][3].expression, /down|args|direction|javascript:/i);
  assert.equal(evaluations.length, 3, 'visibility is probed first and the position is still read after the fallback');
});

test('Chromium scroll in a hidden tab skips the wheel event, which Chrome would hold until the tab is shown', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const position = { scrollX: 0, scrollY: 680, maxY: 4_000, atTop: false, atBottom: false };
  chromium.handlers['Runtime.evaluate'] = ({ expression }) => (
    /visibilityState/.test(expression) ? { result: { value: true } } : { result: { value: position } }
  );
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  const result = await adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal: openSignal() });
  assert.deepEqual(result, { status: 'scrolled', position });
  assert.deepEqual(mouseEvents(chromium.calls), [], 'no wheel event is queued for a hidden tab');
  const scrolls = chromium.calls.filter((call) => call[2] === 'Runtime.evaluate' && /window\.scrollBy/.test(call[3].expression));
  assert.equal(scrolls.length, 1);
  assert.match(scrolls[0][3].expression, /window\.scrollBy\(\{left:0,top:680,behavior:'auto'\}\)/);
});

test('Chromium scroll at a ref in a hidden tab scrolls the nearest scrollable ancestor in the page', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Runtime.evaluate'] = ({ expression }) => (
    /visibilityState/.test(expression) ? { result: { value: true } } : { result: { value: null } }
  );
  chromium.handlers['DOM.resolveNode'] = () => ({ object: { objectId: 'object-44' } });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  await adapter.execute('browser_scroll', { direction: 'down', amount: 300 }, { scope, signal: openSignal(), target: clickTarget });
  assert.deepEqual(mouseEvents(chromium.calls), []);
  const call = chromium.calls.find((entry) => entry[2] === 'Runtime.callFunctionOn' && /scrollBy/.test(entry[3].functionDeclaration || ''));
  assert.ok(call, 'the node scroll helper runs against the resolved element');
  assert.deepEqual(call[3].arguments, [{ value: 0 }, { value: 300 }]);
  assert.doesNotMatch(call[3].functionDeclaration, /eval|Function\(/);
});

function hiddenTabHandlers(chromium) {
  chromium.handlers['Runtime.evaluate'] = ({ expression }) => (
    /visibilityState/.test(expression) ? { result: { value: true } } : { result: { value: null } }
  );
}

test('Chromium click in a hidden tab sends press and release but not the mouseMoved Chrome would hold', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  hiddenTabHandlers(chromium);
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  const result = await adapter.execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget });
  assert.equal(result.status, 'clicked');
  assert.deepEqual(mouseEvents(chromium.calls).map(({ type }) => type), ['mousePressed', 'mouseReleased']);
});

test('Chromium hover and drag in a hidden tab fail fast with tab_hidden instead of hanging', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  hiddenTabHandlers(chromium);
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  for (const action of ['browser_hover', 'browser_drag']) {
    await assert.rejects(
      adapter.execute(action, { ref: '@e1', destination_ref: '@e2' }, {
        scope, signal: openSignal(), target: clickTarget, destination: { backendDOMNodeId: 45 },
      }),
      (error) => error.code === 'tab_hidden' && error.message === HIDDEN_TAB_MESSAGE && !/browser_tab_activate/.test(error.message),
    );
  }
  assert.deepEqual(mouseEvents(chromium.calls), []);
});

test('Chromium screenshot of a hidden tab stops waiting for a frame that never comes', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  hiddenTabHandlers(chromium);
  chromium.handlers['Page.captureScreenshot'] = () => new Promise(() => {});
  const timers = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    ...fakeClock(),
    setTimer: (callback, ms) => {
      timers.push(ms);
      if (ms === 5_000) callback();
      return timers.length;
    },
    clearTimer: () => {},
  });
  const failure = await adapter.execute('browser_screenshot', {}, { scope, signal: openSignal() }).catch((error) => error);
  assert.equal(failure.code, 'tab_hidden');
  assert.equal(failure.message, HIDDEN_SCREENSHOT_MESSAGE);
  // Screenshots of a background tab can succeed, so a timed-out capture never claims they cannot run.
  assert.doesNotMatch(failure.message, /cannot run|can't run/);
  assert.ok(timers.includes(5_000));
});

test('Chromium screenshot of a visible tab is not time-limited', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const timers = [];
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    ...fakeClock(),
    setTimer: (callback, ms) => { timers.push(ms); return timers.length; },
    clearTimer: () => {},
  });
  const result = await adapter.execute('browser_screenshot', {}, { scope, signal: openSignal() });
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  assert.equal(timers.includes(5_000), false);
});

test('Chromium scroll at a ref scrolls the element into view and wheels over its centre', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api, calls } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api, ...fakeClock() });
  await adapter.execute('browser_scroll', { direction: 'down' }, { scope, signal: openSignal(), target: clickTarget });
  assert.equal(calls.some((call) => call[2] === 'DOM.scrollIntoViewIfNeeded'), true);
  assert.deepEqual(mouseEvents(calls).map(({ x, y }) => [x, y]), [[20, 30]]);
});

test('Chromium navigate to the tab\'s current URL is a no-op, ignoring a missing hash and trailing slash', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.tabs.set(7, { ...chromium.tabs.get(7), url: 'https://example.test/docs/page/?q=1#top' });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  for (const url of ['https://example.test/docs/page?q=1', 'https://example.test/docs/page/?q=1#top', 'https://example.test/docs/page/?q=1']) {
    const result = await adapter.execute('browser_navigate', { url }, { scope, signal: openSignal() });
    assert.deepEqual(result, {
      url: 'https://example.test/docs/page/?q=1#top', title: 'Example', status: 'already-open', navigated: false,
    });
  }
  assert.deepEqual(chromium.calls, [], 'no attach and no Page.navigate for the same page');

  const different = await adapter.execute('browser_navigate', { url: 'https://example.test/docs/page?q=2' }, { scope, signal: openSignal() });
  assert.equal(different.status, 'navigated');
  assert.equal(chromium.calls.some((call) => call[2] === 'Page.navigate'), true);
});

test('Chromium navigate returns the final URL and title after the load finishes', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Page.navigate'] = (params, target) => {
    // The destination redirects; the tab is still loading until the load event.
    chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'loading', url: 'https://example.test/redirected', title: 'Landing' });
    setTimeout(() => {
      chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'complete' });
      chromium.emitEvent(target.tabId, 'Page.loadEventFired', {});
    }, 5);
    return { frameId: 'main-frame' };
  };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const result = await adapter.execute('browser_navigate', { url: 'https://example.test/old-link' }, { scope, signal: openSignal() });
  assert.deepEqual(result, {
    url: 'https://example.test/redirected', title: 'Landing', status: 'navigated', navigated: true, timedOut: false,
  });
  assert.equal(chromium.eventListeners.length, 1, 'the event listener lives once per adapter, waiters are per navigation');
});

test('Chromium navigate ignores frame-stopped events from other frames', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const clock = fakeClock();
  chromium.handlers['Page.navigate'] = (params, target) => {
    chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'loading', url: params.url });
    return { frameId: 'main-frame' };
  };
  let polls = 0;
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    now: clock.now,
    sleep: async (ms) => {
      await clock.sleep(ms);
      polls += 1;
      if (polls === 1) chromium.emitEvent(7, 'Page.frameStoppedLoading', { frameId: 'ad-frame' });
      if (polls === 3) chromium.emitEvent(7, 'Page.frameStoppedLoading', { frameId: 'main-frame' });
    },
  });
  const result = await adapter.execute('browser_navigate', { url: 'https://example.test/two' }, { scope, signal: openSignal() });
  assert.equal(result.timedOut, false);
  assert.equal(polls, 3);
});

test('Chromium navigate turns a Page.navigate errorText into a navigation_failed error', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Page.navigate'] = () => ({ frameId: 'main-frame', errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  await assert.rejects(
    adapter.execute('browser_navigate', { url: 'https://nope.invalid/' }, { scope, signal: openSignal() }),
    (error) => error?.code === 'navigation_failed' && /ERR_NAME_NOT_RESOLVED/.test(error.message),
  );
});

test('Chromium navigate and back report timedOut instead of failing when the page never finishes loading', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const clock = fakeClock();
  chromium.handlers['Page.navigate'] = (params, target) => {
    chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'loading', url: params.url, title: 'Slow page' });
    return { frameId: 'main-frame' };
  };
  chromium.handlers['Page.navigateToHistoryEntry'] = () => ({});
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...clock });
  const result = await adapter.execute('browser_navigate', { url: 'https://example.test/slow' }, { scope, signal: openSignal() });
  assert.deepEqual(result, {
    url: 'https://example.test/slow', title: 'Slow page', status: 'navigated', navigated: true, timedOut: true,
  });
  assert.ok(clock.now() >= 8_000 && clock.now() < 8_500, `waited the 8s cap, not longer (${clock.now()})`);

  chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'loading' });
  const back = await adapter.execute('browser_back', {}, { scope, signal: openSignal() });
  assert.equal(back.status, 'navigated-back');
  assert.equal(back.timedOut, true);
});

test('Chromium back waits for the load and returns the page it landed on', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const { api } = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: api, ...fakeClock() });
  const back = await adapter.execute('browser_back', {}, { scope, signal: openSignal() });
  assert.deepEqual(back, {
    url: 'https://example.test/old', title: 'Old page', status: 'navigated-back', navigated: true, timedOut: false,
  });
});

test('Chromium navigate aborts promptly when the command is cancelled during the load wait', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Page.navigate'] = (params, target) => {
    chromium.tabs.set(target.tabId, { ...chromium.tabs.get(target.tabId), status: 'loading', url: params.url });
    return { frameId: 'main-frame' };
  };
  const controller = new AbortController();
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    sleep: async () => { controller.abort(new Error('deadline')); },
  });
  await assert.rejects(
    adapter.execute('browser_navigate', { url: 'https://example.test/slow' }, { scope, signal: controller.signal }),
    /deadline/,
  );
});

test('Chromium settle in dom mode waits for a quiet window and never throws', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  let quiet = true;
  chromium.handlers['Runtime.evaluate'] = () => ({ result: { value: quiet } });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });

  const settled = await adapter.settle({ scope, signal: openSignal(), mode: 'dom' });
  assert.deepEqual(settled, { navigated: false, url: 'https://example.test/start', title: 'Example', timedOut: false });
  const evaluate = chromium.calls.find((call) => call[2] === 'Runtime.evaluate');
  assert.equal(evaluate[3].awaitPromise, true);
  assert.equal(evaluate[3].returnByValue, true);
  assert.match(evaluate[3].expression, /MutationObserver/);
  assert.match(evaluate[3].expression, /setTimeout\(\(\) => finish\(true\), 150\)/);
  assert.match(evaluate[3].expression, /setTimeout\(\(\) => finish\(false\), 1200\)/);

  quiet = false;
  assert.equal((await adapter.settle({ scope, signal: openSignal() })).timedOut, true, 'a page that never goes quiet hits the cap');

  chromium.handlers['Runtime.evaluate'] = () => { throw new Error('Execution context was destroyed.'); };
  const failed = await adapter.settle({ scope, signal: openSignal(), mode: 'dom' });
  assert.equal(failed.timedOut, true);
  assert.equal(failed.url, 'https://example.test/start');
});

test('Chromium settle switches to the load wait when the action started a navigation', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  // A click is already loading a new document when settle runs.
  chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'loading', url: 'https://example.test/clicked' });
  let polls = 0;
  const originalGet = chromium.api.tabs.get;
  chromium.api.tabs.get = async (tabId) => {
    polls += 1;
    if (polls >= 3) chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'complete', title: 'Clicked page' });
    return originalGet(tabId);
  };
  const settled = await adapter.settle({ scope, signal: openSignal(), mode: 'dom' });
  assert.deepEqual(settled, { navigated: true, url: 'https://example.test/clicked', title: 'Clicked page', timedOut: false });
  assert.equal(chromium.calls.some((call) => call[2] === 'Runtime.evaluate'), false, 'no in-page wait while the document is loading');

  // A navigation that begins during the quiet window is detected afterwards.
  const second = chromiumApis();
  second.handlers['Runtime.evaluate'] = () => {
    second.tabs.set(7, { ...second.tabs.get(7), status: 'complete', url: 'https://example.test/after-click', title: 'After click' });
    throw new Error('Execution context was destroyed.');
  };
  const secondAdapter = createChromiumCdpAdapter({ browserApi: second.api, ...fakeClock() });
  const detected = await secondAdapter.settle({ scope, signal: openSignal() });
  assert.deepEqual(detected, { navigated: true, url: 'https://example.test/after-click', title: 'After click', timedOut: false });
});

test('Chromium settle in navigation mode returns immediately for a loaded tab and honours the timeout for a loading one', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const clock = fakeClock();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...clock });
  const loaded = await adapter.settle({ scope, signal: openSignal(), mode: 'navigation' });
  assert.deepEqual(loaded, { navigated: true, url: 'https://example.test/start', title: 'Example', timedOut: false });
  assert.equal(clock.now(), 0);

  chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'loading' });
  const slow = await adapter.settle({ scope, signal: openSignal(), mode: 'navigation', timeoutMs: 1_000 });
  assert.equal(slow.timedOut, true);
  assert.ok(clock.now() >= 1_000 && clock.now() < 1_300);
});

test('Chromium settle never throws for a missing scope, a gone tab, or a cancelled command', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  assert.deepEqual(
    await adapter.settle({ scope: {}, signal: openSignal(), mode: 'dom' }),
    { navigated: false, url: '', title: '', timedOut: true },
  );
  chromium.api.tabs.get = async () => { throw new Error('No tab with id: 7.'); };
  assert.deepEqual(
    await adapter.settle({ scope, signal: openSignal(), mode: 'navigation' }),
    { navigated: true, url: '', title: '', timedOut: true },
  );
  chromium.api.tabs.get = async () => ({ id: 7, status: 'complete', url: 'https://example.test/start', title: 'Example' });
  const aborted = new AbortController();
  aborted.abort(new Error('cancelled'));
  const result = await adapter.settle({ scope, signal: aborted.signal, mode: 'dom' });
  assert.equal(result.timedOut, true);
  assert.deepEqual(await adapter.settle(), { navigated: false, url: '', title: '', timedOut: true });
});

test('Chromium maps missing-node CDP errors to a stale_ref error that tells the model what to do', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const expected = /That element is gone .* browser_snapshot\./;
  for (const [method, message] of [
    ['DOM.getBoxModel', 'Could not find node with given id'],
    ['DOM.scrollIntoViewIfNeeded', 'No node with given id found'],
    ['DOM.resolveNode', 'No node with given id found'],
    ['DOM.focus', 'Node is detached from document'],
  ]) {
    const chromium = chromiumApis();
    chromium.handlers[method] = () => { throw new Error(message); };
    const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
    const action = method === 'DOM.resolveNode' || method === 'DOM.focus' ? 'browser_type' : 'browser_click';
    await assert.rejects(
      adapter.execute(action, { ref: '@e1', text: 'x' }, { scope, signal: openSignal(), target: clickTarget }),
      (error) => error?.code === 'stale_ref' && expected.test(error.message),
      method,
    );
  }
  const chromium = chromiumApis();
  chromium.handlers['DOM.getBoxModel'] = () => { throw new Error('Could not compute box model.'); };
  await assert.rejects(
    createChromiumCdpAdapter({ browserApi: chromium.api }).execute('browser_click', { ref: '@e1' }, { scope, signal: openSignal(), target: clickTarget }),
    (error) => error?.code === undefined && /box model/.test(error.message),
  );
});

test('Chromium snapshot derives sensitive-field signals and state flags from AX properties without reading values', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const ax = (role, name, extra = {}) => ({
    nodeId: String(Math.random()), backendDOMNodeId: extra.id, role: { value: role }, name: { value: name }, ignored: false, ...extra.node,
    properties: extra.properties || [],
  });
  const prop = (name, value) => ({ name, value: { type: 'boolean', value } });
  chromium.handlers['Accessibility.getFullAXTree'] = () => ({
    nodes: [
      ax('heading', 'Sign in', { id: 10, properties: [prop('level', 1)] }),
      ax('StaticText', 'Sign in'),
      ax('navigation', 'Primary'),
      ax('textbox', '', { id: 11, properties: [prop('protected', true), prop('editable', 'plaintext'), prop('focused', true)], node: { value: { value: 'hunter2-secret' } } }),
      ax('textbox', 'Email', { id: 12, properties: [prop('editable', 'plaintext'), { name: 'autocomplete', value: { value: 'email' } }], node: { value: { value: 'me@example.test' } } }),
      ax('checkbox', 'Remember me', { id: 13, properties: [{ name: 'checked', value: { type: 'tristate', value: 'mixed' } }] }),
      ax('button', 'Menu', { id: 14, properties: [prop('expanded', true), prop('disabled', true)] }),
      ax('img', '', { id: 15 }),
      ax('img', 'Logo', { id: 16 }),
      ax('StaticText', 'Welcome back'),
    ],
  });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const compactView = await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  assert.deepEqual(compactView.nodes.map((node) => node.backendDOMNodeId), [11, 12, 13, 14, 16], 'unlabeled images are dropped, unnamed inputs are kept');
  assert.deepEqual(compactView.nodes[0], {
    role: 'textbox', name: '', backendDOMNodeId: 11, inputType: 'password', focused: true, editable: true, hasValue: true,
  });
  assert.deepEqual(compactView.nodes[1], {
    role: 'textbox', name: 'Email', backendDOMNodeId: 12, autocomplete: 'email', editable: true, hasValue: true,
  });
  assert.equal(compactView.nodes[2].checked, 'mixed');
  assert.deepEqual([compactView.nodes[3].expanded, compactView.nodes[3].disabled], [true, true]);
  assert.deepEqual(compactView.headings, [{ level: 1, name: 'Sign in' }]);
  assert.deepEqual(compactView.landmarks, [{ role: 'navigation', name: 'Primary' }]);
  assert.equal(compactView.text, 'Sign in\nWelcome back', 'the heading and its static-text child are not repeated');
  assert.doesNotMatch(JSON.stringify(compactView), /hunter2-secret|me@example\.test/);

  const fullView = await adapter.execute('browser_snapshot', { full: true }, { scope, signal: openSignal() });
  assert.equal(fullView.full, true);
  assert.deepEqual(fullView.nodes.map((node) => node.backendDOMNodeId), [11, 12, 13, 14, 15, 16]);
});

test('Chromium snapshot text is capped in compact mode and larger when full is requested', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.handlers['Accessibility.getFullAXTree'] = () => ({
    nodes: Array.from({ length: 400 }, (_, index) => ({
      nodeId: String(index), role: { value: 'StaticText' }, name: { value: `paragraph ${index} ${'x'.repeat(100)}` }, ignored: false,
    })),
  });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const compactView = await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  const fullView = await adapter.execute('browser_snapshot', { full: true }, { scope, signal: openSignal() });
  assert.ok(compactView.text.length <= 6_000);
  assert.ok(fullView.text.length > 30_000);
});

test('Chromium adapter dispose detaches every session and stops listening', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, onDebuggerDetach: (event) => events.push(event) });
  await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  await adapter.execute('browser_snapshot', {}, { scope: { tabId: 8, frameId: 0 }, signal: openSignal() });
  assert.equal(countCalls(chromium.calls, 'attach'), 2);
  await adapter.dispose();
  assert.deepEqual(chromium.calls.filter((call) => call[0] === 'detach').map((call) => call[1].tabId).sort(), [7, 8]);
  assert.equal(chromium.detachListeners.length, 0);
  assert.equal(chromium.eventListeners.length, 0);
  assert.deepEqual(events, []);
});

test('Firefox adapter exposes the same settle and release contract without a debugger', async () => {
  const { createFirefoxWebExtensionAdapter } = await adaptersModule();
  const { api } = firefoxApis();
  const adapter = createFirefoxWebExtensionAdapter({ browserApi: api, ...fakeClock() });
  assert.equal(await adapter.releaseTab(7), false);
  assert.deepEqual(
    await adapter.settle({ scope, signal: openSignal(), mode: 'dom' }),
    { navigated: false, url: 'https://example.test/start', title: 'Example', timedOut: false },
  );
  api.tabs.get = async () => ({ id: 7, status: 'loading', url: 'https://example.test/start', title: 'Example' });
  const slow = await adapter.settle({ scope, signal: openSignal(), timeoutMs: 500 });
  assert.equal(slow.navigated, true);
  assert.equal(slow.timedOut, true);
});

test('Chromium settle gives a loading page the load budget, not the quiet-window cap, and honours loadTimeoutMs', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const clock = fakeClock();
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...clock });
  // A click started a navigation that needs three seconds to finish loading.
  chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'loading', url: 'https://example.test/slow' });
  const originalGet = chromium.api.tabs.get;
  chromium.api.tabs.get = async (tabId) => {
    if (clock.now() >= 5_000) chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'complete', title: 'Slow page' });
    return originalGet(tabId);
  };
  const settled = await adapter.settle({ scope, signal: openSignal(), mode: 'dom', timeoutMs: 1_200, loadTimeoutMs: 8_000 });
  assert.deepEqual(settled, { navigated: true, url: 'https://example.test/slow', title: 'Slow page', timedOut: false });
  assert.ok(clock.now() >= 5_000, 'the page was read only after it finished loading');

  // The load budget never outlasts what the caller has left.
  chromium.tabs.set(7, { ...chromium.tabs.get(7), status: 'loading' });
  chromium.api.tabs.get = originalGet;
  const before = clock.now();
  const capped = await adapter.settle({ scope, signal: openSignal(), mode: 'dom', timeoutMs: 300, loadTimeoutMs: 500 });
  assert.equal(capped.timedOut, true);
  assert.ok(clock.now() - before < 800);

  // Same cap when the navigation only shows up after the quiet window.
  const late = chromiumApis();
  const lateClock = fakeClock();
  late.handlers['Runtime.evaluate'] = () => {
    late.tabs.set(7, { ...late.tabs.get(7), status: 'loading', url: 'https://example.test/late' });
    return { result: { value: true } };
  };
  const lateAdapter = createChromiumCdpAdapter({ browserApi: late.api, ...lateClock });
  const lateResult = await lateAdapter.settle({ scope, signal: openSignal(), mode: 'dom', timeoutMs: 300, loadTimeoutMs: 500 });
  assert.equal(lateResult.navigated, true);
  assert.equal(lateResult.timedOut, true);
  assert.ok(lateClock.now() < 900, `waited ${lateClock.now()} ms for a 500 ms load budget`);
});

test('Chromium adapter lets onDetach land before retrying a command that was answered "Detached while handling command"', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  // Chrome answers the in-flight command first and reports the detach right after.
  const adapter = createChromiumCdpAdapter({
    browserApi: chromium.api,
    onDebuggerDetach: (event) => events.push(event),
    sleep: async () => { chromium.emitDetach(7, 'canceled_by_user'); },
  });
  const context = { scope, signal: openSignal() };
  await adapter.execute('browser_snapshot', {}, context);
  chromium.handlers['Accessibility.getFullAXTree'] = () => { throw new Error('Detached while handling command.'); };
  await assert.rejects(adapter.execute('browser_snapshot', {}, context), /detached while handling/i);
  assert.equal(countCalls(chromium.calls, 'attach'), 1, 'the user cancelled the debugger; it is not silently re-attached');
  assert.deepEqual(events, [{ tabId: 7, reason: 'canceled_by_user', recoverable: false }]);

  // With no detach report, the stale-session retry still happens exactly once.
  const stale = chromiumApis();
  const staleAdapter = createChromiumCdpAdapter({ browserApi: stale.api, sleep: async () => {} });
  await staleAdapter.execute('browser_snapshot', {}, context);
  let failures = 1;
  stale.handlers['Accessibility.getFullAXTree'] = () => {
    if (failures > 0) { failures -= 1; throw new Error('Detached while handling command.'); }
    return { nodes: [] };
  };
  assert.deepEqual((await staleAdapter.execute('browser_snapshot', {}, context)).nodes, []);
  assert.equal(countCalls(stale.calls, 'attach'), 2);
});

test('Chromium snapshot text never includes what is typed into a field', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const prop = (name, value) => ({ name, value: { type: 'string', value } });
  chromium.handlers['Accessibility.getFullAXTree'] = () => ({
    nodes: [
      { nodeId: '1', role: { value: 'heading' }, name: { value: 'Contact us' }, ignored: false, properties: [prop('level', 1)] },
      { nodeId: '2', backendDOMNodeId: 20, role: { value: 'textbox' }, name: { value: 'Message' }, ignored: false, childIds: ['3'], properties: [prop('editable', 'plaintext')] },
      { nodeId: '3', role: { value: 'generic' }, name: { value: '' }, ignored: true, childIds: ['4'] },
      { nodeId: '4', role: { value: 'StaticText' }, name: { value: 'my card is 4111 and my address is 12 Elm St' }, ignored: false },
      { nodeId: '5', backendDOMNodeId: 21, role: { value: 'textbox' }, name: { value: '' }, ignored: false, childIds: ['6'], properties: [{ name: 'protected', value: { value: true } }] },
      { nodeId: '6', role: { value: 'StaticText' }, name: { value: '••••••••' }, ignored: false },
      { nodeId: '7', role: { value: 'generic' }, name: { value: '' }, ignored: false, childIds: ['8'], properties: [prop('editable', 'richtext')] },
      { nodeId: '8', role: { value: 'paragraph' }, name: { value: 'Dear Sam, here is my private draft' }, ignored: false },
      { nodeId: '9', role: { value: 'StaticText' }, name: { value: 'Thanks for visiting' }, ignored: false },
    ],
  });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const view = await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  assert.equal(view.text, 'Contact us\nThanks for visiting');
  assert.deepEqual(view.nodes.map((node) => node.backendDOMNodeId), [20, 21], 'the fields themselves still get refs');
  assert.doesNotMatch(JSON.stringify(view), /4111|Elm St|••••|private draft/);
});

test('Chromium releaseTab detaches an attachment a restarted worker no longer tracks, and only ours', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, onDebuggerDetach: (event) => events.push(event) });
  // This adapter instance never attached tab 7 (a previous worker instance did).
  assert.equal(await adapter.releaseTab(7), true);
  assert.deepEqual(chromium.calls.filter((call) => call[0] === 'detach').map((call) => call[1].tabId), [7]);

  // DevTools or another extension owns the attachment: detach fails and nothing is reported.
  const foreign = chromiumApis();
  foreign.api.debugger.detach = async () => { throw new Error('Debugger is not attached to the tab with id: 7.'); };
  const foreignAdapter = createChromiumCdpAdapter({ browserApi: foreign.api, onDebuggerDetach: (event) => events.push(event) });
  assert.equal(await foreignAdapter.releaseTab(7), false);
  assert.deepEqual(events, []);
});

test('Chromium sweepOrphans detaches attachments this worker does not track and leaves live sessions alone', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  const events = [];
  chromium.api.debugger.getTargets = async () => [
    { type: 'page', tabId: 7, attached: true },
    { type: 'page', tabId: 8, attached: true },
    { type: 'page', tabId: 9, attached: false },
    { type: 'worker', attached: true },
  ];
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, onDebuggerDetach: (event) => events.push(event) });
  await adapter.execute('browser_snapshot', {}, { scope, signal: openSignal() });
  assert.equal(await adapter.sweepOrphans(), 1);
  assert.deepEqual(chromium.calls.filter((call) => call[0] === 'detach').map((call) => call[1].tabId), [8], 'tab 7 has a live session here');
  chromium.emitDetach(8, 'canceled_by_user');
  assert.deepEqual(events, [], 'the sweep is our own detach and is never reported as an external one');

  chromium.api.debugger.getTargets = async () => { throw new Error('unavailable'); };
  assert.equal(await adapter.sweepOrphans(), 0);
  delete chromium.api.debugger.getTargets;
  assert.equal(await adapter.sweepOrphans(), 0);
});

test('Chromium adapter shares one re-attach between concurrent commands that hit the same stale session', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  let stale = false;
  const baseAttach = chromium.api.debugger.attach;
  chromium.api.debugger.attach = async (target, version) => { stale = false; return baseAttach(target, version); };
  const baseSend = chromium.api.debugger.sendCommand;
  chromium.api.debugger.sendCommand = async (target, method, params) => {
    const failing = stale && method === 'Accessibility.getFullAXTree';
    await Promise.resolve();
    if (failing) throw new Error('Debugger is not attached to the tab with id: 7.');
    return baseSend(target, method, params);
  };
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api });
  const context = { scope, signal: openSignal() };
  await adapter.execute('browser_snapshot', {}, context);

  stale = true;
  const results = await Promise.allSettled([
    adapter.execute('browser_snapshot', {}, context),
    adapter.execute('browser_snapshot', {}, context),
    adapter.execute('browser_snapshot', {}, context),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(countCalls(chromium.calls, 'attach'), 2, 'one initial attach and one shared recovery');
  assert.equal(commandMethods(chromium.calls).filter((method) => method === 'Accessibility.enable').length, 2, 'domains are re-enabled once');
});

test('Chromium navigate treats a different fragment as a real navigation so hash-routed apps can change route', async () => {
  const { createChromiumCdpAdapter } = await adaptersModule();
  const chromium = chromiumApis();
  chromium.tabs.set(7, { ...chromium.tabs.get(7), url: 'https://app.example.test/#/home' });
  const adapter = createChromiumCdpAdapter({ browserApi: chromium.api, ...fakeClock() });
  const result = await adapter.execute('browser_navigate', { url: 'https://app.example.test/#/settings' }, { scope, signal: openSignal() });
  assert.equal(result.status, 'navigated');
  assert.equal(chromium.calls.some((call) => call[2] === 'Page.navigate' && call[3].url === 'https://app.example.test/#/settings'), true);

  const same = await adapter.execute('browser_navigate', { url: 'https://app.example.test/#/settings' }, { scope, signal: openSignal() });
  assert.equal(same.status, 'already-open');
});
