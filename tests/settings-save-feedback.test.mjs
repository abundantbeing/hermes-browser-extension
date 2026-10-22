import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSettingsSaveHarness, sidepanelHtml, sidepanelSource } from './helpers/settings-save-harness.mjs';

function functionSource(name) {
  const start = sidepanelSource.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name} not found in sidepanel.js`);
  return sidepanelSource.slice(start, sidepanelSource.indexOf('\n}\n', start) + 2);
}

const form = new JSDOM(sidepanelHtml).window.document.getElementById('settingsForm');

test('Save says what it could not keep and stores nothing', async () => {
  const h = await createSettingsSaveHarness({ settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local' } });
  try {
    h.els.agentPortsInput.value = 'eight, nine';
    h.els.sessionTitleInput.value = 'Should not be stored';
    await assert.rejects(h.save(), /settings\.save\.ports_invalid/);
    assert.equal(h.store.hermesBrowserSettings, undefined);

    h.els.agentPortsInput.value = '8642';
    h.els.customModelSourcesInput.value = 'http://good.example:1234/v1\nnot a url\nftp://x.example';
    await assert.rejects(h.save(), (error) => {
      assert.match(error.message, /settings\.save\.sources_invalid/);
      assert.match(error.message, /not a url, ftp:\/\/x\.example/);
      assert.doesNotMatch(error.message, /good\.example/);
      return true;
    });
    assert.equal(h.store.hermesBrowserSettings, undefined);
  } finally {
    h.close();
  }
});

test('Save reports its outcome in the header, and a failed save names what failed', () => {
  const handler = sidepanelSource.slice(sidepanelSource.indexOf("els.settingsForm.addEventListener('submit'"));
  const submit = handler.slice(0, handler.indexOf('\n  });'));
  assert.match(submit, /setSettingsSaveNote\('saving'/);
  assert.match(submit, /const outcome = settingsSavedNote\(probed\)/);
  assert.match(submit, /setSettingsSaveNote\('failed', t\('settings\.save\.failed', \{ detail \}\)\)/);
  assert.match(submit, /showOperationToast\(\{ kind: 'error', title: 'Settings not saved', detail \}\)/);
  // A save whose follow-up reconnect failed is still a save: the baseline resets and it is not called "not saved".
  const persistedBranch = submit.slice(submit.indexOf('if (persisted)'), submit.indexOf('setSettingsSaveNote(\'failed\''));
  assert.match(persistedBranch, /captureSettingsBaseline\(\)/);
  assert.doesNotMatch(persistedBranch, /Settings not saved/);
  assert.match(functionSource('revealInvalidSettingsField'), /setSettingsSaveNote\('failed'/);
  assert.match(sidepanelHtml, /id="settingsSaveStatus"[^>]*role="status"/);
});

test('every pane confirms a control that saved itself in the same place', () => {
  const chips = form.querySelectorAll('[data-settings-pane] .settings-pane-saved');
  assert.equal(chips.length, form.querySelectorAll('[data-settings-pane]').length, 'each pane carries a Saved chip');
  for (const chip of chips) assert.equal(chip.getAttribute('role'), 'status');
  const wired = [
    ['agents', /trackInstantSave\('agents', browserApi\.storage\.local\.set/],
    ['connections', /trackInstantSave\('connections', persistAgentDiscoverySettings/],
    ['permissions', /trackInstantSave\('permissions', persistBrowserControlPreferences/],
    ['permissions', /trackInstantSave\('permissions', setBrowserContextConsent/],
    ['assist', /trackInstantSave\('assist', persistGmailCaptureEnabled/],
    ['models', /trackInstantSave\('models', persistModelRuntimeOptions\(\)\)/],
    ['appearance', /trackInstantSave\('appearance', setLocale/],
    ['appearance', /flashSettingsPaneSaved\('appearance', 'saved'\)/],
    ['appearance', /flashSettingsPaneSaved\('appearance', 'failed'/],
  ];
  for (const [pane, pattern] of wired) assert.match(sidepanelSource, pattern, `${pane}: ${pattern}`);
});

