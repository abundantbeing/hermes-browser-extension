import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  HOSTED_MEMBER_SETTINGS_NOTE,
  HOSTED_ROOMS_STORAGE_KEY,
  createHostedGroupRuntime,
  createHostedRoomBindings,
  displayMessagesFromHostedLog,
  hostedGroupMode,
  hostedMentionText,
  hostedRespondents,
  hostedRoomMembers,
  probeHostedGroups,
} from '../extension/lib/hosted-group-room.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined in sidepanel.js`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

const MEMBERS = [
  { name: 'default', title: 'Roxas' },
  { name: 'namine', title: 'Naminé' },
  { name: 'riku', title: 'Riku' },
];

function rpcError(reason, extra = {}) {
  return Object.assign(new Error(reason), { code: 4001, rpcCode: 4001, data: { reason, ...extra } });
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}

// A scripted hosted-room gateway. After groups.send, each groups.state poll releases the next batch
// of events from `script` (a list of batches, each a function of the user event).
function fakeGateway({ script = [], sendError = null, stateError = null } = {}) {
  const calls = [];
  const rooms = new Map();
  const log = [];
  let seq = 0;
  let batches = [];
  let activity = [];
  let pendingActions = [];
  const sendFailures = sendError ? [sendError].flat() : [];
  const push = (event) => {
    seq += 1;
    log.push({ seq, created_at: 1_800_000_000 + seq, ...event });
    return log.at(-1);
  };
  const client = {
    calls,
    log,
    setActivity(value) { activity = value; },
    setPendingActions(value) { pendingActions = value; },
    queue(more) { batches.push(...more); },
    async request(method, params = {}) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'groups.capabilities') return { driver: true, persistent_process: true, protocol_version: 2 };
      if (method === 'groups.create') {
        rooms.set(params.room_id, { room_id: params.room_id, name: params.name, members: params.members });
        return { room: { ...rooms.get(params.room_id), idempotent: false } };
      }
      if (method === 'groups.state') {
        if (stateError) throw stateError;
        if (!rooms.has(params.room_id)) throw rpcError('permission_denied');
        const next = batches.shift();
        if (next) for (const event of next) push(event);
        return {
          room: { ...rooms.get(params.room_id), latest_seq: seq },
          driver_status: { running: true, working: activity.length > 0, member_activity: activity, pending_actions: pendingActions },
        };
      }
      if (method === 'groups.send') {
        if (sendFailures.length) throw sendFailures.shift();
        const user = push({ room_id: params.room_id, event_id: `user:${params.event_id}`, kind: 'message.user', actor: { kind: 'user', id: 'desktop' }, payload: params.payload });
        batches = script.map((batch) => batch(user).map((event) => ({ room_id: params.room_id, ...event })));
        return { event: user, client_event_id: params.event_id, accepted: true, driver_started: true };
      }
      if (method === 'groups.log') {
        const events = log.filter((event) => event.seq > params.since_seq);
        return { events, cursor: events.at(-1)?.seq ?? params.since_seq, latest_seq: seq, has_more: false };
      }
      if (method === 'groups.stop') return { cancelled: 1 };
      if (method === 'groups.retry') return { retried: true, task: { task_id: params.task_id } };
      throw new Error(`unexpected ${method}`);
    },
  };
  return client;
}

function reply(user, memberId, text, extra = {}) {
  return {
    kind: 'message.member',
    actor: { kind: 'member', id: memberId, profile: memberId },
    payload: { discussion_event_id: user?.event_id, member_id: memberId, thread_id: user?.payload?.thread_id, text, task_id: `dtask:${memberId}`, ...extra },
  };
}

function settled(user, memberId, passed = false, extra = {}) {
  return { kind: 'turn.settled', actor: { kind: 'gateway', id: 'g' }, payload: { discussion_event_id: user?.event_id, member_id: memberId, passed, task_id: `dtask:${memberId}`, ...extra } };
}

function runtimeFor(client, { storage = memoryStorage(), ids = ['room-1', 'evt-1', 'evt-2', 'evt-3', 'evt-4'], ...options } = {}) {
  const queue = [...ids];
  const seen = { messages: [], activity: [] };
  const runtime = createHostedGroupRuntime({
    client,
    profile: 'default',
    bindings: createHostedRoomBindings({ storage, gatewayKey: 'http://127.0.0.1:1' }),
    onMessage: (message, meta) => seen.messages.push({ message, meta }),
    onActivity: (activity) => seen.activity.push(activity),
    sleep: async () => undefined,
    randomId: () => queue.shift() || `id-${Math.random()}`,
    ...options,
  });
  return { runtime, seen, storage };
}

// ---- capability gate -------------------------------------------------------------------------

test('a gateway that drives rooms is hosted; one that says it does not is legacy', () => {
  assert.equal(hostedGroupMode({ driver: true, persistent_process: true, protocol_version: 2 }), 'hosted');
  assert.equal(hostedGroupMode({ driver: false, persistent_process: false }), 'legacy');
  assert.equal(hostedGroupMode({ driver: false, persistent_process: true, protocol_version: 2 }), 'unavailable');
  assert.equal(hostedGroupMode({ driver: false, persistent_process: false, methods: ['groups.create'] }), 'unavailable');
  assert.equal(hostedGroupMode({ driver: true, methods: 'groups.send' }), 'unavailable');
  assert.equal(hostedGroupMode(null), 'unavailable');
});

test('the probe falls back to the socket profile and treats a gateway without group verbs as legacy', async () => {
  const sent = [];
  const mismatch = {
    async request(method, params) {
      sent.push(params);
      if (params.profile) throw rpcError('profile_mismatch');
      return { driver: true, persistent_process: true };
    },
  };
  assert.deepEqual(await probeHostedGroups(mismatch, 'default').then(({ mode, profile }) => ({ mode, profile })), { mode: 'hosted', profile: '' });
  assert.deepEqual(sent, [{ profile: 'default' }, {}]);
  const old = { async request() { throw Object.assign(new Error('unknown method'), { rpcCode: -32601 }); } };
  assert.equal((await probeHostedGroups(old, 'default')).mode, 'legacy');
  const broken = { async request() { throw rpcError('runtime_draining'); } };
  const answer = await probeHostedGroups(broken, 'default');
  assert.equal(answer.mode, 'unavailable');
  assert.equal(answer.error.message, 'runtime_draining');
});

// ---- roster, mentions ------------------------------------------------------------------------

test('members are seated by profile, answering to their title in plain letters', () => {
  assert.deepEqual(hostedRoomMembers([...MEMBERS, 'riku', { name: 'saix', title: 'Saïx' }]), [
    { member_id: 'default', profile: 'default', handle: 'Roxas', target: { kind: 'local', profile: 'default' }, display_name: 'Roxas' },
    { member_id: 'namine', profile: 'namine', handle: 'Namine', target: { kind: 'local', profile: 'namine' }, display_name: 'Naminé' },
    { member_id: 'riku', profile: 'riku', handle: 'Riku', target: { kind: 'local', profile: 'riku' }, display_name: 'Riku' },
    { member_id: 'saix', profile: 'saix', handle: 'Saix', target: { kind: 'local', profile: 'saix' }, display_name: 'Saïx' },
  ]);
  // A title that cannot be a handle (or is reserved) falls back to the profile name.
  const odd = hostedRoomMembers([{ name: 'a1', title: 'Everyone' }, { name: 'b2', title: '!!' }, { name: 'c3', title: 'Bot:' }]);
  assert.deepEqual(odd.map((member) => member.handle), ['a1', 'b2', 'c3']);
  assert.deepEqual(odd.map((member) => member.display_name), ['Everyone', '!!', 'Bot:']);
});

test('mentions by title or profile are spelled as room handles, and nothing else changes', () => {
  assert.equal(hostedMentionText('@Naminé and @default, what about @riku?', MEMBERS), '@Namine and @Roxas, what about @riku?');
  assert.equal(hostedMentionText('mail me@namine.com or ask @everyone', MEMBERS), 'mail me@namine.com or ask @everyone');
  assert.equal(hostedMentionText('no mentions here', MEMBERS), 'no mentions here');
  assert.equal(hostedMentionText('@Naminéx stays', MEMBERS), '@Naminéx stays');
});

test('the members a message addresses follow the gateway routing', () => {
  const names = (text) => hostedRespondents(text, MEMBERS).map((member) => member.name);
  assert.deepEqual(names('@Naminé what do you think'), ['namine']);
  assert.deepEqual(names('@riku and @Roxas'), ['default', 'riku']);
  assert.deepEqual(names('hello all'), ['default', 'namine', 'riku']);
  assert.deepEqual(names('@everyone hi'), ['default', 'namine', 'riku']);
  assert.deepEqual(names('@nobody hi'), ['default', 'namine', 'riku']);
});

test('a hosted log becomes the panel user and member rows', () => {
  const rows = displayMessagesFromHostedLog([
    { seq: 1, kind: 'message.user', created_at: 10, actor: { kind: 'user', id: 'desktop' }, payload: { text: 'hi', thread_id: 'main' } },
    { seq: 2, kind: 'message.member', created_at: 11, actor: { kind: 'member', id: 'namine', display_name: 'Naminé' }, payload: { text: 'hello', thread_id: 'main', member_id: 'namine' } },
    { seq: 3, kind: 'turn.settled', created_at: 12, payload: { member_id: 'riku', passed: true } },
    { seq: 4, kind: 'room.activity', created_at: 13, payload: { status: 'settled' } },
  ], MEMBERS);
  assert.deepEqual(rows, [
    { role: 'user', roleLabel: 'You', content: 'hi', ts: 10_000, thread: 'main' },
    { role: 'assistant', roleLabel: 'Naminé', speaker: 'namine', content: 'hello', ts: 11_000, thread: 'main' },
  ]);
});

// ---- a turn --------------------------------------------------------------------------------

test('a first send creates a fresh hosted room and follows the discussion to its end', async () => {
  const client = fakeGateway({
    script: [
      (user) => [reply(user, 'default', 'Doing good.'), settled(user, 'default')],
      () => [],
      (user) => [settled(user, 'namine', true), { kind: 'turn.failed', payload: { discussion_event_id: user.event_id, member_id: 'riku', error: 'provider_quota_limit' } }],
      (user) => [{ kind: 'room.activity', payload: { discussion_event_id: user.event_id, status: 'settled', reason_code: 'silent_round' } }],
    ],
  });
  client.setActivity([{ member_id: 'default', status: 'running' }]);
  const { runtime, seen, storage } = runtimeFor(client);
  const result = await runtime.send({ roomId: 'browser-room-1', groupName: 'Crew', members: MEMBERS, messages: [], text: 'how are you @everyone', thread: 'main' });

  const create = client.calls.find((call) => call.method === 'groups.create');
  assert.equal(create.params.room_id, 'room-1', 'a fresh id, never the panel room id');
  assert.equal(create.params.profile, 'default');
  assert.deepEqual(create.params.members.map((member) => member.handle), ['Roxas', 'Namine', 'Riku']);
  const send = client.calls.find((call) => call.method === 'groups.send');
  assert.deepEqual(send.params, { room_id: 'room-1', event_id: 'evt-1', payload: { text: 'how are you @everyone', thread_id: 'main' }, profile: 'default' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages.map((message) => [message.role, message.content]), [['user', 'how are you @everyone'], ['assistant', 'Doing good.']]);
  assert.deepEqual(result.failures, [{ member: 'riku', roleLabel: 'Riku', error: 'provider_quota_limit' }]);
  assert.deepEqual(seen.messages.map(({ meta }) => meta.kind), ['user', 'reply']);
  const kinds = seen.activity.map((activity) => `${activity.kind}${activity.member ? `:${activity.member}` : ''}`);
  assert.deepEqual(kinds, ['turn_start', 'working:default', 'pass:namine', 'failed:riku', 'idle']);
  assert.deepEqual(seen.activity[0].members.map((member) => member.member), ['default', 'namine', 'riku']);
  const stored = storage.data[HOSTED_ROOMS_STORAGE_KEY]['http://127.0.0.1:1']['browser-room-1'];
  assert.equal(stored.roomId, 'room-1');
  assert.equal(stored.profile, 'default');
  assert.deepEqual(stored.members, ['default', 'namine', 'riku']);
});

test('a stop or a newer message in the thread also ends the discussion', async () => {
  for (const end of [
    () => [{ kind: 'room.stop_requested', payload: { cancel_id: 'x' } }],
    () => [{ kind: 'message.user', actor: { kind: 'user', id: 'desktop' }, payload: { text: 'newer', thread_id: 'main' } }],
  ]) {
    const client = fakeGateway({ script: [() => [], end] });
    const { runtime } = runtimeFor(client);
    const result = await runtime.send({ roomId: 'r', members: MEMBERS, text: 'hi', thread: 'main' });
    assert.equal(result.ok, true);
  }
});

test('Stop asks the room to stop with a fresh cancel id', async () => {
  const client = fakeGateway({ script: [() => []] });
  const controller = new AbortController();
  const { runtime } = runtimeFor(client, {
    ids: ['room-1', 'evt-1', 'cancel-1'],
    onActivity: (activity) => { if (activity.kind === 'turn_start') controller.abort(); },
  });
  await assert.rejects(runtime.send({ roomId: 'r', members: MEMBERS, text: 'hi', signal: controller.signal }), { name: 'AbortError' });
  const stop = client.calls.find((call) => call.method === 'groups.stop');
  assert.deepEqual(stop.params, { room_id: 'room-1', cancel_id: 'cancel-1', profile: 'default' });
});

test('a refused send is marked not sent and shows no message', async () => {
  const client = fakeGateway({ sendError: rpcError('invalid_params') });
  const { runtime, seen } = runtimeFor(client);
  await assert.rejects(runtime.send({ roomId: 'r', members: MEMBERS, text: 'hi' }), (error) => error.notSent === true && error.message === 'invalid_params');
  assert.deepEqual(seen.messages, []);
});

test('a transient refusal is sent again once with the identical request', async () => {
  const client = fakeGateway({
    sendError: rpcError('runtime_coordination_required'),
    script: [(user) => [{ kind: 'room.activity', payload: { discussion_event_id: user.event_id, status: 'settled' } }]],
  });
  const { runtime } = runtimeFor(client);
  const result = await runtime.send({ roomId: 'r', members: MEMBERS, text: 'hi' });
  assert.equal(result.ok, true);
  const sends = client.calls.filter((call) => call.method === 'groups.send');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].params, sends[1].params);
});

test('the stored room is reused while it answers, and replaced when it does not or the roster changed', async () => {
  const storage = memoryStorage();
  const client = fakeGateway({ script: [(user) => [{ kind: 'room.activity', payload: { discussion_event_id: user.event_id } }]] });
  const first = runtimeFor(client, { storage, ids: ['room-1', 'evt-1', 'evt-2', 'room-2', 'evt-3'] });
  await first.runtime.send({ roomId: 'r', members: MEMBERS, text: 'one' });
  await first.runtime.send({ roomId: 'r', members: MEMBERS, text: 'two' });
  assert.equal(client.calls.filter((call) => call.method === 'groups.create').length, 1, 'reused');
  await first.runtime.send({ roomId: 'r', members: MEMBERS.slice(0, 2), text: 'three' });
  const creates = client.calls.filter((call) => call.method === 'groups.create');
  assert.equal(creates.length, 2, 'a new roster gets a new room');
  assert.equal(creates[1].params.room_id, 'room-2');

  const orphaned = fakeGateway();
  const again = runtimeFor(orphaned, { storage, ids: ['room-3'] });
  assert.equal((await again.runtime.prepare({ roomId: 'r', members: MEMBERS.slice(0, 2) })).ok, true);
  assert.equal(orphaned.calls.at(-1).method, 'groups.create', 'a room this sign-in no longer owns is replaced');
});

test('mentions keep the handles a room was created with, even after titles load', async () => {
  const client = fakeGateway({ script: [(user) => [{ kind: 'room.activity', payload: { discussion_event_id: user.event_id } }]] });
  const { runtime, storage } = runtimeFor(client, { ids: ['room-1', 'evt-1'] });
  const untitled = MEMBERS.map(({ name }) => ({ name }));
  assert.equal((await runtime.prepare({ roomId: 'r', members: untitled })).ok, true);
  const create = client.calls.find((call) => call.method === 'groups.create');
  assert.deepEqual(create.params.members.map((member) => member.handle), ['default', 'namine', 'riku']);
  assert.deepEqual(storage.data[HOSTED_ROOMS_STORAGE_KEY]['http://127.0.0.1:1'].r.handles, { default: 'default', namine: 'namine', riku: 'riku' });
  await runtime.send({ roomId: 'r', members: MEMBERS, text: '@Roxas and @Naminé?' });
  const send = client.calls.find((call) => call.method === 'groups.send');
  assert.equal(send.params.payload.text, '@default and @namine?');
  assert.equal(hostedMentionText('@Roxas', MEMBERS, { default: 'default' }), '@default');
});

test('prepare reports a roster Hermes cannot seat', async () => {
  const client = fakeGateway();
  const { runtime } = runtimeFor(client);
  assert.deepEqual(await runtime.prepare({ roomId: 'r', members: MEMBERS.slice(0, 1) }), { ok: false, reason: 'member-count', sessions: [], failures: [] });
  client.request = async () => { throw rpcError('invalid_params', { field: 'members', detail: "member 1 profile 'ghost' is not local to this gateway" }); };
  const refused = await runtime.prepare({ roomId: 'r2', members: MEMBERS });
  assert.equal(refused.ok, false);
  assert.match(refused.failures[0].error, /not local to this gateway/);
});

test('history is the room log, with the moment the hosted room took over', async () => {
  const storage = memoryStorage();
  const client = fakeGateway({ script: [(user) => [reply(user, 'riku', 'yo'), { kind: 'room.activity', payload: { discussion_event_id: user.event_id } }]] });
  const { runtime } = runtimeFor(client, { storage, now: () => 1234 });
  assert.deepEqual(await runtime.readHistory({ roomId: 'r', members: MEMBERS }), { messages: [], createdAt: 0 });
  await runtime.send({ roomId: 'r', members: MEMBERS, text: 'hi' });
  const history = await runtime.readHistory({ roomId: 'r', members: MEMBERS });
  assert.equal(history.createdAt, 1234);
  assert.deepEqual(history.messages.map((message) => message.content), ['hi', 'yo']);
});

test('retry runs a deferred member again, and says plainly when there is nothing to retry', async () => {
  const client = fakeGateway({ script: [(user) => [{ kind: 'room.activity', payload: { discussion_event_id: user.event_id } }]] });
  const { runtime, seen } = runtimeFor(client);
  await runtime.send({ roomId: 'r', members: MEMBERS, text: 'hi' });
  await assert.rejects(runtime.retryMember({ roomId: 'r', members: MEMBERS, member: { name: 'riku' } }), /nothing to retry for Riku/);

  client.setPendingActions([{ kind: 'retry', member_id: 'riku', task_id: 'dtask:riku', execution_generation: 2 }]);
  const retried = fakeGatewayScript(client, [() => [reply(null, 'riku', 'back again', { task_id: 'dtask:riku' }), settled(null, 'riku', false, { task_id: 'dtask:riku' })]]);
  const result = await runtime.retryMember({ roomId: 'r', members: MEMBERS, member: { name: 'riku' } });
  assert.equal(retried(), true);
  const call = client.calls.find((entry) => entry.method === 'groups.retry');
  assert.deepEqual(call.params, { room_id: 'room-1', member_id: 'riku', task_id: 'dtask:riku', execution_generation: 2, profile: 'default' });
  assert.deepEqual(result.messages.map((message) => message.content), ['back again']);
  assert.ok(seen.activity.some((activity) => activity.kind === 'retry' && activity.member === 'riku'));
});

// The retry batches the fake releases on its next groups.state polls.
function fakeGatewayScript(client, script) {
  const original = client.request.bind(client);
  let used = false;
  client.request = async (method, params) => {
    if (method === 'groups.retry') {
      used = true;
      const answer = await original(method, params);
      client.queue(script.map((batch) => batch().map((event) => ({ room_id: params.room_id, ...event }))));
      return answer;
    }
    return original(method, params);
  };
  return () => used;
}

test('a waiting approval is reported once with its command', async () => {
  const client = fakeGateway({ script: [() => [], (user) => [{ kind: 'room.activity', payload: { discussion_event_id: user.event_id } }]] });
  client.setPendingActions([{ kind: 'approval', member_id: 'namine', request_id: 'req-1', approval: { command: 'rm -rf build' } }]);
  const { runtime, seen } = runtimeFor(client);
  await runtime.send({ roomId: 'r', members: MEMBERS, text: 'hi' });
  const approvals = seen.activity.filter((activity) => activity.kind === 'approval');
  assert.deepEqual(approvals, [{ kind: 'approval', member: 'namine', roleLabel: 'Naminé', command: 'rm -rf build' }]);
});

test('per-room model picks are honestly unavailable in a hosted room', async () => {
  const { runtime } = runtimeFor(fakeGateway());
  assert.equal(runtime.hosted, true);
  assert.deepEqual(await runtime.readMemberModel('r', { name: 'riku' }), { state: 'no-session' });
  assert.deepEqual(await runtime.setMemberModel('r', { name: 'riku' }, { model: 'x' }), { state: 'unavailable', error: HOSTED_MEMBER_SETTINGS_NOTE });
  assert.deepEqual(await runtime.setMemberRuntimeOption('r', { name: 'riku' }, { fastMode: true }), { state: 'unavailable', error: HOSTED_MEMBER_SETTINGS_NOTE });
  assert.equal(runtime.getMemberSession('riku'), null);
});

// ---- the side panel ----------------------------------------------------------------------------

test('opening a room picks the hosted runtime when Hermes runs rooms itself', () => {
  const open = functionSource('openBotGroupChat');
  assert.match(open, /probeHostedGroups\(connection\.client, settings\.activeProfile \|\| 'default'\)/);
  assert.match(open, /groupMode\.mode === 'hosted'\s*\? createHostedGroupRuntime\(/);
  assert.match(open, /: createBotGroupRuntime\(\{ client: connection\.client, \.\.\.runtimeHooks \}\)/);
  assert.match(open, /groupMode\.mode === 'unavailable' && connection\.client\?\.readyPayload\?\.session_authority === true/);
  assert.match(open, /if \(groupRuntime\.hosted\) return finishHostedGroupOpen\(/);
  assert.match(open, /activity\.kind === 'approval'/);
});

test('a hosted room shows its own log after the panel rows from before it took over', () => {
  const finish = functionSource('finishHostedGroupOpen');
  assert.match(finish, /runtime\.readHistory\(/);
  assert.match(finish, /\(Number\(message\.ts\) \|\| 0\) < takeover/);
  assert.match(functionSource('syncActiveGroupRoomFromGateway'), /!activeGroupRuntime\?\.hosted/);
});

test('a hosted send carries no page or screenshot, skips the projection sync, and hands back a refused draft', () => {
  const send = functionSource('sendActiveGroupMessage');
  assert.match(send, /activeGroupRuntime\.hosted && Array\.isArray\(turnAttachments\) && turnAttachments\.length/);
  assert.match(send, /!groupRuntime\.hosted && \(groupProjection\.syncState === 'local-only'/);
  assert.match(send, /groupRuntime\.hosted \? \{ browserContext: null, screenshotAttachments: \[\] \} : await prepareBotBrowserTurn/);
  assert.match(send, /error\?\.notSent === true/);
  assert.match(send, /Your message is back in the composer\./);
});
