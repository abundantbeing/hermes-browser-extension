import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { approvalBindingFields, createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';

const scope = Object.freeze({
  controllerId: 'controller-1',
  leaseOwnerId: 'controller-1',
  leaseId: 'lease-1',
  leaseGeneration: 2,
  tabId: 7,
  frameId: 0,
  documentGeneration: 3,
});

function frame(action, args = {}, overrides = {}) {
  return {
    command_id: 'command-1',
    action,
    arguments: args,
    tab_id: scope.tabId,
    frame_id: scope.frameId,
    document_generation: scope.documentGeneration,
    ...overrides,
  };
}

const NODES = [
  { role: 'button', name: 'Send message', backendDOMNodeId: 11 },
  { role: 'button', name: 'Send report', backendDOMNodeId: 12 },
  { role: 'button', name: 'Send message', backendDOMNodeId: 13 },
];

function fixture() {
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: NODES });
  const calls = [];
  const adapter = {
    contract: { enabled: true, actions: ['browser_click', 'browser_drag', 'browser_press', 'browser_snapshot'] },
    inspect: async () => ({ currentUrl: 'https://example.test/editor', hasUnsavedContent: false, focused: { role: 'textbox', name: 'Message', inputType: 'text', identity: '0123456789abcdef0123456789abcdef' } }),
    async execute(action, args, context) {
      if (action === 'browser_snapshot') return { title: 'After', url: 'https://example.test/editor', text: '', nodes: NODES };
      calls.push({ action, args, target: context.target?.name });
      return { status: 'ok' };
    },
  };
  const executor = createBrowserControlExecutor({ adapter, approvals, refs });
  return { approvals, executor, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an approval for one button cannot be granted for a different one', async () => {
  const { approvals, executor, calls } = fixture();
  const running = executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  await tick();
  const [pending] = approvals.pending();
  assert.equal(pending.targetRole, 'button');
  assert.equal(pending.targetName, 'Send message');
  assert.equal(pending.binding, 'ref:@e1');

  // A grant that names another label, another ref, or a different role is not this approval.
  assert.equal(approvals.grant({ ...pending, targetName: 'Send report' }).error, 'approval_mismatch');
  assert.equal(approvals.grant({ ...pending, targetRole: 'link' }).error, 'approval_mismatch');
  assert.equal(approvals.grant({ ...pending, binding: 'ref:@e3' }).error, 'approval_mismatch');
  assert.equal(calls.length, 0);

  assert.equal(approvals.grant(pending).ok, true);
  assert.equal((await running).ok, true);
  assert.deepEqual(calls.map((call) => [call.action, call.target]), [['browser_click', 'Send message']]);
});

test('a stored approval cannot be spent on another target, even under the same approval id', async () => {
  const { approvals, executor, calls } = fixture();
  const first = executor.execute(frame('browser_click', { ref: '@e1' }, { approval_id: 'shared' }), { scope });
  await tick();
  const granted = approvals.grant(approvals.pending()[0]);
  assert.equal(granted.ok, true);
  assert.equal((await first).ok, true);

  // Pre-grant an approval for "Send message" (@e1), then ask for "Send report" (@e2).
  const stored = {
    approvalId: 'shared-2',
    approvalNonce: 'shared-2',
    commandId: 'command-2',
    controllerId: scope.controllerId,
    leaseId: scope.leaseId,
    leaseGeneration: scope.leaseGeneration,
    tabId: scope.tabId,
    documentGeneration: scope.documentGeneration,
    action: 'browser_click',
    state: 'paused',
    targetRole: 'button',
    targetName: 'Send message',
    binding: 'ref:@e1',
  };
  assert.equal(approvals.grant(stored).ok, true);
  const second = executor.execute(frame('browser_click', { ref: '@e2' }, { command_id: 'command-2', approval_id: 'shared-2' }), { scope });
  await tick();
  assert.equal(calls.length, 1, 'the mismatched approval ran nothing');
  assert.equal(approvals.pending().length, 1, 'the person is asked again for the new target');
  assert.equal(approvals.pending()[0].targetName, 'Send report');
  approvals.cancelRequest('shared-2', 'approval_denied');
  assert.equal((await second).error.code, 'approval_denied');
  assert.equal(calls.length, 1);
});

test('two look-alike buttons keep separate approvals through their refs', async () => {
  const { approvals, executor } = fixture();
  const running = executor.execute(frame('browser_click', { ref: '@e3' }), { scope });
  await tick();
  const [pending] = approvals.pending();
  assert.equal(pending.targetName, 'Send message');
  assert.equal(pending.binding, 'ref:@e3');
  assert.equal(approvals.grant({ ...pending, binding: 'ref:@e1' }).error, 'approval_mismatch');
  approvals.cancelRequest(pending.approvalId);
  await running;
});

test('a viewport-coordinate approval is bound to those coordinates', async () => {
  const { approvals, executor, calls } = fixture();
  const running = executor.execute(frame('browser_click', { x: 10, y: 20 }), { scope });
  await tick();
  const [pending] = approvals.pending();
  assert.equal(pending.binding, 'point:10,20');
  assert.equal(approvals.grant({ ...pending, binding: 'point:11,20' }).error, 'approval_mismatch');
  assert.equal(calls.length, 0);
  approvals.grant(pending);
  assert.equal((await running).ok, true);
});

test('a drag approval carries the destination and rejects a different drop target', async () => {
  const { approvals, executor } = fixture();
  const running = executor.execute(frame('browser_drag', { ref: '@e1', to_ref: '@e2' }), { scope });
  await tick();
  const [pending] = approvals.pending();
  assert.equal(pending.destination, 'button|Send report');
  assert.equal(pending.binding, 'ref:@e1>@e2');
  assert.equal(approvals.grant({ ...pending, destination: 'button|Send message' }).error, 'approval_mismatch');
  approvals.cancelRequest(pending.approvalId);
  await running;
});

test('a key-press approval is bound to a hash of the key, never the key itself', async () => {
  const { approvals, executor, calls } = fixture();
  const running = executor.execute(frame('browser_press', { key: 'Enter' }), { scope });
  await tick();
  const [pending] = approvals.pending();
  assert.match(pending.valueHash, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(pending).includes('"key"'), false);
  const other = approvalBindingFields('browser_press', { key: 'Control+Enter' }, null, null);
  assert.notEqual(other.valueHash, pending.valueHash);
  assert.equal(approvals.grant({ ...pending, valueHash: other.valueHash }).error, 'approval_mismatch');
  assert.equal(calls.length, 0);
  approvals.grant(pending);
  assert.equal((await running).ok, true);
});

test('typed text is fingerprinted with SHA-256 and never stored', () => {
  const target = { ref: '@e5', role: 'textbox', name: 'Comment' };
  const text = 'Thanks — see you at 9:00, café ☕ '.repeat(8);
  const typed = approvalBindingFields('browser_type', { ref: '@e5', text }, target, null);
  const expected = createHash('sha256').update(JSON.stringify(['type', text, null, null])).digest('hex').slice(0, 32);
  assert.equal(typed.valueHash, expected);
  assert.equal(typed.targetRole, 'textbox');
  assert.equal(typed.targetName, 'Comment');
  assert.equal(typed.binding, 'ref:@e5');
  assert.equal(JSON.stringify(typed).includes('Thanks'), false);

  assert.notEqual(approvalBindingFields('browser_type', { ref: '@e5', text: `${text}!` }, target, null).valueHash, typed.valueHash);
  assert.notEqual(approvalBindingFields('browser_type', { ref: '@e5', text, clear: false }, target, null).valueHash, typed.valueHash);
  const filled = approvalBindingFields('browser_fill', { ref: '@e5', value: text }, target, null);
  assert.notEqual(filled.valueHash, typed.valueHash);
  assert.equal(approvalBindingFields('browser_fill', { ref: '@e5', value: text }, target, null).valueHash, filled.valueHash);
  assert.notEqual(approvalBindingFields('browser_fill', { ref: '@e5', value: 'other' }, target, null).valueHash, filled.valueHash);
  assert.notEqual(approvalBindingFields('browser_select', { ref: '@e5', value: 'a' }, target, null).valueHash,
    approvalBindingFields('browser_select', { ref: '@e5', value: 'b' }, target, null).valueHash);
});

test('hashing matches SHA-256 across block boundaries', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1_000]) {
    const text = 'x'.repeat(length);
    const fields = approvalBindingFields('browser_evaluate', { code: text }, null, null);
    const expected = createHash('sha256').update(JSON.stringify(['evaluate', text])).digest('hex').slice(0, 32);
    assert.equal(fields.valueHash, expected, `length ${length}`);
  }
});

test('the approval store keys on target, destination and value fingerprint', () => {
  const approvals = createBrowserControlApprovalStore();
  const base = {
    approvalId: 'a-1',
    approvalNonce: 'n-1',
    commandId: 'c-1',
    controllerId: 'controller-1',
    leaseId: 'lease-1',
    leaseGeneration: 1,
    tabId: 7,
    documentGeneration: 3,
    action: 'browser_click',
    state: 'paused',
    targetRole: 'button',
    targetName: 'Send',
    destination: 'list|Inbox',
    valueHash: 'abc123',
  };
  assert.equal(approvals.grant(base).ok, true);
  for (const field of ['targetRole', 'targetName', 'destination', 'valueHash']) {
    assert.equal(approvals.consume({ ...base, [field]: `${base[field]}x` }).error, 'approval_mismatch', field);
    assert.equal(approvals.consume({ ...base, [field]: '' }).error, 'approval_mismatch', `${field} removed`);
  }
  assert.equal(approvals.consume(base).ok, true);
});

test('a very long label still matches its own approval', async () => {
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  const name = `Send ${'long '.repeat(80)}`;
  refs.replace({ ...scope, nodes: [{ role: 'button', name, backendDOMNodeId: 11 }] });
  let ran = 0;
  const executor = createBrowserControlExecutor({
    adapter: {
      contract: { enabled: true, actions: ['browser_click'] },
      inspect: async () => ({ currentUrl: 'https://example.test/editor', hasUnsavedContent: false }),
      execute: async () => { ran += 1; return { status: 'ok' }; },
    },
    approvals,
    refs,
  });
  const running = executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  await tick();
  assert.equal(approvals.grant(approvals.pending()[0]).ok, true);
  assert.equal((await running).ok, true);
  assert.equal(ran, 1);
});
