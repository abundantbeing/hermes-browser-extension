import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { autoApprovingStore } from './helpers/auto-approving-store.mjs';

const scope = Object.freeze({
  controllerId: 'controller-1',
  leaseOwnerId: 'controller-1',
  leaseId: 'lease-1',
  leaseGeneration: 2,
  tabId: 7,
  frameId: 0,
  documentGeneration: 3,
});

const NODES = [
  { role: 'textbox', name: 'Search', backendDOMNodeId: 21 },
  { role: 'button', name: 'Go', backendDOMNodeId: 22 },
];

const ACTIONS = ['browser_batch', 'browser_click', 'browser_hover', 'browser_scroll', 'browser_snapshot'];

function fixture(onExecute) {
  const approvals = autoApprovingStore();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: NODES });
  const calls = [];
  const adapter = {
    contract: { enabled: true, actions: ACTIONS },
    inspect: async () => ({ currentUrl: 'https://example.test/start', hasUnsavedContent: false }),
    settle: async () => ({ navigated: false, url: 'https://example.test/start', title: 'Start' }),
    async execute(action, args) {
      calls.push(action);
      if (action === 'browser_snapshot') return { title: 'Done', url: 'https://example.test/start', text: 'Final page', nodes: NODES };
      onExecute?.(action);
      return { status: 'ok' };
    },
  };
  return { calls, executor: createBrowserControlExecutor({ adapter, approvals, refs }) };
}

const frame = (actions) => ({
  command_id: 'batch-pause-1',
  action: 'browser_batch',
  arguments: { actions },
  tab_id: scope.tabId,
  frame_id: scope.frameId,
  document_generation: scope.documentGeneration,
});

test('pausing browser control while a batch runs ends it before the next step and reads nothing back', async () => {
  let halted = false;
  const { calls, executor } = fixture((action) => {
    if (action === 'browser_hover') halted = true;
  });
  const result = await executor.execute(frame([
    { action: 'browser_hover', ref: '@e1' },
    { action: 'browser_click', ref: '@e2' },
    { action: 'browser_scroll', direction: 'down' },
  ]), { scope, controlHalted: () => halted });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.status, 'stopped');
  assert.equal(result.result.stopped_reason, 'controller_paused');
  assert.equal(result.result.completed, 1);
  assert.equal(result.result.remaining, 2);
  assert.deepEqual(calls, ['browser_hover'], 'no further step and no page read after the pause');
  assert.equal('snapshot' in result.result, false);
});

test('a batch is unaffected when control is not halted', async () => {
  const { calls, executor } = fixture();
  const result = await executor.execute(frame([
    { action: 'browser_hover', ref: '@e1' },
    { action: 'browser_scroll', direction: 'down' },
  ]), { scope, controlHalted: () => false });
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(calls, ['browser_hover', 'browser_scroll', 'browser_snapshot']);
});

test('pausing ends a batch even when stop_on_error is off', async () => {
  let halted = false;
  const { calls, executor } = fixture((action) => {
    if (action === 'browser_click') halted = true;
  });
  const batch = frame([{ action: 'browser_click', ref: '@e2' }, { action: 'browser_hover', ref: '@e1' }]);
  batch.arguments.stop_on_error = false;
  const result = await executor.execute(batch, { scope, controlHalted: () => halted });
  assert.equal(result.result.stopped_reason, 'controller_paused');
  assert.deepEqual(calls, ['browser_click']);
});
