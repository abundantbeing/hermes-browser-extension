import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  OVERLAY_SCROLLBAR_CSS,
  attachOverlayScrollbar,
  installOverlayScrollbars,
  overlayLayoutSupported,
  overlayThumbGeometry,
} from '../extension/lib/overlay-scrollbar.mjs';

function area({ scrollHeight = 1000, clientHeight = 200, style = '' } = {}) {
  const dom = new JSDOM(`<!doctype html><div id="list" style="${style}"><button>one</button><button>two</button></div>`, { pretendToBeVisual: true });
  const list = dom.window.document.getElementById('list');
  const sizes = { scrollHeight, clientHeight, scrollTop: 0 };
  Object.defineProperty(list, 'scrollHeight', { get: () => sizes.scrollHeight });
  Object.defineProperty(list, 'clientHeight', { get: () => sizes.clientHeight });
  Object.defineProperty(list, 'clientWidth', { get: () => 300 });
  Object.defineProperty(list, 'scrollTop', { get: () => sizes.scrollTop, set: (value) => { sizes.scrollTop = value; } });
  list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: sizes.clientHeight, width: 300, height: sizes.clientHeight });
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  return { dom, list, sizes, frame };
}

test('the thumb is sized by how much shows and placed by how far it is scrolled', () => {
  assert.deepEqual(overlayThumbGeometry({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }), { visible: false, size: 0, offset: 0 }, 'nothing to scroll');
  assert.deepEqual(overlayThumbGeometry({ scrollTop: 0, scrollHeight: 800, clientHeight: 200 }), { visible: true, size: 49, offset: 2 });
  assert.deepEqual(overlayThumbGeometry({ scrollTop: 600, scrollHeight: 800, clientHeight: 200 }), { visible: true, size: 49, offset: 149 }, 'at the end it touches the bottom inset');
  assert.equal(overlayThumbGeometry({ scrollTop: 0, scrollHeight: 30000, clientHeight: 240 }).size, 24, 'never smaller than a grabbable 24px');
});

test('the browser\'s own bar is hidden, no strip is kept, and the thumb is the area\'s own ::before box', () => {
  assert.match(OVERLAY_SCROLLBAR_CSS, /\[data-overlay-scroll\] \{ scrollbar-width:none; \}/);
  assert.match(OVERLAY_SCROLLBAR_CSS, /\[data-overlay-scroll\]::-webkit-scrollbar \{ display:none; width:0; height:0; \}/);
  assert.doesNotMatch(OVERLAY_SCROLLBAR_CSS, /scrollbar-gutter/);
  const thumb = /\[data-overlay-scroll\]::before \{([^}]*)\}/.exec(OVERLAY_SCROLLBAR_CSS)?.[1] || '';
  assert.match(thumb, /position:sticky; top:0;/);
  assert.match(thumb, /width:8px;/);
  assert.match(thumb, /background:rgba\(var\(--hermes-fg-rgb\),0\.45\); border:1px solid var\(--hermes-line-strong\);/);
  // It takes no room: its height is given back by its bottom margin (and a flex column's gap with it).
  assert.match(thumb, /height:var\(--overlay-size, 0px\); margin:0 calc\(-1 \* var\(--overlay-pad-right, 0px\)\) calc\(-1 \* \(var\(--overlay-size, 0px\) \+ var\(--overlay-gap, 0px\)\)\) auto;/);
  assert.match(OVERLAY_SCROLLBAR_CSS, /\[data-overlay-scroll="shown"\]::before \{ display:block; \}/);
});

test('an area that scrolls shows the thumb, which follows the scroll, and adds no element to the area', async () => {
  const { list, sizes, frame, dom } = area();
  attachOverlayScrollbar(list);
  await frame();
  assert.equal(list.getAttribute('data-overlay-scroll'), 'shown');
  assert.equal(list.children.length, 2, 'the area\'s children are its own');
  assert.equal(list.style.getPropertyValue('--overlay-size'), '39px');
  assert.equal(list.style.getPropertyValue('--overlay-offset'), '2px');
  sizes.scrollTop = 800;
  list.dispatchEvent(new dom.window.Event('scroll'));
  await frame();
  assert.equal(list.style.getPropertyValue('--overlay-offset'), '159px');
});

test('the thumb sits under the top padding until the area scrolls past it, then sticks', async () => {
  const { list, sizes, frame, dom } = area({ style: 'padding-top:10px' });
  attachOverlayScrollbar(list);
  await frame();
  assert.equal(list.style.getPropertyValue('--overlay-offset'), '-8px', 'drawn 2px from the top while the box is still 10px down');
  sizes.scrollTop = 40;
  list.dispatchEvent(new dom.window.Event('scroll'));
  await frame();
  assert.equal(list.style.getPropertyValue('--overlay-offset'), '10px');
});

test('a flex column gives the thumb its gap back, so the first item does not move', async () => {
  const { list, frame } = area({ style: 'display:flex; flex-direction:column; row-gap:10px' });
  attachOverlayScrollbar(list);
  await frame();
  assert.equal(list.style.getPropertyValue('--overlay-gap'), '10px');
});

test('an area with nothing to scroll shows no thumb', async () => {
  const { list, frame } = area({ scrollHeight: 200, clientHeight: 200 });
  attachOverlayScrollbar(list);
  await frame();
  assert.equal(list.getAttribute('data-overlay-scroll'), '');
});

test('grids and flex rows are refused: a sticky box there could not stay in view', () => {
  assert.equal(overlayLayoutSupported({ display: 'block' }), true);
  assert.equal(overlayLayoutSupported({ display: 'flex', flexDirection: 'column' }), true);
  assert.equal(overlayLayoutSupported({ display: 'grid' }), false);
  assert.equal(overlayLayoutSupported({ display: 'flex', flexDirection: 'row' }), false);
  const { list } = area({ style: 'display:grid' });
  attachOverlayScrollbar(list);
  assert.equal(list.hasAttribute('data-overlay-scroll'), false);
});

test('dragging the thumb scrolls the area; a press beside it does not', async () => {
  const { list, sizes, frame, dom } = area();
  attachOverlayScrollbar(list);
  await frame();
  const fire = (type, clientX, clientY) => {
    const event = new dom.window.MouseEvent(type, { clientX, clientY, button: 0, bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    list.dispatchEvent(event);
  };
  fire('pointerdown', 150, 10);
  fire('pointermove', 150, 60);
  assert.equal(sizes.scrollTop, 0, 'a press in the content is not a drag');
  fire('pointerdown', 296, 10);
  fire('pointermove', 296, 60);
  // The thumb travels 200 - 4 - 39 = 157px for 800px of scrolling.
  assert.equal(Math.round(sizes.scrollTop), Math.round(50 * 800 / 157));
  fire('pointerup', 296, 60);
  const after = sizes.scrollTop;
  fire('pointermove', 296, 120);
  assert.equal(sizes.scrollTop, after, 'released: moving no longer scrolls');
});

test('detach gives the area its plain bar back', async () => {
  const { list, frame } = area();
  const overlay = attachOverlayScrollbar(list);
  await frame();
  overlay.detach();
  assert.equal(list.hasAttribute('data-overlay-scroll'), false);
  assert.equal(list.style.getPropertyValue('--overlay-size'), '');
});

test('the installer gives the thumb to matching areas there now and to those added later', async () => {
  const dom = new JSDOM('<!doctype html><main><ol class="scrolls"></ol><ol class="other"></ol></main>', { pretendToBeVisual: true });
  const { document } = dom.window;
  installOverlayScrollbars(document.body, '.scrolls');
  assert.equal(document.querySelector('.scrolls').hasAttribute('data-overlay-scroll'), true);
  assert.equal(document.querySelector('.other').hasAttribute('data-overlay-scroll'), false);
  const added = document.createElement('section');
  added.innerHTML = '<ol class="scrolls"></ol>';
  document.querySelector('main').append(added);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(added.querySelector('.scrolls').hasAttribute('data-overlay-scroll'), true);
});
