import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const PHASE5_MODULES = [
  'extension/lib/session-delivery-state.mjs',
  'extension/lib/controller-registry.mjs',
  'extension/lib/tab-leases.mjs',
  'extension/lib/controller-lifecycle.mjs',
  'extension/lib/controller-connector.mjs',
  'extension/lib/controller-service-worker.mjs',
];

const PHASE5_PURE_MODULES = PHASE5_MODULES.filter((file) => ![
  'extension/lib/controller-connector.mjs',
  'extension/lib/controller-service-worker.mjs',
].includes(file));

test('Phase 5 controller foundations remain present in the v0.3.0 package and manifests', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '0.3.1');
  for (const manifestPath of ['extension/manifest.json', 'manifest.json']) {
    const manifest = JSON.parse(readFileSync(new URL(`../${manifestPath}`, import.meta.url), 'utf8'));
    assert.equal(manifest.version, '0.3.1');
  }
});

test('Phase 5 modules are part of the v0.3.0 check:js syntax gate', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const file of PHASE5_MODULES) {
    assert.match(
      packageJson.scripts['check:js'],
      new RegExp(`node --check ${file.replaceAll('.', '\\.')}`),
      `check:js must gate ${file}`,
    );
  }
  // Existing Phase 4 gates stay intact.
  assert.match(packageJson.scripts['check:js'], /node --check extension\/lib\/controller-protocol\.mjs/);
  assert.match(packageJson.scripts['check:js'], /node --check extension\/lib\/controller-client\.mjs/);
});

test('Phase 5 heartbeat protocol constant exists without mutating the Phase 4 method table', async () => {
  const protocol = await import('../extension/lib/controller-protocol.mjs');
  assert.equal(protocol.CONTROLLER_HEARTBEAT_METHOD, 'browser.controller.heartbeat');
  assert.equal(protocol.CONTROLLER_HEARTBEAT_INTERVAL_MS, 60_000);
  // Phase 4's exact method table is preserved (no deepEqual breakage).
  assert.deepEqual(protocol.CONTROLLER_METHODS, {
    register: 'browser.controller.register',
    command: 'browser.controller.command',
    result: 'browser.controller.result',
    cancel: 'browser.controller.cancel',
  });
});

test('Phase 5 manifests declare alarms in both the extension and root manifests', () => {
  for (const manifestPath of ['extension/manifest.json', 'manifest.json']) {
    const manifest = JSON.parse(readFileSync(new URL(`../${manifestPath}`, import.meta.url), 'utf8'));
    assert.ok(manifest.permissions.includes('alarms'), `${manifestPath} must declare alarms`);
  }
  const extensionManifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(extensionManifest.background?.service_worker, 'background.js');
  assert.equal(extensionManifest.background?.type, 'module');
  const rootManifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(rootManifest.background?.service_worker, 'extension/background.js');
  assert.equal(rootManifest.background?.type, 'module');
});

test('Phase 5 background wires tab navigation/removal into controller authority invalidation', () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(source, /tabs\?\.onUpdated\?\.addListener\?\./);
  assert.match(source, /controllerWorker\?\.handleTabUpdated\(tabId, changeInfo\)/);
  assert.match(source, /tabs\?\.onRemoved\?\.addListener\?\./);
  assert.match(source, /controllerWorker\?\.handleTabRemoved\(tabId\)/);
});

test('Phase 5 pure modules stay import-clean with no node-only or browser-only dependencies', async () => {
  for (const file of PHASE5_PURE_MODULES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from 'node:/, `${file} must not import node builtins`);
    // No real browser API access (protocol method strings are allowed).
    assert.doesNotMatch(
      source,
      /(?:chrome|browser)\.(?:runtime|tabs|storage|alarms|sidePanel|windows|action)\b/,
      `${file} must be pure`,
    );
    const module = await import(`../${file}`);
    assert.ok(module, `${file} must export a module`);
  }
});

test('Phase 5 browser-bound controller modules remain node-importable and keep browser APIs injected', async () => {
  for (const file of [
    'extension/lib/controller-connector.mjs',
    'extension/lib/controller-service-worker.mjs',
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from 'node:/, `${file} must not import node builtins`);
    assert.doesNotMatch(source, /\b(?:chrome|browser)\.(?:runtime|tabs|storage|alarms)\b/, `${file} must receive browser APIs through injection`);
    assert.ok(await import(`../${file}`));
  }
});
