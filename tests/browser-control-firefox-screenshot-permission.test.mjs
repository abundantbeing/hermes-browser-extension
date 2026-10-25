// Firefox's tabs.captureVisibleTab needs the <all_urls> host permission (or an activeTab grant from a user gesture, which a
// model command is not). The shipped manifest has neither, so every browser_screenshot failed with "Missing activeTab
// permission". The adapter says so up front instead: a typed error, and the action is not advertised while it cannot work.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserControlRuntime } from '../extension/lib/browser-control-runtime.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { createFirefoxWebExtensionAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';

const scope = Object.freeze({ tabId: 7, frameId: 0 });
const openSignal = () => new AbortController().signal;
const ALL_URLS = { origins: ['<all_urls>'] };

// A Firefox window showing tab 7. `permission`: true / false answers contains(), an Error makes it throw, null removes the
// permissions API. `captureError` makes captureVisibleTab throw.
function firefox({ permission = false, captureError = null } = {}) {
  const calls = [];
  const tab = { id: 7, windowId: 4, active: true, title: 'Page', url: 'https://example.test/page' };
  const api = {
    tabs: {
      get: async () => ({ ...tab }),
      query: async () => [{ ...tab }],
      captureVisibleTab: async () => {
        calls.push(['captureVisibleTab']);
        if (captureError) throw captureError;
        return 'data:image/png;base64,ZmFrZQ==';
      },
    },
    scripting: {
      executeScript: async (details) => {
        calls.push(['executeScript', details.target]);
        return [{ frameId: 0, result: { url: tab.url, top: true, frames: 0 } }];
      },
    },
  };
  if (permission !== null) {
    api.permissions = {
      contains: async (details) => {
        calls.push(['contains', details]);
        if (permission instanceof Error) throw permission;
        return permission;
      },
      request: async (details) => { calls.push(['request', details]); return true; },
      remove: async (details) => { calls.push(['remove', details]); return true; },
    };
  }
  return { api, calls };
}
const adapterOf = (fake) => createFirefoxWebExtensionAdapter({ browserApi: fake.api });
const shoot = (fake, args = {}, options = {}) => adapterOf(fake).execute('browser_screenshot', args, { scope, signal: openSignal(), ...options });
const names = (fake) => fake.calls.map((call) => call[0]);
const unavailable = (error) => error?.code === 'screenshot_unavailable';

test('without the all-sites permission a screenshot is refused up front with a typed error and a way forward', async () => {
  const fake = firefox({ permission: false });
  const error = await shoot(fake).then(() => null, (thrown) => thrown);
  assert.equal(unavailable(error), true, String(error?.message));
  assert.match(error.message, /Screenshots need extra browser permission in Firefox/);
  assert.match(error.message, /page text/i);
  assert.match(error.message, /Tab screenshot button yourself/);
  assert.deepEqual(fake.calls, [['contains', ALL_URLS]], 'it asked the permission and did nothing else: no frame probe, no capture');
});

test('a screenshot of one element says the same, since no screenshot can be taken at all', async () => {
  const fake = firefox({ permission: false });
  await assert.rejects(shoot(fake, { ref: '@e1' }, { target: { backendDOMNodeId: 5 } }), unavailable);
  assert.equal(names(fake).includes('captureVisibleTab'), false);
});

test('with the permission the screenshot works, and an element screenshot is still unsupported_for_ref', async () => {
  const fake = firefox({ permission: true });
  assert.equal((await shoot(fake)).dataUrl, 'data:image/png;base64,ZmFrZQ==');
  await assert.rejects(shoot(fake, { ref: '@e1' }), (error) => error?.code === 'unsupported_for_ref');
});

test('a permission check that cannot be made leaves the capture to decide, and the exact Firefox refusal is mapped', async () => {
  for (const permission of [null, new Error('permissions are unavailable')]) {
    const fake = firefox({ permission });
    assert.equal((await shoot(fake)).dataUrl, 'data:image/png;base64,ZmFrZQ==');
  }
  for (const permission of [null, true]) {
    const fake = firefox({ permission, captureError: new Error('Missing activeTab permission') });
    await assert.rejects(shoot(fake), unavailable);
  }
  // Any other failure stays what it was.
  const broken = firefox({ permission: true, captureError: new Error('The tab was closed') });
  await assert.rejects(shoot(broken), (error) => !unavailable(error) && /tab was closed/.test(error.message));
});

test('the adapter advertises browser_screenshot only while it can work', async () => {
  const missing = adapterOf(firefox({ permission: false }));
  const { actions, unavailable } = await missing.currentCapabilities();
  assert.equal(actions.includes('browser_screenshot'), false);
  assert.deepEqual(actions, missing.contract.actions.filter((action) => action !== 'browser_screenshot'));
  assert.equal(missing.contract.actions.includes('browser_screenshot'), true, 'the contract itself is unchanged');
  assert.deepEqual(unavailable, [{ action: 'browser_screenshot', reason: 'permission-unavailable' }]);

  for (const permission of [true, null, new Error('no')]) {
    const adapter = adapterOf(firefox({ permission }));
    assert.deepEqual(await adapter.currentCapabilities(), { actions: [...adapter.contract.actions], unavailable: [] });
  }
});

test('the permission is read again each time, so granting it later shows up without a restart', async () => {
  let granted = false;
  const fake = firefox({ permission: false });
  fake.api.permissions.contains = async () => granted;
  const adapter = adapterOf(fake);
  assert.equal((await adapter.currentCapabilities()).actions.includes('browser_screenshot'), false);
  granted = true;
  assert.equal((await adapter.currentCapabilities()).actions.includes('browser_screenshot'), true);
  assert.equal((await adapter.execute('browser_screenshot', {}, { scope, signal: openSignal() })).dataUrl, 'data:image/png;base64,ZmFrZQ==');
});

// --- what Hermes registers with the gateway --------------------------------------------------------------------------

const runtimeFor = (fake) => createBrowserControlRuntime({ browserApi: fake.api, product: { id: 'firefox', engine: 'gecko' } });

test('the capabilities Hermes registers in Firefox leave out the screenshot while it cannot work, and say why', async () => {
  const missing = await runtimeFor(firefox({ permission: false })).status({ browserControlEnabled: true });
  assert.equal(missing.enabled, true);
  assert.equal(missing.capabilities.includes('browser_screenshot'), false);
  assert.equal(missing.capabilities.includes('browser_snapshot'), true, 'page text is still offered');
  assert.deepEqual(missing.gaps.filter((gap) => gap.action === 'browser_screenshot'), [{ action: 'browser_screenshot', reason: 'permission-unavailable' }]);
  assert.equal(missing.gaps.some((gap) => gap.action === 'browser_click'), true, 'the existing gaps are kept');

  const granted = await runtimeFor(firefox({ permission: true })).status({ browserControlEnabled: true });
  assert.equal(granted.capabilities.includes('browser_screenshot'), true);
  assert.equal(granted.gaps.some((gap) => gap.action === 'browser_screenshot'), false);
});

test('asking about the permission never requests or removes anything', async () => {
  const fake = firefox({ permission: false });
  await runtimeFor(fake).status({ browserControlEnabled: true });
  await shoot(fake).catch(() => {});
  assert.deepEqual(names(fake).filter((name) => name !== 'contains'), []);
  assert.deepEqual(fake.calls.filter((call) => call[0] === 'contains').every((call) => JSON.stringify(call[1]) === JSON.stringify(ALL_URLS)), true);
});

test('Chromium still advertises the screenshot', async () => {
  const api = {
    tabs: { get: async () => ({}) },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: { addListener() {}, removeListener() {} }, onEvent: { addListener() {}, removeListener() {} } },
    scripting: { executeScript: async () => [] },
  };
  const status = await createBrowserControlRuntime({ browserApi: api, product: { id: 'chrome', engine: 'chromium' } }).status({ browserControlEnabled: true });
  assert.equal(status.capabilities.includes('browser_screenshot'), true);
});

test('the executor keeps the typed code, so the model sees screenshot_unavailable and the message', async () => {
  const adapter = adapterOf(firefox({ permission: false }));
  const executor = createBrowserControlExecutor({ adapter: { ...adapter, inspect: async () => ({ currentUrl: 'https://example.test/page', hasUnsavedContent: false }) }, approvals: createBrowserControlApprovalStore(), refs: createBrowserControlRefStore() });
  const outcome = await executor.execute(
    { command_id: 'c1', action: 'browser_screenshot', arguments: {}, tab_id: 7, frame_id: 0, document_generation: 1 },
    { scope: { controllerId: 'c', leaseOwnerId: 'c', leaseId: 'l', tabId: 7, frameId: 0, documentGeneration: 1 } },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'screenshot_unavailable');
  assert.match(outcome.error.message, /Tab screenshot button/);
});
