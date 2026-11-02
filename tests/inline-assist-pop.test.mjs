import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField } from './inline-assist-dom.mjs';

// Records every Element.animate call the content script makes (jsdom has none of its own).
function recordAnimations(env) {
  const calls = [];
  env.w.Element.prototype.animate = function animate(keyframes, options) {
    calls.push({ element: this, keyframes, options });
    const animation = { onfinish: null, oncancel: null, cancel() {}, finished: Promise.resolve() };
    setTimeout(() => animation.onfinish?.(), 0);
    return animation;
  };
  return calls;
}

async function open(settings = {}, { reducedMotion = false } = {}) {
  const env = bootAssist({ settings: { inlineAssistOpenMode: 'quick', inlineAssistModel: 'gpt-6.1-terra', ...settings } });
  const calls = recordAnimations(env);
  if (reducedMotion) env.w.matchMedia('(prefers-reduced-motion: reduce)').matches = true;
  const launcher = await focusField(env);
  env.userClick(launcher);
  await env.sleep(40);
  return { env, calls, root: env.root(), panel: env.root().querySelector('.panel'), launcher };
}

const dithered = (frame) => String(frame.maskImage || '');

test('the panel pops out of the circle: a widening circle, in dither steps from sparse dots to solid', async () => {
  const { calls, panel } = await open();
  const pop = calls.find((call) => call.element === panel);
  assert.ok(pop, 'the panel is animated as it opens');
  const frames = pop.keyframes;
  assert.match(frames[0].clipPath, /^circle\(\d+px at -?\d+px -?\d+px\)$/);
  assert.match(frames.at(-1).clipPath, /^circle\(\d+px at /);
  assert.ok(parseFloat(/circle\((\d+)px/.exec(frames.at(-1).clipPath)[1]) > parseFloat(/circle\((\d+)px/.exec(frames[0].clipPath)[1]), 'it widens');
  assert.deepEqual([...frames].map(dithered).slice(0, 3).map((image) => image.split('(')[0]), ['conic-gradient', 'repeating-conic-gradient', 'conic-gradient']);
  assert.equal(frames.at(-1).maskImage, 'none', 'it ends solid');
  assert.ok(pop.options.duration <= 260, 'quick, not a show');
});

test('closing leaves a dithered shell that shrinks back into the circle, while the panel itself closes at once', async () => {
  const { env, calls, root, panel } = await open();
  calls.length = 0;
  env.userClick(root.querySelector('.quick-close'));
  assert.equal(panel.hidden, true, 'closed straight away');
  const vanish = calls.find((call) => call.element.classList.contains('pop-ghost'));
  assert.ok(vanish, 'a shell vanishes in its place');
  assert.equal(vanish.keyframes.at(-1).maskImage.split('(')[0], 'conic-gradient');
  await env.sleep(20);
  assert.equal(root.querySelector('.pop-ghost'), null, 'the shell is gone once it has vanished');
});

test('with reduced motion asked for, the panel opens and closes without the pop', async () => {
  const { env, calls, root } = await open({}, { reducedMotion: true });
  env.userClick(root.querySelector('.quick-close'));
  assert.equal(calls.length, 0);
});

test('the quick menu has its own close button', async () => {
  const { env, root, panel } = await open();
  const close = root.querySelector('.quick-ask .quick-close');
  assert.ok(close);
  assert.equal(close.getAttribute('aria-label'), 'Close Hermes Assist');
  env.userClick(close);
  assert.equal(panel.hidden, true);
});

const pressOnPage = (env, target = env.w.document.body) => {
  for (const listener of env.listenersFor(env.w.document, 'pointerdown')) {
    listener({ type: 'pointerdown', isTrusted: true, target, composedPath: () => [target, env.w.document.body, env.w.document] });
  }
};

test('a press outside the quick menu closes it, as a menu does', async () => {
  const { env, panel } = await open();
  pressOnPage(env);
  assert.equal(panel.hidden, true);
});

test('a press outside the full panel leaves it open', async () => {
  const { env, panel } = await open({ inlineAssistOpenMode: 'panel' });
  pressOnPage(env);
  assert.equal(panel.hidden, false);
});
