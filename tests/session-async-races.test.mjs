import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setImmediate } from 'node:timers';
import { applyModelOptionPick } from '../extension/lib/session-runtime-pick.mjs';
import { sessionRuntimeFromSnapshot } from '../extension/lib/gateway-ws.mjs';
import { modelOptionsRuntimeAckState } from '../extension/lib/common.mjs';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
function fn(name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}\\(`).test(line));
  assert.ok(start >= 0, name);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end++;
  return lines.slice(start, end + 1).join('\n');
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function modelHarness(switchPromise) {
  const applied = [];
  const connection = { wsStoredSessionId: 'A', client: { readyPayload: { session_authority: true }, request: async () => ({}) } };
  const c = vm.createContext({
    settings: { sessionId: 'A', model: 'new', modelContextTokens: 100, sessionModelBindings: {}, activeProfile: 'p' },
    modelSelectionVersion: 1, sessionLoadRequestId: 1, modelSwitchWriteQueues: new Map(),
    scopeRevision: { current: () => 1, isCurrent: (n) => n === 1 },
    usesDashboardWsChatTransport: () => true,
    ensureActiveDashboardWsConnection: async () => connection,
    ensureRemoteWsSession: async () => 'A',
    switchSessionModel: () => switchPromise,
    currentModelProviderSlug: () => 'p', modelProviderLabel: () => 'p', modelDisplayName: () => 'new',
    modelRuntimeAckState: () => ({ state: 'confirmed' }),
    applySessionRuntimeSnapshot: (data) => applied.push(data), applyPendingModelRuntimeAck: () => {},
    setStatus: () => {}, updateBrowserModelScope: () => ({ sessionModelBindings: {}, extensionPreferredModel: {} }),
    browserApi: { storage: { local: { set: async () => {} } } }, renderModelOptions: () => {}, availableModels: [], pendingModelRuntimeAck: {},
  });
  vm.runInContext(`${fn('switchAuthoritySessionModel')}\n${fn('syncSessionModelLock')}`, c);
  return { c, applied };
}
for (const fail of [false, true]) {
  test(`model ${fail ? 'refusal' : 'ack'} from A cannot affect session B`, async () => {
    const gate = deferred();
    const { c, applied } = modelHarness(gate.promise);
    const task = c.syncSessionModelLock({ id: 'new', provider: 'p' }, { previousId: 'old' });
    await new Promise((r) => setImmediate(r));
    c.settings = { ...c.settings, sessionId: 'B', model: 'B-model' };
    c.sessionLoadRequestId++;
    if (fail) gate.reject(new Error('refused')); else gate.resolve({ status: 'switched', runtime: { model: 'new', provider: 'p' } });
    await task;
    assert.equal(c.settings.model, 'B-model');
    assert.ok(applied.every((entry) => entry.sessionId !== 'B'));
  });
}

test('rapid model switches serialize and do not let an old acknowledgement win', async () => {
  const firstGate = deferred();
  const { c, applied } = modelHarness(firstGate.promise);
  const sent = [];
  let backend = '';
  c.switchSessionModel = async (_request, pick) => {
    sent.push(pick.model);
    if (pick.model === 'old-pick') await firstGate.promise;
    backend = pick.model;
    return { status: 'switched', runtime: { model: pick.model, provider: 'p' } };
  };
  const first = c.syncSessionModelLock({ id: 'old-pick', provider: 'p' }, { previousId: 'before' });
  await new Promise((r) => setImmediate(r));
  c.modelSelectionVersion++;
  c.settings.model = 'new-pick';
  const second = c.syncSessionModelLock({ id: 'new-pick', provider: 'p' }, { previousId: 'old-pick' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['old-pick']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(sent, ['old-pick', 'new-pick']);
  assert.equal(backend, 'new-pick');
  assert.deepEqual(applied.map((entry) => entry.runtime.model), ['new-pick']);
});

test('an option read missing Fast metadata is not called confirmed', async () => {
  const client = { request: async (method) => method === 'session.resume' ? { info: { reasoning_effort: 'low' } } : {} };
  const c = vm.createContext({
    settings: { sessionId: 'A', activeProfile: 'p' }, modelOptionSelectionVersion: 1,
    modelOptionWriteQueues: new Map(), sessionRuntimeFromSnapshot, modelOptionsRuntimeAckState,
    sessionLoadRequestId: 1, scopeRevision: { current: () => 1, isCurrent: (n) => n === 1 },
    authoritySessionConnection: () => ({ wsSessionId: 'A', client }), applyModelOptionPick, setStatus: () => {},
  });
  vm.runInContext(fn('syncSessionModelOptions'), c);
  const result = await c.syncSessionModelOptions({ sessionId: 'A', optionVersion: 1, requestedOptions: { thinkingEnabled: true, reasoningEffort: 'low', fastMode: false, serviceTier: null } });
  assert.equal(result.state, 'pending');
});

test('partial option failure does not poison the next complete pick', async () => {
  const backend = { reasoning: 'medium', fast: false };
  const gate = deferred();
  let failFast = true;
  const calls = [];
  const client = { request: async (method, params) => {
    if (method === 'session.resume') return { info: { reasoning_effort: backend.reasoning, fast: backend.fast } };
    calls.push(`${params.key}:${params.value}`);
    if (params.key === 'fast' && failFast) { await gate.promise; failFast = false; throw new Error('refused'); }
    if (params.key === 'reasoning') backend.reasoning = params.value;
    else backend.fast = params.value === 'fast';
    return {};
  } };
  const c = vm.createContext({
    settings: { sessionId: 'A', activeProfile: 'p' }, modelOptionSelectionVersion: 1,
    modelOptionWriteQueues: new Map(), sessionRuntimeFromSnapshot, modelOptionsRuntimeAckState,
    sessionLoadRequestId: 1, scopeRevision: { current: () => 1, isCurrent: (n) => n === 1 },
    authoritySessionConnection: () => ({ wsSessionId: 'A', client }), applyModelOptionPick,
    setStatus: () => {},
  });
  vm.runInContext(fn('syncSessionModelOptions'), c);
  const high = c.syncSessionModelOptions({ sessionId: 'A', optionVersion: 1, requestedOptions: { thinkingEnabled: true, reasoningEffort: 'high', fastMode: true, serviceTier: 'priority' } });
  await new Promise((r) => setImmediate(r));
  c.modelOptionSelectionVersion = 2;
  const low = c.syncSessionModelOptions({ sessionId: 'A', optionVersion: 2, requestedOptions: { thinkingEnabled: true, reasoningEffort: 'low', fastMode: false, serviceTier: null } });
  gate.resolve();
  const [, result] = await Promise.all([high, low]);
  assert.equal(result.state, 'confirmed');
  assert.deepEqual(backend, { reasoning: 'low', fast: false });
  assert.deepEqual(calls, ['reasoning:high', 'fast:fast', 'reasoning:low', 'fast:normal']);
});

test('authority option writes serialize so the latest choice reaches the gateway last', async () => {
  const gate = deferred();
  const sent = [];
  const backend = { reasoning: 'medium', fast: false };
  const client = { request: async (method, params) => {
    if (method === 'session.resume') return { info: { reasoning_effort: backend.reasoning, fast: backend.fast } };
    sent.push(`${params.key}:${params.value}`);
    if (params.key === 'reasoning' && params.value === 'high') await gate.promise;
    if (params.key === 'reasoning') backend.reasoning = params.value;
    else backend.fast = params.value === 'fast';
    return {};
  } };
  const c = vm.createContext({
    settings: { sessionId: 'A', activeProfile: 'p' }, modelOptionSelectionVersion: 1,
    modelOptionWriteQueues: new Map(), sessionRuntimeFromSnapshot, modelOptionsRuntimeAckState,
    sessionLoadRequestId: 1, scopeRevision: { current: () => 1, isCurrent: (n) => n === 1 },
    authoritySessionConnection: () => ({ wsSessionId: 'A', client }),
    applyModelOptionPick,
    setStatus: () => {}, rollBackModelOptionPick: async () => ({ state: 'failed' }),
  });
  vm.runInContext(fn('syncSessionModelOptions'), c);
  const high = c.syncSessionModelOptions({ sessionId: 'A', optionVersion: 1, requestedOptions: { thinkingEnabled: true, reasoningEffort: 'high', fastMode: true, serviceTier: 'priority' } });
  await new Promise((r) => setImmediate(r));
  c.modelOptionSelectionVersion = 2;
  const low = c.syncSessionModelOptions({ sessionId: 'A', optionVersion: 2, requestedOptions: { thinkingEnabled: true, reasoningEffort: 'low', fastMode: false, serviceTier: null } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['reasoning:high']);
  gate.resolve();
  const [, outcome] = await Promise.all([high, low]);
  assert.deepEqual(backend, { reasoning: 'low', fast: false });
  assert.equal(outcome.state, 'confirmed');
  assert.deepEqual(sent, ['reasoning:high', 'fast:fast', 'reasoning:low', 'fast:normal']);
});
