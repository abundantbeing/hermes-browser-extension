import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BROWSER_ACTION_PROTOCOL,
  BROWSER_ACTION_TYPES,
  browserActionApprovalPolicy,
  normalizeBrowserActionRequest,
  sanitizeBrowserActionResult,
  validateBrowserActionRequest,
} from '../extension/lib/browser-actions.mjs';
import { installBrowserActionBridge } from '../extension/lib/browser-action-bridge.mjs';

test('browser action protocol exposes only the reviewed v1 allow-list', () => {
  assert.equal(BROWSER_ACTION_PROTOCOL.id, 'hermes.browser.actions.v1');
  assert.deepEqual(BROWSER_ACTION_TYPES, [
    'getSnapshot', 'screenshot', 'scroll', 'click', 'typeText', 'select', 'openUrl',
  ]);
  for (const type of ['submitForm', 'readCookies', 'history', 'bookmarks', 'nativeMessaging']) {
    assert.deepEqual(validateBrowserActionRequest({ type }), { ok: false, reason: 'unsupported_action' });
  }
});

test('restricted and browser-internal URLs are blocked before dispatch', () => {
  for (const url of [
    'https://bank.example/login',
    'https://shop.example/checkout',
    'https://example.test/password-manager',
    'https://wallet.example/',
    'https://medical.example/account',
    'https://irs.gov/pay',
    'chrome://settings',
    'file:///tmp/secret',
  ]) {
    assert.equal(validateBrowserActionRequest({ type: 'openUrl', url }).reason, 'restricted_url', url);
  }
  assert.equal(validateBrowserActionRequest({ type: 'openUrl', url: 'https://docs.example/path' }).ok, true);
});

test('mutating actions require approval while snapshot, screenshot, and scroll do not', () => {
  for (const type of ['click', 'typeText', 'select', 'openUrl']) {
    const policy = browserActionApprovalPolicy({ type });
    assert.equal(policy.mutatesPage, true, type);
    assert.equal(policy.requiresApproval, true, type);
  }
  for (const type of ['getSnapshot', 'screenshot', 'scroll']) {
    const policy = browserActionApprovalPolicy({ type });
    assert.equal(policy.mutatesPage, false, type);
    assert.equal(policy.requiresApproval, false, type);
  }
});

test('normalization redacts typed text and reduces URLs to their origin in previews', () => {
  const normalized = normalizeBrowserActionRequest({
    type: 'typeText',
    target: { selector: '#prompt' },
    value: 'password=hunter2',
    url: 'https://docs.example/private?token=secret',
  });
  assert.equal(normalized.url, 'https://docs.example/');
  assert.equal(normalized.value, 'password=hunter2');
  assert.equal(normalized.preview.value, 'password=[REDACTED_SECRET]');
  assert.equal(normalized.requiresApproval, true);
});

test('targeted actions require a target and approved mutations cannot bypass policy', () => {
  assert.equal(validateBrowserActionRequest({ type: 'click' }).reason, 'missing_target');
  assert.equal(validateBrowserActionRequest({ type: 'typeText', target: { selector: '#x' } }).ok, true);
});

test('result sanitizer keeps screenshot pixels extension-side', () => {
  const result = sanitizeBrowserActionResult({
    ok: true,
    actionType: 'screenshot',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,SECRET_PIXELS',
    text: 'untrusted page content',
  });
  assert.deepEqual(result, {
    ok: true,
    actionType: 'screenshot',
    mimeType: 'image/png',
    hasDataUrl: true,
  });
  assert.equal(JSON.stringify(result).includes('SECRET_PIXELS'), false);
  assert.equal(JSON.stringify(result).includes('untrusted page content'), false);
});

test('gateway bridge auto-runs read-only requests and reports sanitized result', async () => {
  const listeners = new Map();
  const requests = [];
  const client = {
    on(type, handler) { listeners.set(type, handler); return () => listeners.delete(type); },
    async request(method, params) { requests.push({ method, params }); return { ok: true }; },
  };
  installBrowserActionBridge({
    client,
    sessionId: () => 'sid',
    runtime: { async sendMessage() { return { ok: true, actionType: 'screenshot', mimeType: 'image/png', dataUrl: 'data:image/png;base64,PIXELS' }; } },
    requestApproval: async () => { throw new Error('read-only action must not prompt'); },
  });
  await listeners.get('browser.action.requested')({
    sessionId: 'sid',
    payload: { request_id: 'req-1', action: { type: 'screenshot' } },
  });
  assert.equal(requests[0].method, 'browser.action.result');
  assert.deepEqual(requests[0].params.result, {
    ok: true, actionType: 'screenshot', mimeType: 'image/png', hasDataUrl: true,
  });
});

test('gateway bridge requires fresh explicit approval for mutations and reports denial', async () => {
  const listeners = new Map();
  const requests = [];
  let executed = false;
  let approvalRequests = 0;
  const client = {
    on(type, handler) { listeners.set(type, handler); return () => listeners.delete(type); },
    async request(method, params) { requests.push({ method, params }); return { ok: true }; },
  };
  installBrowserActionBridge({
    client,
    sessionId: () => 'sid',
    runtime: { async sendMessage() { executed = true; return { ok: true }; } },
    requestApproval: async () => { approvalRequests += 1; return false; },
  });
  await listeners.get('browser.action.requested')({
    sessionId: 'sid',
    payload: { request_id: 'req-2', action: { type: 'click', target: { selector: '#save' }, approvedByUser: true } },
  });
  assert.equal(approvalRequests, 1);
  assert.equal(executed, false);
  assert.deepEqual(requests[0].params.result, { ok: false, reason: 'denied_by_user', actionType: 'click' });
});

test('gateway bridge ignores requests until its exact session is active', async () => {
  const listeners = new Map();
  const requests = [];
  let activeSessionId = '';
  const client = {
    on(type, handler) { listeners.set(type, handler); return () => listeners.delete(type); },
    async request(method, params) { requests.push({ method, params }); return { ok: true }; },
  };
  installBrowserActionBridge({
    client,
    sessionId: () => activeSessionId,
    runtime: { async sendMessage() { throw new Error('must not execute'); } },
  });
  const event = {
    sessionId: 'sid',
    payload: { request_id: 'req-session', action: { type: 'scroll' } },
  };
  await listeners.get('browser.action.requested')(event);
  activeSessionId = 'other-sid';
  await listeners.get('browser.action.requested')(event);
  assert.deepEqual(requests, []);
});

test('content and sidepanel sources preserve approval and no-submit guardrails', () => {
  const content = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(content, /HERMES_BROWSER_ACTION/);
  assert.match(content, /approvedByUser/);
  assert.doesNotMatch(content, /\.submit\s*\(/);
  assert.match(sidepanel, /browser\.action\.requested/);
  assert.match(sidepanel, /browser-action-approval-card/);
  assert.match(sidepanel, /browser\.action\.result/);
});
