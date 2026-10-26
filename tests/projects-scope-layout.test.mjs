// The "profile … on host" scope line sat stuck and overlapped the list header: the Projects panel is a grid in a
// fixed-height drawer row, and its overflow:hidden children have a zero automatic minimum height, so a long
// list squeezed them to nothing. Rows must size to their content, and the scope line must wrap, not clip.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rule = (selector) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `${selector} rule exists`);
  return css.slice(start, css.indexOf('}', start));
};

test('the projects panel sizes its rows to their content so nothing is squeezed to zero height', () => {
  assert.match(rule('.projects-panel'), /grid-auto-rows:\s*max-content/);
});

test('the scope line is a muted block of its own that wraps at any width or text zoom', () => {
  const scope = rule('.projects-scope');
  assert.match(scope, /display:\s*block/);
  assert.match(scope, /white-space:\s*normal/);
  assert.match(scope, /overflow-wrap:\s*anywhere/);
  assert.match(scope, /min-height:/);
  assert.doesNotMatch(scope, /overflow:\s*hidden/);
  assert.match(scope, /var\(--hermes-text-zoom, 1\)/, 'it scales with the text zoom');
  assert.match(scope, /rgba\(var\(--hermes-fg-rgb\), 0\.62\)/, 'it stays muted');
});
