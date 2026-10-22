import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('extension/sidepanel.html');
const css = read('extension/sidepanel.css');
const js = read('extension/sidepanel.js');

// The field holds the model chip, the context ring and the mic. The action row
// holds Commands beside Hermes Control and Ask Hermes.
const fieldStart = html.indexOf('<div class="composer-input-wrap"');
const actionsStart = html.indexOf('<div class="composer-actions">');
const field = html.slice(fieldStart, actionsStart);
const actions = html.slice(actionsStart, html.indexOf('</form>', actionsStart));
const settingsSessions = html.slice(html.indexOf('id="settingsPane-sessions"'), html.indexOf('id="settingsPane-assist"'));

test('the side panel has no bottom status row under the composer', () => {
  assert.doesNotMatch(html, /class="desktop-bar"/);
  assert.doesNotMatch(css, /\.desktop-bar\b/);
  assert.doesNotMatch(css, /\.context-bar\b/);
});

test('the model chip and context ring live in the composer field, beside the mic', () => {
  assert.ok(fieldStart > 0 && actionsStart > fieldStart, 'composer field and action row are both present');
  for (const id of ['modelMenuButton', 'contextBarButton', 'voiceButton']) {
    assert.ok(field.includes(`id="${id}"`), `${id} sits inside the composer field`);
    assert.ok(!actions.includes(`id="${id}"`), `${id} is not in the action row`);
  }
  assert.ok(
    field.indexOf('id="contextBarButton"') < field.indexOf('id="voiceButton"'),
    'the context ring sits before the mic',
  );
});

test('the model chip shows the short name and keeps effort in its accessible name', () => {
  const chip = html.match(/<button id="modelMenuButton"[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(chip, /<span id="currentModelName"/, 'the chip names the model');
  assert.match(chip, /<strong id="currentModelEffort" class="sr-only"/, 'effort is read by screen readers but not drawn on the chip');
});

test('Commands is an icon button beside Hermes Control, with its popup anchored to the row', () => {
  const commands = html.match(/<button id="commandMenuButton"[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(commands, /class="composer-commands-button"/);
  assert.match(commands, /data-icon="terminal"/);
  assert.match(actions, /<span class="composer-commands">\s*<button id="commandMenuButton"[\s\S]*?<\/span>/);
  // The popup itself lives in the shell, outside the dock, so the dock's backdrop filter cannot clip or re-anchor it.
  assert.match(html, /<\/footer>\s*<section id="skillMenu"[\s\S]*?<section id="quickMoreMenu"[\s\S]*?<\/main>/);
  assert.ok(
    actions.indexOf('id="commandMenuButton"') < actions.indexOf('id="browserControlMenuButton"'),
    'Commands sits directly before Hermes Control',
  );
});

test('the context readout lives in Settings, under Sessions & Context', () => {
  for (const id of ['settingsContextSummary', 'settingsContextRuntime', 'settingsContextPayload']) {
    assert.ok(settingsSessions.includes(`id="${id}"`), `${id} is in the Sessions & Context pane`);
  }
  assert.match(js, /els\.settingsContextPayload\.replaceChildren/, 'the Settings readout is filled from the same context state');
});

test('the top bar carries no connection light', () => {
  assert.doesNotMatch(html, /topbar-status|connectionPill/);
  assert.doesNotMatch(js, /els\.connectionPill/, 'nothing writes to the removed pill');
  assert.doesNotMatch(css, /connection-pill|topbar-status/);
});
