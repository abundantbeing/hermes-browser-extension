import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { bootAssist, focusField, loadExtensionFile } from './inline-assist-dom.mjs';

const settingsSection = () => new JSDOM(loadExtensionFile('sidepanel.html')).window.document.querySelector('.inline-assist-settings');

test('Settings offers the three button icons, each previewed on a dark and a white page', () => {
  const section = settingsSection();
  const radios = [...section.querySelectorAll('input[name="inlineAssistIcon"]')];
  assert.deepEqual(radios.map((input) => input.value), ['wing', 'staff', 'girl']);
  for (const input of radios) {
    const card = input.closest('label');
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
  assert.match(source, /inlineAssistAutoReplace: settings\.inlineAssistAutoReplace !== false/);
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
  const write = env.stored.find((items) => items.hermesBrowserSettings);
  assert.equal(write?.hermesBrowserSettings.inlineAssistAutoReplace, true);
});
