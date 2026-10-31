import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// The chat stylesheets: the side panel's chat (.message-content) and the text zoom sheet that restyles its headings.
const SHEETS = ['extension/sidepanel.css', 'extension/lib/surface-text-zoom.css'];
const sheets = Object.fromEntries(await Promise.all(SHEETS.map(async (file) => [
  file,
  (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ''),
])));

// The body of a profile's chat heading rule, or '' when the sheet has none.
function headingRule(css, profile) {
  const pattern = new RegExp(`html\\[data-hermes-font-profile="${profile}"\\] \\.(?:web-)?message-content :is\\(h1, h2, h3, h4, h5, h6\\) \\{([^}]*)\\}`);
  return css.match(pattern)?.[1] || '';
}

test('chat headings follow the chosen font in the signature and Cinzel profiles', () => {
  for (const [file, css] of Object.entries(sheets)) {
    for (const profile of ['signature', 'cinzel']) {
      assert.match(headingRule(css, profile), /font-family:\s*var\(--hermes-font-display\);/, `${file}: ${profile} headings`);
    }
  }
});

test('no chat heading rule hard-codes a headline face, so the chosen font always applies', () => {
  for (const [file, css] of Object.entries(sheets)) {
    const messageRules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(([, selector]) => /message-content/.test(selector));
    assert.ok(messageRules.length > 0, `${file}: the chat heading rules are found`);
    for (const [, selector, body] of messageRules) {
      assert.doesNotMatch(body, /font-family:\s*"(Rules Gothic Compressed|HermesDisplay|Collapse|Sigurd)"/, `${file}: ${selector.trim()} hard-codes a face`);
    }
  }
});
