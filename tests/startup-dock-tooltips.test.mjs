import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasVisibleLabel } from '../extension/lib/startup-screen.mjs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

// Just enough of a DOM for a flat button: its direct children as text nodes
// or elements with a tag, classes, attributes and text.
function buttonFromMarkup(id) {
  const match = new RegExp(`<button id="${id}"[^>]*>([\\s\\S]*?)</button>`).exec(html);
  assert.ok(match, `#${id} is in sidepanel.html`);
  const childNodes = [];
  const pattern = /<(svg|span)\b([^>]*)>([\s\S]*?)<\/\1>|([^<]+)/g;
  for (const [, tag, attrs = '', inner = '', text] of match[1].matchAll(pattern)) {
    if (text !== undefined) {
      childNodes.push({ nodeType: 3, textContent: text });
      continue;
    }
    const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const classes = (attr('class') || '').split(/\s+/);
    childNodes.push({
      nodeType: 1,
      tagName: tag.toUpperCase(),
      classList: { contains: (name) => classes.includes(name) },
      getAttribute: attr,
      textContent: inner.replace(/<[^>]+>/g, ''),
    });
  }
  return { childNodes };
}

test('the labelled Connect button shows its name, the dock icon buttons do not', () => {
  assert.equal(hasVisibleLabel(buttonFromMarkup('startupConnectButton')), true);
  assert.equal(hasVisibleLabel(buttonFromMarkup('startupTestConnectionButton')), false);
  assert.equal(hasVisibleLabel(buttonFromMarkup('settingsButton')), false);
});

test('Connect keeps "Connect to Hermes" as its accessible name and has no duplicate title', () => {
  const tag = /<button id="startupConnectButton"([^>]*)>/.exec(html)[1];
  assert.doesNotMatch(tag, /\btitle=|\bdata-tip=/);
  assert.match(html, /<button id="startupConnectButton"[\s\S]*?<span data-i18n="ui\.connect\.to\.hermes">Connect to Hermes<\/span><\/button>/);
});

test('the startup dock drops the tooltip on labelled buttons and keeps it on icon buttons', () => {
  const screen = readFileSync(new URL('../extension/lib/startup-screen.mjs', import.meta.url), 'utf8');
  assert.match(screen, /if \(hasVisibleLabel\(button\)\) \{\s*delete button\.dataset\.tip;\s*continue;\s*\}\s*const tip = button\.dataset\.startupTitle \|\| button\.getAttribute\('aria-label'\)/);
  assert.equal(hasVisibleLabel({ childNodes: [{ nodeType: 3, textContent: '  ' }] }), false);
  assert.equal(hasVisibleLabel({ childNodes: [{ nodeType: 3, textContent: 'Go' }] }), true);
  const hidden = { nodeType: 1, tagName: 'SPAN', classList: { contains: () => false }, getAttribute: (n) => (n === 'aria-hidden' ? 'true' : null), textContent: 'x' };
  assert.equal(hasVisibleLabel({ childNodes: [hidden] }), false);
  assert.equal(hasVisibleLabel(null), false);
});
