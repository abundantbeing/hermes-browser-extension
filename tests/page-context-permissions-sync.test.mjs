import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('storage adoption refreshes page-context permission controls when not being edited', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function adoptHermesBrowserSettingsStorageChange'),
    source.indexOf('function adoptPageContextPermissionControlsFromStorage'),
  );
  assert.match(block, /adoptPageContextPermissionControlsFromStorage\(next\)/);
  assert.match(block, /pageContextPermissionControlDirty/);
});

test('instant-save merges only the edited permission field from storage', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /async function persistPageContextPermissions\(field = 'all'\)/);
  assert.match(source, /field === 'excluded'/);
  assert.match(source, /field === 'private'/);
  assert.match(source, /persistPageContextPermissions\('private'\)/);
  assert.match(source, /persistPageContextPermissions\('excluded'\)/);
});

test('permission instant-save does not adopt another panel session binding into local settings', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('async function persistPageContextPermissions'),
    source.indexOf('async function resolveTabUrlForPageScriptPolicy'),
  );
  assert.match(block, /mergePackedBrowserSettingsFromStorage/);
  assert.doesNotMatch(block, /settings\s*=\s*\{[^}]*\.\.\.fresh/);
  assert.doesNotMatch(block, /\.\.\.fresh/);
  assert.match(block, /session bindings/);
  assert.doesNotMatch(block, /sessionId/);
  assert.doesNotMatch(block, /remoteDashboardSession/);
});
