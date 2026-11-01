import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist as boot, focusField, loadExtensionFile as load } from './inline-assist-dom.mjs';

// The round trigger: which icon it carries, which tone it takes against the page, and the panel's fonts.
test('the chosen icon shows in a light circle on a dark page', async () => {
  const env = boot({ settings: { inlineAssistIcon: 'girl' }, pageBackground: 'rgb(0, 0, 0)' });
  const launcher = await focusField(env);
  assert.equal(launcher.hidden, false);
  assert.equal(launcher.dataset.icon, 'girl');
  assert.equal(launcher.dataset.tone, 'light');
  assert.match(launcher.querySelector('.launcher-logo').style.webkitMaskImage || launcher.querySelector('.launcher-logo').style.maskImage, /assist-girl-solid\.png/);
});

test('a page with no background colour anywhere gets the dark circle', async () => {
  const env = boot();
  const launcher = await focusField(env);
  assert.equal(launcher.dataset.icon, 'wing');
  assert.equal(launcher.dataset.tone, 'dark');
  assert.match(launcher.querySelector('.launcher-logo').style.maskImage, /assist-wing\.png/);
});

test('the trigger is a 24px circle', () => {
  const css = load('content-inline-helper.js');
  assert.match(css, /\.launcher \{[^}]*width:24px; height:24px;[^}]*border-radius:50%/);
});

test('the panel styles name no fixed typeface, only the user font variables', () => {
  const css = /style\.textContent = `([\s\S]*?)`;/.exec(load('content-inline-helper.js'))[1];
  assert.doesNotMatch(css, /Georgia/);
  assert.doesNotMatch(css, /font-family:\s*"Segoe UI"/);
  assert.doesNotMatch(css, /font:[^;]*"Segoe UI"/);
  assert.match(css, /var\(--hb-font-ui\)/);
  assert.match(css, /var\(--hb-font-display\)/);
});

test('font request fails → system stack, no throw', async () => {
  const env = boot({ settings: { fontProfile: 'signature' }, fontReply: () => Promise.reject(new Error('worker asleep')) });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  const panel = env.root().querySelector('.panel');
  assert.equal(panel.hidden, false, 'the panel still opens');
  assert.ok(env.sent.some((message) => message.type === 'HERMES_INLINE_FONT_REQUEST'), 'fonts were asked for on open');
  assert.match(env.host().style.getPropertyValue('--hb-font-ui'), /system-ui, sans-serif$/);
});

test('the signature profile asks for the Rules faces and names them in the panel', async () => {
  const env = boot({ settings: { fontProfile: 'signature' } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_FONT_REQUEST');
  assert.ok(request.families.includes('Rules Variable'));
  assert.ok(request.families.includes('Rules Gothic Compressed'));
  assert.match(env.host().style.getPropertyValue('--hb-font-display'), /^"HermesAssist Rules Gothic Compressed"/);
});
