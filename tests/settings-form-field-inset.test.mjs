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

test('inline inset respects later padding-left after padding shorthand', () => {
  const css = `
textarea { padding: 10px 68px 34px 36px; }
:is(.settings-dialog, .web-settings-dialog) textarea { padding: 9px; padding-left: 40px; }
`;
  const violations = auditSettingsFormFieldInsetCss(css, 'order.css');
  assert.ok(
    violations.some((entry) => entry.detail.includes('40px')),
    'later padding-left must win over earlier padding shorthand',
  );
});

test('inline inset respects later padding shorthand after padding-left', () => {
  const css = `
textarea { padding: 10px 68px 34px 36px; }
:is(.settings-dialog, .web-settings-dialog) textarea { padding-left: 40px; padding: 9px; }
`;
  const violations = auditSettingsFormFieldInsetCss(css, 'order.css');
  const padViolations = violations.filter((entry) => entry.detail.includes('padding-inline-start'));
  assert.ok(
  padViolations.every((entry) => !entry.detail.includes('40px')),
    'later padding shorthand must win over earlier padding-left',
  );
});

test('nested settings field selectors are audited', () => {
  const css = `
textarea { padding: 10px 68px 34px 36px; }
:is(.settings-dialog, .web-settings-dialog) textarea { padding: 9px; }
.settings-pane .settings-field > textarea { padding: 36px; }
`;
  const violations = auditSettingsFormFieldInsetCss(css, 'nested.css');
  assert.ok(
    violations.some((entry) => entry.selector?.includes('.settings-pane .settings-field > textarea')),
    'nested settings textarea rules must be checked',
  );
});

test('text-indent-only settings field rules are audited', () => {
  const css = `
textarea { padding: 10px 68px 34px 36px; }
:is(.settings-dialog, .web-settings-dialog) textarea { padding: 9px; }
.settings-dialog input { text-indent: 36px; }
`;
  const violations = auditSettingsFormFieldInsetCss(css, 'indent.css');
  assert.ok(
    violations.some((entry) => entry.detail.includes('text-indent') && entry.detail.includes('36px')),
    'text-indent must be checked without a padding declaration',
  );
});