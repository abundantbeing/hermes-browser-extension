import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('the Settings header adds no side inset, so its ends meet the divider', () => {
  const css = read('extension/sidepanel.css');
  const rules = [...css.matchAll(/\.settings-dialog header \{[^}]*\}/g)].map((match) => match[0]);
  const last = rules.filter((rule) => /padding/.test(rule)).at(-1) || '';
  assert.match(last, /padding-inline: 0;/, 'the last header padding rule keeps the sides at zero');
  assert.match(css, /\.settings-dialog form \{[^}]*padding: 0 14px 28px;/, 'the form owns the 14px inset');
});

test('every category pane opens with an icon-only back button and a proper heading', () => {
  const html = read('extension/sidepanel.html');
  const bars = [...html.matchAll(/<div class="settings-pane-bar">([\s\S]*?)<\/div>\s*<\/div>/g)].map((match) => match[1]);
  assert.equal(bars.length, 9, 'nine category panes');
  for (const bar of bars) {
    const back = bar.match(/<button[^>]*data-settings-back[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(back, 'back button present');
    assert.match(back[0], /aria-label="Back to categories"/);
    assert.match(back[0], /data-i18n-aria-label="settings\.categories\.back_to"/);
    assert.match(back[0], /data-i18n-title="settings\.categories\.back_to"/);
    assert.match(back[1], /^<svg[^>]*data-icon="arrow-left"[^>]*>[\s\S]*<\/svg>$/, 'only the pixel arrow inside');
    assert.doesNotMatch(back[0], /class="[^"]*secondary/);
    assert.match(bar, /<div class="settings-pane-heading"><span class="settings-pane-crumb" aria-hidden="true" data-i18n="ui\.settings">Settings<\/span><h3 id="settingsPaneTitle-[a-z-]+" class="settings-pane-title" tabindex="-1"/);
  }
  assert.doesNotMatch(html, /&larr;<\/span><span data-i18n="settings\.categories\.back">/, 'the old text button is gone');
});

test('the back button mirrors the close button and the title uses the display face', () => {
  const css = read('extension/sidepanel.css');
  const back = css.match(/\.settings-pane-back \{[^}]*\}/)?.[0] || '';
  for (const declaration of ['width: 30px', 'height: 30px', 'padding: 0', 'border-color: var(--hermes-line-strong)']) assert.ok(back.includes(declaration), declaration);
  assert.match(css, /\.settings-close-icon \{[^}]*width: 30px;/);
  const title = css.match(/\.settings-pane-title \{[^}]*\}/)?.[0] || '';
  assert.match(title, /font-family: var\(--hermes-font-display\)/);
  assert.match(css, /\.settings-pane-bar \{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto;/, 'back, heading, edited hint');
  assert.match(css, /html\[dir="rtl"\] \.settings-pane-back svg \{ transform: scaleX\(-1\); \}/);
});

test('Escape and the back button still return to the categories', () => {
  const js = read('extension/sidepanel.js');
  assert.match(js, /if \(event\.target\.closest\?\.\('\[data-settings-back\]'\)\) showSettingsPane\(''\);/);
  assert.match(js, /if \(!els\.settingsDialog\.hidden && settingsActivePane\) \{\s*showSettingsPane\(''\);/);
  const english = read('extension/lib/locales/en.mjs');
  assert.match(english, /"settings\.categories\.back_to": "Back to categories"/);
});
