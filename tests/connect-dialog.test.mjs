import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const html = read('extension/sidepanel.html');
const css = read('extension/sidepanel.css');
const js = read('extension/sidepanel.js');

test('Connect to Hermes is a dismissible pop-up, not a card in the chat', () => {
  const { document } = parseHTML(html);
  const panel = document.getElementById('connectPanel');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.equal(panel.getAttribute('aria-labelledby'), 'connectPanelTitle');
  assert.ok(panel.hasAttribute('hidden'));
  const close = document.getElementById('connectPanelCloseButton');
  assert.equal(close.getAttribute('data-i18n-aria-label'), 'ui.close');
  assert.ok(close.querySelector('svg[data-icon="close"]'));
  assert.ok(panel.querySelector('#connectButton'), 'the pairing action stays');
  assert.ok(panel.querySelector('#manualSettingsButton'), 'manual setup stays');
  assert.ok(panel.querySelector('#connectStatus'));
  assert.equal(panel.querySelector('[data-i18n="ui.public.setup"]'), null, 'no PUBLIC SETUP eyebrow');
  assert.equal(panel.querySelectorAll('ol > li').length, 3, 'the same steps, tightened');
  assert.notEqual(panel.parentElement.id, 'messages');
});

test('the pop-up floats over the panel and never shows under the startup screen or setup', () => {
  assert.match(css, /\.connect-panel \{[^}]*position: fixed;[^}]*inset: 0;/s);
  assert.match(css, /\.connect-panel\[hidden\],\s*\.connect-panel\.is-dismissed,\s*body\.startup-active \.connect-panel,\s*body\.onboarding-active \.connect-panel \{ display: none; \}/);
  assert.doesNotMatch(css, /\.empty-state,\s*\.connect-panel \{/, 'no longer drawn as a chat card');
});

test('connection state still decides whether Connect is needed; the pop-up only changes how it shows', () => {
  assert.match(js, /els\.connectPanel\.hidden = connected;/);
  const bind = js.match(/function bindConnectDialog\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(bind, /connectPanelCloseButton\?\.addEventListener\('click', dismissConnectDialog\)/, 'X closes it');
  assert.match(bind, /event\.key === 'Escape' && connectDialogShowing\(\)/, 'Escape closes it');
  assert.match(bind, /event\.target === els\.connectPanel\) dismissConnectDialog\(\)/, 'the backdrop closes it');
  assert.match(bind, /if \(nowNeeded && !needed\) \{\s*connectDialogDismissed = false;/, 'a dropped connection or dead token brings it back');
  assert.match(bind, /if \(onboardingFlow\?\.isOpen\) onboardingFlow\.render\(\);/, "setup's Connect step follows the live state");
  assert.match(bind, /els\.sendButton\?\.addEventListener\('click', \(event\) => \{\s*if \(isConnected\(\) \|\| isRemoteWsMode\(\)\) return;\s*event\.preventDefault\(\);\s*openConnectDialog\(\);/, '"Connect first" opens it');
});

test('a send while unpaired opens the pop-up instead of focusing a hidden button', () => {
  const ask = js.match(/async function askHermes\([\s\S]*?\n\}/)?.[0] || '';
  const unpaired = ask.match(/if \(!isConnected\(\)\) \{[\s\S]*?return false;\n {2}\}/)?.[0] || '';
  assert.match(unpaired, /openConnectDialog\(\);/);
  assert.doesNotMatch(unpaired, /els\.connectButton\.focus\(\)/);
  assert.match(js, /"Connect first" stays live and\n {4}\/\/ opens the connect pop-up/);
  assert.match(js, /if \(!isConnected\(\) && !document\.body\.classList\.contains\('startup-active'\)\) els\.sendButton\.disabled = false;/);
});

test('the startup dock and Manual setup keep their own way to connect', () => {
  assert.match(js, /els\.startupConnectButton\?\.addEventListener\('click', \(\) => \{\s*connectToHermes\(\)/);
  assert.match(js, /els\.manualSettingsButton\.addEventListener\('click', openSettingsDialog\)/);
});
