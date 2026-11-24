import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parseHTML } from 'linkedom';

import {
  BACKGROUND_APPROVAL_GET,
  BACKGROUND_APPROVAL_PAGE,
  BACKGROUND_APPROVAL_VISIBLE,
  VISIBLE_CONFIRMATION_GRACE_MS,
  VISIBLE_CONFIRMATION_TTL_MS,
  VISIBLE_HEARTBEAT_MS,
  backgroundApprovalVisibleNow,
  createBackgroundApprovalPage,
  createBackgroundApprovalSurface,
  createBackgroundApprovalVisibleHeartbeat,
} from '../extension/lib/background-approval-surface.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(turns = 10) {
  for (let i = 0; i < turns; i += 1) await nextTurn();
}

function fakeBrowser() {
  const calls = { created: [], removed: [], badge: [], titles: [], colors: [] };
  const removedListeners = [];
  let nextWindow = 500;
  const browserApi = {
    runtime: { getURL: (path) => `chrome-extension://fixture/${path}` },
    windows: {
      create: async (options) => { const id = nextWindow; nextWindow += 1; calls.created.push({ id, ...options }); return { id }; },
      remove: async (id) => { calls.removed.push(id); },
      onRemoved: { addListener: (fn) => removedListeners.push(fn) },
    },
    action: {
      getTitle: async () => 'Open Hermes',
      setTitle: async ({ title }) => { calls.titles.push(title); },
      setBadgeText: async ({ text }) => { calls.badge.push(text); },
      setBadgeBackgroundColor: async ({ color }) => { calls.colors.push(color); },
    },
  };
  return { browserApi, calls, closeByUser: (id) => removedListeners.forEach((fn) => fn(id)) };
}

const translate = (key) => `t:${key}`;

test('a background approval opens one focused approval window and an action signal without the side panel', async () => {
  const { browserApi, calls } = fakeBrowser();
  const timers = manualTimers();
  const surface = createBackgroundApprovalSurface({ browserApi, translate, ...timers });
  const settled = deferred();
  surface.show({ approvalId: 'a 1' }, settled.promise);
  surface.show({ approvalId: 'a 1' }, settled.promise);
  await flush();
  assert.equal(calls.created.length, 0, 'the first look waits a short grace for a visible panel to confirm');
  await timers.fire();
  assert.equal(calls.created.length, 1, 'one window per approval request');
  assert.equal(calls.created[0].url, `chrome-extension://fixture/${BACKGROUND_APPROVAL_PAGE}?approval=a%201`);
  assert.equal(calls.created[0].type, 'popup');
  assert.equal(calls.created[0].focused, true);
  assert.equal(calls.badge.at(-1), '1');
  assert.equal(calls.titles.at(-1), 't:browser_control.approval_waiting');
  settled.resolve({ ok: true });
  await flush();
  assert.deepEqual(calls.removed, [calls.created[0].id], 'the window closes once the request is decided or expires');
  assert.equal(calls.badge.at(-1), '');
  assert.equal(calls.titles.at(-1), 'Open Hermes', 'the toolbar title returns to its default');
});

test('a window the person closed is not reopened, and a request settled before its window opened closes it', async () => {
  const { browserApi, calls, closeByUser } = fakeBrowser();
  const timers = manualTimers();
  const surface = createBackgroundApprovalSurface({ browserApi, translate, ...timers });
  const first = deferred();
  surface.show({ approvalId: 'a1' }, first.promise);
  await flush();
  await timers.fire();
  closeByUser(calls.created[0].id);
  surface.show({ approvalId: 'a1' }, first.promise);
  await flush();
  assert.equal(calls.created.length, 1, 'a dismissed approval window stays closed for that request');
  assert.equal(calls.badge.at(-1), '1', 'the toolbar still says a request is waiting');
  first.resolve({ ok: false, error: 'approval_timeout' });
  await flush();
  assert.deepEqual(calls.removed, [], 'a window the person already closed is not removed twice');
  assert.equal(calls.badge.at(-1), '');

  let release;
  browserApi.windows.create = (options) => new Promise((resolve) => {
    release = () => { calls.created.push({ id: 900, ...options }); resolve({ id: 900 }); };
  });
  const second = deferred();
  surface.show({ approvalId: 'a2' }, second.promise);
  await flush();
  await timers.fire();
  second.resolve({ ok: false, error: 'cancelled' });
  await flush();
  release();
  await flush();
  assert.deepEqual(calls.removed, [900], 'a late window for a finished request is closed');
});

function pageFixture(locale = 'en') {
  const html = readFileSync(new URL('../extension/background-approval.html', import.meta.url), 'utf8');
  const { document } = parseHTML(html);
  const sent = [];
  let closed = 0;
  const request = {
    approvalId: 'a1', approvalNonce: 'n1', commandId: 'c1', controllerId: 'background-x', leaseId: 'lease-1',
    leaseGeneration: 1, action: 'browser_click', tabId: 21, frameId: 0, documentGeneration: 3, state: 'paused',
    reason: 'Click "Continue"? It may change the page.', reasonKey: 'browser_control.approval.click', reasonParams: { name: 'Continue' },
  };
  const page = createBackgroundApprovalPage({
    doc: document,
    approvalId: 'a1',
    t: (key, params = {}) => `${locale}:${key}${Object.keys(params).length ? `:${JSON.stringify(params)}` : ''}`,
    translateText: (text) => text,
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === BACKGROUND_APPROVAL_GET) return { ok: true, approval: request };
      return { ok: true };
    },
    closeWindow: () => { closed += 1; },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  return { document, page, sent, request, closed: () => closed };
}

test('the approval window shows the same localized card text and decides through the controller grant path', async () => {
  const f = pageFixture('de');
  await f.page.load();
  const reason = f.document.getElementById('backgroundApprovalReason').textContent;
  assert.match(reason, /^de:browser_control\.approval\.background_task/);
  assert.match(reason, /de:browser_control\.approval\.click/);
  assert.equal(f.document.getElementById('backgroundApprovalApprove').hidden, false);
  f.document.getElementById('backgroundApprovalApprove').click();
  await flush();
  const grant = f.sent.find((message) => message.type === 'HERMES_CONTROLLER_APPROVAL_GRANT');
  assert.ok(grant, 'approve sends the same controller grant message as the side panel');
  for (const field of ['approvalId', 'approvalNonce', 'commandId', 'controllerId', 'leaseId', 'leaseGeneration',
    'action', 'tabId', 'frameId', 'documentGeneration', 'state']) {
    assert.deepEqual(grant[field], f.request[field], field);
  }
  assert.equal(f.closed(), 1, 'the window closes after the decision is accepted');
});

test('the approval window rejects through the controller and says when the request is gone', async () => {
  const f = pageFixture();
  await f.page.load();
  f.document.getElementById('backgroundApprovalReject').click();
  await flush();
  assert.ok(f.sent.find((message) => message.type === 'HERMES_CONTROLLER_APPROVAL_REJECT'));

  const { document } = parseHTML(readFileSync(new URL('../extension/background-approval.html', import.meta.url), 'utf8'));
  let closed = 0;
  const gone = createBackgroundApprovalPage({
    doc: document, approvalId: 'missing', t: (key) => key, translateText: (text) => text,
    sendMessage: async () => ({ ok: true, approval: null }), closeWindow: () => { closed += 1; },
    setTimer: () => 0, clearTimer: () => {},
  });
  await gone.load();
  assert.equal(document.getElementById('backgroundApprovalReason').textContent, 'browser_control.approval_window_gone');
  assert.equal(document.getElementById('backgroundApprovalApprove').hidden, true);
  assert.equal(document.getElementById('backgroundApprovalReject').hidden, true);
  const close = document.getElementById('backgroundApprovalClose');
  assert.equal(close.hidden, false, 'the ended screen shows a Close button');
  close.click();
  assert.equal(closed, 1, 'Close calls window.close()');
});

test('the approval page has no hardcoded copy and needs no new manifest permission', () => {
  const html = readFileSync(new URL('../extension/background-approval.html', import.meta.url), 'utf8');
  for (const key of ['browser_control.kicker', 'browser_control.approval_needed', 'browser_control.approve_once', 'browser_control.reject', 'browser_control.approval_window_close']) {
    assert.match(html, new RegExp(`data-i18n="${key.replace(/\./g, '\\.')}"`));
  }
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.permissions.includes('notifications'), false);
});

function manualTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => { const id = next; next += 1; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => [...timers.values()],
    async fire() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fn();
      await flush();
    },
  };
}

test('a fresh visible confirmation for this request suppresses the approval window, and a stale or missing confirmation opens it', async () => {
  const { browserApi, calls } = fakeBrowser();
  const timers = manualTimers();
  let clock = 0;
  const surface = createBackgroundApprovalSurface({
    browserApi, translate, ...timers, now: () => clock,
    visibleTtlMs: VISIBLE_CONFIRMATION_TTL_MS, visibleGraceMs: VISIBLE_CONFIRMATION_GRACE_MS,
  });
  const settled = deferred();
  surface.noteVisible('p1');
  surface.show({ approvalId: 'p1' }, settled.promise);
  await flush();
  assert.equal(calls.created.length, 0, 'a fresh confirmation keeps the window closed');
  assert.equal(calls.badge.at(-1), '1', 'the toolbar still says a request is waiting');
  clock += VISIBLE_CONFIRMATION_TTL_MS - 1;
  surface.noteVisible('p1');
  await timers.fire();
  assert.equal(calls.created.length, 0, 'a refreshed confirmation stays fresh');
  clock += VISIBLE_CONFIRMATION_TTL_MS;
  await timers.fire();
  assert.equal(calls.created.length, 1, 'a stale confirmation opens the window');
  settled.resolve({ ok: true });
  await flush();
  assert.deepEqual(calls.removed, [calls.created[0].id]);
  assert.equal(timers.pending().length, 0, 'no confirmation re-check is left running');
});

test('a decided request stops the confirmation re-check without opening a window', async () => {
  const { browserApi, calls } = fakeBrowser();
  const timers = manualTimers();
  const surface = createBackgroundApprovalSurface({ browserApi, translate, ...timers });
  const settled = deferred();
  surface.noteVisible('p2');
  surface.show({ approvalId: 'p2' }, settled.promise);
  await flush();
  settled.resolve({ ok: true });
  await flush();
  await timers.fire();
  assert.equal(calls.created.length, 0);
  assert.equal(timers.pending().length, 0);
  assert.equal(calls.badge.at(-1), '');
});

test('an existing side panel context is not enough: the window opens without a fresh confirmation for this request', async () => {
  const { browserApi, calls } = fakeBrowser();
  const timers = manualTimers();
  browserApi.runtime.getContexts = async () => [
    { contextType: 'SIDE_PANEL', documentUrl: 'chrome-extension://fixture/sidepanel.html' },
  ];
  const surface = createBackgroundApprovalSurface({ browserApi, translate, ...timers });
  const settled = deferred();
  surface.show({ approvalId: 'hidden-panel' }, settled.promise);
  await flush();
  assert.equal(calls.created.length, 0, 'the first look waits a short grace');
  await timers.fire();
  assert.equal(calls.created.length, 1, 'a minimized or silent panel does not suppress the window');

  const other = fakeBrowser();
  const otherTimers = manualTimers();
  const otherSurface = createBackgroundApprovalSurface({ browserApi: other.browserApi, translate, ...otherTimers });
  otherSurface.noteVisible('other-id');
  otherSurface.show({ approvalId: 'this-id' }, deferred().promise);
  await flush();
  await otherTimers.fire();
  assert.equal(other.calls.created.length, 1, 'a confirmation for a different request does not suppress this one');
});

test('a confirmation that arrives during the grace period keeps the window closed', async () => {
  const { browserApi, calls } = fakeBrowser();
  const timers = manualTimers();
  const surface = createBackgroundApprovalSurface({ browserApi, translate, ...timers });
  surface.show({ approvalId: 'p4' }, deferred().promise);
  await flush();
  assert.equal(calls.created.length, 0);
  surface.noteVisible('p4');
  await timers.fire();
  assert.equal(calls.created.length, 0, 'the panel reported in time');
});

test('a worker restart clears the toolbar notice and closes approval windows whose request is gone', async () => {
  const { browserApi, calls } = fakeBrowser();
  const tabRemoved = [];
  browserApi.runtime.getManifest = () => ({ action: { default_title: '__MSG_openExtension__' } });
  browserApi.i18n = { getMessage: (name) => (name === 'openExtension' ? 'Open Hermes' : '') };
  browserApi.tabs = { remove: async (id) => { tabRemoved.push(id); } };
  browserApi.runtime.getContexts = async ({ contextTypes }) => (contextTypes.includes('TAB') ? [
    { contextType: 'TAB', tabId: 71, windowId: 701, documentUrl: `chrome-extension://fixture/${BACKGROUND_APPROVAL_PAGE}?approval=old` },
    { contextType: 'TAB', tabId: 72, windowId: 702, documentUrl: 'chrome-extension://fixture/sidepanel-preview.html' },
  ] : []);
  createBackgroundApprovalSurface({ browserApi, translate });
  await flush();
  assert.equal(calls.badge.at(-1), '', 'the badge from the previous worker is cleared');
  assert.equal(calls.titles.at(-1), 'Open Hermes', 'the toolbar title returns to the manifest default');
  assert.deepEqual(tabRemoved, [71], 'only the approval window of the previous worker closes');
});

test('the startup sweep keeps the window of a request that is still waiting', async () => {
  const { browserApi, calls } = fakeBrowser();
  const tabRemoved = [];
  browserApi.tabs = { remove: async (id) => { tabRemoved.push(id); } };
  let contextsAsked;
  const asked = new Promise((resolve) => { contextsAsked = resolve; });
  browserApi.runtime.getContexts = async ({ contextTypes }) => {
    if (!contextTypes.includes('TAB')) return [];
    await asked;
    return [{ contextType: 'TAB', tabId: 81, windowId: 801, documentUrl: `chrome-extension://fixture/${BACKGROUND_APPROVAL_PAGE}?approval=live` }];
  };
  const surface = createBackgroundApprovalSurface({ browserApi, translate });
  surface.show({ approvalId: 'live' }, deferred().promise);
  contextsAsked();
  await flush(20);
  assert.deepEqual(tabRemoved, []);
  assert.equal(calls.badge.at(-1), '1', 'a request that arrives during the sweep keeps its badge');
});

test('the startup sweep tolerates a browser without context lookup', async () => {
  const { browserApi, calls } = fakeBrowser();
  createBackgroundApprovalSurface({ browserApi, translate });
  await flush();
  assert.equal(calls.badge.at(-1), '');
});

test('an open approval window re-checks its request and says when it is no longer waiting', async () => {
  const { document } = parseHTML(readFileSync(new URL('../extension/background-approval.html', import.meta.url), 'utf8'));
  const timers = manualTimers();
  const win = new globalThis.EventTarget();
  let alive = true;
  let asks = 0;
  const page = createBackgroundApprovalPage({
    doc: document, approvalId: 'a1', t: (key) => key, translateText: (text) => text,
    win, ...timers,
    sendMessage: async (message) => {
      if (message.type !== BACKGROUND_APPROVAL_GET) return { ok: true };
      asks += 1;
      return { ok: true, approval: alive ? { approvalId: 'a1', action: 'browser_click', reason: 'Click?' } : null };
    },
    closeWindow: () => {},
  });
  await page.load();
  assert.equal(document.getElementById('backgroundApprovalApprove').hidden, false);
  assert.equal(timers.pending().length, 1, 'the window keeps checking while the request waits');
  await timers.fire();
  assert.equal(asks, 2);
  assert.equal(document.getElementById('backgroundApprovalApprove').hidden, false);
  alive = false;
  win.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(document.getElementById('backgroundApprovalReason').textContent, 'browser_control.approval_window_gone');
  assert.equal(document.getElementById('backgroundApprovalApprove').hidden, true);
  assert.equal(document.getElementById('backgroundApprovalClose').hidden, false);
  assert.equal(timers.pending().length, 0, 'a gone request stops the re-check');
});

test('the panel reports it is showing a request only while visible with the card on screen, and the heartbeat keeps that report fresh', async () => {
  assert.equal(backgroundApprovalVisibleNow({
    visibilityState: 'visible', dialogOpen: true, approveVisible: true,
    approvalId: 'a1', controllerId: 'background-x',
  }), 'a1');
  for (const state of [
    { visibilityState: 'hidden', dialogOpen: true, approveVisible: true, approvalId: 'a1', controllerId: 'background-x' },
    { visibilityState: 'visible', dialogOpen: false, approveVisible: true, approvalId: 'a1', controllerId: 'background-x' },
    { visibilityState: 'visible', dialogOpen: true, approveVisible: false, approvalId: 'a1', controllerId: 'background-x' },
    { visibilityState: 'visible', dialogOpen: true, approveVisible: true, approvalId: '', controllerId: 'background-x' },
    { visibilityState: 'visible', dialogOpen: true, approveVisible: true, approvalId: 'a1', controllerId: 'manual' },
  ]) {
    assert.equal(backgroundApprovalVisibleNow(state), '', JSON.stringify(state));
  }

  const sent = [];
  const timers = manualTimers();
  let state = {
    visibilityState: 'visible', dialogOpen: true, approveVisible: true,
    approvalId: 'a1', controllerId: 'background-x',
  };
  const heartbeat = createBackgroundApprovalVisibleHeartbeat({
    getState: () => state,
    sendMessage: (message) => { sent.push(message); },
    ...timers,
    heartbeatMs: VISIBLE_HEARTBEAT_MS,
  });
  heartbeat.pulse();
  assert.deepEqual(sent, [{ type: BACKGROUND_APPROVAL_VISIBLE, approvalId: 'a1' }]);
  await timers.fire();
  assert.equal(sent.length, 2, 'the heartbeat repeats while the card stays visible');
  state = { ...state, visibilityState: 'hidden' };
  await timers.fire();
  assert.equal(sent.length, 2, 'a hidden panel stops confirming');
  assert.equal(timers.pending().length, 0);

  state = {
    visibilityState: 'visible', dialogOpen: true, approveVisible: true,
    approvalId: 'a1', controllerId: 'background-x',
  };
  heartbeat.pulse();
  assert.equal(sent.length, 3);
  heartbeat.stop();
  assert.equal(timers.pending().length, 0, 'stop cancels the next heartbeat');
});
