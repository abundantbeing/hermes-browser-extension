// The hover effect, driven the way a browser drives it: pointer events in the
// real order, requestAnimationFrame timestamps that can be earlier than a
// performance.now() read just before them, a canvas that must still be attached
// after the first frame, after 200ms, and gone after leave plus the out duration.
// (Regression: the effect was torn down on its first frame because the loop mixed
// performance.now() with the rAF clock and got a negative step.)

import assert from 'node:assert/strict';
import test from 'node:test';

import { IN_MS, OUT_MS, installDitherHover, specFor } from '../extension/lib/dither-hover.mjs';

function setup({ reduced = false, forced = false, hover = true } = {}) {
  const canvases = [];
  const queue = [];
  let nextId = 1;
  const makeCtx = () => new Proxy({}, {
    get(target, prop) {
      if (prop === 'measureText') return () => ({ fontBoundingBoxAscent: 14, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 0 });
      if (prop === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  globalThis.document = {
    createElement: (tag) => {
      if (tag !== 'canvas') throw new Error(`unexpected ${tag}`);
      const ctx = makeCtx();
      const canvas = {
        width: 0, height: 0, style: {}, className: '', attrs: {}, removed: false, parentElement: null,
        getContext: () => ctx,
        setAttribute(name, value) { this.attrs[name] = value; },
        remove() { this.removed = true; this.parentElement = null; },
      };
      canvases.push(canvas);
      return canvas;
    },
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [{ left: 60, top: 12, width: 100, height: 20 }] }),
  };
  const span = { id: 'label' };
  const styles = new Map();
  const textNode = { nodeType: 3, nodeValue: 'Get started', parentElement: span };
  span.childNodes = [textNode];
  span.nodeType = 1;
  const attrs = {};
  const props = {};
  const button = {
    nodeType: 1,
    childNodes: [span],
    disabled: false,
    isConnected: true,
    children: [],
    style: { setProperty: (name, value) => { props[name] = value; }, removeProperty: (name) => { delete props[name]; } },
    getBoundingClientRect: () => ({ left: 20, top: 100, width: 240, height: 44 }),
    querySelector: () => null,
    matches: (selector) => selector === ':hover',
    closest: () => button,
    contains: (node) => node === button || node === span,
    append(child) { this.children.push(child); child.parentElement = this; },
    setAttribute: (name, value) => { attrs[name] = value; },
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    removeAttribute: (name) => { delete attrs[name]; },
  };
  styles.set(button, { backgroundColor: 'rgb(244, 248, 255)', color: 'rgb(13, 74, 159)', borderTopColor: 'rgb(13, 74, 159)', borderLeftWidth: '1px', direction: 'ltr' });
  styles.set(span, { textTransform: 'uppercase', fontStyle: 'normal', fontWeight: '500', fontSize: '18px', fontFamily: 'sans-serif', letterSpacing: '0.36px' });
  globalThis.window = {
    devicePixelRatio: 1,
    matchMedia: (query) => ({ matches: (/prefers-reduced-motion/.test(query) && reduced) || (/forced-colors/.test(query) && forced) || (/hover: hover/.test(query) && hover) }),
    getComputedStyle: (element) => styles.get(element) || {},
  };
  globalThis.requestAnimationFrame = (callback) => { const id = nextId++; queue.push({ id, callback }); return id; };
  globalThis.cancelAnimationFrame = (id) => { const at = queue.findIndex((entry) => entry.id === id); if (at >= 0) queue.splice(at, 1); };
  // A performance.now() that is LATER than the frame timestamps, as in a real frame.
  globalThis.performance = { now: () => 1002 };
  const handlers = {};
  const host = { addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener() {} };
  const uninstall = installDitherHover(host, { selector: '.btn', quietSelector: '.quiet' });
  const frame = (timestamp) => {
    const pending = queue.splice(0);
    for (const entry of pending) entry.callback(timestamp);
    return pending.length;
  };
  const live = () => button.children.filter((canvas) => !canvas.removed);
  return {
    button, handlers, frame, live, canvases, attrs, props, uninstall, queue,
    over: () => handlers.pointerover({ target: button, relatedTarget: null, clientX: 40, clientY: 120, pointerType: 'mouse' }),
    out: () => handlers.pointerout({ target: button, relatedTarget: null }),
  };
}

function teardownGlobals() {
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
  delete globalThis.performance;
}

test('a hover keeps its canvas through the first frame, 200ms and the whole fill, then removes it', () => {
  const env = setup();
  env.over();
  assert.equal(env.live().length, 1, 'the canvas is laid over the button on enter');
  assert.equal(env.attrs['data-dither'], 'run');
  assert.equal(env.canvases.filter((canvas) => canvas.className === 'dither-hover-canvas').length, 1);
  // The first rAF timestamp (1000) is EARLIER than the performance.now() (1002) read at enter.
  assert.equal(env.frame(1000), 1, 'the loop asked for another frame');
  assert.equal(env.live().length, 1, 'still attached after the first frame');
  let t = 1000;
  while (t < 1000 + 200) { t += 16; env.frame(t); }
  assert.equal(env.live().length, 1, 'still attached after 200ms');
  assert.equal(env.attrs['data-dither'], 'run');
  while (t < 1000 + IN_MS - 40) { t += 16; env.frame(t); }
  assert.equal(env.live().length, 1, 'still running just before the end');
  while (t < 1000 + IN_MS + 60) { t += 16; env.frame(t); }
  assert.equal(env.live().length, 0, 'removed once the fill has settled');
  assert.equal('data-dither' in env.attrs, false, 'the button shows its own static hover face again');
  assert.equal(env.queue.length, 0, 'no loop left running');
  teardownGlobals();
});

test('the browser fires several events on enter; none of them ends the effect', () => {
  const env = setup();
  // pointerover (listened to), then pointerenter, mouseover, mouseenter and pointermove are not.
  env.over();
  env.over();
  env.frame(500);
  env.frame(516);
  assert.equal(env.live().length, 1, 'a repeated pointerover does not duplicate or cancel');
  assert.equal(env.canvases.filter((canvas) => canvas.className === 'dither-hover-canvas').length, 1);
  // The pointer moving inside the button (over the label) is not a leave.
  env.handlers.pointerout({ target: button(env), relatedTarget: env.button.childNodes[0] });
  env.frame(532);
  assert.equal(env.live().length, 1, 'moving between the button and its label is not a leave');
  teardownGlobals();
});

function button(env) { return env.button; }

test('leaving dissolves out over the out duration and then removes the canvas', () => {
  const env = setup();
  env.over();
  let t = 2000;
  env.frame(t);
  while (t < 2000 + IN_MS + 60) { t += 16; env.frame(t); }
  assert.equal(env.live().length, 0, 'settled');
  env.out();
  assert.equal(env.live().length, 1, 'a leave from the settled state lays the canvas back over the button');
  const start = t;
  env.frame(t);
  while (t < start + OUT_MS * 0.6) { t += 16; env.frame(t); }
  assert.equal(env.live().length, 1, 'still dissolving partway through');
  while (t < start + OUT_MS + 80) { t += 16; env.frame(t); }
  assert.equal(env.live().length, 0, 'gone after the out duration');
  assert.equal(env.queue.length, 0);
  teardownGlobals();
});

test('a quick in-out-in reverses from where it is, never restarts and never sticks', () => {
  const env = setup();
  env.over();
  let t = 3000;
  env.frame(t);
  for (let i = 0; i < 6; i += 1) { t += 16; env.frame(t); }
  env.out();
  assert.equal(env.live().length, 1, 'the same canvas keeps going out');
  for (let i = 0; i < 3; i += 1) { t += 16; env.frame(t); }
  env.over();
  assert.equal(env.live().length, 1);
  assert.equal(env.canvases.filter((canvas) => canvas.className === 'dither-hover-canvas').length, 1, 'one canvas the whole time');
  for (let i = 0; i < 80; i += 1) { t += 16; env.frame(t); }
  assert.equal(env.live().length, 0, 'it settles and cleans up');
  assert.equal(env.queue.length, 0);
  teardownGlobals();
});

test('a frame timestamp earlier than the last one never ends it or runs it backwards', () => {
  const env = setup();
  env.over();
  env.frame(5000);
  env.frame(4990); // out of order, as a throttled tab can deliver
  env.frame(5016);
  assert.equal(env.live().length, 1);
  teardownGlobals();
});

test('reduced motion, forced colours and a touch-only device never start it', () => {
  for (const options of [{ reduced: true }, { forced: true }, { hover: false }]) {
    const env = setup(options);
    env.over();
    assert.equal(env.live().length, 0, JSON.stringify(options));
    assert.equal(env.queue.length, 0);
    teardownGlobals();
  }
});

test('the colours are read from the finished hover state, not from a transition that has just begun', () => {
  const env = setup();
  const hover = { backgroundColor: 'rgb(244, 248, 255)', color: 'rgb(13, 74, 159)', borderTopColor: 'rgb(13, 74, 159)', borderLeftWidth: '1px', direction: 'ltr' };
  const rest = { ...hover, backgroundColor: 'rgb(13, 74, 159)', color: 'rgb(244, 248, 255)', borderTopColor: 'rgb(244, 248, 255)' };
  const style = {};
  Object.assign(style, rest);
  globalThis.window.getComputedStyle = (element) => (element === env.button ? style : { textTransform: 'uppercase', fontStyle: 'normal', fontWeight: '500', fontSize: '18px', fontFamily: 'sans-serif', letterSpacing: '0.36px' });
  // A running transition: the computed value is still the resting one until it is finished.
  env.button.getAnimations = () => [{ transitionProperty: 'background-color', finish() { Object.assign(style, hover); } }];
  const spec = specFor(env.button, { x: 5, y: 5 }, false, 1);
  assert.equal(spec.hoverBg, 'rgb(244, 248, 255)', 'the hover fill, not the starting value of a transition');
  assert.equal(spec.hoverFg, 'rgb(13, 74, 159)');
  assert.equal(spec.restBg, 'rgb(13, 74, 159)', 'the resting face is the pair the other way round');
  assert.equal(spec.restFg, 'rgb(244, 248, 255)');
  const quiet = specFor(env.button, { x: 5, y: 5 }, true, 1);
  assert.equal(quiet.restBg, 'rgba(0, 0, 0, 0)', 'a quiet button rests transparent over what is behind it, so nothing pops on enter');
  teardownGlobals();
});

test('keyboard focus starts it at the inline-start edge and is not a hover', () => {
  const env = setup();
  env.button.matches = (selector) => selector === ':focus-visible';
  env.handlers.focusin({ target: env.button });
  assert.equal(env.live().length, 1);
  env.frame(7000);
  env.frame(7016);
  assert.equal(env.live().length, 1);
  teardownGlobals();
});
