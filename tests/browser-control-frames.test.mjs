import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FRAME_ELEMENT_SHARE,
  FRAME_TEXT_SHARE,
  MAX_FRAME_NODES,
  MAX_SNAPSHOT_FRAMES,
  frameChainReadable,
  frameUrlReadable,
  readableChildFrames,
} from '../extension/lib/browser-control-frames.mjs';

const frame = (id, url, childFrames) => ({ frame: { id, url }, ...(childFrames ? { childFrames } : {}) });
const ids = (frames) => frames.map((item) => item.id);
const tree = (...childFrames) => ({ frame: { id: 'MAIN', url: 'https://example.test/' }, childFrames });

test('the budgets are the ones the snapshot, the ref store and the page view rely on', () => {
  assert.equal(MAX_SNAPSHOT_FRAMES, 8);
  assert.equal(MAX_FRAME_NODES, 400);
  assert.ok(FRAME_TEXT_SHARE > 0 && FRAME_TEXT_SHARE < 0.5, 'child frames never get more of the text than the page itself');
  assert.ok(FRAME_ELEMENT_SHARE > 0 && FRAME_ELEMENT_SHARE < 0.5);
});

test('lists the child frames on ordinary web pages, parents before their children, as plain id and url', () => {
  const frames = readableChildFrames(tree(
    frame('A', 'https://example.test/a', [frame('A1', 'https://example.test/a/inner')]),
    frame('B', 'http://localhost:8080/b'),
  ));

  assert.deepEqual(frames, [
    { id: 'A', url: 'https://example.test/a' },
    { id: 'A1', url: 'https://example.test/a/inner' },
    { id: 'B', url: 'http://localhost:8080/b' },
  ]);
});

test('never lists the main frame, and an empty or malformed tree lists nothing', () => {
  assert.deepEqual(readableChildFrames({ frame: { id: 'MAIN', url: 'https://example.test/' } }), []);
  assert.deepEqual(readableChildFrames({ frame: { id: 'MAIN' }, childFrames: 'nope' }), []);
  assert.deepEqual(readableChildFrames(undefined), []);
  assert.deepEqual(readableChildFrames(tree({ frame: { url: 'https://example.test/no-id' } }, { notAFrame: true }, null)), []);
});

test('a frame on a restricted page is not read, and neither is anything it embeds', () => {
  const frames = readableChildFrames(tree(
    frame('PAY', 'https://shop.example/checkout/pay', [frame('WIDGET', 'https://widget.example/help'), frame('INLINE', 'about:srcdoc')]),
    frame('BANK', 'https://mybank.example/accounts'),
    frame('PW', 'https://example.test/password/reset'),
    frame('OK', 'https://shop.example/product'),
  ));

  assert.deepEqual(ids(frames), ['OK']);
});

test('a frame with a credential in its address is not read', () => {
  assert.deepEqual(readableChildFrames(tree(frame('CRED', 'https://user:secret@example.test/embed'))), []);
});

test('inline frames (srcdoc, and an empty frame a script fills) are read, because the frame around them is', () => {
  const frames = readableChildFrames(tree(
    frame('SRCDOC', 'about:srcdoc'),
    frame('BLANK', 'ABOUT:BLANK'),
    frame('PAGE', 'https://example.test/embed', [frame('NESTED', 'about:blank')]),
  ));

  assert.deepEqual(ids(frames), ['SRCDOC', 'BLANK', 'PAGE', 'NESTED']);
});

test('a frame that is a browser page, a data or blob document, an error page or has no address yet is not read', () => {
  const frames = readableChildFrames(tree(
    frame('EXT', 'chrome-extension://abcdef/page.html'),
    frame('CHROME', 'chrome://settings/'),
    frame('DATA', 'data:text/html,hello'),
    frame('BLOB', 'blob:https://example.test/0f1e'),
    frame('ERROR', 'chrome-error://chromewebdata/'),
    frame('VIEW', 'view-source:https://example.test/'),
    frame('FILE', 'file:///home/user/page.html'),
    frame('NONE', ''),
    frame('UNSET', undefined),
    frame('JS', 'javascript:void(0)'),
  ));

  assert.deepEqual(frames, []);
});

test('stops at the limit, counting a frame and the frames inside it alike', () => {
  const many = Array.from({ length: 12 }, (_, index) => frame(`F${index}`, `https://example.test/${index}`));
  assert.deepEqual(ids(readableChildFrames(tree(...many))), Array.from({ length: 8 }, (_, index) => `F${index}`));
  assert.deepEqual(ids(readableChildFrames(tree(...many), { limit: 3 })), ['F0', 'F1', 'F2']);

  const nested = readableChildFrames(tree(frame('A', 'https://example.test/a', [frame('A1', 'https://example.test/1'), frame('A2', 'https://example.test/2')]), frame('B', 'https://example.test/b')), { limit: 3 });
  assert.deepEqual(ids(nested), ['A', 'A1', 'A2']);
});

test('the rule for a restricted page can be replaced, and sees only web addresses', () => {
  const seen = [];
  const frames = readableChildFrames(
    tree(frame('A', 'https://example.test/a'), frame('B', 'https://blocked.test/b'), frame('C', 'about:blank'), frame('D', 'data:text/html,x')),
    { restricted: (url) => { seen.push(url); return url.includes('blocked'); } },
  );

  assert.deepEqual(ids(frames), ['A', 'C']);
  assert.deepEqual(seen, ['https://example.test/a', 'https://blocked.test/b']);
});

test('a frame address is readable only as an ordinary web page, or as an inline frame that counts as its parent', () => {
  for (const url of ['https://chat.example.test/live_chat', 'http://chat.example.test/', 'about:blank', 'about:srcdoc', ' ABOUT:BLANK ']) {
    assert.equal(frameUrlReadable(url), true, url);
  }
  for (const url of ['https://shop.example.test/checkout', 'chrome://settings/', 'chrome-extension://abc/p.html', 'data:text/html,x', 'blob:https://a.test/1', 'file:///C:/x.html', 'chrome-error://chromewebdata/', 'about:newtab', '', undefined]) {
    assert.equal(frameUrlReadable(url), false, String(url));
  }
});

test('a chain of frames is readable only when every frame in it is', () => {
  assert.equal(frameChainReadable([]), true, 'a control in the page itself has no frame above it');
  assert.equal(frameChainReadable(['https://a.test/chat', 'about:srcdoc']), true);
  assert.equal(frameChainReadable(['https://a.test/chat', 'https://b.test/embed', 'about:blank']), true);
  assert.equal(frameChainReadable(['https://a.test/checkout', 'about:srcdoc']), false, 'an inline frame is its parent');
  assert.equal(frameChainReadable(['https://a.test/chat', 'https://b.test/payment', 'about:srcdoc']), false);
  assert.equal(frameChainReadable(['https://a.test/chat', '']), false);
  assert.equal(frameChainReadable(null), false);
  assert.equal(frameChainReadable(['https://a.test/chat'], (url) => url.includes('chat')), false, 'the rule can be replaced');
});
