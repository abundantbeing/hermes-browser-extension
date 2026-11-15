import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  auditCss,
  auditFiles,
  effectiveLineHeight,
  lineHeightFromFontShorthand,
  parseRules,
} from '../scripts/check-display-typography.mjs';

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

test('display typography lint audits rules inside @media blocks', () => {
  const nested = `
@media (max-width: 340px) {
  .onboarding-title {
    font-family: var(--hermes-font-display);
    line-height: 0.95;
    letter-spacing: 0;
  }
}`;
  assert.ok(auditCss(nested, 'nested.css').length > 0);
});

test('display typography lint honors later line-height and letter-spacing overrides', () => {
  const overrides = `
.headline {
  font: 500 20px/1 var(--hermes-font-display);
  line-height: 1.25;
  letter-spacing: var(--hermes-display-tracking);
}`;
  assert.deepEqual(auditCss(overrides, 'override-ok.css'), []);
  const cramped = `
.headline {
  font-family: var(--hermes-font-display);
  line-height: 1.25;
  letter-spacing: var(--hermes-display-tracking);
  line-height: 0.8;
  letter-spacing: 0;
}`;
  assert.ok(auditCss(cramped, 'override-bad.css').length >= 2);
});

test('display typography lint accepts px line-height in font shorthand', () => {
  const rule = `
.headline {
  font: 500 20px/26px var(--hermes-font-display);
  letter-spacing: 0.04em;
}`;
  assert.deepEqual(auditCss(rule, 'font-px-lh.css'), []);
  assert.equal(lineHeightFromFontShorthand('500 20px/26px var(--hermes-font-display)'), 1.3);
});

test('display typography lint rejects pixel line-height tighter than font size', () => {
  const pxLh = `
.headline {
  font-family: var(--hermes-font-display);
  font-size: 20px;
  line-height: 10px;
  letter-spacing: 0.04em;
}`;
  assert.ok(auditCss(pxLh, 'px-lh.css').some((v) => /line-height/.test(v.detail)));
  assert.equal(effectiveLineHeight('font-size: 20px; line-height: 10px'), 0.5);
});

test('new-group dialog title keeps fg color on custom themes', async () => {
  const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  const rule = parseRules(css, 'sidepanel.css').find((entry) => entry.selector.trim() === '.new-group-head h2');
  assert.ok(rule, '.new-group-head h2 rule exists');
  assert.match(rule.body, /color:\s*var\(--hermes-fg\)/);
});