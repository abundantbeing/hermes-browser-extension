import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { manifestAssumptionsFor } from '../scripts/manifest-profiles.mjs';

const PHASE6_MODULES = [
  'extension/lib/browser-control-browser-adapters.mjs',
  'extension/lib/browser-control-executor.mjs',
  'extension/lib/browser-control-indicators.mjs',
  'extension/lib/browser-control-refs.mjs',
  'extension/lib/browser-control-runtime.mjs',
  'extension/lib/browser-control-safety.mjs',
  'extension/lib/browser-control-ui.mjs',
];

test('Phase 6 control modules and debugger permission ship in VERSION 0.3.0', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.version, '0.3.1');
  for (const file of PHASE6_MODULES) {
    assert.match(
      packageJson.scripts['check:js'],
      new RegExp(`node --check ${file.replaceAll('.', '\\.')}`),
      `check:js must gate ${file}`,
    );
  }
  for (const manifestPath of ['extension/manifest.json', 'manifest.json']) {
    const manifest = JSON.parse(readFileSync(new URL(`../${manifestPath}`, import.meta.url), 'utf8'));
    assert.equal(manifest.version, '0.3.1');
    assert.equal(manifest.permissions.includes('debugger'), true);
  }
  assert.equal(
    packageJson.scripts['test:e2e:browser-control'],
    'npm run build && node tests/e2e-phase6-browser-control.mjs && node tests/e2e-phase6-browser-control-reconnect.mjs && node tests/e2e-phase6-agent-route.mjs && node tests/e2e-phase6-youtube-like.mjs',
  );
  assert.equal(
    packageJson.scripts['test:e2e:browser-control:reconnect'],
    'npm run build && node tests/e2e-phase6-browser-control-reconnect.mjs',
  );
  assert.equal(
    packageJson.scripts['test:e2e:browser-control:agent-route'],
    'npm run build && node tests/e2e-phase6-agent-route.mjs',
  );
  assert.equal(
    packageJson.scripts['test:e2e:browser-control:youtube'],
    'npm run build && node tests/e2e-phase6-youtube-like.mjs',
  );
  const reconnect = readFileSync(new URL('../tests/e2e-phase6-browser-control-reconnect.mjs', import.meta.url), 'utf8');
  assert.match(reconnect, /heartbeatCount/);
  assert.match(reconnect, /generationBefore/);
  assert.match(reconnect, /leaseGenerationBefore/);
  assert.match(reconnect, /terminalOutboxAfterReconnect/);
  assert.match(reconnect, /fallbackCount:\s*0/);
  const agentRoute = readFileSync(new URL('../tests/e2e-phase6-agent-route.mjs', import.meta.url), 'utf8');
  assert.match(agentRoute, /phase6_agent_router_server\.py/);
  assert.match(agentRoute, /actual-tools\.registry-handler-to-browser-control-broker/);
  assert.match(agentRoute, /registryDispatchCount/);
  assert.match(agentRoute, /legacyFallbackCount/);
  assert.match(agentRoute, /isolatedFallback/);
  assert.match(agentRoute, /typedValuePersisted/);
  const youtube = readFileSync(new URL('../tests/e2e-phase6-youtube-like.mjs', import.meta.url), 'utf8');
  assert.match(youtube, /https:\/\/www\.youtube\.com\/watch\?v=874kn8I_JTs/);
  assert.match(youtube, /isolatedFallback, 'forbidden'/);
  assert.match(youtube, /targetName/);
  assert.match(youtube, /observedEffect/);
  assert.match(youtube, /fallbackCount:\s*0/);
});

test('Phase 6 Firefox profile removes required debugger access and keeps the safe adapter module', () => {
  const sourceManifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const profile = manifestAssumptionsFor('firefox');
  const firefoxPermissions = sourceManifest.permissions.filter((permission) => !profile.removedPermissions.includes(permission));
  assert.equal(sourceManifest.permissions.includes('debugger'), true);
  assert.equal(profile.removedPermissions.includes('debugger'), true);
  assert.equal(firefoxPermissions.includes('debugger'), false);
  const adapterSource = readFileSync(new URL('../extension/lib/browser-control-browser-adapters.mjs', import.meta.url), 'utf8');
  assert.match(adapterSource, /createFirefoxWebExtensionAdapter/);
  assert.match(adapterSource, /debugger: false/);
  assert.match(adapterSource, /Firefox tabs and scripting APIs are required/);
});

test('Phase 6 live background wires truthful debugger detach events into worker lease authority', () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(background, /browserControlRuntime\.setDebuggerDetachHandler/);
  assert.match(background, /controllerWorker\?\.handleDebuggerDetach\(event\)/);
  assert.doesNotMatch(background, /handleDebuggerDetach[\s\S]{0,200}attach\(/);
});
