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
  assert.match(js, /renderContextDefinitionRows\(els\.settingsContextPayload,/, 'the Settings readout is filled from the same context state');
});

test('the top bar carries no connection light', () => {
  assert.doesNotMatch(html, /topbar-status|connectionPill/);
  assert.doesNotMatch(js, /els\.connectionPill/, 'nothing writes to the removed pill');
  assert.doesNotMatch(css, /connection-pill|topbar-status/);
});

test('the commands, skill, context and model popovers share one placement above the composer card', () => {
  const shared = css.match(/#quickMoreMenu,\s*#skillMenu,\s*#contextPopover,[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(shared, 'one shared rule places the four popovers');
  assert.match(shared, /position:\s*absolute;/);
  assert.match(shared, /left:\s*var\(--hermes-composer-left/, 'the popovers take the composer card left edge');
  assert.match(shared, /width:\s*var\(--hermes-composer-width/, 'the popovers take the composer card width');
  assert.match(shared, /bottom:\s*var\(--hermes-composer-bottom/, 'the popovers hang from the composer card top edge');
  assert.match(shared, /#profileSwitchMenu,\s*#roomMemberPopover,/, 'the avatar menus join the shared placement');
  assert.match(css, /#profileSwitchMenu\s*\{[^}]*max-height:\s*min\(280px,\s*var\(--hermes-composer-space/s, 'the profile menu caps its height to the space above the composer');
  assert.match(css, /#roomMemberPopover\s*\{[^}]*max-height:\s*min\(60vh,\s*var\(--hermes-composer-space/s, 'the room roster caps its height to the space above the composer');
  assert.match(css, /#quickMoreMenu\s*\{[^}]*max-height:\s*min\(386px,\s*var\(--hermes-composer-space/s, 'the commands popup caps its height to the space above the composer');
  assert.match(css, /#contextPopover\s*\{[^}]*max-height:\s*var\(--hermes-composer-space/s, 'the context popover caps its height to the space above the composer');
  assert.doesNotMatch(css, /--hermes-composer-anchor-height/, 'the old per-control anchor is gone');
});

test('one helper measures the composer card and drives every popover on open, resize and text-area size', () => {
  const helper = js.match(/function positionComposerPopovers\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(helper, /getElementById\('composer'\)\?\.getBoundingClientRect\(\)/, 'measures the composer card itself');
  for (const name of ['--hermes-composer-left', '--hermes-composer-width', '--hermes-composer-bottom', '--hermes-composer-space']) {
    assert.ok(helper.includes(`'${name}'`), `${name} is set from the live card`);
  }
  assert.match(helper, /viewportHeight - card\.top \+ COMPOSER_POPOVER_GAP/, 'the bottom edge sits a gap above the card');
  const observer = js.match(/function observeComposerPopovers\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(observer, /globalThis\.addEventListener\?\.\('resize', positionComposerPopovers\)/, 're-measures on window resize');
  assert.match(observer, /new globalThis\.ResizeObserver\(positionComposerPopovers\)/, 're-measures when the card, top bar or text area changes size');
  assert.match(observer, /attributeFilter: \['hidden'\]/, 're-measures whenever a popover opens, from a button or from typing /');
  assert.match(observer, /els\.roomMemberPopover/, 'the room roster re-measures when it opens');
  assert.match(observer, /getElementById\('profileSwitchMenu'\)/, 'the avatar profile menu re-measures when it opens');
  assert.match(js, /\nobserveComposerPopovers\(\);\n/, 'the helper starts at boot');
  assert.doesNotMatch(js, /observeComposerAnchor/, 'the old per-control anchor helper is gone');
});
