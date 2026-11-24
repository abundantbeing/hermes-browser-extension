import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parseHTML } from 'linkedom';

import {
  BACKGROUND_APPROVAL_GET,
  BACKGROUND_APPROVAL_PAGE,
  createBackgroundApprovalPage,
  createBackgroundApprovalSurface,
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
  const surface = createBackgroundApprovalSurface({ browserApi, translate });
  const settled = deferred();
  surface.show({ approvalId: 'a 1' }, settled.promise);
  surface.show({ approvalId: 'a 1' }, settled.promise);
  await flush();
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
  const surface = createBackgroundApprovalSurface({ browserApi, translate });
  const first = deferred();
  surface.show({ approvalId: 'a1' }, first.promise);
  await flush();
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
  const gone = createBackgroundApprovalPage({
    doc: document, approvalId: 'missing', t: (key) => key, translateText: (text) => text,
    sendMessage: async () => ({ ok: true, approval: null }), closeWindow: () => {},
  });
  await gone.load();
  assert.equal(document.getElementById('backgroundApprovalReason').textContent, 'browser_control.approval_window_gone');
  assert.equal(document.getElementById('backgroundApprovalApprove').hidden, true);
  assert.equal(document.getElementById('backgroundApprovalReject').hidden, true);
});

test('the approval page has no hardcoded copy and needs no new manifest permission', () => {
  const html = readFileSync(new URL('../extension/background-approval.html', import.meta.url), 'utf8');
  for (const key of ['browser_control.kicker', 'browser_control.approval_needed', 'browser_control.approve_once', 'browser_control.reject']) {
    assert.match(html, new RegExp(`data-i18n="${key.replace(/\./g, '\\.')}"`));
  }
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.permissions.includes('notifications'), false);
});
