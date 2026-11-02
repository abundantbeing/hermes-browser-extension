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
async function panel({ reply = 'A drafted reply.', running = false } = {}) {
  const h = await createSettingsSaveHarness({ settings: { sessionId: 'chat-current', sessionTitle: 'My chat' } });
  const sent = [];
  const asks = [];
  const drafts = [];
  const removed = [];
  Object.assign(h.scope, {
    INLINE_DRAFT_STORAGE_KEY: 'hermesBrowserInlineDraftRequest',
    inlineDraftProcessing: false,
    inlineDraftHandoffsReady: true,
    lastInlineDraftRequestId: '',
    sending: false,
    gatewayCapabilities: {},
    isAttachedPanelResidency: () => false,
    isRemoteWsMode: () => false,
    viewedSessionIsRunning: () => running,
    loadSessions: async () => undefined,
    resolveInlineDraftPrompt: async (request) => buildInlineDraftPrompt(request),
    beginHermesBrowserDraft: async (options) => {
      drafts.push(options);
      h.scope.settings = { ...h.scope.settings, sessionId: 'chat-new', sessionTitle: options.title };
      return { id: 'chat-new', title: options.title, draft: true };
    },
    askHermes: async (text, attachments, options) => {
      asks.push({ text, options, sessionId: h.scope.settings.sessionId });
      if (running) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await options.onComplete?.(reply);
      return true;
    },
  });
  h.scope.browserApi.storage.session = { remove: async (key) => { removed.push(key); } };
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

test('two Assist titles made in the same second still differ, since the gateway refuses a repeated title', async () => {
  const { h } = await panel();
  const title = h.fn('assistSessionTitle');
  const at = new Date('2026-11-02T04:13:21Z');
  assert.notEqual(title(rawRequest('new', { requestId: 'req-aaaa' }), at), title(rawRequest('new', { requestId: 'req-bbbb' }), at));
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
