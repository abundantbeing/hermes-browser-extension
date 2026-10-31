import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers';
import { WS_EVENTS, WS_METHODS, normalizeGatewayHistoryMessages, promptSubmitParamsFor, readGatewaySessionStatus } from '../extension/lib/gateway-ws.mjs';
import { turnDeliveryFromHistory, latestAssistantAfterUser, sessionStatusKnownIdle, turnRequestFailureState } from '../extension/lib/turn-recovery.mjs';
import { dashboardWatchdogTimeoutAction, matchesDashboardSessionEvent } from '../extension/lib/dashboard-stream-watchdog.mjs';
import { messageDisplayText } from '../extension/lib/common.mjs';
import { hermesGatewayTurnError } from '../extension/lib/turn-recovery.mjs';
import { turnNotDeliveredError } from '../extension/lib/gateway-refusal.mjs';
import { emptyTurnReasoning, formatTurnDuration, liveTurnStartedAt, reduceTurnReasoning, replyTextAfterCommentary, turnReasoningFromRestEvent } from '../extension/lib/turn-activity.mjs';
import { bindDashboardReasoning, ensureSessionShowsReasoning } from '../extension/lib/turn-reasoning-socket.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const attemptSource = source.slice(
  source.indexOf('async function streamDashboardWsChatAttempt('),
  source.indexOf('async function streamSessionChat('),
);

// A turn that never settles must fail an assertion, not hang the run.
const settled = (h, ms = 150) => Promise.race([h.promise, new Promise((resolve) => setTimeout(resolve, ms))]);
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// streamDashboardWsChatAttempt with a fake gateway client. `history` is what
// session.history answers; `status` is what the status read answers.
function attemptHarness({ history, status, authority = false, submitPrompt = false, prompt = 'NEW question', displayText = '', submissionId = '' }) {
  const listeners = new Map();
  const painted = [];
  const calls = [];
  const watchdogs = [];
  const client = {
    readyPayload: authority ? { session_authority: true } : {},
    on: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'session.history') return { messages: history };
      if (method === 'session.status') {
        if (authority) throw Object.assign(new Error('unknown method: session.status'), { rpcCode: -32601, data: { reason: 'unknown_method' } });
        return status;
      }
      if (method === 'session.active_list') return { sessions: [] };
      if (method === 'session.resume') return { running: false, execution_state: 'idle' };
      if (method === 'prompt.submit') return {};
      return {};
    },
  };
  const context = vm.createContext({
    WS_METHODS, WS_EVENTS, promptSubmitParamsFor, bindDashboardReasoning, ensureSessionShowsReasoning,
    matchesDashboardSessionEvent, normalizeGatewayHistoryMessages, readGatewaySessionStatus,
    latestAssistantAfterUser, turnDeliveryFromHistory, sessionStatusKnownIdle, messageDisplayText, turnNotDeliveredError,
    dashboardWatchdogTimeoutAction, hermesGatewayTurnError,
    createDashboardStreamWatchdog: (onTimeout) => { const dog = { onTimeout, ping() {}, stop() {} }; watchdogs.push(dog); return dog; },
    safeActiveProfile: () => '',
    ingestSubagentGatewayEvent: () => {}, rememberLiveSessionAlias: () => {}, bindContextTelemetryClient: () => {},
    refreshSessionContextTelemetry: () => {}, hydrateSubagentSnapshot: async () => {},
    attachDashboardTurnImages: async () => {}, noteDashboardImageAttach: () => {},
    gatewayQuirks: { load: async () => {}, isUnsupported: () => false },
    browserTurnDisplayParam: () => (displayText ? { display_text: displayText } : {}), truncateSubmitParams: () => ({}),
    rememberUserFileAttachments: async () => {}, attachmentSourceKey: () => 'k', setStatus: () => {}, t: (key) => key,
    isDisplayTextRejection: () => false, GATEWAY_QUIRK: { PROMPT_DISPLAY_TEXT: 'x' },
    settings: { gatewayUrl: 'http://gw', sessionId: 'stored-1' },
    DOMException,
    connection: { client, wsSessionId: 'live-1', wsStoredSessionId: 'stored-1', baseUrl: 'http://gw' },
    onDelta: (text) => painted.push(text),
  });
  vm.runInContext(attemptSource, context);
  context.history = history;
  const outcome = {};
  const promise = vm.runInContext(
    `streamDashboardWsChatAttempt(connection, 'live-1', ${JSON.stringify(prompt)}, onDelta, null, { submitPrompt: ${submitPrompt}, submissionId: ${JSON.stringify(submissionId)} })`,
    context,
  ).then((value) => { outcome.resolved = value; }, (error) => { outcome.error = error; });
  return {
    painted, calls, outcome, promise, watchdogs,
    emit: (type, payload) => { for (const fn of listeners.get(type) || []) fn({ sessionId: 'live-1', payload }); },
  };
}

const OLD_TURN = [
  { role: 'user', content: 'OLD question' },
  { role: 'assistant', content: 'OLD ANSWER from the previous turn' },
];

test('turnDeliveryFromHistory only answers from after the matching user row', () => {
  assert.deepEqual(turnDeliveryFromHistory(OLD_TURN, ['NEW question']), { delivered: false, answer: '' });
  assert.deepEqual(
    turnDeliveryFromHistory([...OLD_TURN, { role: 'user', content: 'NEW question' }, { role: 'assistant', content: 'NEW ANSWER' }], ['NEW question']),
    { delivered: true, answer: 'NEW ANSWER' },
  );
  assert.deepEqual(
    turnDeliveryFromHistory([...OLD_TURN, { role: 'user', content: 'NEW question' }], ['NEW question']),
    { delivered: true, answer: '' },
    'delivered but not yet answered',
  );
  assert.equal(
    turnDeliveryFromHistory([{ role: 'user', content: 'typed words' }, { role: 'assistant', content: 'A' }], ['envelope text', 'typed words']).answer,
    'A',
    'the row may carry the display form of the prompt',
  );
});

test('sessionStatusKnownIdle needs positive evidence', () => {
  assert.equal(sessionStatusKnownIdle({ output: 'Agent Running: No' }), true);
  assert.equal(sessionStatusKnownIdle({ status: 'idle' }), true);
  assert.equal(sessionStatusKnownIdle({ output: 'Agent Running: Yes' }), false);
  assert.equal(sessionStatusKnownIdle({ status: 'running' }), false);
  assert.equal(sessionStatusKnownIdle(null), false);
  assert.equal(sessionStatusKnownIdle({}), false);
});

test('a reattach for a prompt the gateway never recorded does not show the previous answer and ends as not delivered', async () => {
  const h = attemptHarness({ history: OLD_TURN, status: { output: 'Agent Running: No' } });
  await settled(h);
  assert.deepEqual(h.painted, [], 'the old answer is never painted for the new prompt');
  assert.equal(h.outcome.error?.turnNotDelivered, true);
  assert.equal(h.outcome.error?.requestAccepted, undefined, 'not accepted: the draft is restored');
  assert.equal(h.calls.filter((call) => call.method === 'prompt.submit').length, 0, 'never resent blind');
  assert.equal(turnRequestFailureState(h.outcome.error).preserveDraft, true);
});

test('the same holds on a session authority, where session.status is not served', async () => {
  const h = attemptHarness({ history: OLD_TURN, authority: true });
  await settled(h);
  assert.deepEqual(h.painted, []);
  assert.equal(h.outcome.error?.turnNotDelivered, true);
});

test('a reattach for a prompt that was recorded and answered paints that answer', async () => {
  const h = attemptHarness({
    history: [...OLD_TURN, { role: 'user', content: 'NEW question' }, { role: 'assistant', content: 'NEW ANSWER' }],
    status: { output: 'Agent Running: No' },
  });
  await flush();
  assert.deepEqual(h.painted, ['NEW ANSWER']);
  assert.equal(h.outcome.error, undefined, 'a delivered turn is not failed');
  h.emit('message.complete', { text: 'NEW ANSWER' });
  await h.promise;
  assert.equal(h.outcome.resolved, 'NEW ANSWER');
});

test('an unrecorded prompt while a turn is still running keeps listening instead of failing', async () => {
  const h = attemptHarness({ history: OLD_TURN, status: { output: 'Agent Running: Yes' } });
  await flush();
  assert.deepEqual(h.painted, []);
  assert.equal(h.outcome.error, undefined);
  assert.equal(h.outcome.resolved, undefined);
  h.emit('message.complete', { text: 'late answer' });
  await h.promise;
  assert.equal(h.outcome.resolved, 'late answer');
});

test('an unreadable status is not evidence of non-delivery', async () => {
  const h = attemptHarness({ history: OLD_TURN, status: null });
  await flush();
  assert.equal(h.outcome.error, undefined);
  assert.deepEqual(h.painted, []);
});

test('the idle timeout does not resolve the previous answer as this turn\'s answer', async () => {
  const h = attemptHarness({ history: OLD_TURN, status: { output: 'Agent Running: No' }, submitPrompt: true });
  await flush();
  h.watchdogs[0].onTimeout(Object.assign(new Error('Dashboard response timed out.'), { requestAccepted: true }));
  await settled(h);
  assert.deepEqual(h.painted, []);
  assert.notEqual(h.outcome.resolved, 'OLD ANSWER from the previous turn');
});

test('a stored envelope turn still matches by its readable form', () => {
  const envelope = '<<<HERMES_PAGE_COMMENTS\nComment 1\nfix this\n<<<END_HERMES_PAGE_COMMENTS>>>\nwhat is wrong here?';
  const rows = [{ role: 'user', content: envelope }, { role: 'assistant', content: 'ANSWER' }];
  const readable = messageDisplayText('user', envelope);
  assert.notEqual(readable, envelope);
  assert.deepEqual(turnDeliveryFromHistory(rows, [readable], { displayText: messageDisplayText }), { delivered: true, answer: 'ANSWER' });
  assert.deepEqual(turnDeliveryFromHistory(rows, ['another prompt'], { displayText: messageDisplayText }), { delivered: false, answer: '' });
});

test('a session authority admits the turn under its submission id, without display_text', async () => {
  const h = attemptHarness({ history: [], authority: true, submitPrompt: true, displayText: 'NEW', submissionId: 'turn-7' });
  await flush();
  const submit = h.calls.find((call) => call.method === 'prompt.submit');
  assert.ok(submit, 'the turn was submitted');
  assert.equal(submit.params.submission_id, 'turn-7');
  assert.equal(submit.params.text, 'NEW question');
  assert.equal('display_text' in submit.params, false, 'the canonical prompt.submit has no display_text key');
});

test('a legacy dashboard socket keeps its own prompt.submit keys and gets no submission id', async () => {
  const h = attemptHarness({ history: [], authority: false, submitPrompt: true, displayText: 'NEW', submissionId: 'turn-7' });
  await flush();
  const submit = h.calls.find((call) => call.method === 'prompt.submit');
  assert.ok(submit, 'the turn was submitted');
  assert.equal('submission_id' in submit.params, false);
  assert.equal(submit.params.display_text, 'NEW');
});
