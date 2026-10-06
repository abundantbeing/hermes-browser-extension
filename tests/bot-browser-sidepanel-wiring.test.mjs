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
