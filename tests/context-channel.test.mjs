// The context card asks Hermes for the viewed session's breakdown over a session socket the panel opens on
// demand, by the session's durable id (REST chat included), and what it learns about a model's window feeds
// the model list. The panel's REAL wiring is sliced from extension/sidepanel.js and run in a VM.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers';

import * as store from '../extension/lib/session-context-store.mjs';
import { createSessionLineage } from '../extension/lib/session-lineage.mjs';
import { createReplayWatermarks } from '../extension/lib/replay-watermarks.mjs';
import { gatewayModelContext, GATEWAY_MODEL_CONTEXT_STORAGE_KEY } from '../extension/lib/gateway-model-context.mjs';
import { normalizeHermesModels } from '../extension/lib/common.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not slice ${from}`);
  return source.slice(start, end);
};
const contextSource = between('let sessionContextStore = emptySessionContextStore();', 'let dragDepth = 0;');
const settle = () => new Promise((resolve) => setImmediate(resolve));

const breakdown = (extra = {}) => ({
  categories: [{ id: 'system_prompt', label: 'System prompt', tokens: 16_200 }, { id: 'conversation', label: 'Conversation', tokens: 3_000 }],
  context_max: 500_000, context_percent: 4, context_used: 19_200, context_source: 'provider_usage', context_estimated: false, estimated_total: 19_200, model: 'gpt-6.1-sol', ...extra,
});

function fakeSocket(answers) {
  const calls = [];
  return {
    readyState: 1, readyPayload: { session_authority: true }, calls,
    request: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(params) : answer;
    },
    on: () => () => {},
  };
}

function panel({ models = [], signIn = false, openSocket = null } = {}) {
  const timers = [];
  const storage = {};
  const renders = [];
  const opened = [];
  gatewayModelContext.clear();
  const context = vm.createContext({
    ...store,
    createSessionLineage,
    createReplayWatermarks,
    gatewayModelContext,
    GATEWAY_MODEL_CONTEXT_STORAGE_KEY,
    normalizeHermesModels,
    console,
    Date,
    browserApi: {
      storage: { local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, JSON.parse(storage[key])])),
        set: async (values) => { for (const [key, value] of Object.entries(values)) storage[key] = JSON.stringify(value); },
      } },
    },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: () => {},
    document: { hidden: false },
    settings: { sessionId: 'rest-session-1', model: 'openai::gpt-6.1-sol' },
    availableModels: models,
    activeConversationTransport: 'rest',
    activeDashboardWsConnection: null,
    profileWsConnection: null,
    sessionAuthoritySideSocket: () => context.profileWsConnection?.client || null,
    WS_METHODS: { sessionStats: 'session.stats', sessionUsage: 'session.usage', contextBreakdown: 'session.context_breakdown' },
    WS_EVENTS: { messageComplete: 'message.complete' },
    renderContextWindow: () => { renders.push('render'); },
    renderModelOptions: () => { renders.push('models'); },
    isRemoteWsMode: () => false,
    accountSignInOffered: () => signIn,
    refreshCapabilityViews: () => {},
    refreshGatewaySocket: async () => {
      opened.push('open');
      if (!openSocket) return null;
      const client = openSocket();
      context.profileWsConnection = { client };
      return context.profileWsConnection;
    },
  });
  vm.runInContext(contextSource, context);
  const run = (code) => vm.runInContext(code, context);
  return { context, run, opened, renders, timers, storage, entry: (id) => run(`sessionContextEntry(sessionContextStore, ${JSON.stringify(id)})`) };
}

test('a REST chat with no socket opens the session socket, then reads usage and breakdown by the durable id', async () => {
  const socket = fakeSocket({ 'session.context_breakdown': breakdown(), 'session.stats': { context_tokens: 19_200, context_length: 500_000, model: 'gpt-6.1-sol' } });
  const p = panel({ openSocket: () => socket });
  assert.equal(p.run('dashboardContextTarget()'), null);
  assert.equal(p.run('refreshSessionContextTelemetry()'), true, 'an attempt to open the channel is under way');
  assert.equal(p.run('contextChannelState()'), 'open', 'the card shows loading, not the no-socket text, while it opens');
  await settle(); await settle();
  assert.deepEqual(p.opened, ['open']);
  assert.deepEqual(socket.calls.map((call) => [call.method, call.params.session_id]), [['session.stats', 'rest-session-1'], ['session.context_breakdown', 'rest-session-1']]);
  assert.equal(p.entry('rest-session-1').breakdown.categories.length, 2);
  assert.equal(p.run('contextChannelState()'), 'open');
});

test('with no way to open a socket the card says so, and a Hermes account sign-in is offered where it would help', async () => {
  const none = panel();
  none.run('refreshSessionContextTelemetry()');
  await settle(); await settle();
  assert.equal(none.run('contextChannelState()'), 'none');
  const offered = panel({ signIn: true });
  offered.run('refreshSessionContextTelemetry()');
  await settle(); await settle();
  assert.equal(offered.run('contextChannelState()'), 'sign-in');
});

test('a failed attempt to open the socket is not repeated on every call, and a forced refresh tries again', async () => {
  const p = panel();
  p.run('refreshSessionContextTelemetry()');
  await settle(); await settle();
  assert.equal(p.run('refreshSessionContextTelemetry()'), false);
  assert.equal(p.run('refreshSessionContextTelemetry({ force: true })'), true);
  await settle(); await settle();
  assert.equal(p.opened.length, 2);
});

test('no session never opens a socket', () => {
  const p = panel();
  p.run("settings = { ...settings, sessionId: '' }");
  assert.equal(p.run('refreshSessionContextTelemetry()'), false);
  assert.deepEqual(p.opened, []);
});

test('a session the gateway does not hold is reported as such and not retried on the ladder', async () => {
  const notFound = Object.assign(new Error('not_found'), { data: { reason: 'not_found' } });
  const socket = fakeSocket({ 'session.context_breakdown': notFound, 'session.stats': notFound });
  const p = panel({ openSocket: () => socket });
  p.run('refreshSessionContextTelemetry()');
  await settle(); await settle(); await settle();
  assert.equal(p.run("sessionContextFailures.get('rest-session-1')"), 'not-held');
  assert.equal(p.timers.length, 0, 'no retry timer for a session that does not exist there');
  assert.equal(socket.calls.filter((call) => call.method === 'session.context_breakdown').length, 1);
});

test('a window a session reports is learned for that model and reaches the model list', async () => {
  const models = normalizeHermesModels([{ id: 'gpt-6.1-sol', provider: 'openai' }]);
  const socket = fakeSocket({ 'session.context_breakdown': breakdown(), 'session.stats': { context_tokens: 19_200, context_length: 500_000, model: 'gpt-6.1-sol', provider: 'openai' } });
  const p = panel({ models, openSocket: () => socket });
  p.run('refreshSessionContextTelemetry()');
  await settle(); await settle();
  assert.equal(gatewayModelContext.lookup({ rawModelId: 'gpt-6.1-sol', provider: 'openai' }), 500_000);
  assert.equal(p.run("availableModels.find((model) => model.rawModelId === 'gpt-6.1-sol').contextTokens"), 500_000);
  assert.ok(p.renders.includes('models'), 'the model list redrew');
  gatewayModelContext.clear();
});

test('the learned windows persist and come back on the next open', async () => {
  const first = panel();
  first.run("noteGatewayModelContext({ model: 'gpt-6.1-sol', tokens: 500000, source: 'model-info' })");
  first.timers.shift().fn();
  await settle();
  const stored = JSON.parse(first.storage[GATEWAY_MODEL_CONTEXT_STORAGE_KEY]);
  gatewayModelContext.clear();
  const second = panel();
  second.storage[GATEWAY_MODEL_CONTEXT_STORAGE_KEY] = JSON.stringify(stored);
  await second.run('loadGatewayModelContext()');
  assert.equal(gatewayModelContext.lookup({ rawModelId: 'gpt-6.1-sol' }), 500_000);
  gatewayModelContext.clear();
});

test('wiring: the catalog hook, the context-socket opener and the card channel are connected in the panel', () => {
  assert.match(source, /noteModelCatalogForGatewayContext\(registryModels, \{ refresh \}\);/);
  assert.match(source, /channel: contextChannelState\(\),/);
  assert.match(source, /if \(!target\) return openContextChannel\(\{ force \}\);/);
  assert.match(source, /await loadGatewayModelContext\(\);/);
});
