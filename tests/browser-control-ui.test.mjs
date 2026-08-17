import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

async function uiModule() {
  try {
    return await import('../extension/lib/browser-control-ui.mjs');
  } catch (error) {
    assert.fail(`Phase 6 browser-control UI contract is required: ${error?.message || error}`);
  }
}

test('Phase 6 control scope never expands an implicit all-tabs selection', async () => {
  const { controlLeaseRequest } = await uiModule();
  const active = { id: 10, windowId: 2 };
  assert.deepEqual(controlLeaseRequest({ scope: 'this-tab', activeTab: active }), {
    ok: true,
    kind: 'this-tab',
    tabIds: [10],
    windowId: 2,
  });
  assert.equal(controlLeaseRequest({ scope: 'selected-tabs', activeTab: active, selectedTabs: null }).error, 'explicit_selection_required');
  assert.equal(controlLeaseRequest({ scope: 'selected-tabs', activeTab: active, selectedTabs: [] }).error, 'explicit_selection_required');
  assert.deepEqual(controlLeaseRequest({
    scope: 'selected-tabs',
    activeTab: active,
    selectedTabs: [{ id: 12 }, { id: 10 }, { id: 12 }],
  }), {
    ok: true,
    kind: 'selected-tabs',
    tabIds: [12, 10],
    windowId: 2,
  });
  const task = controlLeaseRequest({
    scope: 'task-set',
    activeTab: active,
    selectedTabs: [{ id: 12 }, { id: 13 }],
    taskSetId: 'task-ui-1',
  });
  assert.deepEqual(task, {
    ok: true,
    kind: 'task-set',
    tabIds: [12, 13],
    windowId: 2,
    taskSetId: 'task-ui-1',
  });
});

test('Phase 6 Stay never changes the active tab while Follow targets only a different leased action tab', async () => {
  const { followTargetTabId } = await uiModule();
  const status = { leasedTabIds: [10, 12], activeAction: { tabId: 12 } };
  assert.equal(followTargetTabId({ viewBehavior: 'stay', status, activeTabId: 10 }), null);
  assert.equal(followTargetTabId({ viewBehavior: 'follow', status, activeTabId: 10 }), 12);
  assert.equal(followTargetTabId({ viewBehavior: 'follow', status, activeTabId: 12 }), null);
  assert.equal(followTargetTabId({ viewBehavior: 'follow', status: { ...status, leasedTabIds: [10] }, activeTabId: 10 }), null);
});

test('Phase 6 visible state is derived from worker authority and exposes no arguments or page content', async () => {
  const { browserControlView } = await uiModule();
  assert.deepEqual(browserControlView({ settings: { browserControlEnabled: false }, status: {} }), {
    state: 'off',
    tone: 'neutral',
    title: 'Control is off',
    detail: 'Hermes can read approved context but cannot operate tabs.',
    canEnable: true,
    canAttach: false,
    canPause: false,
    canStop: false,
    canDetach: false,
  });
  const active = browserControlView({
    settings: { browserControlEnabled: true },
    status: {
      controlEnabled: true,
      connected: true,
      paused: false,
      leasedTabIds: [10],
      pendingCommands: 1,
      activeAction: { action: 'browser_click', tabId: 10, arguments: { text: 'private' } },
    },
    activeTab: { id: 10, url: 'https://example.test/' },
  });
  assert.equal(active.state, 'active');
  assert.equal(active.title, 'Clicking in tab 10');
  assert.equal(active.canPause, true);
  assert.equal(active.canStop, true);
  assert.doesNotMatch(JSON.stringify(active), /private|arguments/);

  const approval = browserControlView({
    settings: { browserControlEnabled: true },
    status: {
      controlEnabled: true,
      connected: true,
      pendingApproval: {
        approvalId: 'a1', commandId: 'c1', action: 'browser_press', tabId: 10,
        documentGeneration: 2, reason: 'Press Enter to submit the current form or message?',
      },
    },
    activeTab: { id: 10, url: 'https://example.test/' },
  });
  assert.equal(approval.state, 'approval');
  assert.equal(approval.title, 'Approval needed');
  assert.equal(approval.detail, 'Press Enter to submit the current form or message?');
});

test('Phase 6 distinguishes global controller state from exact current-tab authority', async () => {
  const { browserControlView } = await uiModule();
  const settings = { browserControlEnabled: true };

  const reconnecting = browserControlView({
    settings,
    status: { controlEnabled: true, connected: false, leasedTabIds: [10] },
    activeTab: { id: 10, url: 'https://example.test/' },
  });
  assert.equal(reconnecting.state, 'reconnecting');
  assert.equal(reconnecting.canAttach, false);

  const unsupported = browserControlView({
    settings,
    status: { controlEnabled: true, connected: true, leasedTabIds: [] },
    activeTab: { id: 11, url: 'chrome://newtab/' },
  });
  assert.equal(unsupported.state, 'unavailable');
  assert.equal(unsupported.title, 'Unavailable on this page');
  assert.equal(unsupported.canAttach, false);

  const unattached = browserControlView({
    settings,
    status: { controlEnabled: true, connected: true, leasedTabIds: [10] },
    activeTab: { id: 11, url: 'https://example.test/new' },
  });
  assert.equal(unattached.state, 'unattached');
  assert.equal(unattached.title, 'This tab is not attached');
  assert.match(unattached.detail, /1 other tab/i);
  assert.equal(unattached.canAttach, true);
  assert.equal(unattached.canPause, false);

  const ready = browserControlView({
    settings,
    status: { controlEnabled: true, connected: true, leasedTabIds: [10] },
    activeTab: { id: 10, url: 'https://example.test/current' },
    currentTarget: { availability: 'available', tabId: 10, leaseOwned: true },
  });
  assert.equal(ready.state, 'ready');
  assert.equal(ready.title, 'This tab is ready');
  assert.equal(ready.canAttach, false);
  assert.equal(ready.canPause, true);

  const preparing = browserControlView({
    settings,
    status: { controlEnabled: true, connected: true, leasedTabIds: [10] },
    activeTab: { id: 10, url: 'https://example.test/current' },
    currentTarget: { availability: 'unavailable', reason: 'document_not_ready' },
  });
  assert.equal(preparing.state, 'preparing');
  assert.equal(preparing.title, 'Preparing this tab');
  assert.equal(preparing.canAttach, false);
});

test('Phase 6 builds a bounded current-tab lease replacement without expanding scope', async () => {
  const { currentTabLeaseReplacement } = await uiModule();
  assert.deepEqual(currentTabLeaseReplacement({
    status: { connected: true, controllerId: 'controller-1', leasedTabIds: [10, 12, 10] },
    activeTab: { id: 12, windowId: 3, url: 'https://example.test/work' },
  }), {
    ok: true,
    ownerId: 'controller-1',
    releaseTabIds: [10],
    acquire: {
      kind: 'this-tab',
      tabIds: [12],
      windowId: 3,
      ownership: 'owned',
      ownerId: 'controller-1',
    },
  });
  assert.equal(currentTabLeaseReplacement({
    status: { connected: true, controllerId: 'controller-1', leasedTabIds: [] },
    activeTab: { id: 12, url: 'chrome://newtab/' },
  }).error, 'restricted_url');
  assert.equal(currentTabLeaseReplacement({
    status: { connected: true, leasedTabIds: [] },
    activeTab: { id: 12, url: 'https://example.test/' },
  }).error, 'controller_unavailable');
});

test('connected controller without a browser executor is unavailable, not reconnecting', async () => {
  const { browserControlView } = await uiModule();
  const view = browserControlView({
    settings: { browserControlEnabled: true },
    status: { controlEnabled: false, connected: true, leasedTabIds: [] },
    activeTab: { id: 10, url: 'https://example.test/' },
  });
  assert.equal(view.state, 'unavailable');
  assert.equal(view.title, 'Control unavailable');
  assert.doesNotMatch(view.detail, /reconnect/i);
});

test('reconnecting state explains the last controller failure with actionable remediation', async () => {
  const { browserControlView } = await uiModule();
  const settings = { browserControlEnabled: true };
  const base = { status: { connected: false }, activeTab: { id: 10, url: 'https://example.test/' } };

  const session = browserControlView({
    settings,
    ...base,
    status: { connected: false, lastConnectFailure: { reason: 'missing_session' } },
  });
  assert.equal(session.state, 'reconnecting');
  assert.match(session.detail, /session/i);

  const token = browserControlView({
    settings,
    ...base,
    status: { connected: false, lastConnectFailure: { reason: 'connect_failed', detail: 'Controller registration failed (HTTP 401).' } },
  });
  assert.match(token.detail, /Settings|token/i);

  const network = browserControlView({
    settings,
    ...base,
    status: { connected: false, lastConnectFailure: { reason: 'connect_failed', detail: 'Network unreachable.' } },
  });
  assert.match(network.detail, /Network unreachable/);
});

test('browser control strip typography scales with the Hermes text zoom setting', () => {
  const css = readFileSync('extension/sidepanel.css', 'utf8');
  assert.match(css, /\.browser-control-strip-copy strong \{ font: 500 calc\(13px \* var\(--hermes-text-zoom, 1\)\)\/1\.15/);
  assert.match(css, /\.browser-control-strip-copy span \{ margin-top: 3px; color: var\(--hermes-muted\); font: calc\(10px \* var\(--hermes-text-zoom, 1\)\)\/1\.35/);
  assert.match(css, /font: 700 calc\(10\.5px \* var\(--hermes-text-zoom, 1\)\)\/1\.2 var\(--hermes-font-mono\)/);
});
