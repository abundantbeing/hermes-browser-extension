import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import en from '../extension/lib/locales/en.mjs';
import { loadLocaleMessages, SUPPORTED_LOCALES } from '../extension/lib/i18n-registry.mjs';

const KEYS = Object.freeze({
  'browser_control.approval_needed': 'Approval needed',
  'browser_control.off_detail': 'Hermes can read approved context but cannot operate tabs.',
  'browser_control.switch_view': 'Switch your view to this tab?',
  'browser_control.switch_view_to': 'Switch your view to "{title}"?',
});

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('approval and Control-off card copy lives in the English catalog as whole strings', () => {
  for (const [key, english] of Object.entries(KEYS)) {
    assert.equal(en[key], english, key);
  }
});

test('approval and Control-off card copy is translated in every locale, including the title placeholder', async () => {
  for (const locale of SUPPORTED_LOCALES) {
    const messages = await loadLocaleMessages(locale.id);
    for (const [key, english] of Object.entries(KEYS)) {
      assert.ok(Object.hasOwn(messages, key), `${locale.id} has ${key}`);
      const value = messages[key];
      assert.equal(typeof value, 'string', `${locale.id} ${key} is a string`);
      assert.ok(value.trim(), `${locale.id} ${key} must not be empty`);
      if (key === 'browser_control.switch_view_to') {
        assert.match(value, /\{title\}/, `${locale.id} ${key} keeps the {title} placeholder`);
      }
      if (locale.id !== 'en') {
        assert.notEqual(value, english, `${locale.id} must translate ${key}`);
      }
    }
  }
});

test('the Control view and panel route approval and off-state copy through catalog keys', () => {
  const ui = read('extension/lib/browser-control-ui.mjs');
  const panel = read('extension/sidepanel.js');
  const html = read('extension/sidepanel.html');
  const executor = read('extension/lib/browser-control-executor.mjs');
  assert.match(ui, /titleKey:\s*'browser_control\.approval_needed'/);
  assert.match(ui, /detailKey:\s*'browser_control\.off_detail'/);
  assert.match(panel, /view\.titleKey\s*\?\s*t\(view\.titleKey/);
  assert.match(panel, /view\.detailKey\s*\?\s*t\(view\.detailKey/);
  assert.match(html, /id="browserControlCardDetail"[^>]*data-i18n="browser_control\.off_detail"/);
  assert.match(executor, /reasonKey:\s*'browser_control\.switch_view'/);
  assert.match(executor, /reasonKey:\s*'browser_control\.switch_view_to'/);
  assert.match(executor, /reasonParams:\s*\{\s*title:\s*label\s*\}/);
});
