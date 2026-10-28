// Glass bubble tokens and the message-row/rail/room UI contract.
// String-level checks against the shipped CSS and markup, mirroring the
// style of tests/extension-theme-contrast-contract.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const css = readFileSync(path.join(root, 'extension', 'sidepanel.css'), 'utf8');
const themesCss = readFileSync(path.join(root, 'extension', 'sidepanel-themes.css'), 'utf8');
const html = readFileSync(path.join(root, 'extension', 'sidepanel.html'), 'utf8');

function blockOf(source, selector) {
  const start = source.indexOf(selector);
  if (start === -1) return '';
  const open = source.indexOf('{', start);
  if (open === -1) return '';
  const close = source.indexOf('}', open);
  if (close === -1) return '';
  return source.slice(open + 1, close);
}

function tokenPercent(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*(\\d+)%`));
  return match ? Number(match[1]) : NaN;
}

test('glass tokens: the light default resolves to fully opaque, zero blur', () => {
  const light = blockOf(css, ':root {');
  assert.equal(tokenPercent(light, 'hermes-bubble-user-alpha'), 100, 'light user alpha is 100%');
  assert.equal(tokenPercent(light, 'hermes-bubble-assistant-alpha'), 100, 'light assistant alpha is 100%');
  assert.match(light, /--hermes-bubble-blur:\s*0px/, 'light blur is 0px');
  assert.match(light, /--hermes-bubble-saturate:\s*1(?![.\d])/, 'light saturate is 1');
});

test('glass tokens: the dark block defines all four tokens and glasses the bubbles', () => {
  const dark = blockOf(css, 'html[data-hermes-mode="dark"] {');
  assert.notEqual(dark, '', 'a dark-mode glass token block exists');
  const user = tokenPercent(dark, 'hermes-bubble-user-alpha');
  const assistant = tokenPercent(dark, 'hermes-bubble-assistant-alpha');
  assert.ok(user >= 25 && user <= 90, `dark user alpha ${user}% is between 45% and 90%`);
  assert.ok(assistant >= 25 && assistant <= 90, `dark assistant alpha ${assistant}% is between 45% and 90%`);
  assert.match(dark, /--hermes-bubble-blur:\s*\d+(?:\.\d+)?px/, 'dark blur is a positive px value');
  assert.match(dark, /--hermes-bubble-saturate:\s*\d+(?:\.\d+)?/, 'dark saturate is set');
});

test('glass tokens: reduced transparency and forced colors fall back to opaque', () => {
  assert.match(
    css,
    /@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*,\s*\(forced-colors:\s*active\)\s*\{[\s\S]*?--hermes-bubble-user-alpha:\s*100%[\s\S]*?--hermes-bubble-assistant-alpha:\s*100%[\s\S]*?--hermes-bubble-blur:\s*0px/,
    'a reduced-transparency/forced-colors guard restores opaque bubbles',
  );
});

test('glass tokens: each bubble role sets its background exactly once, from the token', () => {
  const userRules = [...css.matchAll(/^\.message\.user\s*\{[^}]*\bbackground:/gm)].length;
  const assistantRules = [...css.matchAll(/^\.message\.assistant\s*\{[^}]*\bbackground:/gm)].length;
  assert.equal(userRules, 1, 'exactly one .message.user rule sets a background (no competing layer)');
  assert.equal(assistantRules, 1, 'exactly one .message.assistant rule sets a background');
  assert.match(
    css,
    /^\.message\.user\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--hermes-user-bg[\s\S]*?var\(--hermes-bubble-user-alpha\)/m,
    'the user bubble mixes through --hermes-bubble-user-alpha',
  );
  assert.match(
    css,
    /^\.message\.assistant\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--hermes-card-bg[\s\S]*?var\(--hermes-bubble-assistant-alpha\)/m,
    'the assistant bubble mixes through --hermes-bubble-assistant-alpha',
  );
  assert.match(css, /backdrop-filter:\s*blur\(var\(--hermes-bubble-blur\)\)\s*saturate\(var\(--hermes-bubble-saturate\)\)/, 'backdrop-filter reads the blur token');
});

test('glass tokens: built-in light mode stays opaque in the theme layer', () => {
  assert.match(
    themesCss,
    /html\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-bubble-user-alpha:\s*100%[^}]*--hermes-bubble-assistant-alpha:\s*100%[^}]*--hermes-bubble-blur:\s*0px/,
    'sidepanel-themes.css pins light mode to opaque bubbles',
  );
});

test('glass tokens: a custom theme card is opaque so bubble alpha is the only translucency', () => {
  const custom = blockOf(css, 'html[data-hermes-theme^="custom:"] {');
  assert.notEqual(custom, '', 'the custom theme block exists');
  assert.doesNotMatch(
    custom,
    /--hermes-card-bg:[^;]*transparent/i,
    'a custom theme --hermes-card-bg must be opaque; a pre-mixed translucent value compounds with the bubble alpha',
  );
  assert.match(custom, /--hermes-card-bg:\s*var\(--hermes-canvas\)\s*;/, 'a custom theme card is the opaque canvas color');
});

test('message rail: row wrapper, reveal states, and bubble-adjacent left placement', () => {
  assert.match(css, /\.message-row\s*\{[^}]*position:\s*relative/, '.message-row is a positioned flex container');
  assert.match(css, /\.message-row\[data-role="user"\]\s*\{[^}]*align-items:\s*flex-end/);
  assert.match(css, /\.message-row\[data-role="assistant"\]\s*\{[^}]*align-items:\s*flex-start/);
  assert.match(css, /\.message-rail\s*\{[^}]*min-height:\s*24px/, 'the below-state rail reserves its row height');
  assert.match(css, /\.message-row\.is-pinned\s*>\s*\.message-rail/, 'pinned rows reveal the rail');
  // Left placement must sit in layout flow IMMEDIATELY before the bubble. An
  // absolutely pinned rail cannot be bubble-adjacent: measured in real Chromium
  // it either left a 260px gap (row-start pin) or overlapped the bubble (row-end
  // pin, because a 125px rail is wider than a 97px bubble).
  const leftRow = css.match(/\.message-row\[data-actions="left"\]\s*\{[^}]*\}/);
  assert.ok(leftRow, 'a left-placement row rule exists');
  assert.match(leftRow[0], /flex-direction:\s*row/, 'the left state lays the rail and bubble out in a row');
  const userLeftRow = css.match(/\.message-row\[data-role="user"\]\[data-actions="left"\]\s*\{[^}]*\}/);
  assert.ok(userLeftRow, 'a right-aligned user row keeps its left state');
  assert.match(userLeftRow[0], /justify-content:\s*flex-end/, 'the user row + rail group stays right-aligned');
  const leftRail = css.match(/\.message-row\[data-actions="left"\]\s*>\s*\.message-rail\s*\{[^}]*\}/);
  assert.ok(leftRail, 'the left-state rail rule exists');
  assert.doesNotMatch(leftRail[0], /position:\s*absolute/, 'the left-state rail must not be absolutely pinned');
  assert.match(leftRail[0], /order:\s*-1/, 'the rail is ordered before the bubble');
  assert.match(leftRail[0], /margin:[^;]*8px/, 'the left-state rail keeps the specified 8px bubble gap');
  assert.match(css, /\[dir="rtl"\][^{]*\.message-row\[data-actions="left"\][^{]*\.message-rail/, 'the left-placed rail has an RTL counterpart');
  assert.match(css, /\.message-day-divider/, 'the day divider rule exists');
  assert.match(css, /\.message-row\.is-run-continuation/, 'run continuation grouping exists');
  assert.match(css, /\.message-row\.has-run-next\s*>\s*\.message/, 'the run tail corner rule exists');
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?\.message-row\.is-entering|\.message-row\.is-entering[\s\S]*?prefers-reduced-motion:\s*reduce/, 'entrance respects reduced motion');
});

test('message editor and restore popover selectors exist', () => {
  for (const selector of ['.message-editor', '.message-editor-input', '.message-editor-actions', '.message-editor-cancel', '.message-editor-send', '.message-restore-popover', '.message-restore-confirm', '.message-restore-cancel']) {
    assert.match(css, new RegExp(selector.replace(/\./g, '\\.') + '\\b'), `${selector} is styled`);
  }
  assert.match(css, /\.message-row\.is-editing[\s\S]*?\.message-rail|\.message-row\.is-editing\s*>\s*\.message-rail/, 'editing hides the rail');
});

test('room identity, working line, failure notices, and member popover selectors exist', () => {
  for (const selector of ['.room-message', '.room-avatar', '.room-name', '.group-presence', '.presence-notice', '.presence-avatar', '.group-working-line', '.group-working-avatar', '.group-working-name', '.group-working-status', '.room-event-line', '.room-member-popover', '.room-member-row', '.room-member-change']) {
    assert.match(css, new RegExp(selector.replace(/\./g, '\\.') + '\\b'), `${selector} is styled`);
  }
  assert.match(css, /@keyframes groupWorkingScan/, 'the working line shimmer exists');
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.group-working-avatar,[^}]*animation: none/, 'reduced motion stills the working line');
  assert.doesNotMatch(css, /\.presence-chip\b/, 'the chip strip is gone');
  assert.match(css, /\.room-member-change\s*\{[^}]*background:\s*var\(--hermes-primary-bg/, 'the Change button uses the theme primary pair');
  // A room bubble must degrade to the plain glass bubble when the identity tint
  // has not been applied, never to a dropped background declaration.
  assert.match(css, /var\(--bot-tint,\s*transparent\)/, 'a missing room tint degrades to transparent over the base glass');
  assert.match(css, /var\(--bot-bar,\s*var\(--hermes-ink,\s*#fff\)\)/, 'a missing room bar color falls back to the theme ink');
  assert.match(css, /color:\s*var\(--bot-ink,\s*var\(--hermes-ink,\s*#fff\)\)/, 'a missing room ink color falls back to the theme ink');
});

test('theme layer: the nous-light room tint workaround also carries a tint fallback', () => {
  assert.match(
    themesCss,
    /var\(--bot-tint,\s*transparent\)/,
    'the nous-light room shadow must not be dropped when the tint is unset',
  );
});

test('sidepanel markup exposes the new template, setting, presence strip, and popover', () => {
  assert.match(html, /<template id="messageTemplate">\s*<div class="message-row">\s*<article class="message" tabindex="0">/, 'the template wraps the article in .message-row');
  assert.match(html, /id="showMessageTimesInput"/, 'the Show message times toggle exists');
  assert.match(html, /id="groupPresence"[^>]*class="group-presence"[^>]*role="list"/, '#groupPresence lists the failure notices');
  assert.match(html, /id="messages"[^>]*><\/section>\s*<!--[^>]*-->\s*<div id="groupWorkingLine" class="group-working-line"/, 'the working line follows the thread');
  assert.match(html, /id="groupWorkingStatus"[^>]*role="status"[^>]*aria-live="polite"/, 'the working line has a polite status for screen readers');
  assert.doesNotMatch(html, /id="groupPresenceChips"|id="groupPresenceStatus"/, 'the chip strip markup is gone');
  assert.match(html, /id="roomMemberPopover"/, 'the room member popover container exists');
  assert.doesNotMatch(html, /id="groupTypingIndicator"/, 'the old typing indicator markup is gone');
});