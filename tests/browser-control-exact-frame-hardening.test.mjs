import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createChromiumCdpAdapter } from '../extension/lib/browser-control-browser-adapters.mjs';
import { createControllerServiceWorker, CONTROLLER_WORKER_MESSAGES } from '../extension/lib/controller-service-worker.mjs';
import { connector, extensionSender, memoryStorage, ownedReady, PRODUCT, settings, uuids, waitFor } from './browser-control-worker-fakes.mjs';

const approval = { approvalId: 'a', approvalNonce: 'n', commandId: 'c', tabId: 9, frameId: 7, documentGeneration: 1, action: 'browser_press', state: 'paused' };
const focus = { role: 'textbox', name: 'Message', inputType: 'text', identity: '0123456789abcdef0123456789abcdef' };

test('store binds requests, grants and consumes to the exact frame, preserving legacy root', async () => {
  const store = createBrowserControlApprovalStore();
  const waiting = store.request(approval);
  try {
    assert.equal(store.pending()[0].frameId, 7);
    assert.deepEqual(store.grant({ ...approval, frameId: 0 }), { ok: false, error: 'approval_mismatch' });
    const missingFrame = { ...approval }; delete missingFrame.frameId;
    assert.deepEqual(store.grant(missingFrame), { ok: false, error: 'approval_mismatch' });
    assert.equal(store.grant(approval).ok, true);
    assert.equal((await waiting).ok, true);
    assert.deepEqual(store.consume({ ...approval, frameId: 0 }), { ok: false, error: 'approval_mismatch' });
    assert.equal(store.consume(approval).ok, true);
    const root = { ...missingFrame, approvalId: 'root', approvalNonce: 'root' };
    assert.equal(store.grant(root).ok, true);
    assert.equal(store.consume({ ...root, frameId: 0 }).ok, true);
    assert.equal(store.grant({ ...root, frameId: -1 }).ok, false);
  } finally { store.clear(); }
});

test('worker checks the pending frame as well as its generation', async () => {
  const approvals = createBrowserControlApprovalStore();
  const transport = connector();
  let effects = 0;
  const adapter = { contract: { enabled: true, actions: ['browser_press'] },
    async inspect() { return { currentUrl: 'https://example.test/', focused: focus }; },
    async execute() { effects++; return { status: 'pressed' }; } };
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore() });
  const worker = createControllerServiceWorker({ storageArea: memoryStorage({ hermesBrowserSettings: settings() }).area, connector: transport, product: PRODUCT, randomUUID: uuids(), extensionOrigin: 'chrome-extension://fixture', approvalStore: approvals, executeBrowserCommand: (frame, context) => executor.execute(frame, context) });
  await worker.boot();
  await ownedReady(worker, 9);
  const child = await worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.documentReady }, { ...extensionSender({ tabId: 9 }), frameId: 7 });
  try {
    await transport.connections[0].emit({ method: 'browser.controller.command', params: { command_id: 'child', action: 'browser_press', arguments: { key: 'Enter' }, tab_id: 9, frame_id: 7, document_generation: child.documentGeneration } });
    const pending = await waitFor(() => worker.status().pendingApproval);
    assert.equal(pending.frameId, 7);
    const grant = (frameId) => worker.handleMessage({ type: CONTROLLER_WORKER_MESSAGES.approvalGrant, ...pending, frameId }, extensionSender());
    assert.equal((await grant(0)).ok, false);
    assert.equal(effects, 0);
    assert.equal((await grant(7)).ok, true);
    await waitFor(() => effects === 1);
  } finally { approvals.clear(); }
});

function chromiumFixture() {
  const calls = [];
  let current = focus;
  const api = { tabs: { get: async () => ({ id: 9, url: 'https://example.test/' }) },
    scripting: { executeScript: async () => [{ result: { focused: current } }] },
    debugger: { attach: async () => {}, detach: async () => {}, onDetach: { addListener() {}, removeListener() {} }, onEvent: { addListener() {}, removeListener() {} }, sendCommand: async (_target, method, params) => { calls.push([method, params]); return {}; } } };
  return { adapter: createChromiumCdpAdapter({ browserApi: api }), calls, setFocus(value) { current = value; } };
}

test('Chromium refuses all child-frame key dispatch even if that frame reports safe focus', async () => {
  const f = chromiumFixture();
  await assert.rejects(f.adapter.execute('browser_press', { key: 'a' }, { scope: { tabId: 9, frameId: 7 } }), { code: 'focus_changed' });
  assert.equal(f.calls.filter(([name]) => name === 'Input.dispatchKeyEvent').length, 0);
});

test('Chromium rechecks approved identity immediately before key dispatch', async () => {
  const f = chromiumFixture();
  f.setFocus({ ...focus, identity: 'fedcba9876543210fedcba9876543210' });
  await assert.rejects(f.adapter.execute('browser_press', { key: 'Enter' }, { scope: { tabId: 9, frameId: 0 }, expectedFocus: focus }), { code: 'focus_changed' });
  assert.equal(f.calls.filter(([name]) => name === 'Input.dispatchKeyEvent').length, 0);
});

test('executor supplies approved focus to the adapter and binds child approvals', async () => {
  const approvals = createBrowserControlApprovalStore();
  let received;
  const adapter = { contract: { enabled: true, actions: ['browser_press'] }, async inspect() { return { currentUrl: 'https://example.test/', focused: focus }; }, async execute(_a, _b, context) { received = context; return { status: 'pressed' }; } };
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore() });
  const scope = { controllerId: 'c', leaseOwnerId: 'c', leaseId: 'l', leaseGeneration: 1, tabId: 9, frameId: 7, documentGeneration: 1 };
  const running = executor.execute({ command_id: 'cmd', action: 'browser_press', arguments: { key: 'Enter' }, tab_id: 9, frame_id: 7, document_generation: 1, deadline_at: Date.now() + 5000 }, { scope });
  try {
    const pending = await waitFor(() => approvals.pending()[0]);
    assert.equal(pending.frameId, 7);
    assert.equal(approvals.grant(pending).ok, true);
    assert.equal((await running).ok, true);
    assert.deepEqual(received.expectedFocus, focus);
  } finally { approvals.clear(); }
});
