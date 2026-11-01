import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// Loads the real Assist content scripts into jsdom with stubbed extension APIs and checks the round
// trigger: which icon it carries, which tone it takes against the page, and the panel's fonts.
const EXTENSION = new URL('../extension/', import.meta.url);
const load = (relative) => readFileSync(new URL(relative, EXTENSION), 'utf8');

function boot({ settings = {}, pageBackground = '', fontReply = () => Promise.resolve({ ok: true, fonts: [] }) } = {}) {
  const sent = [];
  const listeners = [];
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="composer" style="${pageBackground ? `background-color:${pageBackground}` : ''}"><textarea id="field"></textarea></div></body></html>`,
    { url: 'https://page.example/', runScripts: 'outside-only', pretendToBeVisual: true },
  );
  const w = dom.window;
  w.innerWidth = 1280;
  w.innerHeight = 900;
  w.Element.prototype.getBoundingClientRect = () => ({ x: 20, y: 20, top: 20, left: 20, bottom: 60, right: 320, width: 300, height: 40, toJSON() {} });
  let shadow = null;
  const attachShadow = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function patched(init) {
    shadow = attachShadow.call(this, init);
    return shadow;
  };
  const addEventListener = w.EventTarget.prototype.addEventListener;
  w.EventTarget.prototype.addEventListener = function patched(type, listener, options) {
    listeners.push({ target: this, type, listener });
    return addEventListener.call(this, type, listener, options);
  };
  w.chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      getManifest: () => ({}),
      sendMessage: (message) => {
        sent.push(message);
        if (message?.type === 'HERMES_INLINE_FONT_REQUEST') return fontReply();
        if (message?.type === 'HERMES_INLINE_SESSION_STATUS') return Promise.resolve({ ok: true, hasActiveSession: false });
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: {
      local: { get: () => Promise.resolve({ hermesBrowserSettings: { ...settings } }), set: () => Promise.resolve() },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  w.browser = undefined;
  for (const file of ['lib/browser-api-global.js', 'content-extractor.js', 'lib/i18n-content.js', 'content-inline-helper.js']) w.eval(load(file));
  const sleep = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
  const userClick = (element) => {
    for (const entry of listeners.filter((item) => item.target === element && item.type === 'click')) {
      entry.listener.call(element, { type: 'click', target: element, isTrusted: true, preventDefault() {}, stopPropagation() {}, composedPath: () => [element] });
    }
  };
  return { w, sent, sleep, userClick, root: () => shadow, host: () => w.document.getElementById('hermes-inline-draft-host') };
}

async function focusField(env) {
  await env.sleep();
  env.w.document.getElementById('field').focus();
  await env.sleep();
  return env.root().querySelector('.launcher');
}

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
