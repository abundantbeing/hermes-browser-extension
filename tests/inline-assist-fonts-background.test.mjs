import assert from 'node:assert/strict';
import test from 'node:test';

import { INLINE_ASSIST_FONT_REQUEST, createInlineAssistFontServer } from '../extension/lib/inline-assist-font-server.mjs';

const runtime = { id: 'hermes-extension', getURL: (path) => `chrome-extension://hermes-extension/${path}` };
const fromContentScript = { id: 'hermes-extension', tab: { id: 7 } };

function server(fetchImpl) {
  const fetched = [];
  const handle = createInlineAssistFontServer({
    runtime,
    fetch: async (url) => { fetched.push(url); return fetchImpl(url); },
  });
  return { handle, fetched };
}

test('a known family comes back as base64 bytes; unknown families are ignored', async () => {
  const { handle, fetched } = server(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
  const reply = await handle({ type: INLINE_ASSIST_FONT_REQUEST, families: ['Rules Variable', 'Evil'] }, fromContentScript);
  assert.equal(reply.ok, true);
  assert.equal(reply.fonts.length, 1);
  assert.deepEqual(reply.fonts[0], { family: 'Rules Variable', weight: '100 900', style: 'normal', data: 'AQID' });
  assert.deepEqual(fetched, ['chrome-extension://hermes-extension/assets/fonts/RulesVariable.woff2']);
});

test('nothing loads → not ok, so the panel keeps its system fonts', async () => {
  const { handle } = server(async () => { throw new Error('offline'); });
  const reply = await handle({ type: INLINE_ASSIST_FONT_REQUEST, families: ['Rules Variable'] }, fromContentScript);
  assert.equal(reply.ok, false);
  assert.deepEqual(reply.fonts, []);
});

test('a missing licensed face is skipped while the bundled fallback still loads', async () => {
  const { handle } = server(async (url) => (url.includes('Rules') ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer }));
  const reply = await handle({ type: INLINE_ASSIST_FONT_REQUEST, families: ['Rules Variable', 'Space Grotesk'] }, fromContentScript);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.fonts.map((font) => font.family), ['Space Grotesk', 'Space Grotesk']);
});

test('only this extension may ask for font bytes', async () => {
  const { handle, fetched } = server(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
  const reply = await handle({ type: INLINE_ASSIST_FONT_REQUEST, families: ['Rules Variable'] }, { id: 'someone-else', tab: { id: 1 } });
  assert.equal(reply.ok, false);
  assert.deepEqual(fetched, []);
});
