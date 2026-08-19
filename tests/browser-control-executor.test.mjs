import assert from 'node:assert/strict';
import test from 'node:test';

import { createControllerLifecycle } from '../extension/lib/controller-lifecycle.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';

async function executorModule() {
  try {
    return await import('../extension/lib/browser-control-executor.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser-control executor module is required: ${error?.message || error}`);
  }
}

const scope = Object.freeze({
  controllerId: 'controller-1',
  leaseOwnerId: 'controller-1',
  leaseId: 'lease-1',
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

function fullAdapter(execute) {
  return {
    contract: {
      enabled: true,
      actions: [
        'browser_back', 'browser_click', 'browser_navigate', 'browser_press',
        'browser_screenshot', 'browser_scroll', 'browser_snapshot',
        'browser_tab_activate', 'browser_tabs', 'browser_type',
      ],
    },
    inspect: async () => ({ currentUrl: 'https://example.test/start', hasUnsavedContent: false }),
    execute,
  };
}

test('Phase 6 rejects expired, unsupported, and mismatched-scope commands before adapter side effects', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  let calls = 0;
  const executor = createBrowserControlExecutor({
    adapter: fullAdapter(async () => { calls += 1; return { ok: true }; }),
    approvals: createBrowserControlApprovalStore(),
    refs: createBrowserControlRefStore(),
    now: () => 5_000,
  });

  assert.equal((await executor.execute(frame('browser_navigate', { url: 'https://example.test/next' }, { deadline_at: 4_999 }), { scope })).error.code, 'deadline_expired');
  assert.equal((await executor.execute(frame('browser_evaluate', { expression: '1+1' }), { scope })).error.code, 'unsupported_action');
  assert.equal((await executor.execute(frame('browser_scroll', { direction: 'down' }), { scope: { ...scope, tabId: 8 } })).error.code, 'scope_mismatch');
  assert.equal(calls, 0);
});

test('Phase 6 snapshots mint scoped refs and return useful content without raw backend ids', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const refs = createBrowserControlRefStore();
  const executor = createBrowserControlExecutor({
    adapter: fullAdapter(async (action) => {
      assert.equal(action, 'browser_snapshot');
      return {
        title: 'Example',
        url: 'https://example.test/start',
        text: 'Public page summary',
        nodes: [
          { role: 'button', name: 'Search', backendDOMNodeId: 44 },
          { role: 'textbox', name: 'Password', inputType: 'password', backendDOMNodeId: 45 },
        ],
      };
    }),
    approvals: createBrowserControlApprovalStore(),
    refs,
    now: () => 5_000,
  });

  const result = await executor.execute(frame('browser_snapshot'), { scope });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.refs.map((item) => item.ref), ['@e1', '@e2']);
  assert.equal(result.result.text, 'Public page summary');
  assert.equal(result.result.refs[1].name, 'Sensitive field');
  assert.doesNotMatch(JSON.stringify(result), /backendDOMNodeId|\b44\b|\b45\b/);
  assert.equal(refs.resolve({ ...scope, ref: '@e1' }).target.backendDOMNodeId, 44);
});

test('Phase 6 blocks sensitive typing and requires one exact approval before consequential input', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const approvals = createBrowserControlApprovalStore({ now: () => 5_000 });
  const refs = createBrowserControlRefStore();
  refs.replace({
    ...scope,
    nodes: [
      { role: 'textbox', name: 'Password', inputType: 'password', backendDOMNodeId: 45 },
      { role: 'button', name: 'Send message', backendDOMNodeId: 46 },
    ],
  });
  let calls = 0;
  const executor = createBrowserControlExecutor({
    adapter: fullAdapter(async () => { calls += 1; return { completed: true }; }),
    approvals,
    refs,
    now: () => 5_000,
  });

  const blocked = await executor.execute(frame('browser_type', { ref: '@e1', text: 'fixture text' }), { scope });
  assert.equal(blocked.error.code, 'sensitive_action_blocked');
  assert.equal(calls, 0);

  let settled = false;
  const pending = executor.execute(frame('browser_click', { ref: '@e2' }), { scope })
    .then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  assert.equal(calls, 0);
  assert.deepEqual(approvals.pending().map((item) => item.approvalId), ['command-1']);

  approvals.grant(approvals.pending()[0]);
  const approved = await pending;
  assert.equal(approved.ok, true);
  assert.equal(calls, 1);

  const reused = await executor.execute(frame('browser_click', { ref: '@e2' }, { approval_id: 'command-1' }), { scope });
  assert.equal(calls, 1);
  assert.equal(reused.error.code, 'approval_replayed');
});

test('Phase 6 deadline and cancellation abort the adapter and never surface late success', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  let observedAbort = false;
  let sideEffects = 0;
  const adapter = fullAdapter((_action, _args, { signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      observedAbort = true;
      resolve({ late: true });
    }, { once: true });
    setTimeout(() => {
      if (!signal.aborted) sideEffects += 1;
      resolve({ late: true });
    }, 40);
  }));
  const executor = createBrowserControlExecutor({
    adapter,
    approvals: createBrowserControlApprovalStore(),
    refs: createBrowserControlRefStore(),
    now: Date.now,
    defaultDeadlineMs: 10,
  });

  const timedOut = await executor.execute(frame('browser_scroll', { direction: 'down' }), { scope });
  assert.equal(timedOut.error.code, 'deadline_exceeded');
  assert.equal(observedAbort, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sideEffects, 0);

  const cancellation = new AbortController();
  const pending = executor.execute(frame('browser_scroll', { direction: 'down' }, { command_id: 'command-2' }), { scope, signal: cancellation.signal });
  cancellation.abort(new Error('cancelled by caller'));
  assert.equal((await pending).error.code, 'cancelled');
});

test('Phase 6 revalidates the page origin immediately before an approved mutation', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Send message', backendDOMNodeId: 46 }] });
  let inspections = 0;
  let sideEffects = 0;
  const adapter = fullAdapter(async () => { sideEffects += 1; return { status: 'clicked' }; });
  adapter.inspect = async () => ({
    currentUrl: inspections++ === 0
      ? 'https://example.test/editor'
      : 'https://other.test/replaced',
    hasUnsavedContent: false,
  });
  const executor = createBrowserControlExecutor({ adapter, approvals, refs });
  const running = executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  await new Promise((resolve) => setTimeout(resolve, 0));
  approvals.grant(approvals.pending()[0]);
  assert.deepEqual(await running, {
    ok: false,
    error: { code: 'domain_changed', message: 'The page origin changed before the action could run.' },
  });
  assert.equal(sideEffects, 0);
});

test('Phase 8 approved local documents pass origin revalidation on the same file', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Enlarge image', backendDOMNodeId: 46 }] });
  let sideEffects = 0;
  const adapter = fullAdapter(async () => { sideEffects += 1; return { status: 'clicked' }; });
  adapter.inspect = async () => ({
    currentUrl: 'file:///D:/Hermes/bangkok-hermes-events-deck.html',
    hasUnsavedContent: false,
  });
  const executor = createBrowserControlExecutor({ adapter, approvals, refs });
  const running = executor.execute(
    frame('browser_click', { ref: '@e1' }),
    { scope, allowLocalDocuments: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  approvals.grant(approvals.pending()[0]);
  assert.equal((await running).error, undefined);
  assert.equal(sideEffects, 1);
});

test('Phase 8 navigating to a different local file still trips domain_changed', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Enlarge image', backendDOMNodeId: 46 }] });
  let sideEffects = 0;
  let inspections = 0;
  const adapter = fullAdapter(async () => { sideEffects += 1; return { status: 'clicked' }; });
  adapter.inspect = async () => ({
    currentUrl: inspections++ === 0
      ? 'file:///D:/Hermes/bangkok-hermes-events-deck.html'
      : 'file:///D:/Hermes/other-deck.html',
    hasUnsavedContent: false,
  });
  const executor = createBrowserControlExecutor({ adapter, approvals, refs });
  const running = executor.execute(
    frame('browser_click', { ref: '@e1' }),
    { scope, allowLocalDocuments: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  approvals.grant(approvals.pending()[0]);
  assert.deepEqual(await running, {
    ok: false,
    error: { code: 'domain_changed', message: 'The page origin changed before the action could run.' },
  });
  assert.equal(sideEffects, 0);
});

test('Phase 6 lifecycle terminal receipts never echo command arguments or typed text', async () => {
  const terminals = [];
  const lifecycle = createControllerLifecycle({
    execute: async () => ({ ok: true, result: { status: 'typed' } }),
    onTerminal: (terminal) => terminals.push(terminal.params),
  });
  lifecycle.enqueueCommand({
    tabId: 7,
    frame: frame('browser_type', { ref: '@e1', text: 'must-not-persist' }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(terminals.length, 1);
  assert.equal('arguments' in terminals[0], false);
  assert.doesNotMatch(JSON.stringify(terminals[0]), /must-not-persist/);
});

test('Phase 6 advertised screenshot and tab actions stay inside worker-owned leased tabs', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const calls = [];
  const executor = createBrowserControlExecutor({
    adapter: fullAdapter(async (action, args, context) => {
      calls.push({ action, args, scope: context.scope, leasedTabIds: context.leasedTabIds });
      if (action === 'browser_tabs') return { tabs: [{ id: 7 }, { id: 8 }, { id: 99 }] };
      if (action === 'browser_screenshot') return { dataUrl: 'data:image/png;base64,fixture' };
      return { status: 'tab-activated' };
    }),
    approvals: createBrowserControlApprovalStore(),
    refs: createBrowserControlRefStore(),
    now: () => 5_000,
  });

  const tabs = await executor.execute(frame('browser_tabs'), { scope, leasedTabIds: [7, 8] });
  assert.deepEqual(tabs.result.tabs.map((tab) => tab.id), [7, 8]);
  const screenshot = await executor.execute(frame('browser_screenshot'), { scope, leasedTabIds: [7, 8] });
  assert.equal(screenshot.ok, true);
  assert.equal((await executor.execute(frame('browser_tab_activate', { tab_id: 99 }), { scope, leasedTabIds: [7, 8] })).error.code, 'lease_required');
  assert.equal((await executor.execute(frame('browser_tab_activate', { tab_id: 8 }), { scope, leasedTabIds: [7, 8] })).ok, true);
  assert.deepEqual(calls.map((call) => [call.action, call.scope.tabId, call.args.tab_id ?? null]), [
    ['browser_tabs', 7, null],
    ['browser_screenshot', 7, null],
    ['browser_tab_activate', 8, 8],
  ]);
});

test('Phase 6 tab mutations require exact owned tabs and return sanitized metadata', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const calls = [];
  const adapter = fullAdapter(async (action, args, context) => {
    calls.push({ action, args, context });
    if (action === 'browser_tab_create') return { tab: { id: 9, windowId: 4, active: false, url: args.url, title: 'Private' } };
    return { status: action };
  });
  adapter.contract.actions.push('browser_tab_create', 'browser_tab_close', 'browser_tab_group', 'browser_tab_ungroup');
  const approvals = createBrowserControlApprovalStore();
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore() });

  const created = await executor.execute(frame('browser_tab_create', { url: 'https://example.test/new', active: false }), {
    scope,
    leasedTabIds: [7, 8],
    ownedTabIds: [7, 8],
    currentWindowId: 4,
  });
  assert.deepEqual(created, { ok: true, result: { tab: { id: 9, windowId: 4, active: false, url: 'https://example.test/new' } } });
  assert.equal((await executor.execute(frame('browser_tab_close', { tab_id: 99 }), {
    scope, leasedTabIds: [7, 8, 99], ownedTabIds: [7, 8], currentWindowId: 4,
  })).error.code, 'lease_not_owned');
  assert.equal((await executor.execute(frame('browser_tab_group', { tab_ids: [7, 99] }), {
    scope, leasedTabIds: [7, 8, 99], ownedTabIds: [7, 8], currentWindowId: 4,
  })).error.code, 'lease_not_owned');

  const closing = executor.execute(frame('browser_tab_close', { tab_id: 8 }, { command_id: 'close-8' }), {
    scope, leasedTabIds: [7, 8], ownedTabIds: [7, 8], currentWindowId: 4,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  approvals.grant(approvals.pending()[0]);
  assert.equal((await closing).ok, true);
  assert.deepEqual(calls.map((call) => [call.action, call.context.ownedTabIds, call.context.currentWindowId]), [
    ['browser_tab_create', [7, 8], 4],
    ['browser_tab_close', [7, 8], 4],
  ]);
});

test('Phase 6 executor rejects an adapter that bypasses the screenshot transport cap', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const executor = createBrowserControlExecutor({
    adapter: fullAdapter(async () => ({ dataUrl: `data:image/png;base64,${'A'.repeat(1_500_001)}` })),
    approvals: createBrowserControlApprovalStore(),
    refs: createBrowserControlRefStore(),
    now: () => 5_000,
  });
  const result = await executor.execute(frame('browser_screenshot'), { scope, leasedTabIds: [7] });
  assert.deepEqual(result, { ok: false, error: { code: 'screenshot_too_large', message: 'The screenshot exceeds the inline Phase 6 transport cap.' } });
});
