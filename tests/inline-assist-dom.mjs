import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// Loads the real Assist content scripts into jsdom with stubbed extension APIs. `settings` is what
// storage holds under hermesBrowserSettings; `stored` records every storage write.
const EXTENSION = new URL('../extension/', import.meta.url);
export const loadExtensionFile = (relative) => readFileSync(new URL(relative, EXTENSION), 'utf8');
const load = loadExtensionFile;

export function bootAssist({ settings = {}, pageBackground = '', fontReply = () => Promise.resolve({ ok: true, fonts: [] }) } = {}) {
  const sent = [];
  const stored = [];
  const listeners = [];
  const storageListeners = [];
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
      local: { get: () => Promise.resolve({ hermesBrowserSettings: { ...settings } }), set: (items) => { stored.push(items); return Promise.resolve(); } },
      onChanged: { addListener: (listener) => storageListeners.push(listener), removeListener() {} },
    },
  };
  // The faces the panel registers, by the family name the page would see in document.fonts.
  const fonts = [];
  w.FontFace = class FontFace {
    constructor(family) { this.family = family; }
    load() { return Promise.resolve(this); }
  };
  Object.defineProperty(w.document, 'fonts', { configurable: true, value: { add: (face) => fonts.push(face.family) } });
  // One list per query, like a browser: a test fires 'change' on what env.w.matchMedia(query) returns.
  const mediaQueries = new Map();
  w.matchMedia = (query) => {
    if (!mediaQueries.has(query)) mediaQueries.set(query, Object.assign(new w.EventTarget(), { media: query, matches: false }));
    return mediaQueries.get(query);
  };
  w.browser = undefined;
  for (const file of ['lib/browser-api-global.js', 'content-extractor.js', 'lib/i18n-content.js', 'content-inline-helper.js']) w.eval(load(file));
  const sleep = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
  const userClick = (element) => {
    for (const entry of listeners.filter((item) => item.target === element && item.type === 'click')) {
      entry.listener.call(element, { type: 'click', target: element, isTrusted: true, preventDefault() {}, stopPropagation() {}, composedPath: () => [element] });
    }
  };
  const listenersFor = (element, type) => listeners.filter((item) => item.target === element && item.type === type).map((item) => item.listener);
  // Another surface (the side panel, another tab) wrote to storage.
  const changeStorage = (changes) => { for (const listener of storageListeners) listener(changes, 'local'); };
  return { w, sent, stored, fonts, changeStorage, sleep, userClick, listenersFor, root: () => shadow, host: () => w.document.getElementById('hermes-inline-draft-host') };
}

export async function focusField(env) {
  await env.sleep();
  env.w.document.getElementById('field').focus();
  await env.sleep();
  return env.root().querySelector('.launcher');
}
