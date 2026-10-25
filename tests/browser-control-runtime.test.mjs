import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROLLER_NOOP_CAPABILITY,
  controllerRegistrationFor,
} from '../extension/lib/controller-protocol.mjs';

async function runtimeModule() {
  try {
    return await import('../extension/lib/browser-control-runtime.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser-control runtime module is required: ${error?.message || error}`);
  }
}

function permissionsApi() {
  const calls = [];
  return {
    calls,
    api: {
      async contains(details) { calls.push(['contains', details]); return true; },
      async request(details) { calls.push(['request', details]); return true; },
      async remove(details) { calls.push(['remove', details]); return true; },
    },
  };
}

function browserApi() {
  const permissions = permissionsApi();
  const detachListeners = [];
  return {
    permissions,
    detachListeners,
    api: {
      permissions: permissions.api,
      debugger: {
        attach() {}, sendCommand() {}, detach() {},
        onDetach: {
          addListener(listener) { detachListeners.push(listener); },
          removeListener(listener) {
            const index = detachListeners.indexOf(listener);
            if (index >= 0) detachListeners.splice(index, 1);
          },
        },
      },
      scripting: { executeScript() {} },
      tabs: { query() {}, get() {}, update() {} },
    },
  };
}

const identity = Object.freeze({
  controllerId: 'controller-fixture',
  browserProfileId: 'profile-fixture',
  hermesSessionId: 'session-fixture',
  product: { id: 'edge', engine: 'chromium', label: 'Microsoft Edge' },
});

test('Phase 6 Chromium control uses manifest-declared debugger access only after explicit enable', async () => {
  const { createBrowserControlRuntime } = await runtimeModule();
  const browser = browserApi();
  const runtime = createBrowserControlRuntime({ browserApi: browser.api, product: identity.product });

  assert.equal((await runtime.status({ browserControlEnabled: false })).enabled, false);
  assert.deepEqual(browser.permissions.calls, []);

  const enabled = await runtime.enable();
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.adapterId, 'chromium-cdp');
  assert.ok(enabled.capabilities.includes('browser_click'));
  assert.deepEqual(browser.permissions.calls, []);
  assert.equal(browser.detachListeners.length, 1, 'runtime owns exactly one Chromium detach listener');

  const disabled = await runtime.disable();
  assert.equal(disabled.ok, true);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(browser.permissions.calls, []);
  runtime.dispose();
  assert.equal(browser.detachListeners.length, 0);
});

test('Phase 6 Chromium control fails closed when the required debugger API is unavailable', async () => {
  const { createBrowserControlRuntime } = await runtimeModule();
  const unavailableBrowser = browserApi();
  delete unavailableBrowser.api.debugger;
  const unavailable = createBrowserControlRuntime({ browserApi: unavailableBrowser.api, product: identity.product });
  const status = await unavailable.status({ browserControlEnabled: true });
  assert.equal(status.enabled, false);
  assert.equal(status.reason, 'adapter_unavailable');
  assert.deepEqual(status.capabilities, [CONTROLLER_NOOP_CAPABILITY]);
});

test('Phase 6 Firefox control needs no debugger permission and advertises only its safe subset', async () => {
  const { createBrowserControlRuntime } = await runtimeModule();
  const browser = browserApi();
  delete browser.api.debugger;
  const runtime = createBrowserControlRuntime({
    browserApi: browser.api,
    product: { id: 'firefox', engine: 'gecko', label: 'Mozilla Firefox' },
  });
  const status = await runtime.status({ browserControlEnabled: true });
  assert.equal(status.enabled, true);
  assert.equal(status.adapterId, 'firefox-webextension');
  assert.equal(status.capabilities.includes('browser_click'), false);
  assert.equal(status.capabilities.includes('browser_snapshot'), true);
  // It may ask whether the all-sites permission (which the screenshot needs) is there; it never requests or removes one.
  assert.deepEqual(browser.permissions.calls, [['contains', { origins: ['<all_urls>'] }]]);
});

test('Phase 8 runtime wires capability-derived developer mode and one-shot artifacts into the executor', async () => {
  const { createBrowserControlRuntime } = await runtimeModule();
  const browser = browserApi();
  const observed = [];
  const artifacts = {
    upload: async () => ({ ok: false }),
    download: async () => ({ ok: false }),
  };
  const runtime = createBrowserControlRuntime({
    browserApi: browser.api,
    product: identity.product,
    artifactClientFactory: (settings) => {
      observed.push(settings);
      return artifacts;
    },
  });
  const settings = {
    browserControlEnabled: true,
    browserControlDeveloperMode: true,
    browserControlCdpPolicy: { allow: ['Runtime.evaluate'], deny: [] },
  };
  const executor = await runtime.executor(settings);
  assert.ok(executor);
  assert.deepEqual(observed, [settings]);

  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../extension/lib/browser-control-runtime.mjs', import.meta.url), 'utf8'));
  assert.match(source, /artifacts,/);
  assert.match(source, /developerMode:\s*settings\?\.browserControlDeveloperMode === true/);
  assert.match(source, /cdpPolicy:\s*settings\?\.browserControlCdpPolicy/);
});

test('Phase 6 registration advertises only sanitized runtime-proven capabilities', async () => {
  const descriptor = controllerRegistrationFor({
    family: 'local-api',
    baseUrl: 'http://127.0.0.1:8642',
    identity: {
      ...identity,
      capabilities: ['browser_snapshot', 'browser_click', 'browser_evaluate', 'browser_click', CONTROLLER_NOOP_CAPABILITY],
    },
  });
  assert.deepEqual(descriptor.payload.capabilities, [
    CONTROLLER_NOOP_CAPABILITY,
    'browser_click',
    'browser_snapshot',
  ]);

  const defaultDescriptor = controllerRegistrationFor({
    family: 'local-api',
    baseUrl: 'http://127.0.0.1:8642',
    identity,
  });
  assert.deepEqual(defaultDescriptor.payload.capabilities, [CONTROLLER_NOOP_CAPABILITY]);
});

test('Phase 6 manifest declares required Chromium debugger permission and Firefox removes it', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.permissions.includes('debugger'), true);
  assert.equal(manifest.optional_permissions?.includes('debugger') || false, false);

  const { manifestAssumptionsFor } = await import('../scripts/manifest-profiles.mjs');
  const firefox = manifestAssumptionsFor('firefox');
  assert.equal(firefox.removedPermissions.includes('debugger'), true);
});

test('Phase 6 runtime releases the debugger session of a tab on demand and of every tab on disable', async () => {
  const { createBrowserControlRuntime } = await runtimeModule();
  const calls = [];
  const browser = browserApi();
  // Chrome only detaches what is attached.
  const attached = new Set();
  browser.api.debugger.attach = async (target) => { calls.push(['attach', target.tabId]); attached.add(target.tabId); };
  browser.api.debugger.detach = async (target) => {
    if (!attached.delete(target.tabId)) throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
    calls.push(['detach', target.tabId]);
  };
  browser.api.debugger.getTargets = async () => [...attached, 9].map((tabId) => ({ type: 'page', tabId, attached: true }));
  browser.api.debugger.sendCommand = async (_target, method) => (
    method === 'Accessibility.getFullAXTree' ? { nodes: [] } : {}
  );
  browser.api.tabs.get = async (tabId) => ({ id: tabId, status: 'complete', title: 'Fixture', url: 'https://example.test/page' });
  const runtime = createBrowserControlRuntime({ browserApi: browser.api, product: identity.product });
  const scope = {
    controllerId: 'controller-1', leaseOwnerId: 'controller-1', leaseId: 'lease-1', leaseGeneration: 1, tabId: 7, frameId: 0, documentGeneration: 2,
  };
  const snapshot = (tabId) => runtime.execute(
    { command_id: `snapshot-${tabId}`, action: 'browser_snapshot', arguments: {}, tab_id: tabId, frame_id: 0, document_generation: 2 },
    { scope: { ...scope, tabId } },
    { browserControlEnabled: true },
  );

  assert.equal(await runtime.releaseTab(7), false, 'nothing to release before the first command');
  assert.equal((await snapshot(7)).ok, true);
  assert.equal((await snapshot(7)).ok, true);
  assert.equal((await snapshot(8)).ok, true);
  assert.deepEqual(calls, [['attach', 7], ['attach', 8]], 'one attach per tab however many commands run');

  assert.equal(await runtime.releaseTab(7), true);
  assert.deepEqual(calls.at(-1), ['detach', 7]);
  // Tab 9 is attached by a previous worker instance; tab 8 is a live session of this one.
  attached.add(9);
  assert.equal(await runtime.sweepOrphanSessions(), 1);
  assert.deepEqual(calls.at(-1), ['detach', 9]);
  await runtime.disable();
  assert.deepEqual(calls.slice(-1), [['detach', 8]]);
  runtime.dispose();
});
