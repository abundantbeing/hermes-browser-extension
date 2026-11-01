import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { bootAssist, focusField, loadExtensionFile } from './inline-assist-dom.mjs';
import { createSettingsSaveHarness, sidepanelSource } from './helpers/settings-save-harness.mjs';
import { changedPanes } from '../extension/lib/settings-panes.mjs';

const settingsSection = () => new JSDOM(loadExtensionFile('sidepanel.html')).window.document.querySelector('.inline-assist-settings');

test('Settings offers the three button icons, each previewed on a dark and a white page', () => {
  const section = settingsSection();
  const radios = [...section.querySelectorAll('input[name="inlineAssistIcon"]')];
  assert.deepEqual(radios.map((input) => input.value), ['wing', 'staff', 'girl']);
  for (const input of radios) {
    const card = input.closest('label');
    // Three across leaves no room for the check square: the highlighted card is the mark (compact-choice).
    assert.ok(card.classList.contains('compact-choice'), `${input.value} card uses the single-column layout`);
    assert.equal(card.querySelectorAll('.assist-icon-swatch').length, 2, `${input.value} shows two swatches`);
    assert.equal(card.querySelector('.assist-icon-preview').dataset.icon, input.value);
  }
});

test('Settings keeps the Assist options in the agreed order', () => {
  const section = settingsSection();
  const order = ['#inlineAssistEnabled', '#inlineAssistIconOptions', '#inlineAssistDefaultRoute', '#inlineAssistModelButton', '#inlineAssistAutoReplace', '#inlineAssistSessionRetention']
    .map((selector) => section.querySelector(selector));
  order.forEach((node, index) => assert.ok(node, `missing ${index}`));
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(order[index - 1].compareDocumentPosition(order[index]) & 4, `option ${index} is out of order`);
  }
});

test('the side panel loads, shows and saves the icon and auto-replace settings', () => {
  const source = loadExtensionFile('sidepanel.js');
  assert.match(source, /inlineAssistIconInputs: Array\.from\(document\.querySelectorAll\('input\[name="inlineAssistIcon"\]'\)\)/);
  assert.match(source, /inlineAssistAutoReplace: \$\('#inlineAssistAutoReplace'\)/);
  assert.match(source, /inlineAssistIcon: normalizeInlineAssistIcon\(settings\.inlineAssistIcon\)/);
  assert.match(source, /inlineAssistAutoReplace: typeof stored\[INLINE_ASSIST_AUTO_REPLACE_STORAGE_KEY\] === 'boolean'/);
  assert.match(source, /input\.checked = input\.value === normalizeInlineAssistIcon\(settings\.inlineAssistIcon\)/);
  assert.match(source, /inlineAssistIcon: normalizeInlineAssistIcon\(els\.inlineAssistIconInputs\?\.find\(\(input\) => input\.checked\)\?\.value \|\| settings\.inlineAssistIcon\)/);
  assert.match(source, /inlineAssistAutoReplace: els\.inlineAssistAutoReplace \? els\.inlineAssistAutoReplace\.checked : settings\.inlineAssistAutoReplace !== false/);
});

test('a saved "replace automatically: off" holds in the panel, and switching it saves it', async () => {
  const env = bootAssist({ settings: { inlineAssistAutoReplace: false, inlineAssistDefaultRoute: 'background' } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  const toggle = env.root().querySelector('.panel input.toggle[data-setting="auto-replace"]');
  assert.ok(toggle, 'the panel has the auto-replace switch');
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  for (const listener of env.listenersFor(toggle, 'change')) listener.call(toggle, { type: 'change', target: toggle, isTrusted: true });
  await env.sleep();
  // Its own key: Assist never rewrites the shared settings record, which Settings and Hermes Control also save.
  assert.deepEqual(env.stored.map((items) => ({ ...items })), [{ hermesInlineAssistAutoReplace: true }]);
});

test('the choice saved under its own key wins over the copy in the settings record', async () => {
  const env = bootAssist({ settings: { inlineAssistAutoReplace: true }, storage: { hermesInlineAssistAutoReplace: false } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  assert.equal(env.root().querySelector('.panel input.toggle[data-setting="auto-replace"]').checked, false);
});

// Assist's own switch saves inlineAssistAutoReplace while the side panel is open; an unrelated Save must
// not write the panel's older copy back over it.
async function settingsPanel(saved) {
  const h = await createSettingsSaveHarness({ settings: { inlineAssistAutoReplace: saved } });
  h.scope.settingsBaseline = null;
  h.scope.INLINE_ASSIST_AUTO_REPLACE_STORAGE_KEY = /^const INLINE_ASSIST_AUTO_REPLACE_STORAGE_KEY = '([^']+)';$/m.exec(sidepanelSource)[1];
  h.els.inlineAssistAutoReplace.checked = saved;
  h.fn('captureSettingsBaseline')();
  return h;
}

test('a replacement choice saved from a page shows in Settings and holds through an unrelated Save', async () => {
  const h = await settingsPanel(true);
  h.fn('adoptInlineAssistAutoReplaceChange')(false);
  assert.equal(h.els.inlineAssistAutoReplace.checked, false);
  assert.equal(changedPanes(h.scope.settingsBaseline, h.fn('settingsControlEntries')()).size, 0, 'not an unsaved edit');
  await h.save();
  assert.equal(h.store.hermesBrowserSettings.inlineAssistAutoReplace, false);
  assert.equal(h.store.hermesInlineAssistAutoReplace, false, 'Save writes the key Assist reads');
});

test('an unsaved edit of the switch in Settings is not overwritten by a page', async () => {
  const h = await settingsPanel(true);
  h.els.inlineAssistAutoReplace.checked = false;
  h.fn('adoptInlineAssistAutoReplaceChange')(true);
  assert.equal(h.els.inlineAssistAutoReplace.checked, false);
  assert.equal(h.scope.settings.inlineAssistAutoReplace, true);
});
