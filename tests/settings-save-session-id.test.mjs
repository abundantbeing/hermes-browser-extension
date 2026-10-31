// Review finding 3: Save must not overwrite the viewed session's id with a stale form value.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { sessionIdForSave } from '../extension/lib/settings-save-effects.mjs';
import { createSettingsSaveHarness } from './helpers/settings-save-harness.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

test('sessionIdForSave: an untouched field keeps the viewed session, an edited one is the user\'s choice', () => {
  const fallback = 'hermes-browser-extension';
  assert.equal(sessionIdForSave({ typed: 'old', synced: 'old', viewed: 'now', fallback }), 'now', 'stale form value is ignored');
  assert.equal(sessionIdForSave({ typed: '  old ', synced: 'old', viewed: 'now', fallback }), 'now', 'whitespace is not an edit');
  assert.equal(sessionIdForSave({ typed: 'typed', synced: 'old', viewed: 'now', fallback }), 'typed');
  assert.equal(sessionIdForSave({ typed: '', synced: 'old', viewed: 'now', fallback }), fallback, 'a cleared field means the default, as before');
  assert.equal(sessionIdForSave({ typed: 'old', synced: 'old', viewed: '', fallback }), fallback);
  assert.equal(sessionIdForSave({ typed: 'x', synced: undefined, viewed: 'now', fallback }), 'x', 'a form that was never synced is the user\'s');
});

test('Save keeps settings.sessionId when the viewed session changed after the form was synced', async () => {
  const h = await createSettingsSaveHarness({
    settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local', sessionId: 'session-A' },
  });
  try {
    // Settings opened on session A: the form was synced with A.
    h.els.sessionIdInput.value = 'session-A';
    h.els.sessionIdInput.dataset.syncedValue = 'session-A';
    // While Settings was open the panel moved to its successor (a legacy compression adoption).
    h.scope.settings = { ...h.scope.settings, sessionId: 'session-A-c1' };
    await h.save();
    assert.equal(h.scope.settings.sessionId, 'session-A-c1');
    assert.equal(h.store.hermesBrowserSettings.sessionId, 'session-A-c1');
  } finally {
    h.close();
  }
});

test('Save still accepts a session id the user typed', async () => {
  const h = await createSettingsSaveHarness({
    settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local', sessionId: 'session-A' },
  });
  try {
    h.els.sessionIdInput.dataset.syncedValue = 'session-A';
    h.els.sessionIdInput.value = 'session-typed';
    await h.save();
    assert.equal(h.scope.settings.sessionId, 'session-typed');
  } finally {
    h.close();
  }
});

test('the form records which session id it was filled with', () => {
  const sync = source.match(/function syncSettingsForm\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(sync, /els\.sessionIdInput\.dataset\.syncedValue = settings\.sessionId/);
});
