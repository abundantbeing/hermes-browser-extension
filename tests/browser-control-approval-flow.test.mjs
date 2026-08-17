import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';

const SCOPE = Object.freeze({
  controllerId: 'controller-approval',
  leaseOwnerId: 'controller-approval',
  leaseId: 'lease-approval-55',
  leaseGeneration: 7,
  tabId: 55,
  frameId: 0,
  documentGeneration: 4,
});

function frame(overrides = {}) {
  return {
    command_id: 'approval-command',
    approval_nonce: 'nonce-approval-command',
    action: 'browser_press',
    arguments: { key: 'Enter' },
    tab_id: 55,
    frame_id: 0,
    document_generation: 4,
    deadline_at: Date.now() + 2_000,
    ...overrides,
  };
}

function fixture() {
  const approvals = createBrowserControlApprovalStore({ ttlMs: 1_000 });
  const refs = createBrowserControlRefStore();
  let sideEffects = 0;
  const adapter = {
    contract: { enabled: true, actions: ['browser_press'] },
    async inspect() { return { currentUrl: 'https://example.test/editor', hasUnsavedContent: false }; },
    async execute() { sideEffects += 1; return { status: 'typed' }; },
  };
  const executor = createBrowserControlExecutor({ adapter, approvals, refs });
  return { approvals, executor, sideEffects: () => sideEffects };
}

test('Phase 6 approval-required command waits in-flight, exposes minimal request, and resumes exactly once', async () => {
  const { approvals, executor, sideEffects } = fixture();
  let settled = false;
  const running = executor.execute(frame(), { scope: SCOPE }).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(settled, false);
  assert.equal(sideEffects(), 0);
  assert.deepEqual(approvals.pending(), [{
    approvalId: 'approval-command',
    approvalNonce: 'nonce-approval-command',
    commandId: 'approval-command',
    controllerId: 'controller-approval',
    leaseId: 'lease-approval-55',
    leaseGeneration: 7,
    tabId: 55,
    documentGeneration: 4,
    action: 'browser_press',
    state: 'paused',
    reason: 'Press Enter to submit the current form or message?',
  }]);

  const granted = approvals.grant({
    approvalId: 'approval-command',
    approvalNonce: 'nonce-approval-command',
    commandId: 'approval-command',
    controllerId: 'controller-approval',
    leaseId: 'lease-approval-55',
    leaseGeneration: 7,
    tabId: 55,
    documentGeneration: 4,
    action: 'browser_press',
    state: 'paused',
  });
  assert.equal(granted.ok, true);
  assert.deepEqual(await running, { ok: true, result: { status: 'pressed' } });
  assert.equal(sideEffects(), 1);
  assert.deepEqual(approvals.pending(), []);
  assert.equal(approvals.consume({
    approvalId: 'approval-command',
    approvalNonce: 'nonce-approval-command',
    commandId: 'approval-command',
    controllerId: 'controller-approval',
    leaseId: 'lease-approval-55',
    leaseGeneration: 7,
    tabId: 55,
    documentGeneration: 4,
    action: 'browser_press',
    state: 'paused',
  }).ok, false);
});

test('Phase 6 approval wait rejects mismatched grants and aborts without side effects', async () => {
  const { approvals, executor, sideEffects } = fixture();
  const controller = new AbortController();
  const running = executor.execute(frame({ command_id: 'approval-cancelled', approval_id: 'approval-cancelled' }), {
    scope: SCOPE,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(approvals.grant({
    approvalId: 'approval-cancelled',
    approvalNonce: 'nonce-approval-command',
    commandId: 'different-command',
    controllerId: 'controller-approval',
    leaseId: 'lease-approval-55',
    leaseGeneration: 7,
    tabId: 55,
    documentGeneration: 4,
    action: 'browser_press',
    state: 'paused',
  }).ok, false);
  controller.abort();
  assert.equal((await running).error.code, 'cancelled');
  assert.equal(sideEffects(), 0);
  assert.deepEqual(approvals.pending(), []);
});

test('Phase 6 approval store clears pending waiters on detach', async () => {
  const { approvals, executor, sideEffects } = fixture();
  const running = executor.execute(frame({ command_id: 'approval-detach', approval_id: 'approval-detach' }), { scope: SCOPE });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(approvals.pending().length, 1);
  assert.equal(approvals.clear(), 1);
  assert.equal((await running).error.code, 'approval_cancelled');
  assert.equal(sideEffects(), 0);
});
