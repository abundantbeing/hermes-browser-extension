import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { auditCss, auditFiles } from '../scripts/check-display-typography.mjs';

const BAD_LEGACY = `
.status-copy strong {
  font-family: var(--hermes-font-display);
  line-height: 0.96;
  letter-spacing: 0;
  overflow: hidden;
  white-space: nowrap;
}
`;

const GOOD_TOKEN = `
.status-copy strong {
  font-family: var(--hermes-font-display);
  line-height: var(--hermes-display-line-height, 1.25);
  letter-spacing: var(--hermes-display-tracking);
  padding-block-end: 0.12em;
}
`;

test('display typography lint rejects legacy tight status title', () => {
  const violations = auditCss(BAD_LEGACY, 'fixture-bad.css');
  assert.ok(violations.length >= 2, violations.map((v) => v.detail).join('; '));
  assert.ok(violations.some((v) => /line-height/i.test(v.detail)));
  assert.ok(violations.some((v) => /letter-spacing/i.test(v.detail)));
});

test('display typography lint accepts tokenized status title', () => {
  const violations = auditCss(GOOD_TOKEN, 'fixture-good.css');
  assert.deepEqual(violations, []);
});

test('production stylesheets pass display typography lint', () => {
  const violations = auditFiles();
  assert.deepEqual(violations, []);
});

test('legacy b0b23770 empty-state snippet would fail', async () => {
  const snippet = `
.empty-state strong {
  font-family: var(--hermes-font-display);
  font-size: calc(28px * var(--hermes-text-zoom, 1));
  line-height: 0.96;
  font-weight: 300;
}`;
  const violations = auditCss(snippet, 'b0b23770-snippet.css');
  assert.ok(violations.some((v) => /line-height 0\.96/.test(v.detail)));
});

test('sidepanel defines display tracking tokens', async () => {
  const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /--hermes-display-tracking:\s*0\.04em/);
  assert.match(css, /--hermes-display-line-height:\s*1\.25/);
});