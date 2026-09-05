import assert from 'node:assert/strict';
import test from 'node:test';

import {
  botModeExitStateForRegularSession,
  groupProjectionMessagesForDisplay,
  groupThreadMenuEntries,
  mergeGroupChatLists,
  splitBotRosterRows,
} from '../extension/lib/bot-mode.mjs';

import {
  groupMemberSessionTitle,
  createBotGroupRuntime,
  groupProjectionEntryFromDisplayMessage,
  isGroupPassText,
  persistGroupProjectionAppend,
  persistGroupProjectionRename,
  persistGroupProjectionUpdate,
} from '../extension/lib/bot-group-runtime.mjs';

const NOW = 1_800_000_000_000;

const AGENTS = [
  { name: 'default', display_name: 'Roxas', provider: 'gemini-local', model: 'gemini-3.7-flash-high', canonical_session: { id: 'canonical_default' } },
  { name: 'namine', display_name: 'Naminé', provider: 'nous', model: 'z-ai/glm-5.3-flash', canonical_session: { id: 'canonical_namine' } },
  { name: 'riku', display_name: 'Riku', provider: 'qwen', model: 'qwen-max', canonical_session: { id: 'canonical_riku' } },
];

const LAUNCH_ROOM = {
  name: 'launch-room',
  type: 'group',
  display_name: 'Browser launch room',
  title: '3 members · synced projection',
  members: ['roxas', 'namine', 'riku'],
  canonical_session: { id: 'room-launch', preview: 'Roxas: I updated the implementation gates' },
  last_active: NOW - 120000,
};

test('splitBotRosterRows keeps group chats out of the agent profile roster', () => {
  const split = splitBotRosterRows({ profiles: [...AGENTS, LAUNCH_ROOM] }, { sourceId: 'dashboard', now: NOW });
  assert.equal(split.agents.length, 3, 'exactly the 3 genuine agent profiles');
  assert.deepEqual(split.agents.map((row) => row.profileName), ['default', 'namine', 'riku']);
  assert.equal(split.groupChats.length, 1, 'launch room lands in its own roster');
  assert.equal(split.groupChats[0].type, 'group');
  assert.equal(split.groupChats[0].displayName, 'Browser launch room');
  assert.deepEqual(split.groupChats[0].members, ['roxas', 'namine', 'riku']);
  assert.equal(split.groupChats[0].canonical.status, 'ready');
});

test('splitBotRosterRows also reads group_chats collections off the payload', () => {
  const split = splitBotRosterRows({ profiles: AGENTS, group_chats: [LAUNCH_ROOM] }, { sourceId: 'gw', now: NOW });
  assert.equal(split.agents.length, 3);
  assert.equal(split.groupChats.length, 1);
});

test('splitBotRosterRows reads v3 group projections from profile ui_meta', () => {
  const split = splitBotRosterRows({
    profiles: [
      ...AGENTS.slice(1),
      {
        ...AGENTS[0],
        ui_meta: {
          'hermes-bots-groups': {
            version: 3,
            updatedAt: NOW,
            rooms: {
              'id:room-launch': {
                roomId: 'room-launch',
                name: 'Browser launch room',
                revision: 4,
                members: [{ name: 'default', handle: '@roxas' }, { name: 'namine' }],
                image: 'data:image/png;base64,room',
                log: [
                  { id: 'm1', from: { kind: 'user', name: 'Jon' }, text: 'Ship it', at: NOW - 2000 },
                  { id: 'm2', from: { kind: 'member', name: 'default' }, text: 'On it', at: NOW - 1000, thread: 'launch' },
                ],
              },
            },
            deleted: {},
          },
        },
      },
    ],
  }, { sourceId: 'dashboard', now: NOW });

  assert.equal(split.agents.length, 3);
  assert.equal(split.groupChats.length, 1);
  assert.equal(split.groupChats[0].id, 'room-launch');
  assert.equal(split.groupChats[0].displayName, 'Browser launch room');
  assert.deepEqual(split.groupChats[0].members, ['default', 'namine']);
  assert.equal(split.groupChats[0].canonical.status, 'missing', 'a projected room is not a resumable backend session');
  assert.equal(split.groupChats[0].messages.length, 2);
  assert.equal(split.groupChats[0].messages[1].from.name, 'Roxas');
  assert.equal(split.groupChats[0].activity.lastActive, NOW - 1000);
  assert.equal(split.groupChats[0].revision, 4);
});

test('v3 group projection tombstones suppress deleted rooms', () => {
  const split = splitBotRosterRows({
    profiles: [{
      ...AGENTS[0],
      ui_meta: {
        'hermes-bots-groups': {
          version: 3,
          rooms: { 'id:gone': { roomId: 'gone', name: 'Gone', revision: 1, members: [], log: [] } },
          deleted: { 'id:gone': 1 },
        },
      },
    }],
  }, { sourceId: 'dashboard', now: NOW });

  assert.equal(split.groupChats.length, 0);
});

test('projected group messages preserve author labels for the shared bubble renderer', () => {
  const messages = groupProjectionMessagesForDisplay({
    messages: [
      { from: { kind: 'user', name: 'Jon' }, text: 'Ship it', at: NOW - 2 },
      { from: { kind: 'member', name: 'default' }, text: 'On it', at: NOW - 1 },
    ],
  });

  assert.deepEqual(messages, [
    { role: 'user', content: 'Ship it', ts: NOW - 2, roleLabel: 'Jon', thread: '' },
    { role: 'assistant', content: 'On it', ts: NOW - 1, roleLabel: 'Roxas', thread: '' },
  ]);
});

test('group thread menu entries retain room identity, previews, counts, and stable ids', () => {
  const entries = groupThreadMenuEntries({
    id: 'room-launch',
    displayName: 'Browser launch room',
    messages: [
      { id: 'm1', from: { kind: 'user', name: 'Jon' }, text: 'Ship it', at: NOW - 3000 },
      { id: 'm2', from: { kind: 'member', name: 'Riku' }, text: 'I am on it', at: NOW - 2000, thread: 'launch' },
      { id: 'm3', from: { kind: 'member', name: 'Naminé' }, text: 'Launch checklist is ready', at: NOW - 1000, thread: 'launch' },
    ],
  });

  assert.deepEqual(entries.map((entry) => entry.id), ['bot-thread:room-launch:main', 'bot-thread:room-launch:launch']);
  assert.equal(entries[0].sourceLabel, 'Group Chat Threads');
  assert.equal(entries[0].roomLabel, 'Browser launch room');
  assert.equal(entries[0].messageCount, 1);
  assert.equal(entries[1].threadId, 'launch');
  assert.equal(entries[1].messageCount, 2);
  assert.equal(entries[1].replyCount, 1);
  assert.equal(entries[1].preview, 'I am on it');
  assert.equal(entries[1].lastActive, NOW - 1000);
});

test('Bot Mode exit state clears bot-only identity while preserving the saved regular profile target', () => {
  const { returnProfile, nextSettings } = botModeExitStateForRegularSession({
    activeProfile: 'riku',
    botModeSelectedProfile: 'riku',
    botModeReturnProfile: 'default',
    sessionId: 'bot-session',
    extensionPreferredModel: { modelId: 'deepseek/deepseek-v4-flash-0731' },
    extensionPreferredModelOptions: { reasoningEffort: 'max' },
    remoteDashboardSession: { storedSessionId: 'bot-session', gatewayUrl: 'http://127.0.0.1:9119' },
  });

  assert.equal(returnProfile, 'default');
  assert.equal(nextSettings.activeProfile, 'riku');
  assert.equal(nextSettings.botModeSelectedProfile, '');
  assert.equal(nextSettings.botModeReturnProfile, '');
  assert.equal(nextSettings.sessionId, '');
  assert.equal(nextSettings.extensionPreferredModel, null);
  assert.equal(nextSettings.extensionPreferredModelOptions, null);
  assert.equal(nextSettings.remoteDashboardSession.storedSessionId, '');
});

test('members-only entries without runtime fields are treated as group chats', () => {
  const split = splitBotRosterRows([{ name: 'ops-room', members: ['default', 'riku'] }], { sourceId: 's', now: NOW });
  assert.equal(split.agents.length, 0);
  assert.equal(split.groupChats.length, 1);
});

test('group projection enforces the released member, message, text, and image caps', () => {
  const oversizedMembers = Array.from({ length: 7 }, (_, index) => ({ name: `agent-${index}` }));
  const oversizedText = 'x'.repeat(1500);
  const oversizedImage = `data:image/png;base64,${'x'.repeat(25000)}`;
  const boundedImage = `data:image/png;base64,${'x'.repeat(1000)}`;
  const split = splitBotRosterRows({
    profiles: [{
      ...AGENTS[0],
      ui_meta: {
        'hermes-bots-groups': {
          version: 3,
          rooms: {
            'id:bounded': {
              roomId: 'bounded',
              name: 'Bounded room',
              revision: 1,
              members: oversizedMembers,
              image: oversizedImage,
              log: Array.from({ length: 20 }, (_, index) => ({
                id: `m-${index}`,
                from: { kind: 'member', name: 'default' },
                text: oversizedText,
                at: NOW + index,
              })),
            },
          },
          deleted: {},
        },
      },
    }],
  }, { sourceId: 'dashboard', now: NOW });

  assert.equal(split.groupChats.length, 0, 'rooms outside the 2–6 member contract are rejected');

  const bounded = splitBotRosterRows({
    profiles: [{
      ...AGENTS[0],
      ui_meta: {
        'hermes-bots-groups': {
          version: 3,
          rooms: {
            'id:bounded': {
              roomId: 'bounded',
              name: 'Bounded room',
              revision: 1,
              members: oversizedMembers.slice(0, 6),
              image: boundedImage,
              log: Array.from({ length: 20 }, (_, index) => ({
                id: `m-${index}`,
                from: { kind: 'member', name: 'default' },
                text: oversizedText,
                at: NOW + index,
              })),
            },
          },
          deleted: {},
        },
      },
    }],
  }, { sourceId: 'dashboard', now: NOW });
  assert.equal(bounded.groupChats.length, 1);
  assert.equal(bounded.groupChats[0].members.length, 6);
  assert.equal(bounded.groupChats[0].messages.length, 16);
  assert.equal(bounded.groupChats[0].messages[0].text.length, 1200);
  assert.equal(bounded.groupChats[0].image.length, boundedImage.length);

  const imageCapped = splitBotRosterRows({
    profiles: [{
      ...AGENTS[0],
      ui_meta: {
        'hermes-bots-groups': {
          version: 3,
          rooms: {
            'id:image-capped': {
              roomId: 'image-capped',
              name: 'Image room',
              revision: 1,
              members: [{ name: 'default' }, { name: 'riku' }],
              image: oversizedImage,
              log: [{ id: 'image-message', from: { kind: 'member', name: 'default' }, text: 'ok', at: NOW }],
            },
          },
          deleted: {},
        },
      },
    }],
  }, { sourceId: 'dashboard', now: NOW });
  assert.equal(imageCapped.groupChats[0].image.length, 24000);
});

test('oversized group projections are rejected before room normalization', () => {
  const oversizedProjection = {
    version: 3,
    rooms: {
      'id:huge': {
        roomId: 'huge',
        name: 'Huge room',
        revision: 1,
        members: [{ name: 'default' }, { name: 'riku' }],
        log: [{ id: 'm1', from: { kind: 'member', name: 'default' }, text: 'x'.repeat(1200), at: NOW }],
      },
    },
    deleted: {},
    padding: 'x'.repeat(50_000),
  };
  const split = splitBotRosterRows({ profiles: [{ ...AGENTS[0], ui_meta: { 'hermes-bots-groups': oversizedProjection } }] }, { sourceId: 'dashboard', now: NOW });
  assert.equal(split.groupChats.length, 0);
});

test('group projections never create device-owned rooms or local drafts', () => {
  const split = splitBotRosterRows({ profiles: AGENTS }, { sourceId: 'dashboard', now: NOW });
  assert.equal(split.groupChats.length, 0);
  assert.equal(split.groupChats.some((row) => row.sourceId === 'device'), false);
});


function createFakeGroupClient({ promptGoneOnce = false } = {}) {
  const listeners = new Map();
  const calls = [];
  const resumeCounts = new Map();
  let promptGone = promptGoneOnce;
  const emit = (type, event) => {
    for (const handler of listeners.get(type) || []) handler(event);
  };
  const client = {
    calls,
    on(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
      return () => listeners.get(type)?.delete(handler);
    },
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'session.list') {
        return { sessions: [{ id: `stored-${params.profile}`, title: params.title }] };
      }
      if (method === 'session.resume') {
        const count = (resumeCounts.get(params.profile) || 0) + 1;
        resumeCounts.set(params.profile, count);
        return {
          session_id: count === 1 ? `live-${params.profile}` : `live-${params.profile}-rebound`,
          stored_session_id: `stored-${params.profile}`,
          info: { profile_name: params.profile },
        };
      }
      if (method === 'prompt.submit') {
        if (promptGone) {
          promptGone = false;
          const error = new Error('session not found');
          error.code = 4001;
          error.rpcCode = 4001;
          throw error;
        }
        queueMicrotask(() => emit('message.complete', {
          sessionId: params.session_id,
          payload: { text: `${params.session_id} reply` },
        }));
        return { accepted: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };
  return { client, calls };
}

test('group runtime discovers existing hidden Desktop member sessions by room title and profile', async () => {
  const { client, calls } = createFakeGroupClient();
  const visible = [];
  const persisted = [];
  const runtime = createBotGroupRuntime({
    client,
    onMessage: (message) => visible.push(message),
    persist: async (messages, meta) => persisted.push({ messages, meta }),
    timeoutMs: 1000,
  });

  const prepared = await runtime.prepare({
    roomId: 'room-launch',
    members: [{ name: 'alpha', title: 'Alpha' }, { name: 'beta', title: 'Beta' }],
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.sessions.length, 2);
  calls.length = 0;

  const result = await runtime.send({
    roomId: 'room-launch',
    groupName: 'Browser launch room',
    members: [{ name: 'alpha', title: 'Alpha' }, { name: 'beta', title: 'Beta' }],
    messages: [],
    text: 'Please review the launch status.',
  });

  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(calls.map(({ method, params }) => [method, params.profile]), [
    ['session.list', 'alpha'],
    ['session.resume', 'alpha'],
    ['prompt.submit', undefined],
    ['session.list', 'beta'],
    ['session.resume', 'beta'],
    ['prompt.submit', undefined],
  ]);
  assert.deepEqual(visible.map((message) => [message.role, message.roleLabel]), [
    ['user', 'You'],
    ['assistant', 'Alpha'],
    ['assistant', 'Beta'],
  ]);
  assert.equal(persisted.length, 3, 'the user message and each real member reply are persisted through the projection callback');
});

test('group runtime resumes a durable member session once after prompt.submit 4001', async () => {
  const { client, calls } = createFakeGroupClient({ promptGoneOnce: true });
  const result = await createBotGroupRuntime({ client, timeoutMs: 1000 }).send({
    roomId: 'room-launch',
    groupName: 'Launch',
    members: ['alpha', 'beta'],
    text: 'Recover this room turn.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(calls.filter(({ method }) => method === 'prompt.submit').map(({ params }) => params.session_id), [
    'live-alpha',
    'live-alpha-rebound',
    'live-beta',
  ]);
  assert.ok(calls.some(({ method, params }) => method === 'session.resume' && params.session_id === 'stored-alpha'));
  assert.ok(calls.filter(({ method }) => method === 'prompt.submit').every(({ params }) => !Object.hasOwn(params, 'profile')));
});

test('group runtime refuses invalid member counts and does not submit a partial room turn', async () => {
  const { client, calls } = createFakeGroupClient();
  const runtime = createBotGroupRuntime({ client, timeoutMs: 1000 });
  const result = await runtime.send({ roomId: 'room', groupName: 'Room', members: ['only'], text: 'hello' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'member-count');
  assert.equal(calls.length, 0);
});

test('group runtime treats pass replies as silent while retaining the helper contract', () => {
  assert.equal(isGroupPassText(''), true);
  assert.equal(isGroupPassText('(pass)'), true);
  assert.equal(isGroupPassText('Pass.'), true);
  assert.equal(isGroupPassText('A real reply'), false);
});

test('group projection append uses the official profile metadata CAS and verifies the write', async () => {
  const snapshot = {
    version: 3,
    rooms: {
      'id:room-launch': {
        roomId: 'room-launch',
        name: 'Launch',
        revision: 4,
        members: [{ name: 'alpha' }, { name: 'beta' }],
        log: [{ id: 'old', from: { kind: 'user', name: 'You' }, text: 'Earlier', at: NOW }],
      },
    },
    deleted: {},
  };
  const calls = [];
  const client = {
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === 'profiles.list') {
        return {
          profiles: [{
            name: 'default',
            ui_meta: { 'hermes-bots-groups': snapshot },
            ui_meta_revisions: { 'hermes-bots-groups': 9 },
          }],
        };
      }
      if (method === 'profiles.configure') {
        assert.equal(params.name, 'default');
        assert.deepEqual(params.ui_meta_expected_revisions, { 'hermes-bots-groups': 9 });
        snapshot.rooms['id:room-launch'] = params.ui_meta['hermes-bots-groups'].rooms['id:room-launch'];
        return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': 10 } } };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  await persistGroupProjectionAppend(client, {
    roomId: 'room-launch',
    roomKey: 'id:room-launch',
    message: { role: 'user', roleLabel: 'You', content: 'Ship it', ts: NOW + 1 },
    now: NOW + 1,
  });

  assert.equal(calls.filter(({ method }) => method === 'profiles.list').length, 2, 'CAS write is followed by exact read-back');
  assert.equal(snapshot.rooms['id:room-launch'].revision, 5);
  assert.equal(snapshot.rooms['id:room-launch'].log.at(-1).text, 'Ship it');
});

test('group projection append retries once after a Desktop CAS conflict', async () => {
  const snapshot = {
    version: 3,
    rooms: {
      'id:room': {
        roomId: 'room',
        name: 'Room',
        revision: 1,
        members: [{ name: 'alpha' }, { name: 'beta' }],
        log: [],
      },
    },
    deleted: {},
  };
  let revision = 4;
  let configureCalls = 0;
  const client = {
    request: async (method, params = {}) => {
      if (method === 'profiles.list') return { profiles: [{ name: 'default', ui_meta: { 'hermes-bots-groups': snapshot }, ui_meta_revisions: { 'hermes-bots-groups': revision } }] };
      if (method === 'profiles.configure') {
        configureCalls += 1;
        if (configureCalls === 1) {
          snapshot.rooms['id:room'].log.push({ id: 'desktop', from: { kind: 'member', name: 'beta' }, text: 'Desktop won the race', at: NOW + 1 });
          revision += 1;
          return { applied: { ui_meta: false, ui_meta_conflicts: { 'hermes-bots-groups': { expected: 4, actual: 5 } } } };
        }
        assert.equal(params.ui_meta_expected_revisions['hermes-bots-groups'], 5);
        snapshot.rooms['id:room'] = params.ui_meta['hermes-bots-groups'].rooms['id:room'];
        revision += 1;
        return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': revision } } };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const result = await persistGroupProjectionAppend(client, {
    roomId: 'room',
    roomKey: 'id:room',
    message: { role: 'user', roleLabel: 'You', content: 'Browser won too', ts: NOW + 2 },
    now: NOW + 2,
  });
  assert.equal(result.ok, true);
  assert.equal(configureCalls, 2);
  assert.equal(snapshot.rooms['id:room'].log.at(-1).text, 'Browser won too');
});

test('new display messages convert to bounded projection entries with author identity', () => {
  assert.deepEqual(groupProjectionEntryFromDisplayMessage({
    role: 'assistant',
    roleLabel: 'Alpha',
    content: 'A reply',
    ts: NOW,
  }), {
    id: '',
    from: { kind: 'member', name: 'Alpha', source: '' },
    text: 'A reply',
    at: NOW,
    thread: '',
  });
});

test('persistGroupProjectionUpdate renames group and updates image atomically with member profile sync', async () => {
  let revision = 4;
  const snapshot = {
    version: 3,
    updatedAt: NOW,
    rooms: {
      'id:room-launch': {
        name: 'Browser launch room',
        roomId: 'room-launch',
        members: ['default', 'namine', 'riku'],
        revision: 1,
        image: null,
        log: [],
      },
    },
  };
  const profiles = [
    { name: 'default', ui_meta: { 'hermes-bots-groups': snapshot }, ui_meta_revisions: { 'hermes-bots-groups': revision } },
    { name: 'namine', ui_meta: { groups: ['Browser launch room'] } },
    { name: 'riku', ui_meta: { groups: ['Browser launch room'] } },
  ];
  const client = {
    async request(method, params = {}) {
      if (method === 'profiles.list') return { profiles };
      if (method === 'profiles.configure') {
        if (params.name === 'default') {
          revision += 1;
          Object.assign(snapshot, params.ui_meta['hermes-bots-groups']);
          return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': revision } } };
        }
        const member = profiles.find((p) => p.name === params.name);
        if (member) Object.assign(member.ui_meta, params.ui_meta);
        return { applied: { ui_meta: true } };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const result = await persistGroupProjectionUpdate(client, {
    roomId: 'room-launch',
    roomKey: 'id:room-launch',
    profile: 'default',
    newName: 'Kingdom Hearts Team',
    newImage: 'data:image/png;base64,mockImage',
    now: NOW + 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.newName, 'Kingdom Hearts Team');
  assert.equal(result.newImage, 'data:image/png;base64,mockImage');
  assert.equal(snapshot.rooms['id:room-launch'].name, 'Kingdom Hearts Team');
  assert.equal(snapshot.rooms['id:room-launch'].image, 'data:image/png;base64,mockImage');
  assert.deepEqual(profiles.find((p) => p.name === 'namine').ui_meta.groups, ['Kingdom Hearts Team']);
});

test('persistGroupProjectionUpdate handles name-keyed rooms and re-keys them on rename', async () => {
  let revision = 2;
  const snapshot = {
    version: 3,
    updatedAt: NOW,
    rooms: {
      'name:Roxas, Namine, Riku': {
        name: 'Roxas, Namine, Riku',
        members: ['default', 'namine', 'riku'],
        revision: 5,
        log: [],
      },
    },
    deleted: {},
  };
  const profiles = [
    { name: 'default', ui_meta: { 'hermes-bots-groups': snapshot }, ui_meta_revisions: { 'hermes-bots-groups': revision } },
    { name: 'namine', ui_meta: { groups: ['Roxas, Namine, Riku'] } },
    { name: 'riku', ui_meta: { groups: ['Roxas, Namine, Riku'] } },
  ];
  const client = {
    async request(method, params = {}) {
      if (method === 'profiles.list') return { profiles };
      if (method === 'profiles.configure') {
        if (params.name === 'default') {
          revision += 1;
          Object.assign(snapshot, params.ui_meta['hermes-bots-groups']);
          return { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots-groups': revision } } };
        }
        const member = profiles.find((p) => p.name === params.name);
        if (member) Object.assign(member.ui_meta, params.ui_meta);
        return { applied: { ui_meta: true } };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const result = await persistGroupProjectionUpdate(client, {
    roomId: 'Roxas, Namine, Riku',
    profile: 'namine', // even when called while non-default profile is active
    newName: 'Sync Test v1',
    now: NOW + 20,
  });

  assert.equal(result.ok, true);
  assert.equal(result.newName, 'Sync Test v1');
  assert.equal(result.roomKey, 'name:Sync Test v1');
  assert.equal(snapshot.rooms['name:Sync Test v1'].name, 'Sync Test v1');
  assert.equal(snapshot.rooms['name:Roxas, Namine, Riku'], undefined);
  assert.equal(snapshot.deleted['name:Roxas, Namine, Riku'], NOW + 20);
  assert.deepEqual(profiles.find((p) => p.name === 'riku').ui_meta.groups, ['Sync Test v1']);
});

test('mergeGroupChatLists deduplicates by name and drops canonical fallbacks when real rooms exist', () => {
  const fallback = {
    id: 'Roxas, Namine, Riku',
    displayName: 'Roxas, Namine, Riku',
    type: 'group',
    sourceId: 'canonical',
    activity: { lastActive: NOW - 1000 },
  };
  const preRenameLocal = {
    id: 'Roxas, Namine, Riku',
    displayName: 'Sync Room v1',
    type: 'group',
    sourceId: 'current',
    revision: 0,
    activity: { lastActive: NOW },
  };
  const serverSynced = {
    id: 'sync room v1',
    displayName: 'Sync Room v1',
    type: 'group',
    roomKey: 'name:Sync Room v1',
    sourceId: 'http://127.0.0.1:8642',
    revision: 9,
    activity: { lastActive: NOW },
  };

  const merged = mergeGroupChatLists([fallback, preRenameLocal], [serverSynced]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].displayName, 'Sync Room v1');
  assert.equal(merged[0].sourceId, 'http://127.0.0.1:8642');
  assert.equal(merged[0].revision, 9);
});

