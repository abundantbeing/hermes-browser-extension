// Second hardening round for Hermes Control (see the second security review): each test pins one finding.
// Real modules, fake debugger and browser APIs, no browser.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { createChromiumCdpAdapter, createFirefoxWebExtensionAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';

const openSignal = () => new AbortController().signal;
const scope = Object.freeze({ tabId: 1, frameId: 0 });

// --- fakes ---------------------------------------------------------------------------------------------------------

const box = (x, y, w, h) => ({ model: { content: [x, y, x + w, y, x + w, y + h, x, y + h], border: [x, y, x + w, y, x + w, y + h, x, y + h] } });
const documentOf = (owners = []) => ({
  root: {
    nodeType: 9, nodeName: '#document', backendNodeId: 1, frameId: 'MAIN', documentURL: 'https://example.com/',
    children: [{ nodeType: 1, nodeName: 'BODY', backendNodeId: 2, children: [{ nodeType: 1, nodeName: 'A', backendNodeId: 44 }, ...owners] }],
  },
});
const sameProcessFrame = (id, url, children = []) => ({
  nodeType: 1, nodeName: 'IFRAME', backendNodeId: id, frameId: `F${id}`,
  contentDocument: { nodeType: 9, nodeName: '#document', backendNodeId: id + 1000, documentURL: url, children },
});
const crossProcessFrame = (id) => ({ nodeType: 1, nodeName: 'IFRAME', backendNodeId: id, frameId: `OOPIF${id}` });

function fakeChromium({
  handlers = {}, tab = () => ({ url: 'https://example.com/', title: 'Example', status: 'complete', active: true, windowId: 1 }), onSend,
} = {}) {
  const calls = [];
  const counts = { attach: 0, detach: 0 };
  const defaults = {
    'DOM.getDocument': () => documentOf(),
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'MAIN', url: 'https://example.com/' } } }),
    'DOM.getBoxModel': () => box(10, 20, 20, 20),
    'DOM.getNodeForLocation': () => ({ backendNodeId: 44, frameId: 'MAIN' }),
    'DOM.describeNode': () => ({ node: { nodeName: 'A' } }),
    'Runtime.evaluate': () => ({ result: { value: false } }),
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } }),
    'Page.captureScreenshot': () => ({ data: 'AAAA' }),
    'DOM.resolveNode': () => ({ object: { objectId: 'o' } }),
    'Runtime.callFunctionOn': () => ({ result: { value: false } }),
  };
  const table = { ...defaults, ...handlers };
  const api = {
    tabs: { get: async (id) => tab(id, calls) },
    scripting: { executeScript: async () => [{ result: {} }] },
    debugger: {
      attach: async () => { counts.attach += 1; },
      detach: async () => { counts.detach += 1; },
      sendCommand: async (target, method, params) => {
        calls.push([method, params]);
        onSend?.(method, params, calls);
        const handler = table[method];
        return handler ? handler(params, calls) : {};
      },
      onDetach: { addListener() {}, removeListener() {} },
      onEvent: { addListener() {}, removeListener() {} },
    },
  };
  return { api, calls, counts };
}

const methodsOf = (calls) => calls.map((call) => call[0]);
const captured = (calls) => calls.some((call) => call[0] === 'Page.captureScreenshot');
const mouseEvents = (calls) => calls.filter((call) => call[0] === 'Input.dispatchMouseEvent').map((call) => call[1]);
const shoot = (chromium, args = {}, options = {}) => createChromiumCdpAdapter({ browserApi: chromium.api })
  .execute('browser_screenshot', args, { scope, signal: openSignal(), ...options });

// --- 1. the screenshot is judged against the address the tab has, before and after the capture ---------------------

test('a screenshot is discarded when the tab moved to a restricted page while it was captured', async () => {
  let moved = false;
  const chromium = fakeChromium({
    tab: () => ({ url: moved ? 'https://shop.example/checkout/pay' : 'https://shop.example/cart', status: 'complete', active: true, windowId: 1 }),
    handlers: { 'Page.captureScreenshot': () => { moved = true; return { data: 'AAAA' }; } },
  });
  await assert.rejects(shoot(chromium), (error) => error?.code === 'restricted_page' && !/AAAA/.test(error.message));
  assert.equal(captured(chromium.calls), true, 'it was taken, then thrown away');
});

test('a screenshot is never taken of a tab that is already on a restricted page', async () => {
  const chromium = fakeChromium({ tab: () => ({ url: 'https://shop.example/checkout/pay', status: 'complete', active: true, windowId: 1 }) });
  await assert.rejects(shoot(chromium), (error) => error?.code === 'restricted_page');
  assert.equal(captured(chromium.calls), false);
});

test('a screenshot is discarded when the tab went to another page while it was captured, even an ordinary one', async () => {
  let moved = false;
  const chromium = fakeChromium({
    tab: () => ({ url: moved ? 'https://example.com/other' : 'https://example.com/start', status: 'complete', active: true, windowId: 1 }),
    handlers: { 'Page.captureScreenshot': () => { moved = true; return { data: 'AAAA' }; } },
  });
  await assert.rejects(shoot(chromium), (error) => error?.code === 'page_changed' && /try again/i.test(error.message));
});

test('a restricted address in the fragment counts, and an ordinary fragment change does not', async () => {
  for (const [after, ok] of [['https://example.com/app#/checkout', false], ['https://example.com/app#section-2', true]]) {
    let moved = false;
    const chromium = fakeChromium({
      tab: () => ({ url: moved ? after : 'https://example.com/app', status: 'complete', active: true, windowId: 1 }),
      handlers: { 'Page.captureScreenshot': () => { moved = true; return { data: 'AAAA' }; } },
    });
    if (ok) assert.match((await shoot(chromium)).dataUrl, /^data:image\/png;base64,/);
    else await assert.rejects(shoot(chromium), (error) => error?.code === 'restricted_page');
  }
});

test('an ordinary screenshot reports the address it was taken under, and a local document needs the setting', async () => {
  const ordinary = fakeChromium();
  const shot = await shoot(ordinary);
  assert.equal(shot.url, 'https://example.com/');
  assert.match(shot.dataUrl, /^data:image\/png;base64,/);

  const local = () => fakeChromium({ tab: () => ({ url: 'file:///C:/notes/page.html', status: 'complete', active: true, windowId: 1 }) });
  await assert.rejects(shoot(local()), (error) => error?.code === 'restricted_page');
  assert.match((await shoot(local(), {}, { allowLocalDocuments: true })).dataUrl, /^data:image\/png;base64,/);
});

function screenshotExecutor(landing) {
  const adapter = {
    contract: { enabled: true, actions: ['browser_screenshot'] },
    inspect: async () => ({ currentUrl: 'https://shop.example/cart', hasUnsavedContent: false }),
    execute: async () => landing,
  };
  return createBrowserControlExecutor({ adapter, approvals: createBrowserControlApprovalStore(), refs: createBrowserControlRefStore() });
}
const frameOf = (action, args = {}) => ({
  command_id: 'c1', action, arguments: args, tab_id: 1, frame_id: 0, document_generation: 1,
});
const executorScope = { controllerId: 'c', leaseOwnerId: 'c', leaseId: 'l', tabId: 1, frameId: 0, documentGeneration: 1 };

test('the executor drops a screenshot whose adapter says it was taken on a restricted page', async () => {
  const outcome = await screenshotExecutor({ dataUrl: 'data:image/png;base64,AAAA', url: 'https://shop.example/checkout/pay' })
    .execute(frameOf('browser_screenshot'), { scope: executorScope });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'restricted_page');
  assert.doesNotMatch(JSON.stringify(outcome), /AAAA|data:image/);
  const fine = await screenshotExecutor({ dataUrl: 'data:image/png;base64,AAAA', url: 'https://shop.example/cart' })
    .execute(frameOf('browser_screenshot'), { scope: executorScope });
  assert.equal(fine.ok, true);
  assert.equal(fine.result.status, 'captured');
  assert.equal('url' in fine.result, false, 'the address is for the check, not for the model');
});

test('the Firefox screenshot reports its address too', async () => {
  const calls = [];
  const tab = { id: 7, windowId: 4, active: true, title: 'Leased', url: 'https://example.test/a' };
  const api = {
    tabs: {
      get: async () => ({ ...tab }),
      query: async () => [{ ...tab }],
      captureVisibleTab: async (windowId, options) => { calls.push([windowId, options]); return 'data:image/png;base64,ZmFrZQ=='; },
    },
    scripting: { executeScript: async () => [{ result: {} }] },
  };
  const shot = await createFirefoxWebExtensionAdapter({ browserApi: api }).execute('browser_screenshot', {}, { scope: { tabId: 7, frameId: 0 }, signal: openSignal() });
  assert.equal(shot.url, 'https://example.test/a');
});

// --- 5. the region that is checked is the region that is captured ---------------------------------------------------

// The visual viewport as Page.getLayoutMetrics reports it, in document coordinates (pageX/pageY).
const viewportAt = ({ pageX = 0, pageY = 0, clientWidth = 1000, clientHeight = 800, scale = 1, offsetX = 0, offsetY = 0 } = {}) => ({
  cssVisualViewport: { pageX, pageY, clientWidth, clientHeight, scale, offsetX, offsetY },
});
// DOM.getBoxModel answers in viewport coordinates: the control is at 10,20 and every other node at the given box.
const boxesWith = (frames) => ({ backendNodeId }) => box(...(frames[backendNodeId] ?? [10, 20, 20, 20]));
const clipOf = (calls) => calls.find((call) => call[0] === 'Page.captureScreenshot')?.[1]?.clip;
const withheld = (error) => error?.code === 'restricted_frame' && /screenshot was withheld/i.test(error.message);

test('an element screenshot clips in document coordinates, so a scrolled page captures the element and not what is under it', async () => {
  const chromium = fakeChromium({ handlers: { 'Page.getLayoutMetrics': () => viewportAt({ pageY: 3000 }) } });
  await shoot(chromium, { zoom: 2 }, { target: { backendDOMNodeId: 44 } });
  // The control is at 10,20 in the viewport, which is 10,3020 in the document.
  assert.deepEqual(clipOf(chromium.calls), { x: 10, y: 3020, width: 20, height: 20, scale: 2 });
  const unscrolled = fakeChromium({ handlers: { 'Page.getLayoutMetrics': () => viewportAt() } });
  await shoot(unscrolled, {}, { target: { backendDOMNodeId: 44 } });
  assert.deepEqual(clipOf(unscrolled.calls), { x: 10, y: 20, width: 20, height: 20, scale: 1 });
});

test('on a scrolled page a restricted frame over the element is withheld, one elsewhere in the viewport is not', async () => {
  const withFrame = (frameBox) => fakeChromium({
    handlers: {
      'Page.getLayoutMetrics': () => viewportAt({ pageY: 3000 }),
      'DOM.getDocument': () => documentOf([sameProcessFrame(31, 'https://bank.example/checkout')]),
      'DOM.getBoxModel': boxesWith({ 31: frameBox }),
    },
  });
  const over = withFrame([0, 0, 100, 100]);
  await assert.rejects(shoot(over, {}, { target: { backendDOMNodeId: 44 } }), withheld);
  assert.equal(captured(over.calls), false);
  const away = withFrame([400, 400, 100, 100]);
  assert.match((await shoot(away, {}, { target: { backendDOMNodeId: 44 } })).dataUrl, /^data:image\/png;base64,/);
  assert.equal(clipOf(away.calls).y, 3020);
});

test('a viewport screenshot of a scrolled page covers what is in view, not the top of the document', async () => {
  const at = (frameBox) => fakeChromium({
    handlers: {
      'Page.getLayoutMetrics': () => viewportAt({ pageY: 3000 }),
      'DOM.getDocument': () => documentOf([crossProcessFrame(31)]),
      'DOM.getBoxModel': boxesWith({ 31: frameBox }),
    },
  });
  await assert.rejects(shoot(at([744, 700, 256, 60])), withheld);
  // Below the visible part (the viewport is 800 high), and scrolled out above it.
  for (const outside of [[0, 900, 300, 100], [0, -500, 300, 100]]) {
    assert.match((await shoot(at(outside))).dataUrl, /^data:image\/png;base64,/, JSON.stringify(outside));
  }
});

test('a pinch-zoomed page is judged over the part of the document that is in view, whichever way its boxes are scaled', async () => {
  const chromium = fakeChromium({
    handlers: {
      // Zoomed in 2x and moved right: the visible area is 500 x 400 CSS px starting at 500,0 in the document.
      'Page.getLayoutMetrics': () => viewportAt({ pageX: 500, pageY: 0, clientWidth: 500, clientHeight: 400, scale: 2, offsetX: 500 }),
      'DOM.getDocument': () => documentOf([sameProcessFrame(31, 'https://bank.example/checkout')]),
      'DOM.getBoxModel': boxesWith({ 31: [700, 100, 200, 100] }),
    },
  });
  await assert.rejects(shoot(chromium), withheld);
  assert.equal(captured(chromium.calls), false);
});

test('a page position that cannot be read stops an element screenshot instead of guessing the clip', async () => {
  const chromium = fakeChromium({ handlers: { 'Page.getLayoutMetrics': () => { throw new Error('Target closed'); } } });
  await assert.rejects(shoot(chromium, {}, { target: { backendDOMNodeId: 44 } }), /where the page is scrolled to/i);
  assert.equal(captured(chromium.calls), false);
});

test('a scroll during the capture does not move the region that is checked afterwards', async () => {
  // A restricted frame sits at document y 3400, below the element at document y 3020. The page scrolls while the
  // capture runs, so the frame is then at viewport y 20, over where the element was in the viewport: the frame
  // was never in the captured area, and the check afterwards must keep judging the document area.
  let scrolled = false;
  const chromium = fakeChromium({
    handlers: {
      'Page.getLayoutMetrics': () => viewportAt({ pageY: scrolled ? 3380 : 3000 }),
      'DOM.getDocument': () => documentOf([sameProcessFrame(31, 'https://bank.example/checkout')]),
      'DOM.getBoxModel': ({ backendNodeId }) => (backendNodeId === 31 ? box(10, scrolled ? 20 : 400, 100, 100) : box(10, 20, 20, 20)),
      'Page.captureScreenshot': () => { scrolled = true; return { data: 'AAAA' }; },
    },
  });
  assert.match((await shoot(chromium, {}, { target: { backendDOMNodeId: 44 } })).dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(clipOf(chromium.calls), { x: 10, y: 3020, width: 20, height: 20, scale: 1 });
});

// --- 6. a drag that is stopped is not dropped on the destination ----------------------------------------------------

test('a Stop during a drag releases the button where it was pressed, never on the destination', async () => {
  for (const stopAfter of ['press', 'move']) {
    const controller = new AbortController();
    const chromium = fakeChromium({
      handlers: { 'DOM.getBoxModel': ({ backendNodeId }) => (backendNodeId === 44 ? box(10, 20, 20, 20) : box(500, 500, 20, 20)) },
      onSend: (method, params) => {
        if (method !== 'Input.dispatchMouseEvent') return;
        if ((stopAfter === 'press' && params.type === 'mousePressed') || (stopAfter === 'move' && params.type === 'mouseMoved' && params.buttons === 1)) {
          controller.abort(new Error('Stop'));
        }
      },
    });
    await assert.rejects(
      createChromiumCdpAdapter({ browserApi: chromium.api }).execute(
        'browser_drag', {}, { scope, signal: controller.signal, target: { backendDOMNodeId: 44 }, destination: { backendDOMNodeId: 45 } },
      ),
      /Stop/,
    );
    const events = mouseEvents(chromium.calls).filter((event) => event.type !== 'mouseMoved' || event.buttons === 1);
    const released = events.filter((event) => event.type === 'mouseReleased');
    assert.equal(released.length, 1, stopAfter);
    assert.deepEqual({ x: released[0].x, y: released[0].y }, { x: 20, y: 30 }, `${stopAfter}: released at the source`);
    assert.equal(events.some((event) => event.type === 'mouseReleased' && event.x === 510), false, 'nothing was released on the destination');
  }
});

test('a drag that is not stopped still drops on the destination', async () => {
  const chromium = fakeChromium({
    handlers: { 'DOM.getBoxModel': ({ backendNodeId }) => (backendNodeId === 44 ? box(10, 20, 20, 20) : box(500, 500, 20, 20)) },
  });
  await createChromiumCdpAdapter({ browserApi: chromium.api }).execute(
    'browser_drag', {}, { scope, signal: openSignal(), target: { backendDOMNodeId: 44 }, destination: { backendDOMNodeId: 45 } },
  );
  const released = mouseEvents(chromium.calls).filter((event) => event.type === 'mouseReleased');
  assert.deepEqual(released.map((event) => [event.x, event.y]), [[510, 510]]);
});
