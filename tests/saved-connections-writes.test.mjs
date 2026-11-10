import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the side panel and the worker write the whole settings record only through the shared lock', async () => {
  for (const path of ['extension/sidepanel.js', 'extension/lib/controller-service-worker.mjs']) {
    const source = await read(path);
    assert.doesNotMatch(source, /packedHermesBrowserSettingsWrite\(/, `${path} writes the record through writeSettingsOnStoredConnections`);
    assert.match(source, /writeSettingsOnStoredConnections/);
  }
});

test('the wake listener saves its setting under the lock and follows a change of connection', async () => {
  const wake = await read('extension/lib/wake-background.mjs');
  const setEnabled = wake.slice(wake.indexOf('async function setEnabled('), wake.indexOf('async function handleLocalState('));
  assert.match(setEnabled, /withSavedConnectionsLock\(async \(\) => \{[\s\S]*packedHermesBrowserSettingsWrite\(/);
  const native = wake.slice(wake.indexOf('async function tryNativeWake('), wake.indexOf('const credential = await localDashboardCredential'));
  assert.match(native, /clearNativeConnection\(\)/);
});

test('the connection helper refuses a write from a connection that has been left', async () => {
  const helper = await read('extension/lib/saved-connections.mjs');
  const body = helper.slice(helper.indexOf('export async function writeSettingsOnStoredConnections('), helper.indexOf('export function savedConnectionSummary('));
  assert.match(body, /stored\.activeSavedConnectionId !== activeId\) return false/);
  assert.match(body, /withStoredSavedConnections\(settings, stored\)/);
});
