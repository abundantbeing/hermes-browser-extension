import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsSaveHarness } from './helpers/settings-save-harness.mjs';
import { INLINE_DRAFT_MODE, INLINE_DRAFT_SCHEMA, INLINE_DRAFT_VERSION, buildInlineDraftPrompt } from '../extension/lib/inline-draft-policy.mjs';

const PAGE = 'https://www.youtube.com/watch?v=abc123';

function rawRequest(route, overrides = {}) {
  return {
    schema: INLINE_DRAFT_SCHEMA,
    version: INLINE_DRAFT_VERSION,
    mode: INLINE_DRAFT_MODE,
    requestId: `req-${route}-1`,
    documentId: 'doc-12345678',
    actionId: 'reply',
    actionLabel: 'Draft a reply',
    startsFromPage: true,
    route,
    draftText: '',
    fieldLabel: 'Add a comment',
    pageContext: 'A video about pixel art.',
    adapterId: 'youtube',
    pageUrl: PAGE,
    tabId: 9,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

// The real processInlineDraftRequest from sidepanel.js; the chat itself (askHermes, a new chat) is recorded.
async function panel({ reply = 'A drafted reply.', running = false, refuseModel = false, windowId = 0, history = [{ role: 'user', content: 'Earlier message' }] } = {}) {
  const h = await createSettingsSaveHarness({ settings: { sessionId: 'chat-current', sessionTitle: 'My chat' } });
  const sent = [];
  const asks = [];
  const drafts = [];
  const removed = [];
  Object.assign(h.scope, {
    INLINE_DRAFT_STORAGE_KEY: 'hermesBrowserInlineDraftRequest',
    inlineDraftProcessing: false,
    deferredInlineDraftRequests: [],
    inlineDraftDraining: false,
    deferredInlineDraftTimer: 0,
    inlineDraftHandoffsReady: true,
    lastInlineDraftRequestId: '',
    sending: false,
    messages: history,
    gatewayCapabilities: {},
    isAttachedPanelResidency: () => false,
    isRemoteWsMode: () => false,
    viewedSessionIsRunning: () => running,
    loadSessions: async () => undefined,
    resolveInlineDraftPrompt: async (request) => buildInlineDraftPrompt(request),
    refreshContextConsentLedger: async (source) => source,
    inlineDraftRequestForEffectiveContext: (request) => request,
    beginHermesBrowserDraft: async (options) => {
      drafts.push(options);
      h.scope.settings = { ...h.scope.settings, sessionId: 'chat-new', sessionTitle: options.title };
      return { id: 'chat-new', title: options.title, draft: true };
    },
    askHermes: async (text, attachments, options) => {
      asks.push({ text, options, sessionId: h.scope.settings.sessionId });
      if (running) return false;
      // The gateway refuses the turn's own model before taking the turn (its provider stopped working).
      if (refuseModel && options.modelRoute?.model) {
        options.onNotAccepted?.(Object.assign(new Error('Model gpt-6.1-terra is not available.'), { httpStatus: 400, requestRejected: true }));
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      await options.onComplete?.(reply);
      return true;
    },
  });
  h.scope.browserApi.storage.session = { remove: async (key) => { removed.push(key); } };
  h.scope.inlineDraftPanelWindowId = null;
  if (windowId) h.scope.browserApi.windows = { getCurrent: async () => ({ id: windowId }) };
  h.scope.browserApi.tabs = {
    get: async (tabId) => ({ id: tabId, url: PAGE }),
    sendMessage: async (tabId, message) => { sent.push({ tabId, message }); },
  };
  return { h, sent, asks, drafts, removed, process: h.fn('processInlineDraftRequest') };
}

test('Continue current chat sends a visible turn in the open chat, showing what was asked and where', async () => {
  const { process, asks, drafts, sent, h } = await panel();
  assert.equal(await process(rawRequest('current')), true);
  assert.equal(drafts.length, 0, 'no new chat');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].sessionId, 'chat-current');
  assert.equal(asks[0].options.displayUserText, `Hermes Assist · Draft a reply\n${PAGE}`);
  assert.ok(!h.callsTo('fetch').some((call) => /\/chat$/.test(call.args[0])), 'no hidden REST turn');
  const result = sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT');
  assert.equal(result.message.ok, true);
  assert.equal(result.message.text, 'A drafted reply.');
  assert.equal(result.message.sessionId, 'chat-current');
});

test('Start new Assist session opens a new chat named for Assist and the site, then sends the turn there', async () => {
  const { process, asks, drafts, sent } = await panel();
  assert.equal(await process(rawRequest('new')), true);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].title, /^Hermes Assist · YouTube · /);
  assert.equal(drafts[0].focus, false);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].sessionId, 'chat-new');
  assert.equal(asks[0].options.displayUserText, `Hermes Assist · Draft a reply\n${PAGE}`);
  const result = sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT');
  assert.equal(result.message.sessionId, 'chat-new');
  assert.match(result.message.sessionTitle, /^Hermes Assist · YouTube · /);
});

test('two Start new Assist session chats made in the same second get different titles, as the gateway requires', async () => {
  const { process, drafts } = await panel();
  await process(rawRequest('new', { requestId: 'req-new-aaaa' }));
  await process(rawRequest('new', { requestId: 'req-new-bbbb' }));
  assert.equal(drafts.length, 2);
  assert.notEqual(drafts[0].title, drafts[1].title);
});

test('the same request reaching a freshly opened panel twice sends one turn', async () => {
  const { process, asks } = await panel();
  const request = rawRequest('current');
  await Promise.all([process(request), process(request)]);
  assert.equal(asks.length, 1);
});

test('a request that arrives while the panel is still starting waits for the startup check', async () => {
  const { process, asks, removed, h } = await panel();
  h.scope.inlineDraftHandoffsReady = false;
  assert.equal(await process(rawRequest('current')), false);
  assert.equal(asks.length, 0);
  assert.deepEqual(removed, [], 'the request stays queued for the startup check');
});

test('a chat still running elsewhere says so on the page instead of a vague failure', async () => {
  const { process, sent } = await panel({ running: true });
  assert.equal(await process(rawRequest('current')), false);
  const result = sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT');
  assert.equal(result.message.ok, false);
  assert.match(result.message.reason, /still working in this chat/);
  assert.match(result.message.reason, /Start new Assist session/);
});

test('Continue current chat into a chat with nothing in it yet names that chat for Assist too', async () => {
  const { process, asks, drafts } = await panel({ history: [] });
  assert.equal(await process(rawRequest('current')), true);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].title, /^Hermes Assist · YouTube · /);
  assert.equal(asks[0].sessionId, 'chat-new');
});

// What the page's Assist options saved while this panel was open (the panel's own copy is older).
const PAGE_SAVED_ASSIST = {
  inlineAssistModel: 'openai-codex::gpt-6.1-terra',
  inlineAssistRawModel: 'gpt-6.1-terra',
  inlineAssistProvider: 'openai-codex',
  inlineAssistReasoningEffort: 'high',
  inlineAssistThinkingEnabled: true,
};
const ASSIST_TURN = {
  model: 'gpt-6.1-terra',
  provider: 'openai-codex',
  require_model_lock: false,
  reasoning_effort: 'high',
  fast: false,
  model_options: { reasoning: { enabled: true, effort: 'high' }, reasoning_effort: 'high', fast: false, service_tier: null },
};

for (const route of ['current', 'new']) {
  test(`${route === 'current' ? 'Continue current chat' : 'Start new Assist session'} runs the turn on the model and effort picked for Assist`, async () => {
    const { process, asks, sent, h } = await panel();
    h.scope.gatewayCapabilities = { sessionChat: true, sessionModelLock: true };
    await h.scope.browserApi.storage.local.set({ hermesBrowserSettings: { ...h.scope.settings, ...PAGE_SAVED_ASSIST } });
    assert.equal(await process(rawRequest(route)), true);
    // For that turn only: the chat keeps its own model lock for the next message.
    assert.deepEqual(asks[0].options.modelRoute, ASSIST_TURN);
    const result = sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT');
    assert.equal(result.message.modelNotice, '');
  });
}

test('the page is told when the thread was not sent because page context is off for this connection', async () => {
  const { process, sent, h } = await panel();
  h.scope.gatewayCapabilities = { sessionChat: true, sessionModelLock: true };
  h.scope.refreshContextConsentLedger = async (source) => source;
  h.scope.inlineDraftRequestForEffectiveContext = (request) => ({ ...request, pageContext: '', pageUrl: '', fieldLabel: '' });
  await process(rawRequest('current'));
  const withheld = sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT');
  assert.equal(withheld.message.contextWithheld, true);

  const shared = await panel();
  shared.h.scope.gatewayCapabilities = { sessionChat: true, sessionModelLock: true };
  shared.h.scope.refreshContextConsentLedger = async (source) => source;
  shared.h.scope.inlineDraftRequestForEffectiveContext = (request) => request;
  await shared.process(rawRequest('current'));
  assert.equal(shared.sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT').message.contextWithheld, false);
});

test('a request from a page in another window is left for that window\'s side panel', async () => {
  const other = await panel({ windowId: 8 });
  assert.equal(await other.process(rawRequest('new', { windowId: 7 })), false);
  assert.equal(other.asks.length, 0, 'no turn sent from the wrong window');
  assert.deepEqual(other.removed, [], 'and the request is left for the right panel');
  const own = await panel({ windowId: 7 });
  assert.equal(await own.process(rawRequest('new', { windowId: 7 })), true);
  assert.equal(own.asks.length, 1);
});

test('two requests arriving while the panel looks up its window run one at a time, each in its own chat', async () => {
  const { h, asks, drafts, sent, process } = await panel();
  h.scope.browserApi.windows = { getCurrent: () => new Promise((resolve) => setTimeout(() => resolve({ id: 7 }), 10)) };
  const results = await Promise.all([
    process(rawRequest('new', { requestId: 'req-new-a1', windowId: 7 })),
    process(rawRequest('new', { requestId: 'req-new-b2', windowId: 7 })),
  ]);
  assert.deepEqual(results, [true, false], 'the second waits for the first');
  assert.equal(drafts.length, 1, 'one new chat');
  assert.equal(asks.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(drafts.length, 2, 'then the second starts its own chat');
  assert.equal(asks.length, 2);
  const results2 = sent.filter((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT').map((item) => item.message.requestId);
  assert.deepEqual(results2, ['req-new-a1', 'req-new-b2'], 'and both pages get their draft');
});

test('a request arriving while another runs is kept and runs when that one finishes', async () => {
  const { asks, sent, process } = await panel();
  const first = process(rawRequest('current', { requestId: 'req-cur-a1' }));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await process(rawRequest('current', { requestId: 'req-cur-b2' })), false, 'busy now');
  assert.equal(await first, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(asks.length, 2);
  const done = sent.filter((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT').map((item) => item.message.requestId);
  assert.deepEqual(done, ['req-cur-a1', 'req-cur-b2']);
});

test('a request arriving as a run ends waits behind the ones already kept', async () => {
  const { asks, sent, process } = await panel();
  const first = process(rawRequest('current', { requestId: 'req-cur-a1' }));
  await new Promise((resolve) => setTimeout(resolve, 1));
  await process(rawRequest('current', { requestId: 'req-cur-b2' }));
  await first;
  assert.equal(await process(rawRequest('new', { requestId: 'req-new-c3' })), false, 'behind the kept one');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const done = sent.filter((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT').map((item) => item.message.requestId);
  assert.deepEqual(done, ['req-cur-a1', 'req-cur-b2', 'req-new-c3']);
  assert.deepEqual(asks.map((ask) => ask.sessionId), ['chat-current', 'chat-current', 'chat-new'], 'the kept Continue current chat stays in the current chat');
});

test('a request that comes while this panel is sending is kept and runs once the send ends', async () => {
  const { h, asks, sent, process } = await panel();
  h.scope.sending = true;
  assert.equal(await process(rawRequest('current', { requestId: 'req-cur-a1' })), false);
  setTimeout(() => { h.scope.sending = false; }, 100);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(asks.length, 1);
  assert.deepEqual(sent.filter((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT').map((item) => item.message.requestId), ['req-cur-a1']);
});

test('a kept request from another window does not hold up the next one kept for this window', async () => {
  const { asks, sent, process } = await panel({ windowId: 7 });
  const first = process(rawRequest('current', { requestId: 'req-cur-a1', windowId: 7 }));
  await new Promise((resolve) => setTimeout(resolve, 1));
  await process(rawRequest('current', { requestId: 'req-cur-b2', windowId: 8 }));
  await process(rawRequest('current', { requestId: 'req-cur-c3', windowId: 7 }));
  await first;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(asks.length, 2);
  const done = sent.filter((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT').map((item) => item.message.requestId);
  assert.deepEqual(done, ['req-cur-a1', 'req-cur-c3']);
});

test('when the gateway refuses the Assist model before taking the turn, the turn runs on the chat\'s model at Assist\'s effort, and says so', async () => {
  const { process, asks, sent, h } = await panel({ refuseModel: true });
  h.scope.gatewayCapabilities = { sessionChat: true, sessionModelLock: true };
  await h.scope.browserApi.storage.local.set({ hermesBrowserSettings: { ...h.scope.settings, ...PAGE_SAVED_ASSIST } });
  assert.equal(await process(rawRequest('current')), true);
  assert.equal(asks.length, 2, 'one retry');
  assert.equal(asks[1].options.modelRoute.model, undefined, 'on the chat\'s model');
  assert.equal(asks[1].options.modelRoute.model_options.reasoning.effort, 'high', 'at Assist\'s effort');
  const result = sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT');
  assert.equal(result.message.ok, true);
  assert.match(result.message.modelNotice, /gpt-6\.1-terra.*Used this chat's model instead\./);
});

test('with no Assist model the chat\'s model runs, at the effort picked for Assist', async () => {
  const { process, asks, h } = await panel();
  h.scope.gatewayCapabilities = { sessionChat: true, sessionModelLock: true };
  await h.scope.browserApi.storage.local.set({ hermesBrowserSettings: { ...h.scope.settings, inlineAssistModel: '', inlineAssistRawModel: '', inlineAssistProvider: '', inlineAssistReasoningEffort: 'minimal' } });
  await process(rawRequest('current'));
  assert.equal(asks[0].options.modelRoute.model, undefined);
  assert.equal(asks[0].options.modelRoute.model_options.reasoning.effort, 'minimal');
});

test('over the dashboard connection, which cannot switch a chat\'s model for one turn, the page is told which model ran', async () => {
  const { process, asks, sent, h } = await panel();
  h.scope.gatewayCapabilities = { sessionChat: true, sessionModelLock: true };
  h.scope.usesDashboardWsChatTransport = () => true;
  await h.scope.browserApi.storage.local.set({ hermesBrowserSettings: { ...h.scope.settings, ...PAGE_SAVED_ASSIST } });
  await process(rawRequest('current'));
  assert.equal(asks[0].options.modelRoute, null);
  const result = sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT');
  assert.match(result.message.modelNotice, /could not enforce openai-codex \/ gpt-6\.1-terra .*Used this chat's model instead\./);
});

test('a turn request carries the Assist override while that turn is sent, and the chat\'s own model otherwise', async () => {
  const { h } = await panel();
  Object.assign(h.scope, {
    currentModelRequestId: () => 'chat-model',
    currentModelProviderSlug: () => 'chat-provider',
    currentModelOptionsPayload: () => ({ reasoning: { enabled: true, effort: 'medium' } }),
    currentSelectedModel: () => null,
  });
  const fields = h.fn('turnModelFields');
  h.scope.turnModelRoute = null;
  assert.equal(fields().model, 'chat-model');
  assert.equal(fields().require_model_lock, true);
  h.scope.turnModelRoute = ASSIST_TURN;
  assert.deepEqual(fields(), { model: 'gpt-6.1-terra', provider: 'openai-codex', model_options: ASSIST_TURN.model_options, require_model_lock: false });
  // No Assist model: the chat's model, at Assist's effort.
  h.scope.turnModelRoute = { model_options: { reasoning: { enabled: true, effort: 'minimal' } } };
  assert.equal(fields().model, 'chat-model');
  assert.equal(fields().model_options.reasoning.effort, 'minimal');

  const { sidepanelSource } = await import('./helpers/settings-save-harness.mjs');
  const ask = sidepanelSource.slice(sidepanelSource.indexOf('async function askHermes('), sidepanelSource.indexOf('\n}\n', sidepanelSource.indexOf('async function askHermes(')));
  assert.match(ask, /turnModelRoute = dashboardTransport \? null : \(turnOptions\.modelRoute \|\| null\);\n {2}try \{/);
  assert.match(ask, /\} finally \{\n {4}turnModelRoute = null;/);
  for (const name of ['streamSessionChatRest', 'fallbackSessionChat']) {
    const body = sidepanelSource.slice(sidepanelSource.indexOf(`async function ${name}(`), sidepanelSource.indexOf('\n}\n', sidepanelSource.indexOf(`async function ${name}(`)));
    assert.match(body, /\.\.\.turnModelFields\(\)/, name);
    assert.doesNotMatch(body, /model: currentModelRequestId\(\)/, name);
  }
  for (const name of ['streamChatCompletions', 'fallbackChatCompletions']) {
    const body = sidepanelSource.slice(sidepanelSource.indexOf(`async function ${name}(`), sidepanelSource.indexOf('\n}\n', sidepanelSource.indexOf(`async function ${name}(`)));
    assert.match(body, /\.\.\.turnCompletionModelFields\(\)/, name);
  }
});

test('an effort picked on the page reaches an open panel\'s settings, so its next save keeps it', async () => {
  const { h } = await panel();
  h.scope.renderInlineAssistRuntimeOptions = () => {};
  h.fn('adoptInlineAssistEffortChange')({ inlineAssistReasoningEffort: 'ultra', inlineAssistThinkingEnabled: true });
  assert.equal(h.scope.settings.inlineAssistReasoningEffort, 'ultra');
  assert.equal(h.scope.settings.inlineAssistThinkingEnabled, true);
});

test('the draft sent back to the field is Hermes\'s final reply, not text written before a tool call', async () => {
  const { process, sent, h } = await panel({ reply: 'First take.\n\nFinal reply.' });
  h.scope.fetchSessionMessagesQuietly = async () => ({ messages: [
    { role: 'user', content: 'Earlier' },
    { role: 'assistant', content: 'An earlier answer.' },
    { role: 'user', content: 'Hermes Assist · Draft a reply' },
    { role: 'assistant', content: 'First take.', tool_calls: [{ id: 'call_1' }] },
    { role: 'tool', content: '{"skill":"unslop"}' },
    { role: 'assistant', content: 'Final reply.' },
  ] });
  await process(rawRequest('current'));
  const result = sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT');
  assert.equal(result.message.text, 'Final reply.');
});

test('when the chat\'s history cannot be read, the draft is the reply as it streamed', async () => {
  const { process, sent, h } = await panel({ reply: 'Streamed reply.' });
  h.scope.fetchSessionMessagesQuietly = async () => { throw new Error('offline'); };
  await process(rawRequest('current'));
  assert.equal(sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT').message.text, 'Streamed reply.');
});

test('a turn whose final reply is not stored yet never takes an earlier turn\'s answer', async () => {
  const { process, sent, h } = await panel({ reply: 'This turn.' });
  h.scope.fetchSessionMessagesQuietly = async () => ({ messages: [
    { role: 'assistant', content: 'An earlier answer.' },
    { role: 'user', content: 'Hermes Assist · Draft a reply' },
  ] });
  await process(rawRequest('current'));
  assert.equal(sent.find((item) => item.message.type === 'HERMES_INLINE_DRAFT_RESULT').message.text, 'This turn.');
});
