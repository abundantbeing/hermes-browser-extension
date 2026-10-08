import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync('extension/sidepanel.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const body = (selector) => {
  const escaped = selector.replace(/[.[\]()]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] || '';
};
const prop = (block, name) => block.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim();

// The model-selector switch (.toggle-switch) must look exactly like the
// Settings switch (.settings-switch): square, same size, same on/off pairs.
test('model selector switches match the Settings switch', () => {
  for (const [a, b] of [['.toggle-switch', '.settings-switch'], ['.toggle-switch::after', '.settings-switch::after']]) {
    for (const name of ['width', 'height', 'top', 'left', 'border', 'background']) {
      assert.equal(prop(body(a), name), prop(body(b), name), `${a} ${name} must match ${b}`);
    }
  }
  assert.doesNotMatch(body('.toggle-switch'), /border-radius:\s*[1-9]/, 'track is square');
  assert.doesNotMatch(body('.toggle-switch::after'), /border-radius:\s*[1-9]/, 'thumb is square');
  const on = body('.toggle-switch.on');
  assert.match(on, /background:\s*var\(--hermes-primary-bg\)/);
  assert.match(on, /border-color:\s*var\(--hermes-accent\)/);
  const onThumb = body('.toggle-switch.on::after');
  assert.match(onThumb, /translateX\(14px\)/);
  assert.match(onThumb, /background:\s*var\(--hermes-primary-fg\)/);
});
