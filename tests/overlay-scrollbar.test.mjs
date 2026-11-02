import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { OVERLAY_SCROLLBAR_CSS, attachOverlayScrollbar, overlayThumbGeometry } from '../extension/lib/overlay-scrollbar.mjs';

function area({ scrollHeight = 1000, clientHeight = 200 } = {}) {
  const dom = new JSDOM('<!doctype html><div id="list"><button>one</button><button>two</button></div>', { pretendToBeVisual: true });
  const list = dom.window.document.getElementById('list');
  const sizes = { scrollHeight, clientHeight, scrollTop: 0 };
  Object.defineProperty(list, 'scrollHeight', { get: () => sizes.scrollHeight });
  Object.defineProperty(list, 'clientHeight', { get: () => sizes.clientHeight });
  Object.defineProperty(list, 'scrollTop', { get: () => sizes.scrollTop, set: (value) => { sizes.scrollTop = value; } });
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  return { dom, list, sizes, frame };
}

test('the thumb is sized by how much shows and placed by how far it is scrolled', () => {
  assert.deepEqual(overlayThumbGeometry({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }), { visible: false, size: 0, offset: 0 }, 'nothing to scroll');
  assert.deepEqual(overlayThumbGeometry({ scrollTop: 0, scrollHeight: 800, clientHeight: 200 }), { visible: true, size: 49, offset: 2 });
  assert.deepEqual(overlayThumbGeometry({ scrollTop: 600, scrollHeight: 800, clientHeight: 200 }), { visible: true, size: 49, offset: 149 }, 'at the end it touches the bottom inset');
  assert.equal(overlayThumbGeometry({ scrollTop: 0, scrollHeight: 30000, clientHeight: 240 }).size, 24, 'never smaller than a grabbable 24px');
});

test('the browser\'s own bar is hidden and no strip is kept for it', () => {
  assert.match(OVERLAY_SCROLLBAR_CSS, /\[data-overlay-scroll\] \{ scrollbar-width:none; \}/);
  assert.match(OVERLAY_SCROLLBAR_CSS, /\[data-overlay-scroll\]::-webkit-scrollbar \{ display:none; width:0; height:0; \}/);
  assert.doesNotMatch(OVERLAY_SCROLLBAR_CSS, /scrollbar-gutter/);
  // The thumb is the canonical branded one.
  assert.match(OVERLAY_SCROLLBAR_CSS, /\.overlay-scroll-thumb \{[^}]*width:8px;[^}]*background:rgba\(var\(--hermes-fg-rgb\),0\.45\); border:1px solid var\(--hermes-line-strong\);/);
});

test('an area that scrolls gets a floating thumb first in it, which follows the scroll', async () => {
  const { list, sizes, frame, dom } = area();
  attachOverlayScrollbar(list);
  await frame();
  assert.equal(list.hasAttribute('data-overlay-scroll'), true);
  const thumb = list.firstChild.querySelector('.overlay-scroll-thumb');
  assert.equal(list.firstChild.className, 'overlay-scroll-rail');
  assert.equal(list.firstChild.getAttribute('aria-hidden'), 'true');
  assert.equal(thumb.hidden, false);
  assert.equal(thumb.style.height, '39px');
  sizes.scrollTop = 800;
  list.dispatchEvent(new dom.window.Event('scroll'));
  await frame();
  assert.equal(thumb.style.transform, 'translateY(159px)');
});

test('an area with nothing to scroll shows no thumb', async () => {
  const { list, frame } = area({ scrollHeight: 200, clientHeight: 200 });
  attachOverlayScrollbar(list);
  await frame();
  assert.equal(list.querySelector('.overlay-scroll-thumb').hidden, true);
});

test('a screen that replaces the area\'s children gets the thumb back', async () => {
  const { list, frame, dom } = area();
  attachOverlayScrollbar(list, { watchResize: false });
  await frame();
  list.replaceChildren(dom.window.document.createElement('p'));
  await frame();
  await frame();
  assert.equal(list.firstChild.className, 'overlay-scroll-rail');
  assert.equal(list.querySelectorAll('.overlay-scroll-rail').length, 1);
});

test('dragging the thumb scrolls the area', async () => {
  const { list, sizes, frame } = area();
  attachOverlayScrollbar(list);
  await frame();
  const thumb = list.querySelector('.overlay-scroll-thumb');
  const fire = (type, clientY) => {
    thumb.dispatchEvent(Object.assign(new list.ownerDocument.defaultView.Event(type), { button: 0, clientY, pointerId: 1 }));
  };
  fire('pointerdown', 10);
  fire('pointermove', 60);
  // The thumb travels 200 - 4 - 39 = 157px for 800px of scrolling.
  assert.equal(Math.round(sizes.scrollTop), Math.round(50 * 800 / 157));
  fire('pointerup', 60);
  fire('pointermove', 120);
  assert.equal(Math.round(sizes.scrollTop), Math.round(50 * 800 / 157), 'released: moving no longer scrolls');
});

test('detach gives the area its plain bar back', async () => {
  const { list, frame } = area();
  const overlay = attachOverlayScrollbar(list);
  await frame();
  overlay.detach();
  assert.equal(list.hasAttribute('data-overlay-scroll'), false);
  assert.equal(list.querySelector('.overlay-scroll-rail'), null);
});
