import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installGroupLifecycleHarness } from './helpers/group-lifecycle-harness.mjs';
import { prepareBotBrowserTurn } from '../extension/lib/bot-browser-turn.mjs';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const start = source.indexOf('async function sendActiveGroupMessage(');
const sendSource = source.slice(start, source.indexOf('\n// Desktop-parity threads strip', start));
const tab = { id: 7, url: 'https://example.com/docs', title: 'Documentation' };
const screenshot = { browserTabScreenshot: true, tabId: 7, tabUrl: tab.url, dataUrl: 'data:image/png;base64,aGVsbG8=' };

function harness({ collect } = {}) {
  const sent = [];
  const statuses = [];
  const context = {
    activeGroupProjection: { id: 'room-1', displayName: 'Demo room' },
    activeGroupRuntime: { send: async (turn) => { sent.push(turn); return { ok: true, failures: [], messages: [] }; } },
    activeGroupGeneration: 1, activeGroupMessages: [], activeGroupDisplayEvents: [],
    activeGroupPresence: { phase: 'idle' }, activeGroupAbortController: null,
    activeGroupThreadId: '', activeGroupPendingNewThread: false,
    activeGroupExpandedThreads: new Set(), activeGroupTypingMembers: new Map(), messages: [], sending: false,
    AbortController, els: { input: { value: '' } },
    groupRuntimeMembers: () => [{ name: 'demo' }], groupProjectionEntryFromDisplayMessage: (row) => row,
    renderAttachments() {}, updateComposerBusyState() {}, renderGroupThreadStrip() {},
    renderMessagesFromStorage() {}, updateSessionLabel() {}, renderActiveProfileIndicator() {},
    resetActiveGroupTypingIndicator() {}, setStatus: (...args) => statuses.push(args),
    contextScope: { mode: 'follow-active' }, settings: { gatewayUrl: 'http://127.0.0.1:8642' }, browserApi: {},
    effectiveContextGate: (scope) => ({ allowed: scope.mode !== 'chat-only', scope }),
    prepareBotBrowserTurn,
    collectBotPageContext: collect || (async () => ({ activeTab: tab, tabs: [tab], pageContext: { text: 'Approved page' } })),
  };
  vm.createContext(context);
  installGroupLifecycleHarness(context, source);
  vm.runInContext(`${sendSource}\nthis.send = sendActiveGroupMessage;`, context);
  return { context, sent, statuses };
}

test('the actual side-panel group handler forwards explicit tab screenshots', async () => {
  const { context, sent } = harness();
  assert.equal(await context.send('Review this page', [screenshot]), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].screenshotAttachments[0].data, screenshot.dataUrl);
});

test('ordinary group file attachments remain unsupported', async () => {
  const { context, sent } = harness();
  assert.equal(await context.send('Review this file', [{ kind: 'file' }]), false);
  assert.equal(sent.length, 0);
});

test('revoking context consent during collection prevents the group send', async () => {
  let release;
  const { context, sent } = harness({ collect: () => new Promise((resolve) => { release = resolve; }) });
  const pending = context.send('Review this page');
  context.contextScope = { mode: 'chat-only' };
  release({ activeTab: tab, tabs: [tab], pageContext: { text: 'No longer approved' } });
  assert.equal(await pending, false);
  assert.equal(sent.length, 0);
});

// ---- composer ownership and truthful omission (audit: bot-context) ----------
function composerHarness({ gatewayUrl = 'http://127.0.0.1:8642', collect, gate } = {}) {
  const forgotten = [];
  const persisted = [];
  const { context, sent, statuses } = harness({ collect });
  context.settings = { gatewayUrl };
  if (gate) context.effectiveContextGate = gate;
  context.els.input.value = 'Review this page';
  context.attachments = [{ id: 's1', ...screenshot }];
  context.forgetComposerDraft = () => forgotten.push(true);
  context.persistCurrentComposerDraft = (options) => persisted.push(options);
  return { context, sent, statuses, forgotten, persisted };
}

test('a refused preflight leaves the draft, the screenshot and a pending new thread in the composer', async () => {
  const { context, sent, statuses, forgotten } = composerHarness({
    collect: async () => ({ activeTab: { ...tab, id: 99 }, tabs: [{ ...tab, id: 99 }], pageContext: { text: 'Other page' } }),
  });
  context.activeGroupPendingNewThread = true;
  assert.equal(await context.send('Review this page', [...context.attachments]), false);
  assert.equal(sent.length, 0);
  assert.equal(context.els.input.value, 'Review this page');
  assert.equal(context.attachments.length, 1);
  assert.equal(forgotten.length, 0);
  assert.equal(context.activeGroupPendingNewThread, true);
  assert.match(statuses.at(-1)[2], /still in the composer/);
});

test('a dispatched group turn consumes its text and its tab screenshot, so the shot never rides along with the next message', async () => {
  const { context, sent, forgotten } = composerHarness();
  assert.equal(await context.send('Review this page', [...context.attachments]), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].screenshotAttachments.length, 1);
  assert.equal(context.els.input.value, '');
  assert.deepEqual(context.attachments, []);
  assert.equal(forgotten.length, 1, 'the stored draft is forgotten too');
});

test('an attachment typed in while the turn was preparing is not swallowed', async () => {
  let release;
  const { context } = composerHarness({ collect: () => new Promise((resolve) => { release = resolve; }) });
  const pending = context.send('Review this page', [...context.attachments]);
  context.attachments = [...context.attachments, { id: 'late', browserTabScreenshot: true }];
  release({ activeTab: tab, tabs: [tab], pageContext: { text: 'Approved page' } });
  await pending;
  assert.deepEqual(context.attachments.map((item) => item.id), ['late']);
});

test('a remote room still sends chat-only, and the status says the page was not shared', async () => {
  const { context, sent, statuses } = composerHarness({ gatewayUrl: 'https://hermes.example' });
  context.attachments = [];
  assert.equal(await context.send('Review this page', []), true);
  assert.equal(sent[0].browserContext.enabled, false);
  const last = statuses.at(-1);
  assert.equal(last[0], 'warn');
  assert.match(last[2], /not shared/i);
});

test('a screenshot with no message explains why nothing was sent', async () => {
  const { context, sent, statuses } = composerHarness();
  context.els.input.value = '';
  assert.equal(await context.send('', [...context.attachments]), false);
  assert.equal(sent.length, 0);
  assert.equal(context.attachments.length, 1);
  assert.match(statuses.at(-1)[1], /message/i);
});

test('a member retry drops cached page context once the panel is chat-only or the connection is remote', async () => {
  const retries = [];
  const { context } = harness();
  context.renderGroupTypingIndicator = () => {};
  context.activeGroupRuntime = { retryMember: async (turn) => { retries.push(turn); return { ok: true, failures: [], messages: [] }; } };
  context.activeGroupMessages = [{ role: 'user', content: 'hi' }];
  vm.runInContext(`${sendSource}\nthis.retry = retryFailedGroupMember;`, context);
  await context.retry('alpha');
  assert.equal(retries.at(-1).allowCachedContext, true);
  context.contextScope = { mode: 'chat-only' };
  context.effectiveContextGate = (scope) => ({ allowed: true, scope });
  await context.retry('alpha');
  assert.equal(retries.at(-1).allowCachedContext, false);
  context.contextScope = { mode: 'follow-active' };
  context.settings = { gatewayUrl: 'https://hermes.example' };
  await context.retry('alpha');
  assert.equal(retries.at(-1).allowCachedContext, false);
});
