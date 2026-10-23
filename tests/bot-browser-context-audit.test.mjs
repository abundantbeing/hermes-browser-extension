import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBotBrowserTurn, groupBrowserContextAllowed } from '../extension/lib/bot-browser-turn.mjs';
import { collectBotPageContext } from '../extension/lib/bot-browser-capture.mjs';
import { MAX_TURN_SCREENSHOTS, MAX_TURN_SCREENSHOT_CHARS } from '../extension/lib/screenshot-limits.mjs';
import { createBotGroupRuntime } from '../extension/lib/bot-group-runtime.mjs';
import { prepareTabScreenshotAttachment, resolveBotBrowserContext } from '../extension/lib/bot-browser-bridge.mjs';

const tab = { id: 7, windowId: 2, active: true, url: 'https://example.com/docs', title: 'Documentation' };
const getContext = async () => ({ activeTab: tab, tabs: [tab], pageContext: { text: 'Page content' } });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const shot = (n = 0) => ({ browserTabScreenshot: true, tabId: 7, tabUrl: tab.url, dataUrl: PNG, label: `s${n}.png` });

test('a turn carries a bounded number of tab screenshots', async () => {
  const ok = await prepareBotBrowserTurn({ gatewayUrl: 'http://127.0.0.1:8642', scope: { mode: 'follow-active' }, getContext,
    attachments: Array.from({ length: MAX_TURN_SCREENSHOTS }, (_, i) => shot(i)) });
  assert.equal(ok.screenshotAttachments.length, MAX_TURN_SCREENSHOTS);
  await assert.rejects(prepareBotBrowserTurn({ gatewayUrl: 'http://127.0.0.1:8642', scope: { mode: 'follow-active' }, getContext,
    attachments: Array.from({ length: MAX_TURN_SCREENSHOTS + 1 }, (_, i) => shot(i)) }), /at most|too many/i);
});

test('the combined size of tab screenshots is bounded', async () => {
  const big = `data:image/png;base64,${'A'.repeat(Math.floor(MAX_TURN_SCREENSHOT_CHARS / 2) + 1000)}`;
  await assert.rejects(prepareBotBrowserTurn({ gatewayUrl: 'http://127.0.0.1:8642', scope: { mode: 'follow-active' }, getContext,
    attachments: [{ ...shot(1), dataUrl: big }, { ...shot(2), dataUrl: big }] }), /too large|combined|size/i);
});

test('group context is allowed only for a non-chat-only scope on a loopback gateway', () => {
  assert.equal(groupBrowserContextAllowed({ scope: { mode: 'follow-active' }, gatewayUrl: 'http://127.0.0.1:8642' }), true);
  assert.equal(groupBrowserContextAllowed({ scope: { mode: 'chat-only' }, gatewayUrl: 'http://127.0.0.1:8642' }), false);
  assert.equal(groupBrowserContextAllowed({ scope: { mode: 'follow-active' }, gatewayUrl: 'https://hermes.example' }), false);
  assert.equal(groupBrowserContextAllowed({ scope: { mode: 'follow-active' }, gatewayUrl: '' }), false);
});

test('a granted consent ledger or cached positive capability never opens a remote group turn', async () => {
  const settings = {
    browserContextConsentLedger: { version: 1, entries: { any: { granted: true } } },
    gatewayCapabilities: { browserContextProvider: true, imageSessionAttach: true },
  };
  const result = await prepareBotBrowserTurn({ group: true, gatewayUrl: 'https://hermes.example', scope: { mode: 'follow-active' }, settings,
    getContext: () => assert.fail('a remote group must not read the page') });
  assert.equal(result.browserContext.enabled, false);
  await assert.rejects(prepareBotBrowserTurn({ group: true, gatewayUrl: 'https://hermes.example', scope: { mode: 'follow-active' }, settings,
    getContext: () => assert.fail('no read'), attachments: [shot(0)] }), /disabled/i);
});

test('page context is read from the panel window, not whichever window was focused last', async () => {
  const queries = [];
  await collectBotPageContext({
    browserApi: { tabs: {
      query: async (q) => { queries.push(q); return [tab]; },
      get: async () => tab,
      sendMessage: async () => ({ ok: true, url: tab.url, text: 'x' }),
    } },
    scope: { mode: 'follow-active' }, settings: { includePageText: true },
  });
  assert.equal(queries.length, 1);
  assert.equal(queries[0].currentWindow, true);
  assert.equal(queries[0].lastFocusedWindow, undefined);
});

function makeClient() {
  const listeners = new Map();
  const calls = [];
  const prompts = [];
  const emit = (type, event) => { for (const handler of listeners.get(type) || []) handler(event); };
  return {
    calls, prompts,
    client: {
      on(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler); return () => listeners.get(type)?.delete(handler); },
      request: async (method, params = {}) => {
        calls.push({ method, params });
        if (method === 'session.list') return { sessions: [{ id: `stored-${params.profile}`, title: params.title }] };
        if (method === 'session.resume' || method === 'session.create') return { session_id: `live-${params.profile}`, stored_session_id: `stored-${params.profile}`, info: { profile_name: params.profile } };
        if (method === 'image.attach_bytes') return { attached: true, path: `staged-${params.filename}` };
        if (method === 'image.detach') return { detached: true };
        if (method === 'prompt.submit') {
          prompts.push(params.text);
          queueMicrotask(() => emit('message.complete', { sessionId: params.session_id, payload: { text: 'reply' } }));
          return { accepted: true };
        }
        return {};
      },
    },
  };
}

test('a retry does not re-send page context or screenshots the user has since withdrawn', async () => {
  const { client, prompts, calls } = makeClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const context = resolveBotBrowserContext({ scopeMode: 'follow-active', activeTab: tab, pageContext: { text: 'secret offer' } });
  const screenshot = prepareTabScreenshotAttachment(PNG, { tabId: 7 });
  await runtime.send({ roomId: 'r', groupName: 'R', members: ['alpha', 'beta'], text: 'hi', browserContext: context, screenshotAttachments: [screenshot] });
  prompts.length = 0; calls.length = 0;
  await runtime.retryMember({ roomId: 'r', groupName: 'R', members: ['alpha', 'beta'], messages: [{ role: 'user', content: 'hi', ts: 1 }], member: 'alpha', allowCachedContext: false });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].includes('secret offer'), false);
  assert.equal(calls.some(({ method }) => method === 'image.attach_bytes'), false);
});

// ---- composer settle, outcome note, receipt, envelope attachments ----------
import { settleGroupComposer } from '../extension/lib/group-composer-settle.mjs';
import { describeGroupContextOutcome } from '../extension/lib/bot-browser-turn.mjs';
import { buildGroupContextReceipt } from '../extension/lib/group-context-receipt.mjs';
import { formatGroupTurnWithBrowserContext } from '../extension/lib/group-turn-context.mjs';
import { groupProjectionEntryFromDisplayMessage } from '../extension/lib/bot-group-runtime.mjs';

test('sending clears exactly the text and attachments the turn carried, nothing the user added meanwhile', () => {
  const a = { id: 'a' }; const b = { id: 'b' };
  assert.deepEqual(settleGroupComposer({ draft: 'hello', attachments: [a, b] }, { text: 'hello', attachments: [a] }),
    { draft: '', attachments: [b], empty: false });
  assert.deepEqual(settleGroupComposer({ draft: 'hello and more', attachments: [a] }, { text: 'hello', attachments: [a] }),
    { draft: 'hello and more', attachments: [], empty: false });
  assert.deepEqual(settleGroupComposer({ draft: ' hello ', attachments: [a] }, { text: 'hello', attachments: [a] }),
    { draft: '', attachments: [], empty: true });
});

test('a turn that omitted requested page context says why, without leaking anything', () => {
  const off = resolveBotBrowserContext({ scopeMode: 'chat-only' });
  assert.equal(describeGroupContextOutcome({ scope: { mode: 'chat-only' }, gatewayUrl: 'http://127.0.0.1:8642', browserContext: off }).note, '');
  const remote = describeGroupContextOutcome({ scope: { mode: 'follow-active' }, gatewayUrl: 'https://hermes.example', browserContext: off });
  assert.equal(remote.shared, false);
  assert.equal(remote.reason, 'remote-group');
  assert.match(remote.note, /not shared/i);
  const restricted = resolveBotBrowserContext({ scopeMode: 'follow-active', activeTab: { id: 1, url: 'chrome://settings' } });
  const r = describeGroupContextOutcome({ scope: { mode: 'follow-active' }, gatewayUrl: 'http://127.0.0.1:8642', browserContext: restricted });
  assert.equal(r.reason, 'restricted-url');
  assert.doesNotMatch(r.note, /chrome:/);
  const on = resolveBotBrowserContext({ scopeMode: 'follow-active', activeTab: tab, pageContext: { text: 't' } });
  const ok = describeGroupContextOutcome({ scope: { mode: 'follow-active' }, gatewayUrl: 'http://127.0.0.1:8642', browserContext: on });
  assert.deepEqual([ok.shared, ok.note], [true, '']);
});

test('the group receipt names the page, the screenshots and every addressed member, and no page text', () => {
  const on = resolveBotBrowserContext({ scopeMode: 'follow-active', activeTab: tab, pageContext: { text: 'private body text' } });
  const receipt = buildGroupContextReceipt({ browserContext: on, screenshots: [prepareTabScreenshotAttachment(PNG, { tabId: 7 })], members: [{ name: 'alpha' }, { name: 'beta', title: 'Beta' }] });
  const flat = JSON.stringify(receipt);
  assert.match(flat, /Documentation/);
  assert.match(flat, /alpha/);
  assert.match(flat, /Beta/);
  assert.doesNotMatch(flat, /private body text/);
  assert.equal(buildGroupContextReceipt({ browserContext: resolveBotBrowserContext({ scopeMode: 'chat-only' }), screenshots: [], members: [{ name: 'alpha' }] }), null);
});

test('the user message in a group turn carries the receipt for display only, never the projection', async () => {
  const { client } = makeClient();
  const seen = [];
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000, onMessage: (message, meta) => { if (meta.kind === 'user') seen.push(message); } });
  const context = resolveBotBrowserContext({ scopeMode: 'follow-active', activeTab: tab, pageContext: { text: 'body' } });
  const result = await runtime.send({ roomId: 'r', groupName: 'R', members: ['alpha', 'beta'], text: '@alpha hi', browserContext: context });
  assert.ok(seen[0].contextReceipt?.items?.length);
  assert.match(JSON.stringify(seen[0].contextReceipt), /alpha/);
  assert.doesNotMatch(JSON.stringify(seen[0].contextReceipt), /beta/, 'only the addressed member is named');
  assert.equal(result.messages.find((m) => m.role === 'user').contextReceipt, seen[0].contextReceipt);
  assert.equal(groupProjectionEntryFromDisplayMessage(seen[0]).contextReceipt, undefined);
  const plain = [];
  const chatOnly = createBotGroupRuntime({ client: makeClient().client, timeoutMs: 1000, onMessage: (message, meta) => { if (meta.kind === 'user') plain.push(message); } });
  await chatOnly.send({ roomId: 'r', groupName: 'R', members: ['alpha', 'beta'], text: 'hi' });
  assert.equal(plain[0].contextReceipt, undefined);
});

test('a group envelope lists the screenshot that accompanies it', () => {
  const on = resolveBotBrowserContext({ scopeMode: 'follow-active', activeTab: tab, pageContext: { text: 'body' } });
  const shotAttachment = prepareTabScreenshotAttachment(PNG, { tabId: 7, title: 'Documentation' });
  const withShot = JSON.parse(formatGroupTurnWithBrowserContext('hello', on, { attachments: [shotAttachment] }));
  assert.equal(withShot.attachment_context.items.length, 1);
  assert.equal(withShot.attachment_context.items[0].kind, 'image');
  assert.equal(withShot.attachment_context.items[0].mime_type, 'image/png');
  assert.equal(JSON.stringify(withShot).includes('iVBORw0KGgo'), false, 'pixels never ride in the envelope');
  const without = JSON.parse(formatGroupTurnWithBrowserContext('hello', on));
  assert.equal(without.attachment_context?.items?.length || 0, 0);
});
