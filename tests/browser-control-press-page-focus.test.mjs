import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createChromiumCdpAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';

// The real probe and the real Chromium adapter against a fake page, so the focus a key press is held to is the
// focus the probe really reads. Only what the adapter sends to the browser is recorded.
const scope = { controllerId: 'page', leaseOwnerId: 'page', leaseId: 'page', leaseGeneration: 1, tabId: 9, frameId: 0, documentGeneration: 2 };
const control = (tagName = 'A', label = 'First link') => ({ tagName, type: '', getAttribute: (key) => (key === 'aria-label' ? label : null) });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture() {
  const body = {};
  const doc = { body, documentElement: {}, activeElement: body, querySelectorAll: () => [] };
  const context = vm.createContext({
    document: doc,
    crypto: webcrypto,
    chrome: { dom: { openOrClosedShadowRoot: (element) => element.closedRoot || element.shadowRoot || null } },
  });
  const sent = [];
  const api = {
    tabs: { get: async () => ({ id: 9, url: 'https://example.test/app', active: true, windowId: 1 }) },
    scripting: { executeScript: async ({ func, args }) => { context.args = args; return [{ result: vm.runInContext(`(${func.toString()})(...args)`, context) }]; } },
    debugger: {
      attach: async () => {}, detach: async () => {},
      onDetach: { addListener() {}, removeListener() {} }, onEvent: { addListener() {}, removeListener() {} },
      sendCommand: async (_target, method, params) => { sent.push([method, params]); return {}; },
    },
  };
  const adapter = createChromiumCdpAdapter({ browserApi: api });
  const approvals = createBrowserControlApprovalStore({ ttlMs: 5000 });
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore() });
  const keys = () => sent.filter(([method]) => method === 'Input.dispatchKeyEvent');
  const press = (key, id = key) => executor.execute({ command_id: `press-${id}`, approval_nonce: `nonce-${id}`, action: 'browser_press', arguments: { key }, tab_id: 9, frame_id: 0, document_generation: 2, deadline_at: Date.now() + 5000 }, { scope });
  return { doc, body, approvals, executor, keys, press };
}

async function approvedPress(f, key, change = () => {}) {
  const running = f.press(key);
  await settle();
  const shown = f.approvals.pending()[0];
  assert.ok(shown, 'approval shown');
  change();
  assert.equal(f.approvals.grant({ ...shown, state: 'paused' }).ok, true);
  return running;
}

for (const key of ['Tab', 'Shift+Tab', 'Escape', 'ArrowDown', 'ArrowLeft', 'PageDown', 'PageUp', 'Home', 'End']) {
  test(`${key} is sent while the page itself has focus`, async () => {
    const f = fixture();
    const result = await f.press(key);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(f.keys().length, 2, 'key down and key up');
  });
}

test('Tab reaches the first control of a newly opened page, and the next Tab leaves it', async () => {
  const f = fixture();
  assert.equal((await f.press('Tab', 'one')).ok, true);
  f.doc.activeElement = control();
  assert.equal((await f.press('Tab', 'two')).ok, true);
  assert.equal(f.keys().length, 4);
});

test('a navigation key leaves a focused embedded frame, which has no identity to check', async () => {
  const f = fixture();
  f.doc.activeElement = control('IFRAME', 'Video');
  const result = await f.press('Tab');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.keys().length, 2);
});

for (const key of ['ArrowDown', 'ArrowUp', 'Escape', 'Home', 'PageDown', 'Ctrl+Tab']) {
  test(`${key} is not sent into a focused embedded frame, whose address is not judged`, async () => {
    const f = fixture();
    f.doc.activeElement = control('IFRAME', 'Payment');
    const result = await f.press(key);
    assert.equal(result.ok, false);
    assert.equal(f.keys().length, 0, 'nothing reached the frame');
  });
}

test('focus that cannot be read passes only Tab, never an arrow key', async () => {
  const f = fixture();
  f.doc.activeElement = { get tagName() { throw new Error('probe failed'); } };
  const arrow = await f.press('ArrowDown');
  assert.equal(arrow.ok, false);
  assert.equal(f.keys().length, 0);
  assert.equal((await f.press('Tab', 'tab')).ok, true);
  assert.equal(f.keys().length, 2);
});

test('Shift+Tab may leave a focused embedded frame too', async () => {
  const f = fixture();
  f.doc.activeElement = control('IFRAME', 'Video');
  assert.equal((await f.press('Shift+Tab')).ok, true);
  assert.equal(f.keys().length, 2);
});

test('keys that act on the page with nothing focused are held to the page, not refused', async () => {
  const f = fixture();
  assert.equal((await f.press('Space')).ok, true);
  assert.equal(f.keys().length, 2);
});

test('a key that acts on the focused control is refused when focus moves after it was judged', async () => {
  const f = fixture();
  const original = f.doc.activeElement;
  // The page grabs focus for a control between the probe and the key.
  let reads = 0;
  Object.defineProperty(f.doc, 'activeElement', { get: () => (reads++ < 1 ? original : control('BUTTON', 'Next')) });
  const result = await f.press('Space');
  assert.equal(result.error?.code, 'focus_changed');
  assert.equal(f.keys().length, 0);
});

test('Enter approved with the page focused is sent while it stays focused', async () => {
  const f = fixture();
  const result = await approvedPress(f, 'Enter');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.keys().length, 2);
});

test('Enter approved with the page focused is refused once a control takes focus', async () => {
  const f = fixture();
  const result = await approvedPress(f, 'Enter', () => { f.doc.activeElement = control('BUTTON', 'Send'); });
  assert.equal(result.error?.code, 'focus_changed');
  assert.equal(f.keys().length, 0);
});

test('Enter approved with a control focused is still bound to that exact control', async () => {
  const f = fixture();
  f.doc.activeElement = control('BUTTON', 'Same');
  const result = await approvedPress(f, 'Enter', () => { f.doc.activeElement = control('BUTTON', 'Same'); });
  assert.equal(result.error?.code, 'focus_changed');
  assert.equal(f.keys().length, 0);
});

test('page focus the probe cannot identify does not pass an approved key', async () => {
  const f = fixture();
  f.doc.activeElement = null;
  const result = await approvedPress(f, 'Enter');
  assert.equal(result.error?.code, 'focus_changed');
  assert.equal(f.keys().length, 0);
});
