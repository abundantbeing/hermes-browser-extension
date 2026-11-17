import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditSettingsFormFieldInsetCss,
  auditSettingsFormFieldInsetFile,
} from '../scripts/check-settings-form-field-inset.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

test('sidepanel.css keeps composer textarea left padding and resets settings textareas', () => {
  const violations = auditSettingsFormFieldInsetFile();
  assert.deepEqual(violations, []);
});

test('settings textarea override fails when composer padding leaks', () => {
  const css = `
textarea { padding: 10px 68px 34px 36px; }
.settings-pane label > textarea { margin-top: 0; }
`;
  const violations = auditSettingsFormFieldInsetCss(css, 'repro.css');
  assert.ok(violations.some((entry) => /missing .settings-dialog textarea/.test(entry.detail)));
});

test('settings textarea override passes with normal inset padding', () => {
  const css = `
textarea { padding: 10px 68px 34px 36px; }
:is(.settings-dialog, .web-settings-dialog) textarea:not(.model-sources-input) { padding: 9px; }
`;
  const violations = auditSettingsFormFieldInsetCss(css, 'fixed.css');
  assert.deepEqual(violations, []);
});

test('sidepanel.html keeps the exclusions textarea as a settings control', () => {
  const html = read('extension/sidepanel.html');
  assert.match(
    html,
    /<textarea id="pageContextExcludedOriginsInput"[^>]*class="settings-textarea"/,
    'the private/LAN exclusions field must stay a settings textarea',
  );
});