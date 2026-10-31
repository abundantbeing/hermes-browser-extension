import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createFirefoxWebExtensionAdapter, createChromiumCdpAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';

const scope = { controllerId: 'focus', leaseOwnerId: 'focus', leaseId: 'focus', leaseGeneration: 1, tabId: 9, frameId: 0, documentGeneration: 2 };
const node = (tagName = 'BUTTON') => ({ tagName, type: 'button', get openOrClosedShadowRoot() { return this.closedRoot || this.shadowRoot || null; }, getAttribute: (key) => key === 'aria-label' ? 'Same' : null });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(browser = 'firefox') {
  const doc = { body: {}, documentElement: {}, activeElement: null, querySelectorAll: () => [] };
  const context = vm.createContext({ document: doc, crypto: webcrypto, ...(browser === 'chromium' ? { chrome: { dom: { openOrClosedShadowRoot: element => element.closedRoot || element.shadowRoot || null } } } : {}) });
  const api = {
    tabs: { get: async () => ({ id: 9, url: 'https://example.test/app', active: true, windowId: 1 }) },
    scripting: { executeScript: async ({ func, args }) => { context.args = args; return [{ result: vm.runInContext(`(${func.toString()})(...args)`, context) }]; } },
    debugger: { onDetach: { addListener() {}, removeListener() {} }, onEvent: { addListener() {}, removeListener() {} } },
  };
  const actual = browser === 'firefox' ? createFirefoxWebExtensionAdapter({ browserApi: api }) : createChromiumCdpAdapter({ browserApi: api });
  let dispatches = 0;
  const adapter = { contract: { enabled: true, actions: ['browser_press'] }, inspect: actual.inspect, execute: async () => { dispatches++; return { status: 'pressed' }; } };
  const approvals = createBrowserControlApprovalStore({ ttlMs: 5000 });
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore() });
  return { doc, context, approvals, executor, inspect: actual.inspect, dispatches: () => dispatches };
}

async function approvedPress(f, key, change) {
  const running = f.executor.execute({ command_id: 'focus-id', approval_nonce: 'focus-nonce', action: 'browser_press', arguments: { key }, tab_id: 9, frame_id: 0, document_generation: 2, deadline_at: Date.now() + 5000 }, { scope });
  await settle();
  const shown = f.approvals.pending()[0];
  assert.ok(shown, 'approval shown');
  change();
  assert.equal(f.approvals.grant({ ...shown, state: 'paused' }).ok, true);
  return running;
}

for (const browser of ['firefox', 'chromium']) {
  for (const key of ['Enter', 'Control+v']) {
    test(`${browser} ${key}: focus moving to an identical element is rejected`, async () => {
      const f = fixture(browser);
      f.doc.activeElement = node();
      const result = await approvedPress(f, key, () => { f.doc.activeElement = node(); });
      assert.equal(result.error?.code, 'focus_changed');
      assert.equal(f.dispatches(), 0);
    });
    test(`${browser} ${key}: same element remains approved`, async () => {
      const f = fixture(browser);
      f.doc.activeElement = node();
      const result = await approvedPress(f, key, () => {});
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(f.dispatches(), 1);
    });
  }
  test(`${browser}: replacing a focused node with a lookalike is rejected`, async () => {
    const f = fixture(browser);
    f.doc.activeElement = node('INPUT');
    const result = await approvedPress(f, 'Enter', () => { f.doc.activeElement = node('INPUT'); });
    assert.equal(result.error?.code, 'focus_changed');
    assert.equal(f.dispatches(), 0);
  });
  test(`${browser}: focus moving inside an open shadow root is rejected`, async () => {
    const f = fixture(browser);
    const host = node('DIV');
    host.shadowRoot = { activeElement: node() };
    f.doc.activeElement = host;
    const result = await approvedPress(f, 'Enter', () => { host.shadowRoot.activeElement = node(); });
    assert.equal(result.error?.code, 'focus_changed');
    assert.equal(f.dispatches(), 0);
  });
  test(`${browser}: focus moving inside a closed shadow root is rejected`, async () => {
    const f = fixture(browser);
    const host = node('DIV');
    host.closedRoot = { activeElement: node() };
    f.doc.activeElement = host;
    const result = await approvedPress(f, 'Enter', () => { host.closedRoot.activeElement = node(); });
    assert.equal(result.error?.code, 'focus_changed');
    assert.equal(f.dispatches(), 0);
  });
  test(`${browser}: unobservable focus is not considered the same focus`, async () => {
    const f = fixture(browser);
    const result = await approvedPress(f, 'Enter', () => {});
    assert.equal(result.error?.code, 'focus_changed');
    assert.equal(f.dispatches(), 0);
  });
  test(`${browser}: an embedded frame does not prove identity of the inner focused node`, async () => {
    const f = fixture(browser);
    f.doc.activeElement = node('IFRAME');
    const result = await approvedPress(f, 'Enter', () => {});
    assert.equal(result.error?.code, 'focus_changed');
    assert.equal(f.dispatches(), 0);
  });
  test(`${browser}: unavailable closed-shadow inspection fails closed`, async () => {
    const f = fixture(browser);
    f.context.chrome = undefined;
    f.doc.activeElement = { tagName: 'BUTTON', type: 'button', getAttribute: () => null };
    const result = await approvedPress(f, 'Enter', () => {});
    assert.equal(result.error?.code, 'focus_changed');
    assert.equal(f.dispatches(), 0);
  });
  test(`${browser}: unavailable random identity fails closed`, async () => {
    const f = fixture(browser);
    f.context.crypto = undefined;
    f.doc.activeElement = node();
    const result = await approvedPress(f, 'Enter', () => {});
    assert.equal(result.error?.code, 'focus_changed');
    assert.equal(f.dispatches(), 0);
  });
  test(`${browser}: a new document cannot reuse the old node identity`, async () => {
    const f = fixture(browser);
    const sameNode = node();
    f.doc.activeElement = sameNode;
    const result = await approvedPress(f, 'Enter', () => {
      f.context.document = { body: {}, documentElement: {}, activeElement: sameNode, querySelectorAll: () => [] };
    });
    assert.equal(result.error?.code, 'focus_changed');
    assert.equal(f.dispatches(), 0);
  });
}
