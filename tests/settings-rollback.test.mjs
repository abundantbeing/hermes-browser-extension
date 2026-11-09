import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { changesMadeBy, undoChanges } from '../extension/lib/settings-rollback.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

test('only the fields a Save changed are recorded', () => {
  const owned = changesMadeBy({ gatewayUrl: 'a', apiKey: 'k', list: [1] }, { gatewayUrl: 'b', apiKey: 'k', list: [1], added: true });
  assert.deepEqual(Object.keys(owned).sort(), ['added', 'gatewayUrl']);
  assert.deepEqual(owned.gatewayUrl, { had: true, from: 'a', to: 'b' });
  assert.equal(owned.added.had, false);
});

test('undo puts back what the Save changed while it still holds the Save\'s value', () => {
  const owned = changesMadeBy({ gatewayUrl: 'a', apiKey: 'old' }, { gatewayUrl: 'b', apiKey: 'mine', added: 1 });
  assert.deepEqual(undoChanges({ gatewayUrl: 'b', apiKey: 'mine', added: 1 }, owned), { gatewayUrl: 'a', apiKey: 'old' });
});

test('undo leaves a field that something newer has changed', () => {
  const owned = changesMadeBy({ apiKey: 'old', gatewayUrl: 'a' }, { apiKey: 'mine', gatewayUrl: 'b' });
  const next = undoChanges({ apiKey: 'newer-from-another-panel', gatewayUrl: 'b' }, owned);
  assert.equal(next.apiKey, 'newer-from-another-panel');
  assert.equal(next.gatewayUrl, 'a');
});

test('undo keeps a newer change to a field the Save never touched', () => {
  const owned = changesMadeBy({ apiKey: 'old', gatewayUrl: 'a' }, { apiKey: 'old', gatewayUrl: 'b' });
  assert.equal(undoChanges({ apiKey: 'newer', gatewayUrl: 'b' }, owned).apiKey, 'newer');
});

test('Save never restores a whole snapshot taken before it waited', () => {
  const save = source.slice(source.indexOf('async function saveSettingsFromForm('), source.indexOf('async function refreshAfterSettingsSave('));
  assert.doesNotMatch(save, /settings = previousSettings;/);
  assert.match(save, /settings = undoChanges\(settings, changedBySave\);/);
  assert.match(save, /const next = rememberSavedConnection\(/, 'the merged settings are built aside and go live only once stored');
  assert.ok(save.indexOf('await persistHermesBrowserSettings(next') < save.indexOf('settings = next;'));
});
