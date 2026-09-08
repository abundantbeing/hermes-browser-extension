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
