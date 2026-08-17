import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_CONTROL_RISKS,
  classifyBrowserControlAction,
} from '../extension/lib/browser-control-safety.mjs';
import {
  CONTROLLER_ADAPTER_IDS,
  controllerAdapterContractFor,
} from '../extension/lib/browser-controller-adapter.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';

test('Phase 7 classifies browser_fill and browser_select with strict security boundaries', () => {
  assert.equal(classifyBrowserControlAction({
    action: 'browser_fill',
    arguments: { value: 'normal text' },
    target: { role: 'textbox', name: 'Username' },
  }).risk, BROWSER_CONTROL_RISKS.SAFE);

  assert.equal(classifyBrowserControlAction({
    action: 'browser_select',
    arguments: { value: 'option-1' },
    target: { role: 'combobox', name: 'Country' },
  }).risk, BROWSER_CONTROL_RISKS.SAFE);

  // Sensitive fields blocked
  assert.equal(classifyBrowserControlAction({
    action: 'browser_fill',
    arguments: { value: 'password123' },
    target: { role: 'textbox', name: 'Password', inputType: 'password' },
  }).risk, BROWSER_CONTROL_RISKS.BLOCKED);

  assert.equal(classifyBrowserControlAction({
    action: 'browser_fill',
    arguments: { value: '123456' },
    target: { role: 'textbox', name: '2FA Code', autocomplete: 'one-time-code' },
  }).risk, BROWSER_CONTROL_RISKS.BLOCKED);

  assert.equal(classifyBrowserControlAction({
    action: 'browser_select',
    arguments: { value: 'wallet' },
    target: { role: 'combobox', name: 'Payment Method Crypto Wallet' },
  }).risk, BROWSER_CONTROL_RISKS.BLOCKED);
});

test('Phase 7 executor executes browser_fill and browser_select on valid refs', async () => {
  const actions = [];
  const fakeAdapter = {
    contract: { enabled: true, actions: ['browser_fill', 'browser_select'] },
    inspect: async () => ({}),
    execute: async (action, args, { target }) => {
      actions.push({ action, args, target });
      return { status: action === 'browser_fill' ? 'filled' : 'selected' };
    },
  };

  const fakeApprovals = { consume: () => ({ ok: true }) };
  const fakeRefs = {
    resolve: ({ ref }) => {
      if (ref === 'e1') return { ok: true, target: { backendDOMNodeId: 10, role: 'textbox', name: 'Search' } };
      if (ref === 'e2') return { ok: true, target: { backendDOMNodeId: 11, role: 'combobox', name: 'Sort' } };
      return { ok: false, error: 'invalid_ref' };
    },
    replace: () => {},
  };

  const executor = createBrowserControlExecutor({
    adapter: fakeAdapter,
    approvals: fakeApprovals,
    refs: fakeRefs,
  });

  const scope = {
    controllerId: 'ctrl-1',
    leaseOwnerId: 'ctrl-1',
    leaseId: 'lease-1',
    leaseGeneration: 1,
    tabId: 5,
    frameId: 0,
    documentGeneration: 1,
  };

  const fillRes = await executor.execute({
    action: 'browser_fill',
    arguments: { ref: 'e1', value: 'Hermes Agent' },
    tab_id: 5,
    frame_id: 0,
    document_generation: 1,
    controller_id: 'ctrl-1',
    lease_owner_id: 'ctrl-1',
    lease_id: 'lease-1',
    lease_generation: 1,
  }, { scope });

  assert.equal(fillRes.ok, true);
  assert.equal(fillRes.result.status, 'filled');

  const selectRes = await executor.execute({
    action: 'browser_select',
    arguments: { ref: 'e2', value: 'newest' },
    tab_id: 5,
    frame_id: 0,
    document_generation: 1,
    controller_id: 'ctrl-1',
    lease_owner_id: 'ctrl-1',
    lease_id: 'lease-1',
    lease_generation: 1,
  }, { scope });

  assert.equal(selectRes.ok, true);
  assert.equal(selectRes.result.status, 'selected');
  assert.equal(actions.length, 2);
});

test('Phase 7 mints frame-qualified refs when child frame nodes are present', async () => {
  const { createBrowserControlRefStore } = await import('../extension/lib/browser-control-refs.mjs');
  const store = createBrowserControlRefStore();

  const scope = {
    controllerId: 'ctrl-1',
    leaseOwnerId: 'ctrl-1',
    leaseId: 'lease-1',
    leaseGeneration: 1,
    tabId: 10,
    frameId: 0,
    documentGeneration: 1,
  };

  const replaced = store.replace({
    ...scope,
    nodes: [
      { role: 'button', name: 'Main Submit', backendDOMNodeId: 101 },
      { role: 'textbox', name: 'Frame Input', backendDOMNodeId: 102, frameId: '1' },
      { role: 'button', name: 'Frame Action', backendDOMNodeId: 103, frameId: 'f2' },
    ],
  });

  assert.equal(replaced.ok, true);
  assert.deepEqual(replaced.refs.map((r) => r.ref), ['@e1', '@f1e2', '@f2e3']);

  const resolvedMain = store.resolve({ ...scope, ref: '@e1' });
  assert.equal(resolvedMain.ok, true);
  assert.equal(resolvedMain.target.name, 'Main Submit');

  const resolvedFrame = store.resolve({ ...scope, ref: '@f1e2' });
  assert.equal(resolvedFrame.ok, true);
  assert.equal(resolvedFrame.target.name, 'Frame Input');
});
