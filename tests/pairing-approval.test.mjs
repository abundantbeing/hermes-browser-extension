import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  approvalFrameUrl,
  createApprovalFrame,
  extensionOrigin,
  pairingStartBody,
} from '../extension/lib/pairing-approval.mjs';

const CHROME = { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop${path}` };
const FIREFOX = { id: 'hermes@example', getURL: (path) => `moz-extension://6f1c2a52-9d1c-4e2a-8f7e-0a4a5b3c9d10${path}` };
const GATEWAY = 'http://127.0.0.1:8642';
const approval = (extra = {}) => ({
  approval_url: 'http://127.0.0.1:8642/api/browser-extension/pair/approve/Zm9v-YmFy_1',
  pairing_id: 'Zm9v-YmFy_1',
  embeddable: true,
  ...extra,
});

test('the extension origin is this install\'s exact origin, read from the runtime', () => {
  assert.equal(extensionOrigin(CHROME), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
  assert.equal(extensionOrigin(FIREFOX), 'moz-extension://6f1c2a52-9d1c-4e2a-8f7e-0a4a5b3c9d10');
  assert.equal(extensionOrigin({}), '');
  assert.equal(extensionOrigin(null), '');
  assert.equal(extensionOrigin({ getURL: () => 'not a url' }), '');
  assert.equal(extensionOrigin({ getURL: () => { throw new Error('no runtime'); } }), '');
});

test('the pairing request carries the origin beside the id', () => {
  assert.deepEqual(pairingStartBody(CHROME), {
    name: 'Hermes Browser Extension',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  });
  assert.equal(pairingStartBody(FIREFOX).extensionOrigin, 'moz-extension://6f1c2a52-9d1c-4e2a-8f7e-0a4a5b3c9d10');
  assert.deepEqual(pairingStartBody(undefined), { name: 'Hermes Browser Extension', extensionId: '', extensionOrigin: '' });
});

test('the approval page is framed only when the gateway says it can be', () => {
  assert.equal(approvalFrameUrl(approval(), GATEWAY), 'http://127.0.0.1:8642/api/browser-extension/pair/approve/Zm9v-YmFy_1');
  // An older gateway sends no flag, a newer one may say no: either way a tab.
  assert.equal(approvalFrameUrl(approval({ embeddable: undefined }), GATEWAY), '');
  assert.equal(approvalFrameUrl(approval({ embeddable: false }), GATEWAY), '');
  assert.equal(approvalFrameUrl(approval({ embeddable: 'true' }), GATEWAY), '');
  assert.equal(approvalFrameUrl(null, GATEWAY), '');
  assert.equal(approvalFrameUrl({}, GATEWAY), '');
});

test('only the local gateway this panel talks to has its approval page framed', () => {
  const url = (value) => approvalFrameUrl(approval({ approval_url: value }), GATEWAY);
  const page = '/api/browser-extension/pair/approve/abc123';
  assert.notEqual(url(`http://127.0.0.1:8642${page}`), '');
  assert.equal(url(`https://127.0.0.1:8642${page}`), '', 'https is not what frame-src allows');
  assert.equal(url(`http://example.com:8642${page}`), '', 'a remote host');
  assert.equal(url(`http://127.0.0.1.example.com:8642${page}`), '', 'a lookalike host');
  assert.equal(url(`http://localhost:8642${page}`), '', 'another name for the gateway than the one in settings');
  assert.equal(url(`http://127.0.0.1:9999${page}`), '', 'another port than the gateway in settings');
  assert.equal(url(`http://user:pw@127.0.0.1:8642${page}`), '');
  assert.equal(url(`http://127.0.0.1:8642${page}?next=//evil.example`), '');
  assert.equal(url(`http://127.0.0.1:8642${page}#frag`), '');
  assert.equal(url('http://127.0.0.1:8642/api/browser-extension/pair/grant/abc123'), '', 'not the approval page');
  assert.equal(url('http://127.0.0.1:8642/v1/models'), '');
  assert.equal(url('http://127.0.0.1:8642/api/browser-extension/pair/approve/'), '');
  assert.equal(url('http://127.0.0.1:8642/api/browser-extension/pair/approve/a/b'), '');
  assert.equal(url('javascript:alert(1)'), '');
  assert.equal(url(''), '');
  assert.equal(url(undefined), '');
});

test('a profile-prefixed approval link and a localhost gateway are framed', () => {
  assert.notEqual(approvalFrameUrl(
    approval({ approval_url: 'http://localhost:8642/p/work/api/browser-extension/pair/approve/abc' }),
    'http://localhost:8642',
  ), '');
  assert.equal(approvalFrameUrl(approval(), 'http://localhost:8642'), '');
  assert.equal(approvalFrameUrl(approval(), ''), '');
  assert.equal(approvalFrameUrl(approval(), 'not a url'), '');
});

function frameFixture(overrides = {}) {
  const { document } = parseHTML('<!doctype html><html><body><div id="slot"></div></body></html>');
  const opened = [];
  const frame = createApprovalFrame({
    doc: document,
    translate: (key) => `t:${key}`,
    onOpenTab: () => opened.push('tab'),
    ...overrides,
  });
  return { document, frame, opened, slot: document.getElementById('slot') };
}

test('the approval frame is a sandboxed iframe with a way out to a tab', () => {
  const { frame, opened, slot } = frameFixture();
  assert.equal(frame.node.hidden, true, 'nothing shows before there is something to approve');
  assert.equal(frame.showing, false);
  const iframe = frame.node.querySelector('iframe');
  assert.ok(iframe);
  assert.equal(iframe.getAttribute('sandbox'), 'allow-forms allow-same-origin', 'forms, and the gateway\'s own origin; no script, no top navigation');
  assert.equal(iframe.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(iframe.getAttribute('title'), 't:pairing.frame_title');
  assert.equal(iframe.hasAttribute('src'), false, 'no request until shown');
  const tab = frame.node.querySelector('button');
  assert.equal(tab.textContent, 't:pairing.open_tab');
  assert.equal(tab.type, 'button');
  slot.append(frame.node);
  tab.dispatchEvent(new (slot.ownerDocument.defaultView.Event)('click', { bubbles: true }));
  assert.deepEqual(opened, ['tab']);
});

test('showing sets the address once and hiding drops the page', () => {
  const { frame, slot } = frameFixture();
  slot.append(frame.node);
  frame.show('http://127.0.0.1:8642/api/browser-extension/pair/approve/abc');
  assert.equal(frame.showing, true);
  assert.equal(frame.node.hidden, false);
  assert.equal(frame.frame.getAttribute('src'), 'http://127.0.0.1:8642/api/browser-extension/pair/approve/abc');
  frame.hide();
  assert.equal(frame.showing, false);
  assert.equal(frame.frame.hasAttribute('src'), false, 'the approval page is not left loaded');
  assert.equal(slot.contains(frame.node), false);
  // Hiding twice, or before showing, is harmless.
  frame.hide();
});
