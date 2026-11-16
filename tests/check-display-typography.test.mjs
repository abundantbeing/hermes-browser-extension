import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  auditCss,
  auditFiles,
  effectiveLineHeight,
  fontShorthandParts,
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

test('display typography lint audits sibling rules after tracking token in @media', () => {
  const repro = `
@media (max-width: 340px) {
  .ok { font-family: var(--hermes-font-display); letter-spacing: var(--hermes-display-tracking); line-height: 1.3; }
  .bad { font-family: var(--hermes-font-display); line-height: 0.9; letter-spacing: 0; }
}`;
  const rules = parseRules(repro, 'sibling-tracking.css');
  assert.deepEqual(
    rules.map((r) => r.selector.trim()),
    ['.ok', '.bad'],
    rules.map((r) => JSON.stringify(r.selector)).join('; '),
  );
  const violations = auditCss(repro, 'sibling-tracking.css');
  assert.equal(violations.length, 2, violations.map((v) => `${v.selector}: ${v.detail}`).join('; '));
  assert.ok(violations.every((v) => v.selector.trim() === '.bad'));
  assert.equal(rules.find((r) => r.selector.trim() === '.bad').line, 4);
});

test('display typography lint keeps clean sibling selectors inside @media', () => {
  const mediaSiblings = `
@media (a) {
  .ok { color: red; }
  .bad { font-family: var(--hermes-font-display); line-height: 0.9; letter-spacing: 0; }
}`;
  const rules = parseRules(mediaSiblings, 'siblings.css');
  assert.deepEqual(rules.map((r) => r.selector.trim()), ['.ok', '.bad']);
  assert.ok(auditCss(mediaSiblings, 'siblings.css').length >= 2);
});

test('display typography lint keeps clean sibling selectors in nested @media/@supports', () => {
  const nestedSiblings = `
@media (max-width: 340px) {
  @supports (display: grid) {
    .ok { font-family: var(--hermes-font-display); line-height: 1.3; letter-spacing: 0.04em; }
    .bad { font-family: var(--hermes-font-display); line-height: 0.9; letter-spacing: 0; }
  }
}`;
  const rules = parseRules(nestedSiblings, 'nested-siblings.css');
  assert.deepEqual(rules.map((r) => r.selector.trim()), ['.ok', '.bad']);
  const badLine = rules.find((r) => r.selector.trim() === '.bad').line;
  assert.equal(badLine, 5);
  assert.ok(auditCss(nestedSiblings, 'nested-siblings.css').some((v) => v.selector.trim() === '.bad'));
});

test('display typography lint audits rules nested in @media and @supports', () => {
  const nested = `
@media (max-width: 340px) {
  @supports (display: grid) {
    .onboarding-title {
      font-family: var(--hermes-font-display);
      line-height: 0.95;
      letter-spacing: 0;
    }
  }
}`;
  const rules = parseRules(nested, 'nested-at.css');
  assert.ok(rules.some((r) => r.selector.includes('onboarding-title')), rules.map((r) => r.selector).join('; '));
  assert.ok(auditCss(nested, 'nested-at.css').length > 0);
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
  const fontWins = `
.headline {
  line-height: 1.25;
  letter-spacing: var(--hermes-display-tracking);
  font: 500 20px/1 var(--hermes-font-display);
}`;
  assert.ok(auditCss(fontWins, 'font-wins.css').some((v) => /line-height/.test(v.detail)));
});

test('font shorthand parser ignores division inside calc()', () => {
  const parts = fontShorthandParts('500 calc(20px / 2)/1.25 var(--hermes-font-display)');
  assert.equal(parts.lhRaw, '1.25');
  assert.equal(lineHeightFromFontShorthand('500 calc(20px / 2)/1.25 var(--hermes-font-display)'), 1.25);
  const rule = `
.headline {
  font: 500 calc(20px / 2)/1.25 var(--hermes-font-display);
  letter-spacing: 0.04em;
}`;
  assert.deepEqual(auditCss(rule, 'calc-div-lh.css'), []);
});

test('display typography lint rejects multi-term calc with separate px line-height', () => {
  const cramped = `
.headline {
  font: 500 calc(20px + 2px + 2px) var(--hermes-font-display);
  line-height: 16px;
  letter-spacing: 0.04em;
}`;
  const violations = auditCss(cramped, 'calc-multi-separate-lh.css');
  assert.ok(
    violations.some((v) => /line-height/.test(v.detail)),
    violations.map((v) => v.detail).join('; '),
  );
});

test('display typography lint rejects unresolvable calc font size with px line-height', () => {
  const rule = `
.headline {
  font: 500 calc(20px * var(--hermes-text-zoom, 1)) var(--hermes-font-display);
  line-height: 16px;
  letter-spacing: 0.04em;
}`;
  const violations = auditCss(rule, 'calc-var-separate-lh.css');
  assert.ok(
    violations.some((v) => /cannot verify line-height|line-height/.test(v.detail)),
    violations.map((v) => v.detail).join('; '),
  );
});

test('display typography lint rejects cramped calc font size with px line-height', () => {
  const cramped = `
.headline {
  font: 500 calc(20px + 4px)/16px var(--hermes-font-display);
  letter-spacing: 0.04em;
}`;
  assert.ok(
    auditCss(cramped, 'calc-cramped.css').some((v) => /line-height/.test(v.detail)),
    auditCss(cramped, 'calc-cramped.css').map((v) => v.detail).join('; '),
  );
  assert.ok(lineHeightFromFontShorthand('500 calc(20px + 4px)/16px var(--hermes-font-display)') < 1.2);
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