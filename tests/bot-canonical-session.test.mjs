import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOT_CHAT_TITLE,
  resolveCanonicalBotSession,
} from '../extension/lib/bot-canonical-session.mjs';

const rowFor = (canonical = null, profileName = 'roxas') => ({
  profileName,
  canonical,
});

function listed(sessions) {
  return async () => ({ sessions });
}

test('canonical Bot Chat resolution returns the durable id and compression runtime tip', async () => {
  const calls = [];
  const result = await resolveCanonicalBotSession(
    rowFor({ durableId: 'bot-chat-root', resolvedRuntimeId: 'bot-chat-tip', status: 'ready' }),
    async (params) => {
      calls.push(params);
      return {
        sessions: [{
          id: 'bot-chat-root',
          resolved_id: 'bot-chat-tip',
          root_title: BOT_CHAT_TITLE,
          title: 'Bot Chat · continuation',
          profile: 'roxas',
        }],
      };
    },
  );

  assert.deepEqual(result, {
    durableId: 'bot-chat-root',
    runtimeId: 'bot-chat-tip',
  });
  assert.deepEqual(calls, [{
    profile: 'roxas',
    title: BOT_CHAT_TITLE,
    include_hidden: true,
  }]);
});

test('canonical Bot Chat resolution accepts an exact title row without choosing the first row', async () => {
  const result = await resolveCanonicalBotSession(
    rowFor(null),
    listed([
      { id: 'ordinary-session', title: 'A different chat', profile: 'roxas' },
      { id: 'canonical-session', title: BOT_CHAT_TITLE, profile: 'roxas' },
      { id: 'near-match', title: 'Bot Chat · continuation', profile: 'roxas' },
    ]),
  );

  assert.deepEqual(result, {
    durableId: 'canonical-session',
    runtimeId: 'canonical-session',
  });
});

test('canonical Bot Chat resolution accepts lineage rows by exact root title', async () => {
  const result = await resolveCanonicalBotSession(
    rowFor(null),
    listed([{
      id: 'bot-chat-root',
      resolved_id: 'bot-chat-tip',
      root_title: BOT_CHAT_TITLE,
      title: 'Bot Chat · continuation',
      profile: 'roxas',
    }]),
  );

  assert.deepEqual(result, {
    durableId: 'bot-chat-root',
    runtimeId: 'bot-chat-tip',
  });
});

test('canonical Bot Chat resolution rejects an exact row acknowledged for another profile', async () => {
  await assert.rejects(
    () => resolveCanonicalBotSession(
      rowFor(null, 'roxas'),
      listed([{
        id: 'namine-chat',
        title: BOT_CHAT_TITLE,
        profile_name: 'namine',
      }]),
    ),
    /profile/i,
  );
});

test('canonical Bot Chat resolution propagates lookup failures instead of treating them as missing', async () => {
  const failure = new Error('gateway unavailable');

  await assert.rejects(
    () => resolveCanonicalBotSession(rowFor(null), async () => {
      throw failure;
    }),
    (error) => error instanceof Error
      && /gateway unavailable/.test(error.message)
      && error.cause === failure,
  );
});

test('canonical Bot Chat resolution rejects an empty lookup when the roster already knows a canonical chat', async () => {
  await assert.rejects(
    () => resolveCanonicalBotSession(
      rowFor({ id: 'known-bot-chat', resolved_id: 'known-bot-chat-tip' }),
      listed([]),
    ),
    /canonical|confirm/i,
  );
});

test('canonical Bot Chat resolution confirms absence only for an empty roster with no known canonical chat', async () => {
  const result = await resolveCanonicalBotSession(rowFor(null), listed([]));

  assert.equal(result, null);
});

// --- across routes: the Hermes Web socket, then the bot's own gateway routes ----------------------

test('a Bot Chat the session-authority socket cannot see is found on the bot gateway routes', async () => {
  const { resolveBotChatAcrossRoutes } = await import('../extension/lib/bot-canonical-session.mjs');
  const row = { profileName: 'riku' };
  const desktopChat = { id: '20260831_194941_f5d063', title: 'Bot Chat', source: 'desktop' };
  // The reported case: the socket's title lookup answers nothing for a Desktop-made chat.
  const result = await resolveBotChatAcrossRoutes(row, { socketList: async () => ({ sessions: [] }), restList: async () => [desktopChat] });
  assert.equal(result.canonical.durableId, desktopChat.id);
  assert.equal(result.transport, 'rest');
  // The roster already knows the chat, so the socket's empty answer throws: still found over REST.
  const known = { profileName: 'riku', canonical: { id: desktopChat.id } };
  const viaRoster = await resolveBotChatAcrossRoutes(known, { socketList: async () => ({ sessions: [] }), restList: async () => [desktopChat] });
  assert.equal(viaRoster.canonical.durableId, desktopChat.id);
  assert.ok(viaRoster.socketError, 'the socket error is kept for the log');
});

test('the socket wins when it can see the Bot Chat, and nothing is created unless every route found none', async () => {
  const { resolveBotChatAcrossRoutes } = await import('../extension/lib/bot-canonical-session.mjs');
  const row = { profileName: 'saix' };
  let restAsked = 0;
  const viaSocket = await resolveBotChatAcrossRoutes(row, {
    socketList: async () => ({ sessions: [{ id: 's1', title: 'Bot Chat' }] }),
    restList: async () => { restAsked += 1; return []; },
  });
  assert.deepEqual([viaSocket.canonical.durableId, viaSocket.transport, restAsked], ['s1', 'dashboard-ws', 0]);
  // A new bot: both routes positively find none.
  const none = await resolveBotChatAcrossRoutes(row, { socketList: async () => ({ sessions: [] }), restList: async () => [] });
  assert.deepEqual([none.canonical, none.transport], [null, 'dashboard-ws']);
  // No socket: REST alone decides.
  const restOnly = await resolveBotChatAcrossRoutes(row, { restList: async () => [{ id: 'r1', title: 'Bot Chat' }] });
  assert.deepEqual([restOnly.canonical.durableId, restOnly.transport], ['r1', 'rest']);
  // Both routes fail: it throws (the socket error first), so the caller never forks a new chat.
  await assert.rejects(
    resolveBotChatAcrossRoutes(row, { socketList: async () => { throw new Error('socket down'); }, restList: async () => { throw new Error('rest down'); } }),
    /socket down/,
  );
  // The roster knows a chat neither route can confirm: it throws instead of creating one.
  await assert.rejects(resolveBotChatAcrossRoutes({ profileName: 'saix', canonical: { id: 'gone' } }, { socketList: async () => ({ sessions: [] }), restList: async () => [] }));
});
