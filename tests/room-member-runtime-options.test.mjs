import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createBotGroupRuntime } from '../extension/lib/bot-group-runtime.mjs';

// Mock gateway whose bots deliberately have DIFFERENT efforts, so a runtime
// that reads one shared value (the old "everyone is Max" bug) cannot pass.
function makeClient({ efforts = {}, fast = {}, refuseSet = false, noSession = false, noFast = false } = {}) {
  const calls = [];
  const state = new Map(Object.entries(efforts));
  const fastState = new Map(Object.entries(fast));
  const profileOf = (sessionId) => String(sessionId).replace(/^live-/, '');
  const client = {
    calls,
    on() { return () => {}; },
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'session.list') return noSession ? { sessions: [] } : { sessions: [{ id: `stored-${params.profile}`, title: params.title }] };
      if (method === 'session.resume') return { session_id: `live-${params.profile}`, stored_session_id: `stored-${params.profile}`, info: { profile_name: params.profile } };
      if (method === 'session.create') return { session_id: `live-${params.profile}`, stored_session_id: `stored-${params.profile}`, info: { profile_name: params.profile } };
      if (method === 'config.get') {
        const profile = profileOf(params.session_id);
        if (params.key === 'reasoning') return { value: state.get(profile) ?? 'medium' };
        if (params.key === 'fast') {
          if (noFast) throw new Error('unknown config key: fast');
          return { value: fastState.get(profile) ?? 'normal' };
        }
      }
      if (method === 'config.set') {
        if (refuseSet) return { value: 'ignored' };
        const profile = profileOf(params.session_id);
        if (params.key === 'reasoning') state.set(profile, params.value);
        if (params.key === 'fast') fastState.set(profile, params.value);
        return { value: params.value };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  return { client, calls };
}

const runtimeFor = (options) => {
  const mock = makeClient(options);
  return { ...mock, runtime: createBotGroupRuntime({ client: mock.client, timeoutMs: 1000 }) };
};

test('each room member reports its OWN effort, not one shared value', async () => {
  const { runtime } = runtimeFor({ efforts: { alpha: 'low', beta: 'high', gamma: 'max' } });
  assert.equal((await runtime.readMemberRuntimeOptions('room', 'alpha')).reasoningEffort, 'low');
  assert.equal((await runtime.readMemberRuntimeOptions('room', 'beta')).reasoningEffort, 'high');
  assert.equal((await runtime.readMemberRuntimeOptions('room', 'gamma')).reasoningEffort, 'max');
});

test('reasoning "none" reads as Thinking off with no effort', async () => {
  const { runtime } = runtimeFor({ efforts: { alpha: 'none' } });
  const read = await runtime.readMemberRuntimeOptions('room', 'alpha');
  assert.equal(read.state, 'ok');
  assert.equal(read.thinkingEnabled, false);
  assert.equal(read.reasoningEffort, null);
});

test('fast mode is read from the member session and tolerates gateways without it', async () => {
  const withFast = runtimeFor({ efforts: { alpha: 'high' }, fast: { alpha: 'fast' } });
  assert.equal((await withFast.runtime.readMemberRuntimeOptions('room', 'alpha')).fastMode, true);
  const withoutFast = runtimeFor({ efforts: { alpha: 'high' }, noFast: true });
  const read = await withoutFast.runtime.readMemberRuntimeOptions('room', 'alpha');
  assert.equal(read.state, 'ok');
  assert.equal(read.fastMode, false);
});

test('a member with no session is reported as such and never guessed', async () => {
  const { runtime } = runtimeFor({ noSession: true });
  assert.deepEqual(await runtime.readMemberRuntimeOptions('room', 'alpha'), { state: 'no-session' });
});

test('setting effort is session-scoped, targets only that member, and is verified by reading back', async () => {
  const { runtime, calls } = runtimeFor({ efforts: { alpha: 'low', beta: 'high' } });
  const result = await runtime.setMemberRuntimeOption('room', 'alpha', { reasoningEffort: 'xhigh' });
  assert.equal(result.state, 'ok');
  assert.equal(result.reasoningEffort, 'xhigh');
  const sets = calls.filter(({ method }) => method === 'config.set');
  assert.equal(sets.length, 1);
  assert.deepEqual(sets[0].params, { session_id: 'live-alpha', key: 'reasoning', value: 'xhigh' });
  assert.equal((await runtime.readMemberRuntimeOptions('room', 'beta')).reasoningEffort, 'high', 'other members are untouched');
});

test('a write the gateway ignores is reported unverified, never as success', async () => {
  const { runtime } = runtimeFor({ efforts: { alpha: 'low' }, refuseSet: true });
  const result = await runtime.setMemberRuntimeOption('room', 'alpha', { reasoningEffort: 'max' });
  assert.equal(result.state, 'unverified');
  assert.equal(result.observed.reasoningEffort, 'low');
});

test('thinking can be switched off and fast toggled per member', async () => {
  const { runtime, calls } = runtimeFor({ efforts: { alpha: 'high' } });
  const off = await runtime.setMemberRuntimeOption('room', 'alpha', { thinkingEnabled: false });
  assert.equal(off.state, 'ok');
  assert.equal(off.thinkingEnabled, false);
  const fast = await runtime.setMemberRuntimeOption('room', 'alpha', { fastMode: true });
  assert.equal(fast.state, 'ok');
  assert.equal(fast.fastMode, true);
  assert.deepEqual(calls.filter(({ method }) => method === 'config.set').map(({ params }) => `${params.key}=${params.value}`), ['reasoning=none', 'fast=fast']);
});

test('option values cannot smuggle flags or whitespace into the gateway', async () => {
  const { runtime } = runtimeFor({ efforts: { alpha: 'low' } });
  await assert.rejects(() => runtime.setMemberRuntimeOption('room', 'alpha', { reasoningEffort: 'high --global' }), /flags or whitespace/);
  await assert.rejects(() => runtime.setMemberRuntimeOption('room', 'alpha', {}), /runtime option is required/);
});

test('the room picker shows the bot\'s own options and never the 1:1 chat\'s', () => {
  const js = readFileSync('extension/sidepanel.js', 'utf8');
  const render = js.match(/function renderModelRuntimeOptions\(\)[\s\S]*?\n\}\n/)?.[0] || '';
  assert.match(render, /currentRoomMemberRuntimeOptions\(\)/, 'room picks read the member options');
  assert.match(render, /roomTarget\s*\n?\s*\?\s*\(memberEffortListed/, 'effort for a room pick comes from the member, not settings.reasoningEffort');
  const click = js.match(/els\.modelOptionsList\.addEventListener\('click'[\s\S]*?\n {2}\}\);/)?.[0] || '';
  const roomBranch = click.slice(0, click.indexOf("modelSelectionTarget === 'assist'"));
  assert.match(roomBranch, /setRoomMemberRuntimeOption/, 'room clicks write to the member session');
  assert.doesNotMatch(roomBranch, /setModelRuntimeOption/, 'room clicks never write the 1:1 chat settings');
});
