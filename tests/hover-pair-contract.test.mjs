// Static guard for the hover/focus "unreadable label" bug class.
//
// sidepanel.css has a global `button:hover` that paints BOTH halves of the
// action pair (--hermes-primary-bg fill + --hermes-primary-fg label). A
// component rule that overrides only the FILL leaves the other half behind, so
// the label ends up primary-fg on a pale tint (white on pale blue, etc).
//
// Rule: any :hover/:focus-visible rule that sets `background` on a control must
// also set `color`, unless its fill is the primary pair itself. Rules the global
// pair already covers are exempt. The rendered check lives in
// tests/hover-contrast-guard-probes.mjs (npm run test:hover-guard).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const FILES = ['extension/sidepanel.css', 'extension/lib/branded-select.css', 'extension/lib/effort-control.css'];
const STATE = /:(hover|focus-visible)\b/;
const FILL = /(^|[;{\s])background(-color)?\s*:/;
const LABEL = /(^|[;{\s])color\s*:/;
// Surfaces that never inherit the global button fill (non-buttons or already isolated).
const EXEMPT = [
  /^(html\b.*)?\.(room-member-row|group-row|new-group-bot-row|bot-mode-row)\b(?!.*button)/,
  /^\.bot-mode-pet-tile\b/,
  /:not\(button\)/,
];

function rules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  return out;
}

test('hover/focus rules that repaint a control fill also repaint its label', () => {
  const offenders = [];
  const labelled = new Set();
  for (const file of FILES) {
    for (const { selector, body } of rules(readFileSync(file, 'utf8'))) {
      if (LABEL.test(body)) for (const part of selector.split(',')) labelled.add(part.trim());
    }
  }
  for (const file of FILES) {
    for (const { selector, body } of rules(readFileSync(file, 'utf8'))) {
      for (const part of selector.split(',').map((x) => x.trim())) {
        if (!STATE.test(part)) continue;
        if (!FILL.test(body) || LABEL.test(body) || labelled.has(part)) continue;
        if (/\.remove\b/.test(part)) continue;
        if (/^button:(hover|focus-visible)$/.test(part)) continue;
        if (/(^|\s)\*$|\*\)/.test(part) || /::(before|after)/.test(part)) continue;
        if (!/button|btn|action|secondary|close|toggle|tab|icon|chip|pill|link|-trigger|control/i.test(part)) continue;
        if (EXEMPT.some((re) => re.test(part))) continue;
        offenders.push(`${file}: ${part}`);
      }
    }
  }
  assert.deepEqual([...new Set(offenders)], [], 'Set `color` together with `background` in hover/focus rules. The global button:hover leaves a primary-fg label behind.');
});

test('no `* { color: inherit !important }` rule can repaint a nested button on hover', () => {
  const css = readFileSync('extension/sidepanel.css', 'utf8');
  for (const m of css.matchAll(/([^{}]*:(hover|focus-visible)\s+\*)\s*\{[^}]*color:\s*inherit\s*!important/g)) {
    assert.match(m[1], /:not\(button/, `Unsafe star-inherit rule: ${m[1].trim()}`);
  }
});
