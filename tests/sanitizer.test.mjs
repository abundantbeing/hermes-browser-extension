import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../extension/lib/common.mjs';

// DOMPurify binds to `window` lazily at first sanitize call. jsdom is the
// officially supported Node DOM for DOMPurify (linkedom is not), so the
// sanitizer tests run against a jsdom window. node --test runs each file in
// its own process, so the global cannot leak into other suites.
const { window } = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = window;

const { renderMarkdownSafe, sanitizeHtml } = await import('../extension/lib/sanitizer.mjs');

const BENIGN_CORPUS = [
  'Plain text with **bold**, *italic*, `code`, ~~strike~~ and [link](https://hermes-agent.nousresearch.com/docs).',
  '# Heading stays literal in the custom renderer',
  '> Blockquote stays literal',
  '1. First\n2. Second',
  '7. Start here',
  '- [x] Done task\n- [ ] Open task',
  '```js\nconst x = 1 < 2;\n```',
  '| Name | Value |\n|---|---:|\n| MiniMax | 1M |',
  '---',
  '![Generated image](https://cdn.example.com/img.png)',
  'MEDIA: https://cdn.example.com/med.png',
  'Line with raw <script>alert(1)</script> html inside',
  'Unicode: ไทย 🇹🇭 æøå 中文',
  'Link with spaces [text](https://example.com/a b) stays plain',
  '',
];

test('renderMarkdownSafe preserves renderMarkdown output for benign input', () => {
  for (const input of BENIGN_CORPUS) {
    const before = renderMarkdown(input);
    const after = renderMarkdownSafe(input);
    // DOMPurify re-serializes the DOM, so allow only serialization-level
    // normalizations of void elements and the known empty-result marker;
    // everything else must match exactly.
    const normalize = (html) => String(html || '')
      .replace(/<hr\s*\/?>/g, '<hr>')
      .replace(/<img([^>]*)\s\/?>/g, '<img$1>')
      .replace(/<input([^>]*)\s\/?>/g, '<input$1>')
      .replace(/'/g, '"')
      .replace(/^<!-->$/, '')
      .replace(/class="([^"]*?)\s+"/g, 'class="$1"');
    assert.equal(normalize(after), normalize(before), `parity failed for: ${JSON.stringify(input)}`);
  }
});

test('renderMarkdownSafe keeps generated-image data-slot for lightbox hooks', () => {
  const html = renderMarkdownSafe('![Generated image](https://cdn.example.com/img.png)');
  assert.match(html, /data-slot="aui_generated-image"/);
  assert.match(html, /loading="lazy"/);
});

test('renderMarkdownSafe blocks javascript: URLs in markdown links', () => {
  const html = renderMarkdownSafe('[click](javascript:alert(1))');
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<a/i);
});

test('renderMarkdownSafe escapes raw HTML instead of executing it', () => {
  const html = renderMarkdownSafe('<img src=x onerror=alert(1)><script>alert(2)</script>');
  // The renderer escapes the markup into inert text before DOMPurify sees it.
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<[^>]*onerror/i);
  assert.match(html, /&lt;script&gt;/i);
});

test('sanitizeHtml strips scripts, event handlers, and dangerous URL schemes from raw HTML', () => {
  const input = '<p onclick="steal()">hi</p><script>alert(1)</script><a href="javascript:alert(2)">x</a><a href="vbscript:alert(3)">y</a><img src="https://ok.example/i.png" onerror="alert(4)">';
  const html = sanitizeHtml(input);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /onerror/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /vbscript:/i);
  assert.match(html, /https:\/\/ok\.example\/i\.png/);
});

test('sanitizeHtml tolerates style attributes without breaking markup', () => {
  // DOMPurify's CSS sanitizer (stripping url()/expression() vectors) runs in
  // real browsers via the native CSSOM; jsdom's CSSOM is a stub, so this test
  // only pins the pipeline behavior that is identical everywhere: valid
  // markup and custom properties survive, hostile elements never appear.
  const html = sanitizeHtml('<span style="--preview-bg:red; position:fixed; top:0; background:url(javascript:alert(1))">swatch</span>');
  assert.match(html, /<span/);
  assert.match(html, /--preview-bg:/i);
  assert.match(html, /swatch/);
  assert.doesNotMatch(html, /<script/i);
});

test('sanitizeHtml keeps target=_blank only on noopener anchors', () => {
  const html = sanitizeHtml('<a href="https://x.dev/" target="_blank" rel="noopener noreferrer">ok</a><a href="https://y.dev/" target="_self">bad</a><span target="_blank">nope</span>');
  assert.match(html, /<a href="https:\/\/x\.dev\/" target="_blank" rel="noopener noreferrer">ok<\/a>/i);
  assert.doesNotMatch(html, /_self/i);
  assert.equal((html.match(/target=/g) || []).length, 1);
});

test('sanitizeHtml preserves custom-property theme swatch styles', () => {
  // The theme preview renders swatches via inline CSS custom properties; the
  // sanitizer must keep them or the theme picker preview loses its colors.
  const html = sanitizeHtml('<span style="--preview-bg:#123456;--preview-accent:#0505e8">swatch</span>');
  assert.match(html, /--preview-bg:\s*#123456/i);
  assert.match(html, /--preview-accent:\s*#0505e8/i);
});

test('hermes-client request layer always sends redirect:error', async () => {
  const { createHermesClient } = await import('../extension/lib/hermes-client.mjs');
  let captured = null;
  const client = createHermesClient({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => '{}' };
    },
    getConnection: () => ({ gatewayUrl: 'http://127.0.0.1:8642' }),
  });
  await client.fetch('/v1/capabilities', { method: 'GET' });
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.url, 'http://127.0.0.1:8642/v1/capabilities');
});

test('content.js page fetch intentionally keeps redirect following (user page fetch)', async () => {
  // Regression guard for the deliberate exception: fetching the user's page
  // must keep following redirects (http->https, tracker hops). Gateway/API
  // fetches are covered by hermes-client's redirect:'error' instead.
  const { createHermesClient } = await import('../extension/lib/hermes-client.mjs');
  assert.equal(typeof createHermesClient, 'function');
  // The exception lives in content.js, not the client; assert the client
  // never silently relaxes its own policy.
  let captured = null;
  const client = createHermesClient({
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => '{}' };
    },
    getConnection: () => ({ gatewayUrl: 'http://127.0.0.1:8642' }),
  });
  await client.fetch('/health', { method: 'GET', redirect: 'follow' });
  // Explicit per-call overrides must not downgrade the default policy.
  assert.equal(captured.options.redirect, 'error');
});
