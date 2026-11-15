import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Rule: the side column of a Settings card is for the square switch only. A card whose control is a
// button stacks instead: text across the full width, the buttons below it at full width, their labels
// free to wrap. A long button label in the side column squeezed the Hermes account text into a strip
// a few words wide.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

function rules(css) {
  return [...css.matchAll(/(?:^|[}\n])\s*([^{}@][^{}]*)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

const css = read('extension/sidepanel.css');

test('a Settings card that holds a button stacks into one column', () => {
  const stack = rules(css).find(({ selector }) => /\.settings-toggle-card:has\(button\)\s*$/m.test(selector.split(',').pop()));
  assert.ok(stack, 'one rule for .settings-toggle-card:has(button)');
  assert.match(stack.body, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.match(stack.selector, /settings-dialog/, 'it outranks the two-column dialog rule');
});

test('the buttons in a stacked card fill the width and wrap their labels', () => {
  const buttons = rules(css).find(({ selector }) => /\.settings-toggle-card:has\(button\)\s+button\b/.test(selector));
  assert.ok(buttons, 'a rule for the buttons inside a stacked card');
  assert.match(buttons.body, /inline-size:\s*100%|width:\s*100%/);
  assert.match(buttons.body, /white-space:\s*normal/);
});

test('no card overrides the stack back into two columns', () => {
  const offenders = rules(css)
    .filter(({ selector, body }) => /hermes-account-row|settings-toggle-card:has\(button\)/.test(selector)
      && /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/.test(body))
    .map(({ selector }) => selector);
  assert.deepEqual(offenders, []);
});

test('every Settings card with a side control uses the switch or a button, never anything else', () => {
  const html = read('extension/sidepanel.html');
  const cards = [...html.matchAll(/<(div|label) class="settings-toggle-card[^"]*"[^>]*>([\s\S]*?)<\/\1>/g)];
  assert.ok(cards.length >= 10, 'found the cards');
  for (const [, , inner] of cards) {
    const outside = inner.replace(/<span class="settings-toggle-copy">[\s\S]*?<\/span>\s*(?=<)/, '');
    const controls = [...outside.matchAll(/<(select|a|textarea|input)\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => !/class="settings-switch-input"/.test(tag));
    assert.deepEqual(controls, [], 'a side control other than the switch or a button');
  }
});
