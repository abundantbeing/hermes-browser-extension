import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// Loads the real Assist content scripts into jsdom with stubbed extension APIs. `settings` is what
// storage holds under hermesBrowserSettings, `storage` any other keys; `stored` records every storage write.
const EXTENSION = new URL('../extension/', import.meta.url);
export const loadExtensionFile = (relative) => readFileSync(new URL(relative, EXTENSION), 'utf8');
const load = loadExtensionFile;

export function bootAssist({ settings = {}, storage = {}, pageBackground = '', url = 'https://page.example/', fontReply = () => Promise.resolve({ ok: true, fonts: [] }), replies = {} } = {}) {
  const sent = [];
  const messageListeners = [];
  const stored = [];
  const listeners = [];
  const storageListeners = [];
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="composer" style="${pageBackground ? `background-color:${pageBackground}` : ''}"><textarea id="field"></textarea></div></body></html>`,
    { url, runScripts: 'outside-only', pretendToBeVisual: true },
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
        // A test answers any other background message by its type.
        if (replies[message?.type]) return Promise.resolve(replies[message.type](message));
        if (message?.type === 'HERMES_INLINE_SESSION_STATUS') return Promise.resolve({ ok: true, hasActiveSession: false });
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener: (fn) => messageListeners.push(fn), removeListener() {} },
    },
    storage: {
      local: { get: () => Promise.resolve({ ...structuredClone(storage), hermesBrowserSettings: { ...settings } }), set: (items) => { stored.push(items); return Promise.resolve(); } },
      onChanged: { addListener: (listener) => storageListeners.push(listener), removeListener() {} },
    },
  };
  // The faces the panel registers, by the family name the page would see in document.fonts.
  const fonts = [];
  const fontSources = new Map();
  w.FontFace = class FontFace {
    constructor(family, source) {
      this.family = family;
      if (typeof source === 'string') fontSources.set(family, source);
    }
    load() { return Promise.resolve(this); }
  };
  Object.defineProperty(w.document, 'fonts', { configurable: true, value: { add: (face) => fonts.push(face.family) } });
  // One list per query, like a browser: a test fires 'change' on what env.w.matchMedia(query) returns.
  const mediaQueries = new Map();
  w.matchMedia = (query) => {
    if (!mediaQueries.has(query)) mediaQueries.set(query, Object.assign(new w.EventTarget(), { media: query, matches: false }));
    return mediaQueries.get(query);
  };
  // Size observers fire only when a test says an element changed size (env.resized).
  const resizeObservers = [];
  w.ResizeObserver = class ResizeObserver {
    constructor(callback) { this.callback = callback; this.elements = new Set(); resizeObservers.push(this); }
    observe(element) { this.elements.add(element); }
    unobserve(element) { this.elements.delete(element); }
    disconnect() { this.elements.clear(); }
  };
  const resized = (element) => { for (const observer of resizeObservers) if (observer.elements.has(element)) observer.callback([{ target: element }], observer); };
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
  // Hands the content script a message from the background, as the result of a draft arrives.
  const deliver = (message) => messageListeners.forEach((fn) => fn(message, {}, () => {}));
  return { w, sent, stored, fonts, fontSources, changeStorage, sleep, userClick, listenersFor, deliver, resized, root: () => shadow, host: () => w.document.getElementById('hermes-inline-draft-host') };
}

export async function focusField(env) {
  await env.sleep();
  env.w.document.getElementById('field').focus();
  await env.sleep();
  return env.root().querySelector('.launcher');
}
