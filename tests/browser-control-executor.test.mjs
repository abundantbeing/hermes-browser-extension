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

// Mutating actions now read the page afterwards; tests that count side effects
// only want the action itself, so the follow-up snapshot gets an empty page.
function sideEffectAdapter(effect, nodes = []) {
  return fullAdapter(async (action, ...rest) => {
    if (action === 'browser_snapshot') return { title: 'After', url: 'https://example.test/start', text: '', nodes };
    return effect(action, ...rest);
  });
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
  assert.equal(result.result.text, '[@e1] button "Search"\n[@e2] textbox "Sensitive field"\n\nPublic page summary');
  assert.equal(result.result.element_count, 2);
  assert.equal(result.result.truncated, false);
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
    adapter: sideEffectAdapter(async () => { calls += 1; return { completed: true }; }, [
      { role: 'textbox', name: 'Password', inputType: 'password', backendDOMNodeId: 45 },
      { role: 'button', name: 'Send message', backendDOMNodeId: 46 },
    ]),
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
  const adapter = sideEffectAdapter(async () => { sideEffects += 1; return { status: 'clicked' }; });
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
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Send deck', backendDOMNodeId: 46 }] });
  let sideEffects = 0;
  const adapter = sideEffectAdapter(async () => { sideEffects += 1; return { status: 'clicked' }; });
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
  // The origin is only re-checked after a human approval wait, so the click
  // must be one that needs approval.
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Send deck', backendDOMNodeId: 46 }] });
  let sideEffects = 0;
  let inspections = 0;
  const adapter = sideEffectAdapter(async () => { sideEffects += 1; return { status: 'clicked' }; });
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
  const approvals = createBrowserControlApprovalStore();
  const executor = createBrowserControlExecutor({
    adapter: fullAdapter(async (action, args, context) => {
      calls.push({ action, args, scope: context.scope, leasedTabIds: context.leasedTabIds });
      if (action === 'browser_tabs') return { tabs: [{ id: 7 }, { id: 8 }, { id: 99 }] };
      if (action === 'browser_screenshot') return { dataUrl: 'data:image/png;base64,fixture' };
      return { status: 'tab-activated' };
    }),
    approvals,
    refs: createBrowserControlRefStore(),
    now: () => 5_000,
  });

  const tabs = await executor.execute(frame('browser_tabs'), { scope, leasedTabIds: [7, 8] });
  assert.deepEqual(tabs.result.tabs.map((tab) => tab.id), [7, 8]);
  const screenshot = await executor.execute(frame('browser_screenshot'), { scope, leasedTabIds: [7, 8] });
  assert.equal(screenshot.ok, true);
  assert.equal((await executor.execute(frame('browser_tab_activate', { tab_id: 99 }), { scope, leasedTabIds: [7, 8] })).error.code, 'lease_required');
  // Switching the person's tab waits for their approval; nothing moves before it is granted.
  const activating = executor.execute(frame('browser_tab_activate', { tab_id: 8 }, { command_id: 'activate-8' }), { scope, leasedTabIds: [7, 8] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // This fake tab has no title, so the card names its host.
  assert.deepEqual(approvals.pending().map((item) => [item.action, item.reason]), [['browser_tab_activate', 'Switch your view to "example.test"?']]);
  // The approval belongs to the command's own tab and lease, which the worker checks on the grant.
  assert.equal(approvals.pending()[0].tabId, 7);
  assert.equal(approvals.pending()[0].leaseId, 'lease-1');
  assert.equal(calls.some((call) => call.action === 'browser_tab_activate'), false);
  approvals.grant(approvals.pending()[0]);
  assert.equal((await activating).ok, true);
  assert.deepEqual(calls.map((call) => [call.action, call.scope.tabId, call.args.tab_id ?? null]), [
    ['browser_tabs', 7, null],
    ['browser_screenshot', 7, null],
    ['browser_tab_activate', 8, 8],
  ]);
});

test('a close names the tab it closes, and its approval cannot be spent on a different tab', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const calls = [];
  const approvals = createBrowserControlApprovalStore();
  const titles = new Map([[7, 'Command tab'], [8, 'Quarterly report']]);
  const adapter = fullAdapter(async (action, args) => {
    calls.push({ action, tabId: args.tab_id ?? null });
    return { status: 'tab-closed' };
  });
  adapter.contract.actions.push('browser_tab_close');
  adapter.inspect = async ({ tabId }) => ({ currentUrl: 'https://example.test/start', hasUnsavedContent: false, title: titles.get(tabId) || '' });
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore(), now: () => 5_000 });

  // The command rides on tab 7 and closes tab 8: the card says which tab goes.
  const closing = executor.execute(frame('browser_tab_close', { tab_id: 8 }, { command_id: 'close-8' }), {
    scope, leasedTabIds: [7, 8], ownedTabIds: [7, 8],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [pending] = approvals.pending();
  assert.equal(pending.reason, 'Close the tab "Quarterly report"?');
  assert.equal(pending.binding, 'tab:8');
  assert.equal(approvals.grant({ ...pending, binding: 'tab:9' }).ok, false);
  assert.deepEqual(calls, [], 'nothing closes before the grant');
  approvals.grant(pending);
  assert.equal((await closing).ok, true);
  assert.deepEqual(calls, [{ action: 'browser_tab_close', tabId: 8 }]);
});

test('a tab switch names the tab it switches to, and its approval cannot be spent on a different tab', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const calls = [];
  const approvals = createBrowserControlApprovalStore();
  const titles = new Map([
    [7, 'Command tab'],
    [8, 'Quarterly planning for the whole product team and every partner who uses it'],
  ]);
  const adapter = fullAdapter(async (action, args) => {
    calls.push({ action, tabId: args.tab_id ?? null });
    return { status: 'tab-activated' };
  });
  adapter.inspect = async ({ tabId }) => ({ currentUrl: 'https://example.test/start', hasUnsavedContent: false, title: titles.get(tabId) || '' });
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore(), now: () => 5_000 });

  // The command runs on tab 7 and asks to switch the person to tab 8.
  const activating = executor.execute(frame('browser_tab_activate', { tab_id: 8 }, { command_id: 'activate-8' }), { scope, leasedTabIds: [7, 8] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [pending] = approvals.pending();
  // The card names the target (cut to 60 characters), and the request is bound to it.
  assert.equal(pending.reason, 'Switch your view to "Quarterly planning for the whole product team and every par…"?');
  assert.equal(pending.binding, 'tab:8');
  // The approval still belongs to the command's own tab and lease, which the worker checks on the grant.
  assert.equal(pending.tabId, 7);
  assert.equal(pending.leaseId, 'lease-1');
  assert.deepEqual(calls, [], 'nothing moves before the grant');

  // A grant that names another tab does not release this request.
  assert.equal(approvals.grant({ ...pending, binding: 'tab:9' }).ok, false);
  assert.equal(approvals.grant(pending).ok, true);
  // Once granted, the approval matches tab 8 only.
  assert.equal(approvals.consume({ ...pending, binding: 'tab:9' }).error, 'approval_mismatch');
  assert.equal((await activating).ok, true);
  assert.deepEqual(calls, [{ action: 'browser_tab_activate', tabId: 8 }]);
});

// Starts a tab switch to tab 8, whose inspect answers with the given tab facts, and returns the approval card's reason.
async function tabSwitchReasonFor(info) {
  const { createBrowserControlExecutor } = await executorModule();
  const approvals = createBrowserControlApprovalStore();
  const adapter = fullAdapter(async () => ({ status: 'tab-activated' }));
  adapter.inspect = async () => info;
  const executor = createBrowserControlExecutor({ adapter, approvals, refs: createBrowserControlRefStore(), now: () => 5_000 });
  const activating = executor.execute(frame('browser_tab_activate', { tab_id: 8 }, { command_id: 'activate-8' }), { scope, leasedTabIds: [7, 8] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [pending] = approvals.pending();
  assert.equal(approvals.grant(pending).ok, true);
  assert.equal((await activating).ok, true);
  return pending.reason;
}

test('a page title cannot reorder or hide part of the tab-switch approval: control and format characters are removed', async () => {
  // A right-to-left override (U+202E) would print the rest of the title backwards; a zero-width space hides a character.
  assert.equal(
    await tabSwitchReasonFor({ currentUrl: 'https://example.test/start', title: 'Report \u202Egnp.exe \u200BApproved' }),
    'Switch your view to "Report gnp.exe Approved"?',
  );
  const reason = await tabSwitchReasonFor({ currentUrl: 'https://example.test/start', title: 'Q3 \u2066plan\u2069 \u202Atotals\u0007' });
  assert.equal(reason, 'Switch your view to "Q3 plan totals"?');
  assert.doesNotMatch(reason, /[\p{Cc}\p{Cf}]/u);
  // A line break or tab is whitespace, so the words on either side stay apart.
  assert.equal(
    await tabSwitchReasonFor({ currentUrl: 'https://example.test/start', title: 'Quarterly\nReport\tDraft' }),
    'Switch your view to "Quarterly Report Draft"?',
  );
});

test('a tab-switch approval names the host when the tab has no title or its title only repeats the URL', async () => {
  const url = 'https://plan.example.test/q3?token=secret';
  const named = 'Switch your view to "plan.example.test"?';
  // An empty title, and a loading tab whose title is its URL with or without the scheme: the host stands in.
  assert.equal(await tabSwitchReasonFor({ title: '', currentUrl: url }), named);
  assert.equal(await tabSwitchReasonFor({ title: url, currentUrl: url }), named);
  assert.equal(await tabSwitchReasonFor({ title: 'plan.example.test/q3?token=secret', currentUrl: url }), named);
  assert.equal(await tabSwitchReasonFor({ title: 'plan.example.test/', currentUrl: 'https://plan.example.test/' }), named);
  // The port stays, so two local apps can be told apart.
  assert.equal(await tabSwitchReasonFor({ title: '', currentUrl: 'http://localhost:3000/app' }), 'Switch your view to "localhost:3000"?');
  // A real title is still the name, and the generic wording stands without a URL or a title.
  assert.equal(await tabSwitchReasonFor({ title: 'Q3 plan', currentUrl: url }), 'Switch your view to "Q3 plan"?');
  assert.equal(await tabSwitchReasonFor({ title: '' }), 'Switch your view to this tab?');
  assert.equal(await tabSwitchReasonFor({ title: 'about:blank', currentUrl: 'about:blank' }), 'Switch your view to this tab?');
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

test('Phase 6 keeps the stale_ref, navigation_failed and tab_hidden codes adapter errors carry and hides unknown ones', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Search', backendDOMNodeId: 44 }] });
  let failure = null;
  const executor = createBrowserControlExecutor({
    adapter: fullAdapter(async () => { throw failure; }),
    approvals: createBrowserControlApprovalStore(),
    refs,
    now: () => 5_000,
  });
  const coded = (code, message) => Object.assign(new Error(message), { code });

  failure = coded('stale_ref', 'That element is gone \u2014 use the refs in the latest result or call browser_snapshot.');
  const stale = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'stale_ref');
  assert.match(stale.error.message, /browser_snapshot/);

  failure = coded('navigation_failed', 'Navigation failed: net::ERR_NAME_NOT_RESOLVED');
  const navigation = await executor.execute(frame('browser_navigate', { url: 'https://nope.invalid/' }), { scope });
  assert.equal(navigation.error.code, 'navigation_failed');

  failure = coded('tab_hidden', "This tab is in the background, so hover and drag can't run there. Ask the user to bring it to the front with Show tab in Hermes Control, or use click, type or scroll, which work in background tabs.");
  const hidden = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(hidden.error.code, 'tab_hidden');
  assert.match(hidden.error.message, /Show tab in Hermes Control/);

  failure = coded('debugger_conflict', 'Another debugger controls this tab: x');
  assert.equal((await executor.execute(frame('browser_click', { ref: '@e1' }), { scope })).error.code, 'command_error');
  failure = new Error('plain failure');
  assert.equal((await executor.execute(frame('browser_scroll', { direction: 'down' }), { scope })).error.code, 'command_error');
});

test('a screenshot the adapter withheld keeps its code: not_active_tab and restricted_page reach the model', async () => {
  const { createBrowserControlExecutor } = await executorModule();
  let failure = null;
  const executor = createBrowserControlExecutor({
    adapter: fullAdapter(async () => { throw failure; }),
    approvals: createBrowserControlApprovalStore(),
    refs: createBrowserControlRefStore(),
    now: () => 5_000,
  });
  for (const code of ['not_active_tab', 'restricted_page']) {
    failure = Object.assign(new Error(`withheld: ${code}`), { code });
    const result = await executor.execute(frame('browser_screenshot'), { scope, leasedTabIds: [7] });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
});
