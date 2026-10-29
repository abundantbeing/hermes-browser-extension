import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  botChatDeliveryFrame,
  botChatRefusalState,
  isPendingBotChatDelivery,
  movedAsideBotChat,
  movedBotChatSessionId,
} from '../extension/lib/bot-chat-delivery.mjs';
import { appendOpenAiChunkText } from '../extension/lib/common.mjs';
import { isPromptEventName } from '../extension/lib/gateway-prompts.mjs';
import { normalizeBrowserRuntimeEvent, reduceAssistantStreamText } from '../extension/lib/runtime-events.mjs';
import english from '../extension/lib/locales/en.mjs';
import { emptyTurnReasoning, formatTurnDuration, liveTurnStartedAt, reduceTurnReasoning, replyTextAfterCommentary, turnReasoningFromRestEvent } from '../extension/lib/turn-activity.mjs';
import { bindDashboardReasoning, ensureSessionShowsReasoning } from '../extension/lib/turn-reasoning-socket.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined in sidepanel.js`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

const askHermes = functionSource('askHermes');

// ---- the receipt frames ----------------------------------------------------

test('a frame without a delivery id is an ordinary run frame', () => {
  assert.equal(botChatDeliveryFrame('assistant.completed', { content: 'hi', session_id: 's1' }), null);
  assert.equal(botChatDeliveryFrame('run.started', { run_id: 'run_x' }), null);
  assert.equal(botChatDeliveryFrame('error', { message: 'boom' }), null);
});

test('a settled hand-off names the Bot Chat the turn entered', () => {
  assert.deepEqual(
    botChatDeliveryFrame('assistant.completed', { content: 'Doing good', delivery_id: 'd1', session_id: 'local-new' }),
    { status: 'settled', deliveryId: 'd1', sessionId: 'local-new' },
  );
  assert.deepEqual(
    botChatDeliveryFrame('run.completed', { delivery_id: 'd1', session_id: 'local-new' }),
    { status: 'settled', deliveryId: 'd1', sessionId: 'local-new' },
  );
});

test('a delivery still queued at the gateway budget is pending, claimed included', () => {
  const queued = botChatDeliveryFrame('run.queued', { status: 'queued', delivery_id: 'd2', session_id: 's' });
  const claimed = botChatDeliveryFrame('run.queued', { status: 'claimed', delivery_id: 'd2', session_id: 's' });
  assert.equal(queued.status, 'queued');
  assert.equal(claimed.status, 'claimed');
  assert.equal(isPendingBotChatDelivery(queued), true);
  assert.equal(isPendingBotChatDelivery(claimed), true);
  assert.equal(isPendingBotChatDelivery({ status: 'settled' }), false);
  assert.equal(isPendingBotChatDelivery(null), false);
});

test('a refused delivery carries the gateway code', () => {
  assert.deepEqual(
    botChatDeliveryFrame('error', { message: 'Bot Chat admission refused: permission_denied', code: 'permission_denied', delivery_id: 'd3', session_id: 's' }),
    { status: 'refused', deliveryId: 'd3', sessionId: 's', code: 'permission_denied' },
  );
});

test('the view follows only a Bot Chat the turn actually entered under another id', () => {
  const settled = { status: 'settled', deliveryId: 'd', sessionId: 'local-new' };
  assert.equal(movedBotChatSessionId('hermes-browser-extension-1', settled), 'local-new');
  assert.equal(movedBotChatSessionId('local-new', settled), '');
  assert.equal(movedBotChatSessionId('', settled), '');
  assert.equal(movedBotChatSessionId('old', { status: 'settled', deliveryId: 'd', sessionId: '' }), '');
  assert.equal(movedBotChatSessionId('old', { ...settled, status: 'refused' }), '');
  assert.equal(movedBotChatSessionId('old', { ...settled, status: 'queued' }), 'local-new');
  assert.equal(movedBotChatSessionId('old', null), '');
});

// ---- the side panel's stream reader ----------------------------------------

function loadReader() {
  const context = {
    TextDecoder,
    DOMException,
    settings: { sessionId: 'requested' },
    botChatDeliveryFrame,
    appendOpenAiChunkText,
    isPromptEventName,
    normalizeBrowserRuntimeEvent,
    reduceAssistantStreamText,
    isSubagentEventName: () => false,
    subagentGatewayEventFromSse: () => null,
    ingestSubagentGatewayEvent: () => {},
    turnReasoningFromRestEvent,
    replyTextAfterCommentary,
  };
  vm.createContext(context);
  vm.runInContext(
    `${functionSource('parseSseBlock')}\n${functionSource('sseBlocksFromBuffer')}\n${functionSource('readSseResponse')}\nthis.readSseResponse = readSseResponse;`,
    context,
  );
  return context.readSseResponse;
}

function sseResponse(frames) {
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => {},
      }),
    },
  };
}

test('a hand-off stream returns the reply and reports the Bot Chat it entered', async () => {
  const readSseResponse = loadReader();
  const deliveries = [];
  const runs = [];
  const text = await readSseResponse(sseResponse([
    ['run.started', { user_message: { role: 'user', content: 'hi' }, runtime: {}, session_id: 'local-new', run_id: 'run_unregistered' }],
    ['message.started', { message: { id: 'm1', role: 'assistant' }, session_id: 'local-new', run_id: 'run_unregistered' }],
    ['assistant.completed', { message_id: 'm1', content: 'Doing good, bro.', delivery_id: 'd1', runtime: {}, session_id: 'local-new', run_id: 'run_unregistered' }],
    ['run.completed', { message_id: 'm1', delivery_id: 'd1', usage: {}, runtime: {}, session_id: 'local-new', run_id: 'run_unregistered' }],
    ['done', {}],
  ]), () => {}, null, { onRun: (id) => runs.push(id), onDelivery: (delivery) => deliveries.push(delivery) });
  assert.equal(text, 'Doing good, bro.');
  assert.deepEqual(runs, ['run_unregistered']);
  assert.ok(deliveries.length >= 1);
  assert.ok(deliveries.every((delivery) => delivery.status === 'settled' && delivery.sessionId === 'local-new'));
});

test('a delivery still queued ends the stream without an error', async () => {
  const readSseResponse = loadReader();
  const deliveries = [];
  const text = await readSseResponse(sseResponse([
    ['run.started', { user_message: { role: 'user', content: 'hi' }, runtime: {}, session_id: 'bc', run_id: 'run_x' }],
    ['run.queued', { status: 'queued', delivery_id: 'd2', session_id: 'bc', run_id: 'run_x' }],
    ['done', {}],
  ]), () => {}, null, { onDelivery: (delivery) => deliveries.push(delivery) });
  assert.equal(text, '');
  assert.equal(deliveries.at(-1).status, 'queued');
});

test('a refused delivery throws the gateway words with the receipt attached', async () => {
  const readSseResponse = loadReader();
  await assert.rejects(
    readSseResponse(sseResponse([
      ['run.started', { user_message: { role: 'user', content: 'hi' }, runtime: {}, session_id: 'bc', run_id: 'run_x' }],
      ['error', { message: 'Bot Chat admission refused: permission_denied', code: 'permission_denied', delivery_id: 'd3', session_id: 'bc', run_id: 'run_x' }],
      ['done', {}],
    ]), () => {}, null, {}),
    (error) => {
      assert.equal(error.message, 'Bot Chat admission refused: permission_denied');
      assert.equal(error.streamError, true);
      assert.equal(error.requestRejected, true);
      assert.equal(error.botChatDelivery.status, 'refused');
      assert.equal(error.botChatDelivery.code, 'permission_denied');
      return true;
    },
  );
});

test('an ordinary run stream never reports a delivery', async () => {
  const readSseResponse = loadReader();
  const deliveries = [];
  const text = await readSseResponse(sseResponse([
    ['run.started', { run_id: 'run_real', session_id: 'requested' }],
    ['assistant.completed', { content: 'plain reply', session_id: 'requested', run_id: 'run_real' }],
    ['run.completed', { session_id: 'requested', run_id: 'run_real' }],
  ]), () => {}, null, { onDelivery: (delivery) => deliveries.push(delivery) });
  assert.equal(text, 'plain reply');
  assert.deepEqual(deliveries, []);
});

// ---- the turn ------------------------------------------------------------------

test('the REST stream path hands onDelivery through to the reader', () => {
  assert.match(functionSource('streamSessionChat'), /streamSessionChatRest\([^)]*onDelivery/);
  assert.match(functionSource('streamSessionChatRest'), /readSseResponse\([^)]*onDelivery/);
});

test('a hand-off turn drops the unregistered run id so nothing polls or reconciles it', () => {
  const handler = askHermes.match(/onDelivery: \(delivery\) => \{([\s\S]*?)\n {10}\},/)?.[1] || '';
  assert.match(handler, /botChatDelivery = delivery/);
  assert.match(handler, /promptPoller\?\.stop\(\)/);
  assert.match(handler, /activeRunId = ''/);
  assert.match(handler, /promptRunId = ''/);
});

test('the turn follows a moved Bot Chat before the post-turn refresh reads it', () => {
  assert.match(askHermes, /movedBotChatSessionId\(runSessionId, botChatDelivery\)/);
  assert.match(askHermes, /if \(movedBotChatId && runIsViewed\(\)\) await adoptMovedBotChat\(runSessionId, movedBotChatId\)/);
  const adopt = functionSource('adoptMovedBotChat');
  assert.match(adopt, /sessionId: next/);
  assert.match(adopt, /hermesBrowserSettings: settings/);
  assert.doesNotMatch(adopt, /sessionLineage\.adopt/, 'the moved-aside chat stays its own conversation');
});

test('a queued reply is said plainly and never stored as an empty answer', () => {
  assert.match(askHermes, /isPendingBotChatDelivery\(botChatDelivery\)/);
  assert.match(askHermes, /t\('chat\.bot_reply_queued'\)/);
  assert.match(askHermes, /=== runSessionId && !pendingBotChatReply/);
  assert.equal(typeof english['chat.bot_reply_queued'], 'string');
});

test('a reported failure is not wiped by the post-turn history refresh', () => {
  assert.match(askHermes, /if \(error\?\.requestAccepted !== true\) holdPostTurnRefresh = true;/);
  assert.match(askHermes, /if \(!holdPostTurnRefresh\) void refreshActiveSessionHistoryQuietly\(/);
  assert.equal((askHermes.match(/refreshActiveSessionHistoryQuietly\(/g) || []).length, 1);
});

test('a Bot Chat from before the gateway kept chats names the one step that hands it over', () => {
  const refused = botChatDeliveryFrame('error', { delivery_id: 'd1', code: 'bot_chat_unbound', message: 'Bot Chat admission refused: bot_chat_unbound' });
  const state = botChatRefusalState(refused, { profile: 'namine', name: 'Naminé' });
  assert.equal(state.kind, 'bot-chat-unbound');
  assert.equal(state.gatewayStatus, 'connected', 'the gateway answered: it stays connected');
  assert.equal(state.preserveDraft, true);
  assert.match(state.detail, /Naminé's Bot Chat/);
  assert.match(state.detail, /Hermes Desktop/);
  assert.match(state.detail, /`hermes -p namine sessions adopt`/);
  assert.match(botChatRefusalState(refused, { profile: 'default', name: 'Roxas' }).detail, /`hermes sessions adopt`/, 'the default profile needs no -p');
  assert.equal(botChatRefusalState(botChatDeliveryFrame('error', { delivery_id: 'd1', code: 'bot_chat_not_local' })), null, 'other refusals keep the gateway text');
  assert.equal(botChatRefusalState(botChatDeliveryFrame('run.queued', { delivery_id: 'd1' })), null);
  assert.equal(botChatRefusalState(null), null);
});

test('the panel shows the hand-over step for a refused Bot Chat turn before the generic rejection', () => {
  const ask = functionSource('askHermes');
  assert.match(ask, /preGatewayChatFailureState\(error\)\s*\|\| botChatRefusalState\(error\?\.botChatDelivery, botChatRefusalNames\(\)\)\s*\|\| turnRequestFailureState\(error\)/);
  assert.match(functionSource('botChatRefusalNames'), /safeActiveProfile\(\) \|\| 'default'/);
});

test('the earlier messages are the newest Bot Chat Hermes moved aside that holds any', () => {
  const rows = [
    { id: 'local-1', title: 'Bot Chat', message_count: 2, last_active: 50 },
    { id: 'old-a', title: 'Bot Chat (API old-a)', message_count: 12, last_active: 10 },
    { id: 'old-b', title: 'Bot Chat (hermes_browser old-b)', message_count: 46, last_active: 30 },
    { id: 'empty', title: 'Bot Chat (API empty)', message_count: 0, last_active: 40 },
    { id: 'draft', title: 'Bot Chat · 20260831_194941_f5d063', message_count: 0, last_active: 60 },
    { id: 'other', title: 'Planning notes', message_count: 9, last_active: 70 },
  ];
  assert.equal(movedAsideBotChat(rows)?.id, 'old-b');
  assert.equal(movedAsideBotChat(rows.filter((row) => !row.id.startsWith('old-'))), null);
  assert.equal(movedAsideBotChat(null), null);
});

test('the bot chat shows the earlier messages read-only and loads them only when opened', () => {
  const refresh = functionSource('refreshBotChatEarlier');
  assert.match(refresh, /movedAsideBotChat\(rows\)/);
  assert.match(refresh, /botChatEarlier\.profile !== profile/, 'a reply for a bot no longer open is dropped');
  const render = functionSource('renderBotChatEarlier');
  assert.match(render, /!activeGroupProjection/);
  assert.match(render, /bot-mode-engaged/);
  const load = functionSource('loadBotChatEarlierMessages');
  assert.match(load, /renderMarkdownSafe\(/);
  assert.doesNotMatch(load, /askHermes\(|openHermesSession\(|settings\.sessionId =/, 'reading them never switches or writes the open chat');
  assert.match(source, /void refreshBotChatEarlier\(row\);/);
  assert.match(source, /function renderBotChatIntro\(row = null\) \{\s*renderActiveProfileIndicator\(\);\s*renderBotChatEarlier\(\);/);
  assert.match(source, /els\.botChatEarlier\?\.addEventListener\('toggle'/);
  assert.match(english['bot_mode.earlier_messages'], /\{name\}/);
});
