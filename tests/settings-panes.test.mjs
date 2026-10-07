import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SETTINGS_PANES,
  changedPanes,
  normalizeSettingsPane,
  resolveSettingsTarget,
  snapshotControls,
} from '../extension/lib/settings-panes.mjs';

test('SETTINGS_PANES lists the nine categories with no duplicates', () => {
  assert.equal(SETTINGS_PANES.length, 9);
  assert.equal(new Set(SETTINGS_PANES).size, 9);
});

test('normalizeSettingsPane only accepts known categories', () => {
  assert.equal(normalizeSettingsPane('Permissions'), 'permissions');
  assert.equal(normalizeSettingsPane('  voice '), 'voice');
  assert.equal(normalizeSettingsPane('nope'), '');
  assert.equal(normalizeSettingsPane(undefined), '');
  assert.equal(normalizeSettingsPane({}), '');
});

test('resolveSettingsTarget treats click events and unknown shapes as the category home', () => {
  assert.deepEqual(resolveSettingsTarget(), { pane: '', field: '' });
  assert.deepEqual(resolveSettingsTarget(null), { pane: '', field: '' });
  assert.deepEqual(resolveSettingsTarget({ type: 'click', preventDefault() {} }), { pane: '', field: '' });
  assert.deepEqual(resolveSettingsTarget({ pane: 'bogus' }), { pane: '', field: '' });
});

test('resolveSettingsTarget keeps a known pane and only safe field ids', () => {
  assert.deepEqual(resolveSettingsTarget({ pane: 'permissions', field: 'browserContextConsentInput' }), {
    pane: 'permissions',
    field: 'browserContextConsentInput',
  });
  assert.deepEqual(resolveSettingsTarget({ pane: 'connections', field: 'a b' }), { pane: 'connections', field: '' });
  assert.deepEqual(resolveSettingsTarget({ pane: 'connections', field: 'x"]; alert(1)//' }), { pane: 'connections', field: '' });
  assert.deepEqual(resolveSettingsTarget({ pane: 'connections', field: '1abc' }), { pane: 'connections', field: '' });
});

test('changedPanes reports only categories whose controls differ from the baseline', () => {
  const baseline = snapshotControls([
    ['sessions', 'sessionIdInput', 'a'],
    ['sessions', 'contextDepthInput', 'normal'],
    ['voice', 'wakeWordEnabledInput', 'false'],
  ]);
  const same = changedPanes(baseline, [
    ['sessions', 'sessionIdInput', 'a'],
    ['sessions', 'contextDepthInput', 'normal'],
    ['voice', 'wakeWordEnabledInput', 'false'],
  ]);
  assert.equal(same.size, 0);

  const changed = changedPanes(baseline, [
    ['sessions', 'sessionIdInput', 'a'],
    ['sessions', 'contextDepthInput', 'full'],
    ['voice', 'wakeWordEnabledInput', 'true'],
  ]);
  assert.deepEqual([...changed].sort(), ['sessions', 'voice']);
});

test('editing a value back to its baseline clears the dirty state', () => {
  const baseline = snapshotControls([['sessions', 'sessionIdInput', 'a']]);
  assert.equal(changedPanes(baseline, [['sessions', 'sessionIdInput', 'b']]).size, 1);
  assert.equal(changedPanes(baseline, [['sessions', 'sessionIdInput', 'a']]).size, 0);
});
