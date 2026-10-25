// The Firefox adapter only has the scripting API, so it cannot judge frames the way the Chromium adapter does; what it
// can do it does honestly: no element screenshot it cannot take, and no screenshot while a frame it can see is on a
// page Hermes will not read or a frame it could not look at is in view.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { createFirefoxWebExtensionAdapter, frameProbe } from '../extension/lib/browser-control-browser-adapters.mjs';

const scope = Object.freeze({ tabId: 7, frameId: 0 });
const openSignal = () => new AbortController().signal;

// A window showing tab 7 on `url`. `frames()` answers the all-frames probe: the page's own entry, then one per frame.
function firefox({ url = 'https://example.test/page', frames = () => [], visibleFrames = null, onCapture, probeError = null } = {}) {
  const calls = [];
  const tab = { id: 7, windowId: 4, active: true, title: 'Page', url };
  const api = {
    tabs: {
      get: async () => ({ ...tab }),
      query: async () => [{ ...tab }],
      captureVisibleTab: async (windowId, options) => {
        calls.push(['captureVisibleTab', windowId, options]);
        onCapture?.(tab);
        return 'data:image/png;base64,ZmFrZQ==';
      },
    },
    scripting: {
      executeScript: async (details) => {
        calls.push(['executeScript', details.target]);
        if (!details.target.allFrames) return [{ frameId: 0, result: { hasUnsavedContent: false } }];
        if (probeError) throw probeError;
        const children = frames(calls);
        return [
          { frameId: 0, result: { url, top: true, frames: visibleFrames ?? children.length } },
          ...children.map((child, index) => ({ frameId: index + 1, result: { url: child, top: false, frames: 0 } })),
        ];
      },
    },
  };
  return { api, calls, tab };
}
const shoot = (fake, args = {}, options = {}) => createFirefoxWebExtensionAdapter({ browserApi: fake.api })
  .execute('browser_screenshot', args, { scope, signal: openSignal(), ...options });
const captures = (fake) => fake.calls.filter((call) => call[0] === 'captureVisibleTab').length;
const withheld = (error) => error?.code === 'restricted_frame' && /screenshot was withheld/i.test(error.message);

test('an element screenshot is refused as unsupported in Firefox instead of returning the whole page', async () => {
  const fake = firefox();
  for (const options of [{ args: { ref: '@e1' } }, { args: {}, target: { backendDOMNodeId: 5 } }, { args: { ref: '@e1' }, target: { selector: '[data-hermes-ref="1"]' } }]) {
    await assert.rejects(
      shoot(fake, options.args, options.target ? { target: options.target } : {}),
      (error) => error?.code === 'unsupported_for_ref' && /whole visible tab/i.test(error.message) && /without a ref/i.test(error.message),
    );
  }
  assert.equal(captures(fake), 0);
  assert.equal(fake.calls.some((call) => call[0] === 'executeScript'), false, 'refused before anything ran in the page');
});

test('a page with no frames, or only ordinary ones, is captured', async () => {
  const none = firefox();
  assert.equal((await shoot(none)).dataUrl, 'data:image/png;base64,ZmFrZQ==');
  const ordinary = firefox({ frames: () => ['https://www.youtube.com/embed/abc', 'https://ads.example/slot', 'about:blank', 'about:srcdoc'] });
  assert.equal((await shoot(ordinary)).dataUrl, 'data:image/png;base64,ZmFrZQ==');
});

test('a frame on a checkout, sign-in or card page, or one that is not a web page, withholds the screenshot and is named by host only', async () => {
  for (const url of [
    'https://pay.example:8443/checkout/card?token=sk_live_abc', 'https://js.stripe.com/v3/elements-inner-card-1a2b.html',
    'https://accounts.google.com/gsi/iframe/select', 'data:text/html,hello', 'blob:https://example.test/1234', 'chrome://settings/',
  ]) {
    const fake = firefox({ frames: () => ['https://www.youtube.com/embed/abc', url] });
    const error = await shoot(fake).then(() => null, (thrown) => thrown);
    assert.ok(withheld(error), url);
    assert.equal(captures(fake), 0, `${url}: never captured`);
    assert.doesNotMatch(error.message, /checkout|card\?|token|sk_live|hello|\?/);
  }
  const error = await shoot(firefox({ frames: () => ['https://pay.example:8443/checkout/card?token=abc'] })).then(() => null, (thrown) => thrown);
  assert.match(error.message, /A frame from pay\.example:8443 on this page is on a page Hermes cannot read, so the screenshot was withheld\./);
  assert.match(error.message, /Hermes can still read the page text/);
});

test('a frame that could not be looked at, or a probe that failed, withholds the screenshot', async () => {
  // Three frames are in view but only two answered: one cannot be judged.
  const missing = firefox({ frames: () => ['https://ads.example/a', 'https://ads.example/b'], visibleFrames: 3 });
  const error = await shoot(missing).then(() => null, (thrown) => thrown);
  assert.ok(withheld(error));
  assert.match(error.message, /could not be checked/);
  assert.equal(captures(missing), 0);

  const broken = firefox({ probeError: new Error('Missing host permission for the tab') });
  await assert.rejects(shoot(broken), withheld);
  assert.equal(captures(broken), 0);
});

test('pixels are dropped when a frame turned restricted while the capture ran', async () => {
  let restricted = false;
  const fake = firefox({
    frames: () => [restricted ? 'https://pay.example/checkout' : 'https://ads.example/slot'],
    onCapture: () => { restricted = true; },
  });
  await assert.rejects(shoot(fake), withheld);
  assert.equal(captures(fake), 1, 'taken, then thrown away');
});

test('a restricted page is still refused before any frame is looked at', async () => {
  const fake = firefox({ url: 'https://shop.example/checkout/pay' });
  await assert.rejects(shoot(fake), (error) => error?.code === 'restricted_page');
  assert.equal(fake.calls.some((call) => call[0] === 'executeScript'), false);
});

// The probe runs in every frame of the page; run it against a small fake document and window.
const runProbe = (env) => vm.runInNewContext(`(${frameProbe.toString()})()`, env);

test('the probe reports the frame address and counts only frames that show', () => {
  const element = (width, height, style = {}) => ({ getBoundingClientRect: () => ({ width, height }), style });
  const top = {};
  top.top = top;
  // The probe is serialized into the page, so it must reach the style reader through `window`.
  top.getComputedStyle = (el) => ({ visibility: 'visible', display: 'block', opacity: '1', ...el.style });
  const env = {
    location: { href: 'https://example.test/page' },
    window: top,
    document: {
      querySelectorAll: () => [
        element(300, 250), element(1, 1), element(3, 300), element(300, 250, { visibility: 'hidden' }), element(300, 250, { display: 'none' }), element(300, 250, { opacity: '0' }),
      ],
    },
  };
  const result = runProbe(env);
  assert.deepEqual({ url: result.url, top: result.top, frames: result.frames }, { url: 'https://example.test/page', top: true, frames: 1 });

  const childWindow = { top };
  const child = runProbe({ ...env, window: childWindow, location: { href: 'https://ads.example/slot' } });
  assert.deepEqual({ url: child.url, top: child.top, frames: child.frames }, { url: 'https://ads.example/slot', top: false, frames: 0 });
});
