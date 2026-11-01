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
  assert.match(env.root().querySelector('style.assist-fonts').textContent, /--hb-font-ui: [^;]*system-ui, sans-serif;/);
});

test('the signature profile asks for the Rules faces and names them in the panel', async () => {
  const env = boot({ settings: { fontProfile: 'signature' } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  const request = env.sent.find((message) => message.type === 'HERMES_INLINE_FONT_REQUEST');
  assert.ok(request.families.includes('Rules Variable'));
  assert.ok(request.families.includes('Rules Gothic Compressed'));
  assert.match(env.root().querySelector('style.assist-fonts').textContent, /--hb-font-display: "HermesAssist-[0-9a-f]{8} [0-9a-f]{6}"/);
});

test('the page can not read the font choice or guess the font names', async () => {
  const env = boot({ settings: { fontProfile: 'signature' } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  const host = env.host();
  assert.equal(host.hasAttribute('data-font-profile'), false, 'no profile on the page-visible host');
  assert.equal(host.style.getPropertyValue('--hb-font-ui'), '', 'no font stack on the page-visible host');
  assert.equal(env.root().querySelector('.panel').dataset.fontProfile, 'signature');
  const other = boot({ settings: { fontProfile: 'signature' } });
  await focusField(other).then((item) => other.userClick(item));
  await other.sleep(60);
  const token = (text) => /HermesAssist-([0-9a-f]{8}) /.exec(text)?.[1];
  assert.notEqual(token(env.root().querySelector('style.assist-fonts').textContent), token(other.root().querySelector('style.assist-fonts').textContent), 'each page gets its own font names');
});

test('the names the panel registers in document.fonts do not say which font was chosen', async () => {
  const env = boot({
    settings: { fontProfile: 'signature' },
    fontReply: () => Promise.resolve({ ok: true, fonts: [{ family: 'Rules Variable', data: 'AAAA', weight: '100 900', style: 'normal' }] }),
  });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  assert.equal(env.fonts.length, 1, 'the face was registered');
  const bundled = /Rules|Grotesk|HermesDisplay|HermesMono|Montserrat/;
  assert.doesNotMatch(env.fonts[0], bundled);
  assert.doesNotMatch(env.root().querySelector('style.assist-fonts').textContent, bundled);
  assert.ok(env.root().querySelector('style.assist-fonts').textContent.includes(`--hb-font-ui: "${env.fonts[0]}"`), 'the stack uses the registered name');
});

test('the panel and circle set their own font, so text that only inherits it follows the choice', async () => {
  const env = boot({ settings: { fontProfile: 'montserrat' } });
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(60);
  // --hb-font-ui changes on .panel; :host computed its font-family from the default before that.
  assert.match(env.root().querySelector('style.assist-fonts').textContent, /\.launcher, \.panel \{[^}]*font-family: var\(--hb-font-ui\);/);
});

// What sits under the circle decides its tone: the circle usually sits beside the field, not on it.
function bootWithSurface({ field = 'rgb(255, 255, 255)', under = 'rgb(0, 0, 0)' } = {}) {
  const env = boot({ pageBackground: field });
  const surface = env.w.document.createElement('div');
  surface.id = 'surface';
  surface.style.backgroundColor = under;
  env.w.document.body.append(surface);
  env.w.document.elementsFromPoint = () => [env.host(), surface, env.w.document.body];
  return { env, surface };
}

test('a white field on a black page gets the light circle when the circle sits on the black', async () => {
  const { env } = bootWithSurface();
  const launcher = await focusField(env);
  assert.equal(launcher.dataset.tone, 'light');
  assert.match(launcher.querySelector('.launcher-logo').style.maskImage, /assist-wing\.png/);
});

test('the circle follows the page when the surface under it changes theme', async () => {
  const { env, surface } = bootWithSurface({ under: 'rgb(255, 255, 255)' });
  const launcher = await focusField(env);
  assert.equal(launcher.dataset.tone, 'dark');
  surface.style.backgroundColor = 'rgb(10, 10, 10)';
  env.w.dispatchEvent(new env.w.Event('resize'));
  assert.equal(launcher.dataset.tone, 'light', 'layout change');
  surface.style.backgroundColor = 'rgb(250, 250, 250)';
  for (const listener of env.listenersFor(env.w.matchMedia('(prefers-color-scheme: dark)'), 'change')) listener({ matches: false });
  assert.equal(launcher.dataset.tone, 'dark', 'system theme change');
});
