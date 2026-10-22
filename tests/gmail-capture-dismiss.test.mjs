import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

test('the Gmail capture button can be dismissed and re-enabled from settings', () => {
  // Structure: the button sits in a wrap with a dedicated dismiss control.
  const wrapIndex = html.indexOf('id="explicitSiteCaptureWrap"');
  const buttonIndex = html.indexOf('id="explicitSiteCaptureButton"');
  const dismissIndex = html.indexOf('id="explicitSiteCaptureDismiss"');
  assert.ok(wrapIndex >= 0 && buttonIndex > wrapIndex && dismissIndex > buttonIndex, 'capture wrap + dismiss structure must exist');

  const settingsToggleIndex = html.indexOf('id="gmailCaptureEnabledInput"');
  assert.ok(settingsToggleIndex >= 0, 'the settings toggle must exist');
  assert.ok(settingsToggleIndex > html.indexOf('id="contextMenuSettingsTitle"'), 'the toggle lives in the Right-click actions section');
});

test('dismissing the capture button persists the opt-out and hides it', () => {
  assert.match(source, /els\.explicitSiteCaptureDismiss\?\.addEventListener\('click'/);
  assert.match(source, /settings = \{ \.\.\.settings, gmailCaptureHidden: true \};/);
  assert.match(source, /browserApi\.storage\.local\.set\(\{ hermesBrowserSettings: settings \}\)/);
  assert.match(source, /els\.explicitSiteCaptureWrap\.hidden = !action \|\| captureEnabled \|\| settings\.gmailCaptureHidden === true;/);
  assert.match(source, /els\.explicitSiteCaptureButton\.hidden = !action \|\| captureEnabled;/);
});

test('the settings toggle reads and writes durable thread sharing, not button visibility', () => {
  assert.match(source, /els\.gmailCaptureEnabledInput\.checked = settings\.gmailCaptureEnabled === true;/);
  assert.match(source, /gmailCaptureEnabled: els\.gmailCaptureEnabledInput \? els\.gmailCaptureEnabledInput\.checked : settings\.gmailCaptureEnabled === true,/);
  assert.match(source, /gmailCaptureToggleTitle\.textContent = translateUiText\('Gmail thread context'\)/);
});

test('enabling thread capture once stays on until it is turned off again', () => {
  // The settings checkbox persists immediately on change so a later unrelated
  // Settings save cannot silently write gmailCaptureEnabled back to false.
  assert.match(source, /els\.gmailCaptureEnabledInput\?\.addEventListener\('change', async \(\) => \{/);
  assert.match(source, /await trackInstantSave\('assist', persistGmailCaptureEnabled\(enabled\)\)/);
  // The send-time gate honors the persisted setting on every thread send, so
  // there is no second consent click after the first enable.
  assert.match(source, /explicitSiteCapture: Boolean\(options\.explicitSiteCapture\) \|\| \(settings\.gmailCaptureEnabled === true && isGmailThreadUrl\(tab\.url\)\),/);
});

test('capture wrap styling positions the dismiss control without shrinking the button', () => {
  assert.match(css, /\.context-explicit-capture-wrap \{ position: relative; margin: 0 0 7px; \}/);
  assert.match(css, /\.context-explicit-capture-wrap\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.context-explicit-capture-dismiss \{/);
  const dismissBlock = css.slice(css.indexOf('.context-explicit-capture-dismiss {'), css.indexOf('.context-explicit-capture-dismiss:hover'));
  assert.match(dismissBlock, /position: absolute;/);
  assert.match(dismissBlock, /border: 1px solid transparent;/);
});
