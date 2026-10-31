import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

// These boxes apply on their own (zoom, font, theme search, theme prompt).
// They sit inside #settingsForm, where Enter would otherwise submit the whole
// form: a full Save that re-probes the gateway and closes Settings.
const INSTANT_APPLY_INPUTS = [
  'textZoomInput',
  'customFontFamilyInput',
  'marketplaceThemeSearchInput',
  'agentThemeDescription',
];

test('Save keeps Settings open so its Saved state stays visible', () => {
  const start = js.indexOf("els.settingsForm.addEventListener('submit'");
  assert.ok(start > 0, 'settings submit handler not found');
  const end = js.indexOf('\n  });', start);
  const handler = js.slice(start, end);
  assert.match(handler, /setSaveSettingsState\('saved'\)/);
  assert.doesNotMatch(handler, /closeSettingsDialog\(\)/, 'Save must not close Settings out from under its own confirmation');
});

test('instant-apply settings boxes keep Enter from submitting the settings form', () => {
  const start = html.indexOf('id="settingsForm"');
  const end = html.indexOf('</form>', start);
  assert.ok(start > 0 && end > start, 'settings form not found');
  const form = html.slice(start, end);
  for (const id of INSTANT_APPLY_INPUTS) {
    assert.match(form, new RegExp(`<input[^>]*id="${id}"`), `${id} should be inside the settings form`);
    const guarded = new RegExp(`handleEnterInSettingsField\\(els\\.${id}\\b`).test(js)
      || new RegExp(`els\\.${id}\\?\\.addEventListener\\('keydown'[\\s\\S]{0,160}?event\\.preventDefault\\(\\)`).test(js);
    assert.ok(guarded, `${id} must handle Enter itself instead of submitting Settings`);
  }
});
