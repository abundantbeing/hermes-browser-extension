// Issue #130: a model picked before the first message (a draft session, or the
// default placeholder id on a fresh install) must stick. The gateway answers a
// model lock for a session it does not have yet with 404 session_not_found, and
// Test connection must not call the saved model missing because of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as common from '../extension/lib/common.mjs';
import { selectedModelReadiness } from '../extension/lib/readiness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(root, 'extension/sidepanel.js'), 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `sidepanel.js still defines ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `sidepanel.js still has ${end} after ${start}`);
  return source.slice(from, to);
};

const GROK = { id: 'xai::grok-4.7', rawModelId: 'grok-4.7', label: 'grok-4.7', provider: 'xai', providerLabel: 'xAI', source: 'registry', runtimeSelectable: true };
const HAIKU = { id: 'anthropic::claude-haiku-5-5', rawModelId: 'claude-haiku-5-5', label: 'claude-haiku-5-5', provider: 'anthropic', providerLabel: 'Anthropic', source: 'registry', runtimeSelectable: true };
const CATALOG = [GROK, HAIKU];
const DEFAULT_ID = common.DEFAULT_SETTINGS.sessionId;
const DRAFT_ID = 'hermes-browser-extension-20261029120000-abc123';
const NOT_FOUND = { status: 404, body: { error: { message: 'Session not found: x', code: 'session_not_found' } } };

function panel({ sessionId = DEFAULT_ID, sessions = [], lockAnswer = NOT_FOUND, createdSessions = null } = {}) {
  const calls = [];
  const statuses = [];
  const writes = [];
  const settings = {
    ...common.DEFAULT_SETTINGS,
    sessionId,
    model: GROK.id,
    extensionPreferredModel: { modelId: GROK.id, rawModelId: GROK.rawModelId, provider: 'xai', contextTokens: 0 },
    sessionModelBindings: {},
  };
  const context = vm.createContext({
    settings,
    availableModels: CATALOG,
    availableSessions: sessions,
    gatewayCapabilities: { sessionModelLock: true },
    modelSelectionVersion: 1,
    pendingModelRuntimeAck: { version: 1, model: 'grok-4.7', provider: 'xai' },
    DEFAULT_SETTINGS: common.DEFAULT_SETTINGS,
    isUnsavedBrowserDraftSession: common.isUnsavedBrowserDraftSession,
    isModelLockDraftMiss: common.isModelLockDraftMiss,
    shouldRequireModelLock: common.shouldRequireModelLock,
    modelRuntimeAckState: common.modelRuntimeAckState,
    updateBrowserModelScope: common.updateBrowserModelScope,
    modelDisplayName: common.modelDisplayName,
    translateUiText: (text) => text,
    t: (key) => key,
    usesDashboardWsChatTransport: () => false,
    encodeSessionId: encodeURIComponent,
    currentModelOptionsPayload: () => ({}),
    currentSelectedModel: () => GROK,
    currentModelProviderSlug: () => 'xai',
    currentModelRequestId: () => 'grok-4.7',
    readJsonResponse: async (response) => response.payload,
    renderModelOptions() {},
    setStatus: (kind, title, detail) => statuses.push({ kind, title, detail }),
    browserApi: { storage: { local: { set: async (value) => { writes.push(value); } } } },
    apiFetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      const answer = typeof lockAnswer === 'function' ? lockAnswer({ createdSessions }) : lockAnswer;
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, payload: answer.body };
    },
  });
  vm.runInContext([
    between('async function requestSessionModelLock(', 'async function syncSessionModelLock('),
    between('async function syncSessionModelLock(', 'async function ensureActiveSessionModelLockOrThrow('),
    between('async function ensureActiveSessionModelLockOrThrow(', 'function renderModelRefreshState('),
    'function applyPendingModelRuntimeAck(runtime = {}) {' + between('function applyPendingModelRuntimeAck(runtime = {}) {', 'function applyTurnRuntimePayload(').slice('function applyPendingModelRuntimeAck(runtime = {}) {'.length),
  ].join('\n'), context);
  return { context, calls, statuses, writes };
}

function pick(tab) {
  return tab.context.syncSessionModelLock(GROK, {
    previousId: 'hermes-agent',
    previousBinding: null,
    requestedDetail: 'xAI · grok-4.7',
  });
}

test('draft ids are the default placeholder and the extension timestamp ids, never a listed session', () => {
  assert.equal(common.isDraftSessionForModelPick({ sessionId: DEFAULT_ID, sessions: [] }), true);
  assert.equal(common.isDraftSessionForModelPick({ sessionId: DRAFT_ID, sessions: [] }), true);
  assert.equal(common.isDraftSessionForModelPick({ sessionId: DEFAULT_ID, sessions: [{ id: DEFAULT_ID }] }), false);
  assert.equal(common.isDraftSessionForModelPick({ sessionId: 'my-old-chat', sessions: [] }), false, 'a saved session that is gone is not a draft');
  assert.equal(common.isDraftSessionForModelPick({ sessionId: '', sessions: [] }), false);
});

test('#130: a session_not_found on the default placeholder id keeps the pick pending', async () => {
  const tab = panel({ sessionId: DEFAULT_ID });
  const outcome = await pick(tab);
  assert.equal(outcome.state, 'pending');
  assert.equal(tab.context.settings.model, GROK.id, 'the pick is not rolled back to hermes-agent');
  assert.equal(tab.context.settings.extensionPreferredModel.modelId, GROK.id);
  assert.ok(tab.context.pendingModelRuntimeAck, 'the first turn still confirms the pick');
  assert.equal(tab.writes.length, 0, 'nothing rewrote the stored settings');
  assert.equal(tab.statuses.at(-1).kind, 'warn');
  assert.match(tab.statuses.at(-1).detail, /first message/);
});

test('#130: the same holds for an extension draft id the loaded list does not know', async () => {
  const tab = panel({ sessionId: DRAFT_ID });
  // Timestamped drafts are recognised before any request is made.
  const outcome = await pick(tab);
  assert.equal(outcome.state, 'pending');
  assert.equal(tab.context.settings.model, GROK.id);
  assert.equal(tab.calls.length, 0);
});

test('#130: a missing session that is not a draft is still reported and rolled back', async () => {
  const tab = panel({ sessionId: 'my-old-chat', sessions: [{ id: 'other' }] });
  const outcome = await pick(tab);
  assert.equal(outcome.state, 'failed');
  assert.equal(tab.context.settings.model, 'hermes-agent', 'the pick is restored');
  assert.equal(tab.statuses.at(-1).kind, 'error');
  assert.equal(tab.statuses.at(-1).title, 'Model lock failed');
});

test('a default-id session the gateway does know still gets a real lock error reported', async () => {
  const tab = panel({ sessionId: DEFAULT_ID, sessions: [{ id: DEFAULT_ID }], lockAnswer: { status: 404, body: { error: { message: 'Session not found', code: 'session_not_found' } } } });
  const outcome = await pick(tab);
  assert.equal(outcome.state, 'failed', 'a listed session cannot be "not created yet"');
});

test('other lock failures on a draft are still failures', async () => {
  const tab = panel({ sessionId: DEFAULT_ID, lockAnswer: { status: 403, body: { error: { message: 'forbidden', code: 'forbidden' } } } });
  const outcome = await pick(tab);
  assert.equal(outcome.state, 'failed');
  assert.equal(tab.context.settings.model, 'hermes-agent');
});

test('#130: the first send applies the pending pick once the session exists', async () => {
  const tab = panel({
    sessionId: DEFAULT_ID,
    lockAnswer: { status: 200, body: { runtime: { provider: 'xai', model: 'grok-4.7', model_lock: 'accepted' } } },
  });
  assert.equal(await tab.context.ensureActiveSessionModelLockOrThrow(), true);
  assert.equal(tab.calls.length, 1);
  assert.match(tab.calls[0].url, /\/api\/sessions\/hermes-browser-extension\/model$/);
  assert.equal(tab.context.pendingModelRuntimeAck, null, 'the acknowledgement cleared the pending pick');
  assert.equal(tab.statuses.at(-1).title, 'Hermes model confirmed');
});

test('the first send still fails loudly when the lock is refused', async () => {
  const tab = panel({ sessionId: 'my-old-chat', sessions: [{ id: 'x' }] });
  await assert.rejects(() => tab.context.ensureActiveSessionModelLockOrThrow(), /Session not found/);
});

test('#130: Test connection does not fail "Selected model" for the gateway default or a draft pick', () => {
  const alias = { model: 'hermes-agent' };
  // A catalog without the alias row (the startup cache never stores it).
  assert.equal(selectedModelReadiness({ settings: alias, availableModels: CATALOG }).status, 'ready');
  assert.equal(selectedModelReadiness({
    settings: { model: 'riku', extensionPreferredModel: { modelId: 'riku', gatewayDefault: true } },
    availableModels: CATALOG,
  }).status, 'ready');
  // A draft with a pick the catalog does not list yet.
  const draft = selectedModelReadiness({ settings: { model: 'anthropic::claude-opus-5-5' }, availableModels: CATALOG, draftSession: true });
  assert.equal(draft.status, 'observed');
  assert.equal(draft.selectedModel.id, 'anthropic::claude-opus-5-5');
  // A saved session whose model is gone is still an error.
  assert.equal(selectedModelReadiness({ settings: { model: 'anthropic::claude-opus-5-5' }, availableModels: CATALOG }).status, 'error');
  // No pick at all is not a draft pick.
  assert.equal(selectedModelReadiness({ settings: { model: '' }, availableModels: CATALOG, draftSession: true }).status, 'error');
});

test('the panel readiness run hands the draft state to the selected-model check', () => {
  assert.match(source, /selectModel: async \(\) => selectedModelReadiness\(\{[\s\S]*?draftSession: isDraftSessionForModelPick\(/);
});

test('a selected-model failure leaves New chat reachable on the startup card', () => {
  const offers = between('function startupOffersNewChat() {', 'let newSessionButtonHome');
  assert.match(offers, /steps\?\.selectedModel\?\.status === 'error'/);
  // The topbar button moves into the startup actions only for that failure, and is enabled there.
  assert.match(source, /if \(newChat && newSessionButtonHome && startupOffersNewChat\(\)\) actions\.append\(newChat\)/);
  assert.match(source, /els\.newSessionButton\.disabled = view\.visible && !startupOffersNewChat\(\)/);
  const css = readFileSync(path.join(root, 'extension/sidepanel.css'), 'utf8');
  assert.match(css, /body\.startup-active \.startup-actions #newSessionButton \{/);
});
