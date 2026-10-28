import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { establishGatewaySession, readSessionRuntimeViaSocket, sessionRuntimeFromSnapshot } from '../extension/lib/gateway-ws.mjs';
import {
  applyModelOptionPick,
  buildModelMutateParams,
  modelOptionPickRequests,
  reasoningLevel,
  switchSessionModel,
} from '../extension/lib/session-runtime-pick.mjs';
import { resolveAcknowledgedSessionModelOptions } from '../extension/lib/common.mjs';

const panel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = panel.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined in sidepanel.js`);
  const end = panel.indexOf('\n}\n', start);
  return panel.slice(start, end + 2);
}

const snapshot = (info, extra = {}) => ({
  session_id: 's1', stored_session_id: 's1', revision: 4, execution_generation: 2, running: false, info, ...extra,
});

test('a resume snapshot names the model, provider and reasoning level the session runs with', () => {
  const runtime = sessionRuntimeFromSnapshot(snapshot({ model: 'claude-sonnet-5-5', provider: 'anthropic', reasoning_effort: 'high', fast: false }));
  assert.deepEqual(runtime, {
    model: 'claude-sonnet-5-5',
    provider: 'anthropic',
    modelOptions: { reasoning: { enabled: true, effort: 'high' }, fast: false },
  });
  const options = resolveAcknowledgedSessionModelOptions({ sessionOptions: runtime.modelOptions, storedOptions: { reasoningEffort: 'xhigh', thinkingEnabled: true } });
  assert.equal(options.reasoningEffort, 'high', "the session's own level wins over a stored or default one");
  assert.equal(options.thinkingEnabled, true);
});

test('thinking off, a priority tier, an unset level and an unknown level read as the session states them', () => {
  const off = sessionRuntimeFromSnapshot(snapshot({ model: 'm', reasoning_effort: 'none', service_tier: 'priority' }));
  assert.deepEqual(off.modelOptions, { reasoning: { enabled: false, effort: '' }, fast: true });
  assert.equal(resolveAcknowledgedSessionModelOptions({ sessionOptions: off.modelOptions }).thinkingEnabled, false);
  // '' = the session sets no level of its own (it follows its profile): no options to show, so the
  // panel never invents one; the model still reads.
  assert.deepEqual(sessionRuntimeFromSnapshot(snapshot({ model: 'm', reasoning_effort: '' })), { model: 'm', provider: '', modelOptions: null });
  assert.equal(sessionRuntimeFromSnapshot(snapshot({ model: 'm', reasoning_effort: 'thinking' })).modelOptions, null, 'a provider-only tier is not coerced to a panel level');
  assert.equal(sessionRuntimeFromSnapshot(snapshot({})), null);
  assert.equal(sessionRuntimeFromSnapshot({}), null);
  assert.equal(sessionRuntimeFromSnapshot(null), null);
});

test('establishGatewaySession hands back what the resumed session runs with', async () => {
  const client = {
    request: async (method) => {
      assert.equal(method, 'session.resume');
      return snapshot({ model: 'gpt-6.1', provider: 'openai', reasoning_effort: 'medium' }, { session_id: 'live-1', stored_session_id: 's1' });
    },
  };
  const opened = await establishGatewaySession({ client, storedSessionId: 's1' });
  assert.equal(opened.liveId, 'live-1');
  assert.equal(opened.runtime.model, 'gpt-6.1');
  assert.deepEqual(opened.runtime.modelOptions.reasoning, { enabled: true, effort: 'medium' });
});

test('a reasoning or Fast pick becomes the config.set requests the session authority takes', () => {
  assert.equal(reasoningLevel({ thinkingEnabled: false, reasoningEffort: 'high' }), 'none');
  assert.equal(reasoningLevel({ thinkingEnabled: true, reasoningEffort: 'HIGH' }), 'high');
  const previous = { thinkingEnabled: true, reasoningEffort: 'xhigh', fastMode: false };
  assert.deepEqual(modelOptionPickRequests({ sessionId: 's1', previous, requested: { ...previous, reasoningEffort: 'high' } }), [
    { method: 'config.set', params: { session_id: 's1', key: 'reasoning', value: 'high' } },
  ]);
  assert.deepEqual(modelOptionPickRequests({ sessionId: 's1', previous, requested: { ...previous, thinkingEnabled: false } }), [
    { method: 'config.set', params: { session_id: 's1', key: 'reasoning', value: 'none' } },
  ]);
  assert.deepEqual(modelOptionPickRequests({ sessionId: 's1', previous, requested: { ...previous, fastMode: true } }), [
    { method: 'config.set', params: { session_id: 's1', key: 'fast', value: 'fast' } },
  ]);
  assert.deepEqual(modelOptionPickRequests({ sessionId: 's1', previous, requested: previous }), [], 'an unchanged pick sends nothing');
  assert.deepEqual(modelOptionPickRequests({ sessionId: '', previous, requested: { ...previous, reasoningEffort: 'low' } }), []);
});

test('a refused reasoning pick rejects with the gateway error', async () => {
  const refusal = Object.assign(new Error('permission_denied'), { rpcCode: 4001, data: { reason: 'permission_denied' } });
  await assert.rejects(
    applyModelOptionPick(async () => { throw refusal; }, { sessionId: 's1', previous: { reasoningEffort: 'xhigh' }, requested: { reasoningEffort: 'low' } }),
    (error) => error === refusal,
  );
});

test('a model pick is a fenced session.mutate, read back after it commits', async () => {
  const calls = [];
  let revision = 4;
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'session.resume') return snapshot({ model: calls.some((c) => c.method === 'session.mutate') ? 'claude-sonnet-5-5' : 'gpt-6.1', provider: 'anthropic', reasoning_effort: 'high' }, { revision });
    if (method === 'session.mutate') return { session_id: 's1', operation: 'model', revision: ++revision };
    throw new Error(`unexpected ${method}`);
  };
  const result = await switchSessionModel(request, { sessionId: 's1', model: 'claude-sonnet-5-5', provider: 'anthropic' });
  assert.equal(result.status, 'switched');
  assert.equal(result.runtime.model, 'claude-sonnet-5-5');
  const mutate = calls.find((c) => c.method === 'session.mutate').params;
  assert.deepEqual(Object.keys(mutate).sort(), ['expected_generation', 'expected_revision', 'operation', 'payload', 'request_id', 'session_id']);
  assert.equal(mutate.expected_revision, 4);
  assert.equal(mutate.expected_generation, 2);
  assert.deepEqual(mutate.payload, { model: 'claude-sonnet-5-5', provider: 'anthropic' });
  assert.equal(calls.some((c) => c.method === 'config.set'), false, 'the legacy config.set model is never sent to an authority');
});

test('a fence refusal is re-read and sent once more; a second one rejects', async () => {
  let mutates = 0;
  const stale = () => Object.assign(new Error('revision_conflict'), { rpcCode: 4001, data: { reason: 'revision_conflict' } });
  const request = async (method) => {
    if (method === 'session.resume') return snapshot({ model: 'm2' });
    mutates += 1;
    if (mutates === 1) throw stale();
    return { status: 'committed' };
  };
  assert.equal((await switchSessionModel(request, { sessionId: 's1', model: 'm2' })).status, 'switched');
  mutates = 0;
  const always = async (method) => {
    if (method === 'session.resume') return snapshot({ model: 'm1' });
    mutates += 1;
    throw stale();
  };
  await assert.rejects(switchSessionModel(always, { sessionId: 's1', model: 'm2' }), /revision_conflict/);
  assert.equal(mutates, 2);
});

test('a guarded model asks first, and a gateway without session.mutate says so', async () => {
  const asks = async (method) => (method === 'session.resume'
    ? snapshot({ model: 'm1' })
    : { status: 'confirmation_required', confirm_required: true, confirm: 'tok-1', confirm_message: 'This model costs more.' });
  assert.deepEqual(await switchSessionModel(asks, { sessionId: 's1', model: 'big' }), { status: 'confirm', message: 'This model costs more.', confirm: 'tok-1' });
  const confirmed = buildModelMutateParams({ sessionId: 's1', expectedRevision: 1, expectedGeneration: 0, model: 'big', confirm: 'tok-1' });
  assert.deepEqual(confirmed.payload, { model: 'big', confirm: 'tok-1' }, 'an empty provider is left out of the payload');
  const legacy = async (method) => {
    if (method === 'session.resume') return snapshot({ model: 'm1' });
    throw Object.assign(new Error('unknown method'), { rpcCode: -32601 });
  };
  assert.deepEqual(await switchSessionModel(legacy, { sessionId: 's1', model: 'm2' }), { status: 'unavailable' });
});

test('the panel reads the opened session\'s own model and level, and never shows the last session\'s', () => {
  const open = functionSource('openHermesSession');
  assert.match(open, /const \{ liveId, storedId, profile: reportedProfile, runtime \} = await establishGatewaySession\(/);
  assert.match(open, /session = \{ \.\.\.session, id: storedId, \.\.\.sessionFieldsFromRuntime\(runtime\) \};/);
  assert.ok(open.indexOf('sessionFieldsFromRuntime(runtime)') < open.indexOf('applyModelOptionsForSession(session)'));
  const apply = functionSource('applyModelOptionsForSession');
  assert.match(apply, /if \(!options\) \{[\s\S]*resolveBrowserEffectiveModelOptions\(\{ extensionPreferredModelOptions: settings\.extensionPreferredModelOptions \}\)/);
});

test('the panel sends a pick to the session authority and keeps the legacy path for other sockets', () => {
  const sync = functionSource('syncSessionModelOptions');
  assert.ok(sync.indexOf('authoritySessionConnection(sessionId)') < sync.indexOf('if (isRemoteWsMode())'), 'an authority is asked before the old pending notice');
  assert.match(sync, /applyModelOptionPick\(\(method, params\) => authority\.client\.request\(method, params\)/);
  assert.match(functionSource('authoritySessionConnection'), /readyPayload\?\.session_authority !== true/);
  const lock = functionSource('syncSessionModelLock');
  assert.ok(lock.indexOf('switchAuthoritySessionModel(connection, liveSessionId, selected)') < lock.indexOf('buildSessionModelSwitchRequest('));
  assert.match(functionSource('switchAuthoritySessionModel'), /if \(result\.status === 'unavailable'\) return null;/);
});

test('a chat opened over REST reads what it runs with through a session-authority socket, then leaves it', async () => {
  const calls = [];
  const client = {
    readyState: 1,
    readyPayload: { session_authority: true },
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'session.resume') return snapshot({ model: 'claude-haiku-5-5', provider: 'anthropic', reasoning_effort: 'max' }, { session_id: 'live-1', subscription_id: 'sub-1' });
      return {};
    },
  };
  const runtime = await readSessionRuntimeViaSocket(client, 's1');
  assert.equal(runtime.model, 'claude-haiku-5-5');
  assert.deepEqual(runtime.modelOptions.reasoning, { enabled: true, effort: 'max' });
  assert.deepEqual(calls, [
    ['session.resume', { session_id: 's1', omit_messages: true }],
    ['session.detach', { session_id: 'live-1', subscription_id: 'sub-1' }],
  ]);
});

test('without an authority socket, or when the gateway refuses the read, the REST chat keeps what it had', async () => {
  const legacy = { readyState: 1, readyPayload: {}, request: async () => { throw new Error('must not be asked'); } };
  assert.equal(await readSessionRuntimeViaSocket(legacy, 's1'), null);
  assert.equal(await readSessionRuntimeViaSocket(null, 's1'), null);
  const closed = { readyState: 3, readyPayload: { session_authority: true }, request: async () => { throw new Error('closed'); } };
  assert.equal(await readSessionRuntimeViaSocket(closed, 's1'), null);
  const calls = [];
  const refusing = {
    readyState: 1,
    readyPayload: { session_authority: true },
    async request(method) { calls.push(method); throw Object.assign(new Error('not_found'), { data: { reason: 'not_found' } }); },
  };
  assert.equal(await readSessionRuntimeViaSocket(refusing, 's1'), null);
  assert.deepEqual(calls, ['session.resume'], 'nothing to leave when the resume was refused');
});

test('opening a chat over REST applies the runtime the authority socket reports', () => {
  const open = functionSource('openHermesSession');
  assert.match(open, /if \(!dashboardTransport\) \{[\s\S]*?const runtime = await readSessionRuntimeViaSocket\(sessionAuthoritySideSocket\(\), session\.id\);\s*if \(!isCurrentRequest\(\)\) return false;\s*if \(runtime\) session = \{ \.\.\.session, \.\.\.sessionFieldsFromRuntime\(runtime\) \};/);
});
