// Which frames withhold a screenshot or stop a pointer action. A frame in another process is judged by the address the
// browser reports for it, with the policy the page itself is held to; one whose address cannot be had stays refused.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createChromiumCdpAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';
import {
  box, captured, crossProcessFrame, documentOf, fakeChromium, mouseEvents, openSignal, sameProcessFrame,
} from './browser-control-fakes.mjs';

const scope = Object.freeze({ tabId: 1, frameId: 0 });

// The iframe targets the browser lists: { frame id: address }, or an entry with a parent to nest it.
const targetInfos = (entries) => ({
  targetInfos: [
    { targetId: 'MAINTAB', type: 'page', url: 'https://example.com/' },
    ...Object.entries(entries).map(([targetId, value]) => {
      const entry = typeof value === 'string' ? { url: value } : value;
      return { targetId, type: 'iframe', url: entry.url, parentFrameId: entry.parent || 'MAIN', attached: true };
    }),
  ],
});

// A page with OOPIF owners 31.. at the given boxes (viewport coordinates), the targets they run in, and optional extras.
function pageWith({ frames, targets, targetsError = null, computed = null, extra = {} }) {
  const owners = Object.keys(frames).map((id) => crossProcessFrame(Number(id)));
  return fakeChromium({
    handlers: {
      'DOM.getDocument': () => documentOf(owners),
      'DOM.getBoxModel': ({ backendNodeId }) => {
        const found = frames[backendNodeId];
        if (found === 'none') throw new Error('Could not compute box model.');
        return found ? box(...found) : box(10, 20, 20, 20);
      },
      'Target.getTargets': () => { if (targetsError) throw targetsError; return targets ? targetInfos(targets) : {}; },
      ...(computed ? {
        'DOM.pushNodesByBackendIdsToFrontend': ({ backendNodeIds }) => ({ nodeIds: backendNodeIds.map((id) => id + 5000) }),
        'CSS.getComputedStyleForNode': ({ nodeId }) => {
          const style = computed[nodeId - 5000];
          if (style instanceof Error) throw style;
          return { computedStyle: Object.entries({ display: 'block', visibility: 'visible', opacity: '1', ...style }).map(([name, value]) => ({ name, value })) };
        },
      } : {}),
      ...extra,
    },
  });
}
const shoot = (chromium, options = {}) => createChromiumCdpAdapter({ browserApi: chromium.api })
  .execute('browser_screenshot', {}, { scope, signal: openSignal(), ...options });
const IN_VIEW = [744, 700, 256, 60]; // the viewport is 1000 x 800
const refused = (error) => error?.code === 'restricted_frame' && /screenshot was withheld/i.test(error.message);

// --- the matrix ---------------------------------------------------------------------------------------------------

test('an ordinary cross-site frame in view no longer withholds the screenshot: ad slot, chat launcher, video embed, captcha badge', async () => {
  for (const [label, url] of [
    ['an ad frame', 'https://googleads.g.doubleclick.net/pagead/html/r20240101/r20190131/zrt_lookup.html?fsb=1'],
    ['a YouTube embed', 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=0&rel=0'],
    ['a chat launcher', 'https://widget.intercom.io/widget/abc123'],
    ['a captcha badge', 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=key'],
    ['a frame on a port', 'https://embed.example:8443/player'],
  ]) {
    const chromium = pageWith({ frames: { 31: IN_VIEW }, targets: { OOPIF31: url } });
    assert.match((await shoot(chromium)).dataUrl, /^data:image\/png;base64,/, label);
  }
});

test('a frame on a browser page, a data or blob document, a checkout or sign-in page stays withheld', async () => {
  for (const [label, url] of [
    ['chrome://', 'chrome://settings/passwords'],
    ['chrome-error', 'chrome-error://chromewebdata/'],
    ['data:', 'data:text/html,<input type=password>'],
    ['blob:', 'blob:https://example.com/6f1a0c2e'],
    ['javascript:', 'javascript:void(0)'],
    ['an extension page', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/pay.html'],
    ['a checkout path', 'https://pay.example/checkout/card?session=abc'],
    ['a card field (an opaque address)', 'https://js.stripe.com/v3/elements-inner-card-1a2b3c.html'],
    ['a PayPal frame', 'https://www.sandbox.paypal.com/smart/buttons?clientID=abc'],
    ['a Google sign-in frame', 'https://accounts.google.com/gsi/iframe/select?client_id=1'],
    ['a Microsoft sign-in frame', 'https://login.microsoftonline.com/common/oauth2/authorize'],
    ['a fragment route to checkout', 'https://shop.example/app#/checkout'],
    ['not yet committed', ''],
  ]) {
    const chromium = pageWith({ frames: { 31: IN_VIEW }, targets: { OOPIF31: url } });
    await assert.rejects(shoot(chromium), refused, label);
    assert.equal(captured(chromium.calls), false, `${label}: never captured`);
  }
});

test('a frame whose address cannot be had stays withheld', async () => {
  // Not among the targets, no target list at all, the call refused, or a target list that is not one.
  for (const [label, options] of [
    ['not in the list', { frames: { 31: IN_VIEW }, targets: { OOPIF99: 'https://elsewhere.example/' } }],
    ['no list', { frames: { 31: IN_VIEW }, targets: null }],
    ['the call fails', { frames: { 31: IN_VIEW }, targets: {}, targetsError: new Error('Not allowed') }],
  ]) {
    const chromium = pageWith(options);
    await assert.rejects(shoot(chromium), refused, label);
    assert.equal(captured(chromium.calls), false, label);
  }
});

test('a frame nested in an allowed frame is judged too', async () => {
  const restrictedInside = pageWith({
    frames: { 31: IN_VIEW },
    targets: { OOPIF31: 'https://ads.example/slot', NESTED: { url: 'https://bank.example/billing', parent: 'OOPIF31' } },
  });
  await assert.rejects(shoot(restrictedInside), refused);
  const fineInside = pageWith({
    frames: { 31: IN_VIEW },
    targets: { OOPIF31: 'https://ads.example/slot', NESTED: { url: 'https://cdn.example/creative', parent: 'OOPIF31' } },
  });
  assert.match((await shoot(fineInside)).dataUrl, /^data:image\/png;base64,/);
});

test('a frame under 4 x 4 CSS pixels, one that is not rendered, and one out of the picture do not count', async () => {
  // The address of each is unknown: it would be withheld if it counted.
  for (const [label, frameBox] of [
    ['a 1 x 1 tracker', [5, 5, 1, 1]], ['3 x 3', [5, 5, 3, 3]], ['4 wide, 300 high but 3 tall', [5, 5, 300, 3]],
    ['not rendered', 'none'], ['below the viewport', [0, 5000, 300, 200]], ['left of it', [-500, 0, 100, 100]],
  ]) {
    const chromium = pageWith({ frames: { 31: frameBox }, targets: {} });
    assert.match((await shoot(chromium)).dataUrl, /^data:image\/png;base64,/, label);
  }
  const fourByFour = pageWith({ frames: { 31: [5, 5, 4, 4] }, targets: {} });
  await assert.rejects(shoot(fourByFour), refused, '4 x 4 is a frame');
});

test('a frame that is not visible (hidden, transparent) does not count, and one whose style cannot be read does', async () => {
  for (const [label, style] of [
    ['visibility hidden', { visibility: 'hidden' }], ['visibility collapse', { visibility: 'collapse' }], ['opacity 0', { opacity: '0' }], ['display none', { display: 'none' }],
  ]) {
    const chromium = pageWith({ frames: { 31: IN_VIEW }, targets: {}, computed: { 31: style } });
    assert.match((await shoot(chromium)).dataUrl, /^data:image\/png;base64,/, label);
  }
  const visible = pageWith({ frames: { 31: IN_VIEW }, targets: {}, computed: { 31: {} } });
  await assert.rejects(shoot(visible), refused, 'a visible frame of unknown address');
  const unreadable = pageWith({ frames: { 31: IN_VIEW }, targets: {}, computed: { 31: new Error('CSS agent was not enabled') } });
  await assert.rejects(shoot(unreadable), refused, 'style cannot be read');
  const faint = pageWith({ frames: { 31: IN_VIEW }, targets: {}, computed: { 31: { opacity: '0.4' } } });
  await assert.rejects(shoot(faint), refused, 'a faint frame is still pixels');
});

test('same-process frames are judged as before', async () => {
  const readable = fakeChromium({ handlers: { 'DOM.getDocument': () => documentOf([sameProcessFrame(31, 'https://ads.example/slot')]) } });
  assert.match((await shoot(readable)).dataUrl, /^data:image\/png;base64,/);
  const restricted = fakeChromium({ handlers: { 'DOM.getDocument': () => documentOf([sameProcessFrame(31, 'https://bank.example/checkout')]) } });
  await assert.rejects(shoot(restricted), refused);
});

// --- what the message says -----------------------------------------------------------------------------------------

test('the message names the host and says what to do, and never the path, the query or any page content', async () => {
  const chromium = pageWith({ frames: { 31: IN_VIEW }, targets: { OOPIF31: 'https://pay.example:8443/checkout/card?token=sk_live_abc123&name=Jane' } });
  const error = await shoot(chromium).then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'restricted_frame');
  assert.match(error.message, /A frame from pay\.example:8443 on this page is on a page Hermes cannot read, so the screenshot was withheld\./);
  assert.match(error.message, /Hermes can still read the page text/);
  assert.match(error.message, /scroll/i);
  assert.match(error.message, /ask the person/i);
  assert.doesNotMatch(error.message, /checkout|card|token|sk_live|Jane|\?/);
});

test('a frame that is not a web page, and one that could not be checked, are described without inventing a host', async () => {
  const data = await shoot(pageWith({ frames: { 31: IN_VIEW }, targets: { OOPIF31: 'data:text/html,<p>secret</p>' } })).then(() => null, (e) => e);
  assert.match(data.message, /A frame on this page that is not an ordinary web page/);
  assert.doesNotMatch(data.message, /secret|<p>/);
  const unknown = await shoot(pageWith({ frames: { 31: IN_VIEW }, targets: {} })).then(() => null, (e) => e);
  assert.match(unknown.message, /A frame on this page could not be checked, so the screenshot was withheld\./);
  assert.match(unknown.message, /Hermes can still read the page text/);
});

test('the element screenshot message is the same, and an element away from the frame is still captured', async () => {
  const chromium = pageWith({ frames: { 31: [0, 0, 100, 100] }, targets: { OOPIF31: 'https://pay.example/checkout' } });
  await assert.rejects(shoot(chromium, { target: { backendDOMNodeId: 44 } }), /frame from pay\.example/);
  const away = pageWith({ frames: { 31: [400, 400, 100, 100] }, targets: { OOPIF31: 'https://pay.example/checkout' } });
  assert.match((await shoot(away, { target: { backendDOMNodeId: 44 } })).dataUrl, /^data:image\/png;base64,/);
});

// --- pointer actions -----------------------------------------------------------------------------------------------

// The point is over the frame's owner element, in the page's own frame: what Chrome reports for a cross-site frame.
function overlayPage(targets, extra = {}) {
  return fakeChromium({
    handlers: {
      'DOM.getNodeForLocation': () => ({ backendNodeId: 61, frameId: 'MAIN' }),
      'DOM.describeNode': ({ backendNodeId }) => ({ node: backendNodeId === 61 ? { nodeName: 'IFRAME', frameId: 'OOPIF61' } : { nodeName: 'A' } }),
      'DOM.getDocument': () => documentOf([crossProcessFrame(61)]),
      'DOM.getBoxModel': ({ backendNodeId }) => (backendNodeId === 61 ? box(0, 0, 400, 400) : box(10, 20, 20, 20)),
      'Target.getTargets': () => (targets ? targetInfos(targets) : {}),
      ...extra,
    },
  });
}
const click = (chromium, args = { x: 25, y: 35 }, options = {}) => createChromiumCdpAdapter({ browserApi: chromium.api })
  .execute('browser_click', args, { scope, signal: openSignal(), ...options });

test('a click on a consent banner or a video play button, which are ordinary cross-site frames, goes through', async () => {
  for (const url of ['https://consent.cookiebot.com/banner', 'https://www.youtube.com/embed/abc?controls=1']) {
    const chromium = overlayPage({ OOPIF61: url });
    assert.deepEqual(await click(chromium), { status: 'clicked' });
    assert.deepEqual(mouseEvents(chromium.calls).map((event) => event.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  }
});

test('a click into a frame on a restricted page, or one whose address is unknown, is refused with a message that names the host', async () => {
  const checkout = overlayPage({ OOPIF61: 'https://pay.example/checkout/card?token=abc' });
  const error = await click(checkout).then(() => null, (thrown) => thrown);
  assert.equal(error.code, 'restricted_frame');
  assert.match(error.message, /frame from pay\.example/);
  assert.match(error.message, /Click somewhere else|ask the person/i);
  assert.doesNotMatch(error.message, /checkout|token/);
  assert.deepEqual(mouseEvents(checkout.calls), []);

  const unknown = overlayPage(null);
  const unknownError = await click(unknown).then(() => null, (thrown) => thrown);
  assert.equal(unknownError.code, 'restricted_frame');
  assert.match(unknownError.message, /frame on this page that Hermes could not check/);
  assert.deepEqual(mouseEvents(unknown.calls), []);

  for (const url of ['chrome://settings', 'data:text/html,hi']) {
    const refusedFrame = overlayPage({ OOPIF61: url });
    await assert.rejects(click(refusedFrame), (thrown) => thrown?.code === 'restricted_frame', url);
  }
});

test('a ref click covered by an ordinary cross-site frame goes out and says it was covered, and hover is judged the same way', async () => {
  const chromium = overlayPage({ OOPIF61: 'https://ads.example/slot' });
  const result = await click(chromium, { ref: '@e1' }, { target: { backendDOMNodeId: 44 } });
  assert.equal(result.status, 'clicked');
  assert.equal(result.obscured, true);

  const hover = overlayPage({ OOPIF61: 'https://pay.example/checkout' });
  await assert.rejects(
    createChromiumCdpAdapter({ browserApi: hover.api }).execute('browser_hover', { ref: '@e1' }, { scope, signal: openSignal(), target: { backendDOMNodeId: 44 } }),
    (thrown) => thrown?.code === 'restricted_frame',
  );
  assert.deepEqual(mouseEvents(hover.calls), []);
});

// --- the frame policy itself ---------------------------------------------------------------------------------------

test('a card or sign-in frame is never readable, whatever its path says, and ordinary frames still are', async () => {
  const { frameUrlReadable, readableChildFrames } = await import('../extension/lib/browser-control-frames.mjs');
  for (const url of [
    'https://js.stripe.com/v3/elements-inner-card-1a2b3c.html', 'https://m.stripe.network/inner.html', 'https://www.paypal.com/smart/buttons',
    'https://accounts.google.com/gsi/iframe/select', 'https://login.microsoftonline.com/x', 'https://appleid.apple.com/auth/authorize', 'https://pay.google.com/gp/p/ui/pay',
    'https://JS.STRIPE.COM./v3/x.html',
  ]) assert.equal(frameUrlReadable(url), false, url);
  for (const url of [
    'https://www.youtube.com/embed/abc', 'https://www.google.com/recaptcha/api2/anchor', 'https://ads.example/slot', 'https://notstripe.com/x', 'https://stripe.com.example.net/x',
    'about:blank', 'about:srcdoc',
  ]) assert.equal(frameUrlReadable(url), true, url);
  const tree = { frame: { id: 'MAIN' }, childFrames: [
    { frame: { id: 'card', url: 'https://js.stripe.com/v3/elements-inner-card.html' } },
    { frame: { id: 'chat', url: 'https://chat.example/live' } },
  ] };
  assert.deepEqual(readableChildFrames(tree).map((frame) => frame.id), ['chat']);
});
