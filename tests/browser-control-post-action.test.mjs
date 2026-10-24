import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { createBrowserControlExecutor } from '../extension/lib/browser-control-executor.mjs';
import { createBrowserControlRefStore } from '../extension/lib/browser-control-refs.mjs';
import { createBrowserControlApprovalStore } from '../extension/lib/browser-control-safety.mjs';

const scope = Object.freeze({
  controllerId: 'controller-1',
  leaseOwnerId: 'controller-1',
  leaseId: 'lease-1',
  tabId: 7,
  frameId: 0,
  documentGeneration: 3,
});

const PAGE_NODES = [
  { role: 'link', name: 'Home', backendDOMNodeId: 40 },
  { role: 'button', name: 'Add to cart', backendDOMNodeId: 41, disabled: true },
  { role: 'textbox', name: 'Password', inputType: 'password', backendDOMNodeId: 42 },
];

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

const ALL_ACTIONS = [
  'browser_back', 'browser_click', 'browser_fill', 'browser_hover', 'browser_navigate', 'browser_press',
  'browser_scroll', 'browser_scroll_to', 'browser_select', 'browser_snapshot', 'browser_type',
];

// An adapter that reports what the page looks like after any action.
function pageAdapter({
  actionResults = {},
  snapshot = null,
  settle = null,
  inspect = null,
} = {}) {
  const calls = [];
  const adapter = {
    calls,
    contract: { enabled: true, actions: ALL_ACTIONS },
    inspect: inspect || (async (options) => {
      calls.push({ method: 'inspect', light: options?.light === true });
      return { currentUrl: 'https://example.test/start', hasUnsavedContent: false };
    }),
    settle: settle || (async (options) => {
      calls.push({ method: 'settle', mode: options.mode, timeoutMs: options.timeoutMs });
      return { navigated: false, url: 'https://example.test/start', title: 'Start', timedOut: false };
    }),
    async execute(action, args, context) {
      calls.push({ method: 'execute', action });
      if (action === 'browser_snapshot') {
        if (snapshot instanceof Error) throw snapshot;
        return typeof snapshot === 'function'
          ? snapshot(args, context)
          : { title: 'Start', url: 'https://example.test/start', text: 'Welcome to the shop.', nodes: PAGE_NODES, headings: [{ level: 1, name: 'Shop' }] };
      }
      return actionResults[action] || { status: 'ok' };
    },
  };
  return adapter;
}

function makeExecutor(adapter, options = {}) {
  const refs = options.refs || createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: PAGE_NODES });
  const executor = createBrowserControlExecutor({
    adapter,
    approvals: options.approvals || createBrowserControlApprovalStore(),
    refs,
    ...(options.executorOptions || {}),
  });
  return { executor, refs };
}

const MUTATIONS = [
  ['browser_click', { ref: '@e1' }, 'clicked'],
  ['browser_type', { ref: '@e2', text: 'hello' }, 'typed'],
  ['browser_press', { key: 'Tab' }, 'pressed'],
  ['browser_scroll', { direction: 'down' }, 'scrolled'],
  ['browser_navigate', { url: 'https://example.test/next' }, 'navigated'],
  ['browser_back', {}, 'navigated-back'],
  ['browser_fill', { ref: '@e1', value: 'x' }, 'filled'],
  ['browser_select', { ref: '@e1', value: 'x' }, 'selected'],
  ['browser_hover', { ref: '@e1' }, 'hovered'],
  ['browser_scroll_to', { ref: '@e1' }, 'scrolled-to-target'],
];

for (const [action, args, status] of MUTATIONS) {
  test(`Phase 2 ${action} returns the page state with fresh refs`, async () => {
    const adapter = pageAdapter({
      actionResults: {
        browser_navigate: { status: 'navigated', navigated: true, url: 'https://example.test/next', title: 'Next' },
        browser_back: { status: 'navigated-back', navigated: true, url: 'https://example.test/prev', title: 'Prev' },
      },
    });
    const { executor, refs } = makeExecutor(adapter);
    const outcome = await executor.execute(frame(action, args), { scope });

    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.result.status, status);
    assert.equal(typeof outcome.result.url, 'string');
    assert.equal(typeof outcome.result.title, 'string');
    assert.equal(typeof outcome.result.navigated, 'boolean');
    assert.equal(outcome.result.snapshot_error, undefined);
    assert.deepEqual(Object.keys(outcome.result.snapshot).sort(), ['element_count', 'refs', 'text', 'truncated']);
    assert.equal(outcome.result.snapshot.element_count, 3);
    assert.match(outcome.result.snapshot.text, /^\[@e1\] link "Home"\n\[@e2\] button "Add to cart" \(disabled\)\n\[@e3\] textbox "Sensitive field"/);
    assert.match(outcome.result.snapshot.text, /## Shop/);
    assert.match(outcome.result.snapshot.text, /Welcome to the shop\./);
    assert.deepEqual(outcome.result.snapshot.refs.map((item) => item.ref), ['@e1', '@e2', '@e3']);
    assert.doesNotMatch(JSON.stringify(outcome), /backendDOMNodeId/);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(outcome)));
    // The refs in the result are live for the next command.
    assert.equal(refs.resolve({ ...scope, ref: '@e1' }).ok, true);
    if (action === 'browser_navigate' || action === 'browser_back') {
      assert.equal(outcome.result.navigated, true);
    }
  });
}

test('Phase 2 click reports an obstructed target, scroll reports the position, navigate reports the final page', async () => {
  const position = { scrollX: 0, scrollY: 800, maxY: 2400, atTop: false, atBottom: false };
  const adapter = pageAdapter({
    actionResults: {
      browser_click: { status: 'clicked', obscured: true },
      browser_scroll: { status: 'scrolled', position: { ...position, extra: 'dropped' } },
      browser_navigate: { status: 'navigated', url: 'https://example.test/redirected', title: 'Landed', navigated: true, timedOut: true },
    },
    settle: async () => ({ navigated: false, url: 'https://example.test/settled', title: 'Settled', timedOut: false }),
  });
  const { executor } = makeExecutor(adapter);

  const click = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(click.result.obscured, true);
  assert.equal(click.result.url, 'https://example.test/settled');
  assert.equal(click.result.title, 'Settled');
  assert.equal(click.result.navigated, false);

  const scroll = await executor.execute(frame('browser_scroll', { direction: 'down' }, { command_id: 'c2' }), { scope });
  assert.deepEqual(scroll.result.position, position);

  const navigate = await executor.execute(frame('browser_navigate', { url: 'https://example.test/next' }, { command_id: 'c3' }), { scope });
  assert.equal(navigate.result.navigated, true);
  assert.equal(navigate.result.timedOut, true);
});

test('Phase 2 settles the page before reading it and skips settling for an already-open page', async () => {
  const adapter = pageAdapter({
    actionResults: { browser_navigate: { status: 'already-open', navigated: false, url: 'https://example.test/start', title: 'Start' } },
  });
  const { executor } = makeExecutor(adapter);
  await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  const clickSequence = adapter.calls.filter((call) => call.method !== 'inspect').map((call) => call.method === 'settle' ? `settle:${call.mode}` : call.action);
  assert.deepEqual(clickSequence, ['browser_click', 'settle:dom', 'browser_snapshot']);

  adapter.calls.length = 0;
  const already = await executor.execute(frame('browser_navigate', { url: 'https://example.test/start/' }, { command_id: 'c2' }), { scope });
  assert.equal(already.result.status, 'already-open');
  assert.equal(already.result.navigated, false);
  assert.ok(already.result.snapshot.text.includes('[@e1]'));
  assert.deepEqual(adapter.calls.filter((call) => call.method === 'settle'), []);
});

test('Phase 2 browser_snapshot returns the rendered view plus refs, with larger budgets for full', async () => {
  const nodes = Array.from({ length: 500 }, (_, index) => ({ role: 'button', name: `Button number ${index + 1}`, backendDOMNodeId: index + 1 }));
  const pageText = Array.from({ length: 6_000 }, (_, index) => `Paragraph ${index} of the page body text.`).join('\n');
  const adapter = pageAdapter({ snapshot: () => ({ title: 'Big', url: 'https://example.test/big', text: pageText, nodes }) });
  const { executor } = makeExecutor(adapter, { refs: createBrowserControlRefStore({ maxRefsPerDocument: 500 }) });

  const compact = await executor.execute(frame('browser_snapshot'), { scope });
  assert.equal(compact.ok, true);
  assert.ok(compact.result.text.length <= 15_000);
  assert.ok(compact.result.text.length > 12_000, 'an explicit snapshot may use the larger budget');
  assert.equal(compact.result.truncated, true);
  assert.equal(compact.result.element_count, 500);
  assert.ok(compact.result.refs.length < 500);
  assert.match(compact.result.text, /more elements — scroll or call browser_snapshot with full=true/);

  const full = await executor.execute(frame('browser_snapshot', { full: true }, { command_id: 'c2' }), { scope });
  assert.ok(full.result.text.length <= 60_000);
  assert.ok(full.result.text.length > compact.result.text.length);
  assert.equal(full.result.refs.length, 500);
  assert.equal(full.result.truncated, true, 'page text is still cut at the budget');
});

test('Phase 2 post-action snapshots stay within 12,000 characters and hint at the rest', async () => {
  const nodes = Array.from({ length: 400 }, (_, index) => ({ role: 'link', name: `Link number ${index + 1}`, backendDOMNodeId: index + 1 }));
  const adapter = pageAdapter({ snapshot: () => ({ title: 'Big', url: 'https://example.test/start', text: Array.from({ length: 2_000 }, (_, index) => `Body line ${index}.`).join('\n'), nodes }) });
  const { executor } = makeExecutor(adapter);
  const outcome = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.result.snapshot.text.length <= 12_000);
  assert.equal(outcome.result.snapshot.truncated, true);
  assert.equal(outcome.result.snapshot.element_count, 400);
  assert.match(outcome.result.snapshot.text, /… \d+ more elements — scroll or call browser_snapshot with full=true/);
  assert.ok(JSON.stringify(outcome).length < 30_000);
});

test('Phase 2 redacts page text, element names, titles, and urls in every snapshot view', async () => {
  const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
  const adapter = pageAdapter({
    snapshot: () => ({
      title: `Keys ${secret}`,
      url: `https://example.test/keys/${secret}`,
      text: `Your api_key=${secret} is ready.\nSafe sentence.`,
      nodes: [{ role: 'button', name: `Copy ${secret}`, backendDOMNodeId: 5 }],
      headings: [{ level: 2, name: `Heading ${secret}` }],
    }),
    settle: async () => ({ navigated: false, url: `https://example.test/keys/${secret}`, title: `Keys ${secret}`, timedOut: false }),
  });
  const { executor } = makeExecutor(adapter);
  const snapshot = await executor.execute(frame('browser_snapshot'), { scope });
  // The seeded refs @e1-@e3 are gone; the new button took the next free number.
  const click = await executor.execute(frame('browser_click', { ref: '@e4' }, { command_id: 'c2' }), { scope });
  for (const outcome of [snapshot, click]) {
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.doesNotMatch(JSON.stringify(outcome), /abcdefghijklmnopqrstuvwxyz0123456789/);
  }
  assert.match(snapshot.result.text, /Safe sentence\./);
});

test('Phase 2 a failing post-action snapshot never fails the action', async () => {
  const failing = Object.assign(new Error('boom'), { code: 'stale_ref' });
  const { executor } = makeExecutor(pageAdapter({ snapshot: failing }));
  const stale = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(stale.ok, true);
  assert.equal(stale.result.status, 'clicked');
  assert.equal(stale.result.snapshot_error, 'stale_ref');
  assert.equal('snapshot' in stale.result, false);
  assert.equal(stale.result.url, 'https://example.test/start');

  const generic = makeExecutor(pageAdapter({ snapshot: new Error('anything') }));
  const outcome = await generic.executor.execute(frame('browser_type', { ref: '@e1', text: 'x' }), { scope });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.status, 'typed');
  assert.equal(outcome.result.snapshot_error, 'snapshot_failed');

  // browser_snapshot itself still reports the failure.
  const direct = await generic.executor.execute(frame('browser_snapshot', {}, { command_id: 'c3' }), { scope });
  assert.equal(direct.ok, false);
});

test('Phase 2 settle failures and unreadable pages degrade to snapshot_error, not an error', async () => {
  const throwing = pageAdapter({ settle: async () => { throw new Error('settle exploded'); } });
  const first = makeExecutor(throwing);
  const outcome = await first.executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.status, 'clicked');
  assert.ok(outcome.result.snapshot.text.includes('[@e1]'));

  const restricted = pageAdapter({
    settle: async () => ({ navigated: true, url: 'chrome://settings/passwords?token=abc', title: 'Settings', timedOut: false }),
  });
  const second = makeExecutor(restricted);
  const blocked = await second.executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.result.snapshot_error, 'restricted_page');
  assert.equal(blocked.result.navigated, true);
  assert.equal('snapshot' in blocked.result, false);
  assert.equal(blocked.result.title, undefined);
  assert.doesNotMatch(JSON.stringify(blocked), /passwords|token=abc/);
  assert.equal(restricted.calls.filter((call) => call.action === 'browser_snapshot').length, 0);
});

test('Phase 2 a hung post-action snapshot times out inside the command deadline', async () => {
  const adapter = pageAdapter({ snapshot: () => new Promise(() => {}) });
  const { executor } = makeExecutor(adapter, { executorOptions: { defaultDeadlineMs: 800 } });
  const started = Date.now();
  const outcome = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.status, 'clicked');
  assert.equal(outcome.result.snapshot_error, 'snapshot_timeout');
  assert.ok(Date.now() - started < 800);
});

test('Phase 2 skips the page read when too little of the deadline is left', async () => {
  const adapter = pageAdapter();
  const { executor } = makeExecutor(adapter, { executorOptions: { defaultDeadlineMs: 500 } });
  const outcome = await executor.execute(frame('browser_press', { key: 'Tab' }), { scope });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.status, 'pressed');
  assert.equal(outcome.result.snapshot_error, 'deadline_near');
  assert.equal(adapter.calls.some((call) => call.action === 'browser_snapshot'), false);
});

test('Phase 2 adapters without settle or snapshot support keep the plain action result', async () => {
  const adapter = {
    contract: { enabled: true, actions: ['browser_click'] },
    inspect: async () => ({ currentUrl: 'https://example.test/start' }),
    execute: async () => ({ status: 'clicked' }),
  };
  const { executor } = makeExecutor(adapter);
  const outcome = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.deepEqual(outcome, { ok: true, result: { status: 'clicked' } });
});

test('Phase 2 refs are minted under the generation the next command will use', async () => {
  let generation = 3;
  const adapter = pageAdapter({
    settle: async () => {
      generation = 5; // tabs.onUpdated and document-ready landed while settling
      return { navigated: true, url: 'https://example.test/next', title: 'Next', timedOut: false };
    },
  });
  const { executor, refs } = makeExecutor(adapter);
  const outcome = await executor.execute(frame('browser_click', { ref: '@e1' }), {
    scope,
    currentDocumentGeneration: (tabId, frameId) => {
      assert.equal(tabId, 7);
      assert.equal(frameId, 0);
      return generation;
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.navigated, true);
  assert.equal(refs.resolve({ ...scope, documentGeneration: 5, ref: '@e1' }).ok, true);
  assert.notEqual(refs.resolve({ ...scope, documentGeneration: 3, ref: '@e1' }).ok, true, 'old-document refs are dropped');
});

test('Phase 2 falls back to the current generation when a navigation never advances it', async () => {
  const adapter = pageAdapter({
    settle: async () => ({ navigated: true, url: 'https://example.test/next', title: 'Next', timedOut: false }),
  });
  const { executor, refs } = makeExecutor(adapter);
  const started = Date.now();
  const outcome = await executor.execute(frame('browser_click', { ref: '@e1' }), {
    scope,
    currentDocumentGeneration: () => 3,
  });
  assert.equal(outcome.ok, true);
  assert.ok(Date.now() - started < 1_500, 'the wait for the generation is bounded');
  assert.equal(refs.resolve({ ...scope, ref: '@e1' }).ok, true);
});

test('Phase 2 inspects the page once per action and uses the URL-only probe for read-only ones', async () => {
  const adapter = pageAdapter();
  const { executor } = makeExecutor(adapter);
  await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.deepEqual(adapter.calls.filter((call) => call.method === 'inspect'), [{ method: 'inspect', light: false }]);

  adapter.calls.length = 0;
  await executor.execute(frame('browser_scroll', { direction: 'down' }, { command_id: 'c2' }), { scope });
  await executor.execute(frame('browser_back', {}, { command_id: 'c3' }), { scope });
  await executor.execute(frame('browser_snapshot', {}, { command_id: 'c4' }), { scope });
  assert.deepEqual(adapter.calls.filter((call) => call.method === 'inspect'), [
    { method: 'inspect', light: true },
    { method: 'inspect', light: true },
    { method: 'inspect', light: true },
  ]);
});

test('Phase 2 approval waits that run out report approval_timeout and clear the pending request', async () => {
  const approvals = createBrowserControlApprovalStore();
  const adapter = pageAdapter();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Send message', backendDOMNodeId: 9 }] });
  const executor = createBrowserControlExecutor({ adapter, approvals, refs, defaultDeadlineMs: 60 });
  const outcome = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.deepEqual(outcome, {
    ok: false,
    error: { code: 'approval_timeout', message: 'Waiting for your approval in the Hermes panel timed out.' },
  });
  assert.equal(approvals.pending().length, 0);
  assert.equal(adapter.calls.some((call) => call.method === 'execute'), false);

  // A deadline that expires outside an approval wait keeps its own code.
  const slow = createBrowserControlExecutor({
    adapter: { ...pageAdapter(), execute: () => new Promise(() => {}) },
    approvals,
    refs,
    defaultDeadlineMs: 30,
  });
  const timedOut = await slow.execute(frame('browser_scroll', { direction: 'down' }, { command_id: 'c2' }), { scope });
  assert.equal(timedOut.error.code, 'deadline_exceeded');
});

test('Phase 2 approval waits end before the broker cancels the command at 30 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const approvals = createBrowserControlApprovalStore();
  const refs = createBrowserControlRefStore();
  refs.replace({ ...scope, nodes: [{ role: 'button', name: 'Send message', backendDOMNodeId: 9 }] });
  const executor = createBrowserControlExecutor({
    adapter: pageAdapter(),
    approvals,
    refs,
    now: () => 5_000,
    defaultDeadlineMs: 30_000,
  });
  let result = null;
  const running = executor.execute(frame('browser_click', { ref: '@e1' }), { scope }).then((value) => { result = value; });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(approvals.pending().length, 1);
  t.mock.timers.tick(27_999);
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  assert.equal(result, null, 'still waiting just before 28 s');
  t.mock.timers.tick(1);
  await running;
  assert.equal(result.error.code, 'approval_timeout');
  mock.timers.reset();
});

test('Phase 2 navigate and back never describe a restricted landing page beyond its origin', async () => {
  const landing = { navigated: true, url: 'https://shop.example/checkout?cart=9', title: 'Checkout - Jane Doe, 12 Elm St', timedOut: false };
  for (const [action, args, status] of [
    ['browser_navigate', { url: 'https://shop.example/cart' }, 'navigated'],
    ['browser_back', {}, 'navigated-back'],
  ]) {
    const adapter = pageAdapter({
      actionResults: { [action]: { status, ...landing }, },
      settle: async () => landing,
    });
    const { executor } = makeExecutor(adapter);
    const outcome = await executor.execute(frame(action, args), { scope });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.status, status);
    assert.equal(outcome.result.snapshot_error, 'restricted_page');
    assert.equal(outcome.result.url, 'https://shop.example');
    assert.equal('title' in outcome.result, false);
    assert.doesNotMatch(JSON.stringify(outcome), /Jane Doe|Elm St|checkout|cart=9/);
  }

  // Even when the page read is skipped, the adapter's own url and title are not passed on.
  const skipped = pageAdapter({
    actionResults: { browser_navigate: { status: 'navigated', ...landing } },
  });
  const { executor } = makeExecutor(skipped, { executorOptions: { defaultDeadlineMs: 500 } });
  const outcome = await executor.execute(frame('browser_navigate', { url: 'https://shop.example/cart' }), { scope });
  assert.equal(outcome.result.snapshot_error, 'deadline_near');
  assert.equal(outcome.result.url, 'https://shop.example');
  assert.equal('title' in outcome.result, false);
});

test('Phase 2 reads the page back only until 28 seconds after the command started, and never past the load budget', async () => {
  let clock = 1_000;
  const adapter = pageAdapter();
  const originalExecute = adapter.execute;
  // The action itself (for example after a long approval) used up most of the time.
  adapter.execute = async (action, args, context) => {
    if (action === 'browser_click') clock += 27_400;
    return originalExecute(action, args, context);
  };
  const { executor } = makeExecutor(adapter, { executorOptions: { now: () => clock, defaultDeadlineMs: 30_000 } });
  const late = await executor.execute(frame('browser_click', { ref: '@e1' }), { scope });
  assert.equal(late.ok, true);
  assert.equal(late.result.status, 'clicked');
  assert.equal(late.result.snapshot_error, 'deadline_near', 'the 30 s broker timeout is measured from dispatch, so the page is not read this late');
  assert.equal(adapter.calls.some((call) => call.method === 'settle'), false);

  clock = 1_000;
  const settleCalls = [];
  const early = pageAdapter({
    settle: async (options) => { settleCalls.push(options); return { navigated: true, url: 'https://example.test/start', title: 'Start', timedOut: false }; },
  });
  const roomy = makeExecutor(early, { executorOptions: { now: () => clock, defaultDeadlineMs: 30_000 } });
  const outcome = await roomy.executor.execute(frame('browser_click', { ref: '@e1' }, { command_id: 'c2' }), { scope });
  assert.equal(outcome.result.snapshot_error, undefined);
  assert.equal(settleCalls.length, 1);
  assert.equal(settleCalls[0].timeoutMs, 1_200);
  assert.ok(settleCalls[0].loadTimeoutMs > 25_000, 'a slow navigation may use the whole remaining budget (the adapter caps it at 8 s)');

  // A navigation that already waited out its own load is not waited on again.
  settleCalls.length = 0;
  const slowNavigate = pageAdapter({
    actionResults: { browser_navigate: { status: 'navigated', navigated: true, timedOut: true, url: 'https://example.test/slow', title: 'Slow' } },
    settle: async (options) => { settleCalls.push(options); return { navigated: true, url: 'https://example.test/slow', title: 'Slow', timedOut: true }; },
  });
  const navigating = makeExecutor(slowNavigate, { executorOptions: { now: () => clock, defaultDeadlineMs: 30_000 } });
  await navigating.executor.execute(frame('browser_navigate', { url: 'https://example.test/slow' }, { command_id: 'c4' }), { scope });
  assert.equal(settleCalls[0].loadTimeoutMs, 1_200);

  clock = 1_000;
  settleCalls.length = 0;
  const tight = makeExecutor(early, { executorOptions: { now: () => clock, defaultDeadlineMs: 3_000 } });
  await tight.executor.execute(frame('browser_click', { ref: '@e1' }, { command_id: 'c3' }), { scope });
  assert.ok(settleCalls[0].loadTimeoutMs <= 2_600, `load budget ${settleCalls[0].loadTimeoutMs} must stay inside the command deadline`);
});
