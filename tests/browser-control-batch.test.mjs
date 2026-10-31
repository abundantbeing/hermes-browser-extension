import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import test from 'node:test';

import { CHROMIUM_ACTIONS, controllerAdapterContractFor } from '../extension/lib/browser-controller-adapter.mjs';
import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { CONTROLLER_BROWSER_CAPABILITIES, controllerRegistrationFor } from '../extension/lib/controller-protocol.mjs';

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
  { role: 'button', name: 'Send message', backendDOMNodeId: 23 },
  { role: 'textbox', name: 'Password', inputType: 'password', backendDOMNodeId: 24 },
];

const ACTIONS = [
  'browser_batch', 'browser_back', 'browser_click', 'browser_drag', 'browser_fill', 'browser_hover',
  'browser_navigate', 'browser_press', 'browser_scroll', 'browser_scroll_to', 'browser_select',
  'browser_snapshot', 'browser_screenshot', 'browser_tab_create', 'browser_tabs', 'browser_type',
  'browser_evaluate',
];

function batchFrame(args = {}, overrides = {}) {
  return {
    command_id: 'batch-1',
    action: 'browser_batch',
    arguments: args,
    tab_id: scope.tabId,
    frame_id: scope.frameId,
    document_generation: scope.documentGeneration,
    ...overrides,
  };
}

function fixture({
  onExecute = null,
  settle = null,
  inspect = null,
  now = Date.now,
  refsSetup = true,
  adapterOverrides = {},
} = {}) {
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  if (refsSetup) refs.replace({ ...scope, nodes: NODES });
  const calls = [];
  const adapter = {
    contract: { enabled: true, actions: ACTIONS },
    inspect: inspect || (async () => ({ currentUrl: 'https://example.test/start', hasUnsavedContent: false, focused: { role: 'textbox', name: 'Message', inputType: 'text', identity: '0123456789abcdef0123456789abcdef' } })),
    settle: settle || (async () => ({ navigated: false, url: 'https://example.test/start', title: 'Start' })),
    async execute(action, args, context) {
      calls.push({ action, args, scope: context.scope, target: context.target?.name });
      if (action === 'browser_snapshot') {
        return { title: 'Done', url: 'https://example.test/start', text: 'Final page', nodes: NODES };
      }
      if (onExecute) {
        const handled = await onExecute(action, args, context);
        if (handled !== undefined) return handled;
      }
      return { status: 'ok' };
    },
    ...adapterOverrides,
  };
  const executor = createBrowserControlExecutor({ adapter, approvals, refs, now });
  return { approvals, refs, adapter, calls, executor };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const stepActions = (calls) => calls.filter((call) => call.action !== 'browser_snapshot').map((call) => call.action);

test('browser_batch is advertised to the gateway and listed by the Chromium adapter', () => {
  assert.ok(CONTROLLER_BROWSER_CAPABILITIES.includes('browser_batch'));
  assert.ok(CHROMIUM_ACTIONS.includes('browser_batch'));
  const contract = controllerAdapterContractFor({
    product: { id: 'chrome', engine: 'chromium' },
    capabilities: { apis: { debugger: true, tabs: true } },
    controlEnabled: true,
  });
  assert.ok(contract.actions.includes('browser_batch'));
  const registration = controllerRegistrationFor({
    family: 'local-api',
    baseUrl: 'http://127.0.0.1:8642',
    identity: {
      controllerId: 'c-1',
      browserProfileId: 'p-1',
      hermesSessionId: 's-1',
      product: { id: 'chrome', engine: 'chromium', label: 'Chrome' },
      capabilities: ['browser_batch', 'browser_click'],
    },
  });
  assert.ok(registration.payload.capabilities.includes('browser_batch'));
  const firefox = controllerAdapterContractFor({
    product: { id: 'firefox', engine: 'gecko' },
    capabilities: { apis: { scripting: true, tabs: true } },
    controlEnabled: true,
  });
  assert.equal(firefox.actions.includes('browser_batch'), false);
});

test('a batch runs its steps in order, reads the page once and reports per-step status', async () => {
  const { executor, calls } = fixture();
  const result = await executor.execute(batchFrame({
    actions: [
      { action: 'browser_fill', ref: '@e1', value: 'shoes' },
      { action: 'browser_click', ref: '@e2' },
      { action: 'browser_scroll', direction: 'down' },
    ],
  }), { scope });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(stepActions(calls), ['browser_fill', 'browser_click', 'browser_scroll']);
  assert.equal(calls.filter((call) => call.action === 'browser_snapshot').length, 1, 'one snapshot for the whole batch');
  assert.equal(calls.at(-1).action, 'browser_snapshot');
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.completed, 3);
  assert.equal(result.result.remaining, 0);
  assert.deepEqual(result.result.steps, [
    { index: 0, action: 'browser_fill', status: 'filled' },
    { index: 1, action: 'browser_click', status: 'clicked' },
    { index: 2, action: 'browser_scroll', status: 'scrolled' },
  ]);
  assert.match(result.result.snapshot.text, /\[@e2\] button "Go"/);
  assert.match(result.result.snapshot.text, /Final page/);
  assert.equal(result.result.url, 'https://example.test/start');
  // Intermediate steps carry no page content, only their status.
  assert.equal(JSON.stringify(result.result.steps).includes('Final page'), false);
  // The step arguments reach the adapter without the action name.
  assert.deepEqual(calls[0].args, { ref: '@e1', value: 'shoes' });
});

test('every step settles, but the page is only read at the end', async () => {
  let settles = 0;
  const { executor, calls } = fixture({ settle: async () => { settles += 1; return { navigated: false }; } });
  await executor.execute(batchFrame({
    actions: [{ action: 'browser_hover', ref: '@e1' }, { action: 'browser_click', ref: '@e2' }],
  }), { scope });
  assert.equal(settles, 2);
  assert.equal(calls.filter((call) => call.action === 'browser_snapshot').length, 1);
});

test('short action names are accepted and nested or unsafe steps are rejected before anything runs', async () => {
  const { executor, calls } = fixture();
  const short = await executor.execute(batchFrame({ actions: [{ action: 'scroll', direction: 'down' }] }), { scope });
  assert.equal(short.result.steps[0].action, 'browser_scroll');

  const before = calls.length;
  const disallowed = [
    'browser_batch', 'browser_snapshot', 'browser_screenshot', 'browser_tab_create', 'browser_tabs', 'browser_evaluate',
  ];
  for (const action of disallowed) {
    const rejected = await executor.execute(batchFrame({
      actions: [{ action: 'browser_scroll', direction: 'down' }, { action, url: 'https://example.test/x' }],
    }), { scope });
    assert.equal(rejected.ok, false, action);
    assert.equal(rejected.error.code, 'batch_action_not_allowed', action);
    assert.match(rejected.error.message, /Step 2/);
  }
  assert.equal(calls.length, before, 'a rejected batch performs no step, not even the valid ones');
});

test('a batch needs one to twenty well-formed steps', async () => {
  const { executor, calls } = fixture();
  const step = { action: 'browser_scroll', direction: 'down' };
  for (const actions of [undefined, [], 'click', [null], [[]], [{ ref: '@e1' }]]) {
    const result = await executor.execute(batchFrame({ actions }), { scope });
    assert.equal(result.ok, false);
    assert.match(result.error.code, /^(invalid_batch|batch_action_not_allowed)$/);
  }
  const tooMany = await executor.execute(batchFrame({ actions: Array.from({ length: 21 }, () => step) }), { scope });
  assert.equal(tooMany.error.code, 'batch_too_large');
  const exactly = await executor.execute(batchFrame({ actions: Array.from({ length: 20 }, () => step) }), { scope });
  assert.equal(exactly.ok, true);
  assert.equal(exactly.result.completed, 20);
  assert.equal(stepActions(calls).length, 20);
});

test('a step the adapter does not implement is refused before the batch starts', async () => {
  const { executor, calls, adapter } = fixture();
  adapter.contract = { enabled: true, actions: ['browser_batch', 'browser_snapshot', 'browser_scroll'] };
  const result = await executor.execute(batchFrame({
    actions: [{ action: 'browser_scroll', direction: 'down' }, { action: 'browser_click', ref: '@e1' }],
  }), { scope });
  assert.equal(result.error.code, 'unsupported_action');
  assert.equal(calls.length, 0);
});

test('without browser_batch in the adapter contract the command is unsupported', async () => {
  const { executor, adapter } = fixture();
  adapter.contract = { enabled: true, actions: ['browser_scroll', 'browser_snapshot'] };
  const result = await executor.execute(batchFrame({ actions: [{ action: 'browser_scroll' }] }), { scope });
  assert.equal(result.error.code, 'unsupported_action');
});

test('stop_on_error defaults to true and reports what was left undone', async () => {
  const { executor, calls } = fixture({
    onExecute: (action) => {
      if (action === 'browser_click') throw Object.assign(new Error('That element is gone'), { code: 'stale_ref' });
      return undefined;
    },
  });
  const result = await executor.execute(batchFrame({
    actions: [
      { action: 'browser_hover', ref: '@e1' },
      { action: 'browser_click', ref: '@e2' },
      { action: 'browser_scroll', direction: 'down' },
    ],
  }), { scope });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'stopped');
  assert.equal(result.result.stopped_reason, 'stale_ref');
  assert.equal(result.result.completed, 1);
  assert.equal(result.result.remaining, 1);
  assert.deepEqual(result.result.steps.map((entry) => [entry.action, entry.status || entry.error]), [
    ['browser_hover', 'hovered'],
    ['browser_click', 'stale_ref'],
  ]);
  assert.deepEqual(stepActions(calls), ['browser_hover', 'browser_click']);
  assert.ok(result.result.snapshot, 'the page is still read so the model can recover');
});

test('stop_on_error false carries on past a failed step', async () => {
  const { executor, calls } = fixture({
    onExecute: (action) => {
      if (action === 'browser_click') throw Object.assign(new Error('That element is gone'), { code: 'stale_ref' });
      return undefined;
    },
  });
  const result = await executor.execute(batchFrame({
    stop_on_error: false,
    actions: [
      { action: 'browser_click', ref: '@e2' },
      { action: 'browser_scroll', direction: 'down' },
    ],
  }), { scope });
  assert.equal(result.result.status, 'completed_with_errors');
  assert.equal(result.result.completed, 1);
  assert.equal(result.result.remaining, 0);
  assert.equal(result.result.steps[0].error, 'stale_ref');
  assert.equal(result.result.steps[1].status, 'scrolled');
  assert.deepEqual(stepActions(calls), ['browser_click', 'browser_scroll']);
});

test('each step is classified like a standalone command, so blocked input never reaches the page', async () => {
  const { executor, calls } = fixture();
  const stopped = await executor.execute(batchFrame({
    actions: [
      { action: 'browser_type', ref: '@e4', text: 'hunter2' },
      { action: 'browser_scroll', direction: 'down' },
    ],
  }), { scope });
  assert.equal(stopped.result.steps[0].error, 'sensitive_action_blocked');
  assert.equal(stopped.result.remaining, 1);
  assert.deepEqual(stepActions(calls), []);

  const continued = await executor.execute(batchFrame({
    stop_on_error: false,
    actions: [
      { action: 'browser_type', ref: '@e4', text: 'hunter2' },
      { action: 'browser_type', ref: '@e1', text: 'api_key=abcdef123456' },
      { action: 'browser_navigate', url: 'chrome://settings' },
      { action: 'browser_type', ref: '@e1', text: 'shoes' },
    ],
  }), { scope });
  assert.deepEqual(continued.result.steps.map((entry) => entry.status || entry.error), [
    'sensitive_action_blocked', 'sensitive_action_blocked', 'sensitive_action_blocked', 'typed',
  ]);
  assert.deepEqual(stepActions(calls), ['browser_type']);
  assert.equal(calls.find((call) => call.action === 'browser_type').args.text, 'shoes');
});

test('an unknown ref fails its own step, not the whole command', async () => {
  const { executor } = fixture();
  const result = await executor.execute(batchFrame({
    stop_on_error: false,
    actions: [{ action: 'browser_click', ref: '@e99' }, { action: 'browser_scroll' }],
  }), { scope });
  assert.equal(result.ok, true);
  assert.equal(result.result.steps[0].error, 'unknown_ref');
  assert.equal(result.result.steps[1].status, 'scrolled');
});

test('a step that needs approval pauses the batch for that approval and then continues', async () => {
  const { approvals, executor, calls } = fixture();
  let settled = false;
  const running = executor.execute(batchFrame({
    actions: [
      { action: 'browser_hover', ref: '@e1' },
      { action: 'browser_click', ref: '@e3' },
      { action: 'browser_scroll', direction: 'down' },
    ],
  }), { scope }).then((value) => { settled = true; return value; });
  await tick();
  await tick();

  assert.equal(settled, false);
  assert.deepEqual(stepActions(calls), ['browser_hover'], 'the step after the approval has not started');
  const [pending] = approvals.pending();
  assert.equal(pending.action, 'browser_click');
  assert.equal(pending.commandId, 'batch-1');
  assert.equal(pending.approvalId, 'batch-1:step-2');
  assert.equal(pending.targetName, 'Send message');
  assert.match(pending.reason, /^Step 2 of 3: /);

  assert.equal(approvals.grant(pending).ok, true);
  const result = await running;
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.completed, 3);
  assert.deepEqual(stepActions(calls), ['browser_hover', 'browser_click', 'browser_scroll']);
  assert.deepEqual(approvals.pending(), []);
});

test('each approval-gated step asks on its own and an approval is spent once', async () => {
  const { approvals, executor, calls } = fixture();
  const running = executor.execute(batchFrame({
    actions: [{ action: 'browser_click', ref: '@e3' }, { action: 'browser_press', key: 'Enter' }],
  }), { scope });
  await tick();
  const first = approvals.pending()[0];
  assert.equal(first.approvalId, 'batch-1:step-1');
  approvals.grant(first);
  await tick();
  await tick();
  const second = approvals.pending()[0];
  assert.equal(second.approvalId, 'batch-1:step-2');
  assert.notEqual(second.approvalNonce, first.approvalNonce);
  // The first approval cannot be replayed for the second step.
  assert.equal(approvals.grant({ ...first, approvalId: second.approvalId }).ok, false);
  assert.equal(stepActions(calls).length, 1);
  approvals.grant(second);
  const result = await running;
  assert.equal(result.result.completed, 2);
});

test('denying an approval stops the batch even when stop_on_error is off', async () => {
  const { approvals, executor, calls } = fixture();
  const running = executor.execute(batchFrame({
    stop_on_error: false,
    actions: [
      { action: 'browser_hover', ref: '@e1' },
      { action: 'browser_click', ref: '@e3' },
      { action: 'browser_scroll', direction: 'down' },
    ],
  }), { scope });
  await tick();
  await tick();
  approvals.cancelRequest(approvals.pending()[0].approvalId, 'approval_denied');
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'stopped');
  assert.equal(result.result.stopped_reason, 'approval_denied');
  assert.equal(result.result.completed, 1);
  assert.equal(result.result.remaining, 1);
  assert.equal(result.result.steps[1].error, 'approval_denied');
  assert.deepEqual(stepActions(calls), ['browser_hover']);
});

test('the origin is re-checked after an approval wait inside a batch', async () => {
  let inspections = 0;
  const { approvals, executor, calls } = fixture({
    inspect: async () => ({
      currentUrl: inspections++ === 0 ? 'https://example.test/editor' : 'https://other.test/replaced',
      hasUnsavedContent: false,
    }),
  });
  const running = executor.execute(batchFrame({
    stop_on_error: false,
    actions: [{ action: 'browser_click', ref: '@e3' }, { action: 'browser_scroll', direction: 'down' }],
  }), { scope });
  await tick();
  approvals.grant(approvals.pending()[0]);
  const result = await running;
  assert.equal(result.result.steps[0].error, 'domain_changed');
  assert.equal(result.result.stopped_reason, 'domain_changed');
  assert.equal(result.result.remaining, 1);
  assert.deepEqual(stepActions(calls), []);
});

test('a restricted page stops the next step and is never described by the closing snapshot', async () => {
  let url = 'https://example.test/start';
  const { executor, calls } = fixture({
    settle: async () => ({ navigated: true, url, title: 'Secret settings' }),
    inspect: async () => ({ currentUrl: url, hasUnsavedContent: false }),
    onExecute: (action) => {
      if (action === 'browser_click') url = 'chrome://settings/passwords';
      return undefined;
    },
  });
  const result = await executor.execute(batchFrame({
    stop_on_error: false,
    actions: [{ action: 'browser_click', ref: '@e2' }, { action: 'browser_scroll', direction: 'down' }],
  }), { scope });
  assert.equal(result.result.steps[1].error, 'sensitive_action_blocked');
  assert.equal(result.result.snapshot, undefined);
  assert.equal(result.result.snapshot_error, 'restricted_page');
  assert.equal(JSON.stringify(result).includes('Secret settings'), false);
  assert.equal(calls.filter((call) => call.action === 'browser_snapshot').length, 0);
});

test('steps after a navigation run under the new document generation and old refs stop working', async () => {
  let generation = 3;
  const { executor, calls } = fixture({
    settle: async () => ({ navigated: generation > 3, url: 'https://example.test/next', title: 'Next' }),
    onExecute: (action) => {
      if (action === 'browser_click') generation = 4;
      return undefined;
    },
  });
  const result = await executor.execute(batchFrame({
    stop_on_error: false,
    actions: [
      { action: 'browser_click', ref: '@e2' },
      { action: 'browser_click', ref: '@e1' },
      { action: 'browser_scroll', direction: 'down' },
    ],
  }), { scope, currentDocumentGeneration: () => generation });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.navigated, true);
  assert.equal(result.result.steps[0].status, 'clicked');
  assert.match(result.result.steps[1].error, /^(stale_ref_scope|unknown_ref)$/, 'refs of the old page are gone');
  assert.equal(result.result.steps[2].status, 'scrolled');
  const scroll = calls.find((call) => call.action === 'browser_scroll');
  assert.equal(scroll.scope.documentGeneration, 4);
});

async function waitForPending(approvals, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const [pending] = approvals.pending();
    if (pending) return pending;
    await tick();
  }
  assert.fail('no approval was requested');
  return null;
}

test('a click that needs approval after a navigation in the same batch asks under the new document generation', async () => {
  let generation = 3;
  const { approvals, executor, calls } = fixture({
    settle: async () => ({ navigated: generation > 3, url: 'https://example.test/next', title: 'Next' }),
    onExecute: (action) => {
      if (action === 'browser_navigate') generation = 4;
      return undefined;
    },
  });
  const running = executor.execute(batchFrame({
    actions: [
      { action: 'browser_navigate', url: 'https://example.test/next' },
      { action: 'browser_click', x: 120, y: 240 },
    ],
  }), { scope, currentDocumentGeneration: () => generation });
  // The click waits for the person. Its request names the document the click will run on,
  // which the navigation moved on from the generation the command arrived with.
  const pending = await waitForPending(approvals);
  assert.equal(pending.action, 'browser_click');
  assert.equal(pending.approvalId, 'batch-1:step-2');
  assert.equal(pending.documentGeneration, 4);
  assert.equal(pending.tabId, scope.tabId);
  assert.equal(pending.leaseId, scope.leaseId);
  assert.equal(approvals.grant(pending).ok, true);
  const result = await running;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.status, 'completed');
  assert.equal(result.result.completed, 2);
  assert.deepEqual(stepActions(calls), ['browser_navigate', 'browser_click']);
});

test('a document that moves without the batch causing it ends the batch', async () => {
  let generation = 3;
  const { executor, calls } = fixture({
    onExecute: (action) => {
      if (action === 'browser_hover') generation = 5;
      return undefined;
    },
  });
  const result = await executor.execute(batchFrame({
    stop_on_error: false,
    actions: [{ action: 'browser_hover', ref: '@e1' }, { action: 'browser_click', ref: '@e2' }],
  }), { scope, currentDocumentGeneration: () => generation });
  assert.equal(result.result.stopped_reason, 'stale_document');
  assert.equal(result.result.completed, 1);
  assert.equal(result.result.remaining, 1);
  assert.equal(result.result.steps.length, 1);
  assert.deepEqual(stepActions(calls), ['browser_hover']);
});

test('the batch stops starting steps when the 28 second command budget runs out', async () => {
  let clock = 1_000_000;
  const { executor, calls } = fixture({
    now: () => clock,
    onExecute: () => { clock += 10_000; return undefined; },
  });
  const result = await executor.execute(batchFrame({
    actions: Array.from({ length: 6 }, () => ({ action: 'browser_scroll', direction: 'down' })),
  }, { deadline_at: clock + 60_000 }), { scope });
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'stopped');
  assert.equal(result.result.stopped_reason, 'budget_exhausted');
  assert.equal(result.result.completed, 3);
  assert.equal(result.result.remaining, 3);
  assert.equal(stepActions(calls).length, 3);
  assert.equal(result.result.snapshot_error, 'deadline_near');
});

test('a step that waits too long for approval times out on its own and keeps earlier results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
  let clock = 1_000_000;
  const { approvals, executor, calls } = fixture({ now: () => clock });
  const running = executor.execute(batchFrame({
    actions: [
      { action: 'browser_hover', ref: '@e1' },
      { action: 'browser_click', ref: '@e3' },
      { action: 'browser_scroll', direction: 'down' },
    ],
  }, { deadline_at: clock + 60_000 }), { scope });
  await flush();
  assert.equal(approvals.pending().length, 1);

  clock += 28_000;
  t.mock.timers.tick(28_000);
  const outcome = await running;
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.result.stopped_reason, 'approval_timeout');
  assert.equal(outcome.result.completed, 1);
  assert.equal(outcome.result.remaining, 1);
  assert.deepEqual(outcome.result.steps.map((entry) => entry.status || entry.error), ['hovered', 'approval_timeout']);
  assert.deepEqual(stepActions(calls), ['browser_hover']);
  assert.deepEqual(approvals.pending(), []);
});

test('a deadline that ends the whole command still says how far the batch got', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const clock = 1_000_000;
  const { executor } = fixture({
    now: () => clock,
    onExecute: (action) => (action === 'browser_click' ? new Promise(() => {}) : undefined),
  });
  const running = executor.execute(batchFrame({
    actions: [{ action: 'browser_hover', ref: '@e1' }, { action: 'browser_click', ref: '@e2' }],
  }, { deadline_at: clock + 20_000 }), { scope });
  await flush();
  t.mock.timers.tick(20_000);
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'deadline_exceeded');
  assert.match(result.error.message, /1 of 2 steps had completed/);
});

test('cancelling a running batch stops it before the next step', async () => {
  const controller = new AbortController();
  const { executor, calls } = fixture({
    onExecute: (action) => {
      if (action === 'browser_hover') controller.abort(new Error('stop'));
      return undefined;
    },
  });
  const result = await executor.execute(batchFrame({
    actions: [{ action: 'browser_hover', ref: '@e1' }, { action: 'browser_click', ref: '@e2' }],
  }), { scope, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'cancelled');
  assert.deepEqual(stepActions(calls), ['browser_hover']);
});

test('a batch result never carries typed text or raw backend ids', async () => {
  const { executor } = fixture();
  const result = await executor.execute(batchFrame({
    actions: [{ action: 'browser_type', ref: '@e1', text: 'my private search' }],
  }), { scope });
  const text = JSON.stringify(result);
  assert.equal(text.includes('my private search'), false);
  assert.doesNotMatch(text, /backendDOMNodeId/);
});
