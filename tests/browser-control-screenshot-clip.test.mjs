// The clip of an element screenshot under pinch zoom and browser zoom. Measured in Chrome (see the real-browser probe
// that goes with this change): DOM.getBoxModel answers in CSS px relative to the visual viewport, unscaled by the pinch,
// so the element's document position is the viewport's pageX/pageY plus the box; Page.captureScreenshot reads its clip in
// the page's zoomed px, so a browser zoom of z multiplies the document rect by z, and the image is clip x scale x the
// device pixel ratio. The frame-overlap check judges the same element, in CSS px.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createChromiumCdpAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';
import {
  box, captured, crossProcessFrame, documentOf, fakeChromium, frameTarget, openSignal, sameProcessFrame,
} from './browser-control-fakes.mjs';

const scope = Object.freeze({ tabId: 1, frameId: 0 });
const shoot = (chromium, args = {}) => createChromiumCdpAdapter({ browserApi: chromium.api })
  .execute('browser_screenshot', args, { scope, signal: openSignal(), target: { backendDOMNodeId: 44 } });
const clipOf = (chromium) => chromium.calls.find((call) => call[0] === 'Page.captureScreenshot')?.[1]?.clip;
const withheld = (error) => error?.code === 'restricted_frame' && /screenshot was withheld/i.test(error.message);

// A PNG as far as its header: the signature and an IHDR chunk with the size (enough for the adapter, which reads only that).
function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

const metrics = (view) => () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 800, scale: 1, zoom: 1, ...view } });
const page = ({ view = {}, element = [230, 100, 300, 150], extra = {}, ...rest } = {}) => fakeChromium({
  ...rest,
  handlers: { 'Page.getLayoutMetrics': metrics(view), 'DOM.getBoxModel': ({ backendNodeId }) => box(...(backendNodeId === 44 ? element : [0, 0, 10, 10])), ...extra },
});

test('pinch zoom 2: the clip is the element in the document, with no division by the pinch scale', async () => {
  // Chrome's numbers from the probe: box [230,146] relative to the visual viewport, whose top is at 4854 in the document.
  const chromium = page({ view: { pageX: 0, pageY: 4854, clientWidth: 632.5, clientHeight: 442.5, scale: 2 }, element: [230, 146, 300, 150] });
  await shoot(chromium);
  assert.deepEqual(clipOf(chromium), { x: 230, y: 5000, width: 300, height: 150, scale: 1 });
  // A visual viewport panned to the right inside the page.
  const panned = page({ view: { pageX: 40, pageY: 4824, scale: 2 }, element: [190, 176, 300, 150] });
  await shoot(panned);
  assert.deepEqual(clipOf(panned), { x: 230, y: 5000, width: 300, height: 150, scale: 1 });
});

test('browser zoom: the clip is in zoomed px, so the document rect is multiplied by the zoom factor', async () => {
  for (const [zoom, expected] of [
    [2, { x: 460, y: 10000, width: 600, height: 300 }],
    [0.5, { x: 115, y: 2500, width: 150, height: 75 }],
    [1.5, { x: 345, y: 7500, width: 450, height: 225 }],
    [1, { x: 230, y: 5000, width: 300, height: 150 }],
  ]) {
    const chromium = page({ view: { pageY: 4854, zoom }, element: [230, 146, 300, 150] });
    await shoot(chromium);
    assert.deepEqual(clipOf(chromium), { ...expected, scale: 1 }, `zoom ${zoom}`);
  }
});

test('pinch and browser zoom together, and the scale the model asked for rides on top', async () => {
  const chromium = page({ view: { pageX: 108, pageY: 4927.5, scale: 2, zoom: 1.5 }, element: [122, 72.5, 300, 150] });
  await shoot(chromium, { zoom: 2 });
  assert.deepEqual(clipOf(chromium), { x: 345, y: 7500, width: 450, height: 225, scale: 2 });
});

test('a missing or odd zoom reading counts as no browser zoom', async () => {
  for (const zoom of [undefined, 0, -2, Number.NaN, 'wide']) {
    const chromium = page({ view: { pageY: 4854, zoom }, element: [230, 146, 300, 150] });
    await shoot(chromium);
    assert.deepEqual(clipOf(chromium), { x: 230, y: 5000, width: 300, height: 150, scale: 1 }, String(zoom));
  }
});

// --- the checked region is the captured region ------------------------------------------------------------------------

test('under browser zoom a frame beside the element is not in the picture, one over it is, both judged in CSS px', async () => {
  // The element covers x 230..530 of the document; the zoomed clip would reach x 1060, so a unit mix-up would take
  // the frame at 600 to be inside the capture.
  const at = (frameBox) => page({
    view: { pageY: 4854, zoom: 2 },
    element: [230, 146, 300, 150],
    extra: {
      'DOM.getDocument': () => documentOf([sameProcessFrame(31, 'https://bank.example/checkout')]),
      'DOM.getBoxModel': ({ backendNodeId }) => box(...(backendNodeId === 31 ? frameBox : [230, 146, 300, 150])),
    },
  });
  const beside = at([600, 146, 100, 100]);
  assert.equal(typeof (await shoot(beside)).dataUrl, 'string');
  assert.equal(captured(beside.calls), true);
  const over = at([500, 146, 100, 100]);
  await assert.rejects(shoot(over), withheld);
  assert.equal(captured(over.calls), false);
});

test('under pinch zoom the frame boxes are unscaled: one just outside the element is not withheld for, one touching it is', async () => {
  const at = (frameBox) => page({
    view: { pageX: 0, pageY: 4854, clientWidth: 632.5, clientHeight: 442.5, scale: 2 },
    element: [230, 146, 300, 150],
    extra: {
      'DOM.getDocument': () => documentOf([crossProcessFrame(31)]),
      'DOM.getBoxModel': ({ backendNodeId }) => box(...(backendNodeId === 31 ? frameBox : [230, 146, 300, 150])),
    },
    debuggerTargets: [frameTarget('OOPIF31', 'https://bank.example/billing')],
  });
  // Doubling the box (the old "scaled" reading) would put this one over the element; unscaled it is clear of it.
  assert.equal(typeof (await shoot(at([540, 146, 20, 20]))).dataUrl, 'string');
  await assert.rejects(shoot(at([520, 146, 40, 40])), withheld);
});

// --- the picture is the size that was asked for -----------------------------------------------------------------------

test('an image the size of the clip (times the scale, times the device pixel ratio) is returned', async () => {
  for (const [label, args, view, dims] of [
    ['plain', {}, {}, [300, 150]],
    ['scale 2', { zoom: 2 }, {}, [600, 300]],
    ['dpr 2', {}, {}, [600, 300]],
    ['browser zoom 2', {}, { zoom: 2 }, [600, 300]],
    ['browser zoom 2, dpr 2', {}, { zoom: 2 }, [1200, 600]],
    ['a pixel of rounding', {}, {}, [301, 150]],
  ]) {
    const chromium = page({ view, extra: { 'Page.captureScreenshot': () => ({ data: png(...dims) }) } });
    const result = await shoot(chromium, args);
    assert.match(result.dataUrl, /^data:image\/png;base64,/, label);
  }
});

test('an image of another size than the element is not returned: capture_region_mismatch', async () => {
  for (const [label, dims] of [
    ['half the size', [150, 75]],
    ['clamped to the page on one side', [300, 90]],
    ['stretched', [300, 300]],
    ['one pixel wide', [1, 1]],
    ['empty', [0, 0]],
  ]) {
    const chromium = page({ extra: { 'Page.captureScreenshot': () => ({ data: png(...dims) }) } });
    const error = await shoot(chromium).then(() => null, (thrown) => thrown);
    assert.equal(error?.code, 'capture_region_mismatch', label);
    assert.match(error.message, /did not match|different size|not the element/i, label);
    assert.doesNotMatch(error.message, /data:image|base64/);
  }
});

test('a screenshot the adapter cannot read the size of is returned as before (the size is only checked when it is stated)', async () => {
  const chromium = page({ extra: { 'Page.captureScreenshot': () => ({ data: 'AAAA' }) } });
  assert.match((await shoot(chromium)).dataUrl, /^data:image\/png;base64,AAAA$/);
});

test('a viewport screenshot is not size-checked against an element', async () => {
  const chromium = page({ extra: { 'Page.captureScreenshot': () => ({ data: png(1280, 900) }) } });
  const result = await createChromiumCdpAdapter({ browserApi: chromium.api })
    .execute('browser_screenshot', {}, { scope, signal: openSignal() });
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
});
