import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { bootAssist, focusField, loadExtensionFile } from './inline-assist-dom.mjs';
import { createSettingsSaveHarness } from './helpers/settings-save-harness.mjs';
import { changedPanes } from '../extension/lib/settings-panes.mjs';

const settingsSection = () => new JSDOM(loadExtensionFile('sidepanel.html')).window.document.querySelector('.inline-assist-settings');

test('each icon card shows the bare light and dark circles, with no tile behind them', () => {
  const css = loadExtensionFile('sidepanel.css');
  const rule = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  };
  for (const swatch of ['.assist-icon-swatch', '.assist-icon-swatch-dark', '.assist-icon-swatch-light']) {
    assert.doesNotMatch(rule(swatch), /background|border-radius: 8px|box-shadow/, `${swatch} paints no tile`);
  }
  assert.match(rule('.assist-icon-swatch-dark::before'), /background: #f4f4f1/, 'the light circle');
  assert.match(rule('.assist-icon-swatch-light::before'), /background: #141414/, 'the dark circle');
});

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

// Every tab has its own side panel, and they share one settings record: an icon picked in one panel must not
// be put back by an unrelated Save in another.
test('an icon saved by another panel shows here and holds through an unrelated Save', async () => {
  const h = await createSettingsSaveHarness({ settings: { inlineAssistIcon: 'wing' } });
  h.scope.settingsBaseline = null;
  for (const input of h.els.inlineAssistIconInputs) input.checked = input.value === 'wing';
  h.fn('captureSettingsBaseline')();
  h.fn('adoptInlineAssistIconChange')('girl');
  assert.equal(h.els.inlineAssistIconInputs.find((input) => input.checked)?.value, 'girl');
  assert.equal(changedPanes(h.scope.settingsBaseline, h.fn('settingsControlEntries')()).size, 0, 'not an unsaved edit');
  await h.save();
  assert.equal(h.store.hermesBrowserSettings.inlineAssistIcon, 'girl');
});

test('an icon picked here and not saved yet is not overwritten by another panel', async () => {
  const h = await createSettingsSaveHarness({ settings: { inlineAssistIcon: 'wing' } });
  h.scope.settingsBaseline = null;
  for (const input of h.els.inlineAssistIconInputs) input.checked = input.value === 'staff';
  h.fn('adoptInlineAssistIconChange')('girl');
  assert.equal(h.els.inlineAssistIconInputs.find((input) => input.checked)?.value, 'staff');
  assert.equal(h.scope.settings.inlineAssistIcon, 'girl');
});

test('the Assist choice headings keep a gap above their cards', () => {
  // A fieldset legend is not a grid item, so the group's gap never reaches it: it needs its own margin.
  const css = loadExtensionFile('sidepanel.css');
  assert.match(css, /\n\.inline-assist-settings \.settings-choice-group legend \{[^}]*margin-bottom: 10px;/);
});

test('Settings offers Quick menu and Full panel, each with a picture of what opens', () => {
  const section = new JSDOM(loadExtensionFile('sidepanel.html')).window.document.querySelector('.inline-assist-settings');
  const radios = [...section.querySelectorAll('input[name="inlineAssistOpenMode"]')];
  assert.deepEqual(radios.map((input) => input.value), ['quick', 'panel']);
  for (const input of radios) {
    assert.ok(input.closest('label').querySelector('.assist-open-thumb'), `${input.value} has a picture`);
    assert.ok(input.closest('label').classList.contains('compact-choice'), `${input.value} card uses the single-column layout`);
  }
  const source = loadExtensionFile('sidepanel.js');
  assert.match(source, /inlineAssistOpenMode: normalizeInlineAssistOpenMode\(settings\.inlineAssistOpenMode\)/);
  assert.match(source, /input\.checked = input\.value === normalizeInlineAssistOpenMode\(settings\.inlineAssistOpenMode\)/);
  assert.match(source, /inlineAssistOpenMode: normalizeInlineAssistOpenMode\(els\.inlineAssistOpenModeInputs\?\.find\(\(input\) => input\.checked\)\?\.value \|\| settings\.inlineAssistOpenMode\)/);
});

test('the Sites list merges where Assist reads the thread with where the circle is hidden', async () => {
  const { inlineAssistSitesModel, inlineAssistSiteEntries, withInlineAssistSiteState, withoutInlineAssistSite } = await import('../extension/lib/inline-assist-look.mjs');
  const model = inlineAssistSitesModel({ x: 'visible', gmail: 'draft', bogus: 'maybe' }, ['reddit', 'forum.example']);
  assert.deepEqual(inlineAssistSiteEntries(model), [
    { site: 'forum.example', state: 'hidden' },
    { site: 'gmail', state: 'draft' },
    { site: 'reddit', state: 'hidden' },
    { site: 'x', state: 'visible' },
  ]);
  const hiddenX = withInlineAssistSiteState(model, 'x', 'hidden');
  assert.ok(hiddenX.hidden.includes('x'));
  assert.equal(inlineAssistSiteEntries(hiddenX).find((entry) => entry.site === 'x').state, 'hidden');
  assert.equal(Object.hasOwn(hiddenX.contextPrefs, 'x'), false, 'a site keeps one setting: hidden drops its thread reading');
  const shownAgain = withInlineAssistSiteState(hiddenX, 'x', 'draft');
  assert.equal(shownAgain.hidden.includes('x'), false);
  assert.equal(shownAgain.contextPrefs.x, 'draft');
  const removed = withoutInlineAssistSite(shownAgain, 'gmail');
  assert.equal(inlineAssistSiteEntries(removed).some((entry) => entry.site === 'gmail'), false);
  assert.deepEqual(model.hidden, ['reddit', 'forum.example'], 'the original model is not changed');
});

test('Where it runs, Model, Replace text automatically and Keep Assist chats are rows: the name left, the control right', () => {
  const section = settingsSection();
  for (const id of ['#inlineAssistDefaultRoute', '#inlineAssistModelButton', '#inlineAssistAutoReplace', '#inlineAssistSessionRetention']) {
    const row = section.querySelector(id).closest('.assist-setting-row');
    assert.ok(row, `${id} sits in a row`);
    assert.ok(row.firstElementChild.matches('.settings-toggle-copy'), `${id}: the name comes first`);
  }
  const css = loadExtensionFile('sidepanel.css');
  assert.match(css, /\n\.settings-dialog \.assist-setting-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  // Square like every other control in the panel: no rounded pills.
  assert.doesNotMatch(css, /\n\.inline-assist-site \{[^}]*border-radius/, 'sites are square');
  assert.doesNotMatch(css, /\n\.settings-dialog \.inline-assist-site-add \{[^}]*border-radius/, 'Add is square');
  assert.doesNotMatch(css, /\n\.inline-assist-site-remove \{[^}]*border-radius/, 'remove is square');
  assert.ok(section.querySelector('.inline-assist-sites-chips #inlineAssistAddSite'), 'Add this site is the last pill');
});

test('a Quick or Full choice and a Keep Assist chats change saved elsewhere show here and hold through an unrelated Save', async () => {
  const h = await createSettingsSaveHarness({ settings: { inlineAssistOpenMode: 'panel', inlineAssistSessionRetention: 'keep' } });
  h.scope.settingsBaseline = null;
  for (const input of h.els.inlineAssistOpenModeInputs) input.checked = input.value === 'panel';
  h.els.inlineAssistSessionRetention.value = 'keep';
  h.fn('captureSettingsBaseline')();
  h.fn('adoptInlineAssistOpenModeChange')('quick');
  h.fn('adoptInlineAssistSessionRetentionChange')('delete');
  assert.equal(h.els.inlineAssistOpenModeInputs.find((input) => input.checked)?.value, 'quick');
  assert.equal(h.els.inlineAssistSessionRetention.value, 'delete');
  assert.equal(changedPanes(h.scope.settingsBaseline, h.fn('settingsControlEntries')()).size, 0, 'not unsaved edits');
  await h.save();
  assert.equal(h.store.hermesBrowserSettings.inlineAssistOpenMode, 'quick');
  assert.equal(h.store.hermesBrowserSettings.inlineAssistSessionRetention, 'delete');
});

test('an open-mode pick made here and not saved yet is not overwritten by another panel', async () => {
  const h = await createSettingsSaveHarness({ settings: { inlineAssistOpenMode: 'panel' } });
  h.scope.settingsBaseline = null;
  for (const input of h.els.inlineAssistOpenModeInputs) input.checked = input.value === 'quick';
  h.fn('adoptInlineAssistOpenModeChange')('panel');
  assert.equal(h.els.inlineAssistOpenModeInputs.find((input) => input.checked)?.value, 'quick');
});

test('an Assist model picked on a page shows in Settings and holds through an unrelated Save', async () => {
  const h = await createSettingsSaveHarness({ settings: { inlineAssistModel: 'anthropic::claude-haiku-5-5', inlineAssistRawModel: 'claude-haiku-5-5', inlineAssistProvider: 'anthropic' } });
  h.scope.settingsBaseline = null;
  h.scope.renderInlineAssistModelOptions = () => { h.els.inlineAssistModel.value = h.scope.settings.inlineAssistModel; };
  h.els.inlineAssistModel.value = 'anthropic::claude-haiku-5-5';
  h.fn('captureSettingsBaseline')();
  h.fn('adoptInlineAssistModelChange')({ inlineAssistModel: 'openai-codex::gpt-6.1-terra', inlineAssistRawModel: 'gpt-6.1-terra', inlineAssistProvider: 'openai-codex' });
  assert.equal(h.els.inlineAssistModel.value, 'openai-codex::gpt-6.1-terra');
  assert.equal(changedPanes(h.scope.settingsBaseline, h.fn('settingsControlEntries')()).size, 0, 'not an unsaved edit');
  assert.equal(h.scope.settings.inlineAssistProvider, 'openai-codex');
});
