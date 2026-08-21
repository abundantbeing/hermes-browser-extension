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
  assert.deepEqual(browser.permissions.calls, []);
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
