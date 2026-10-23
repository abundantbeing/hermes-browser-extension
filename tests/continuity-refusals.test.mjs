import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  classifyPromptRefusal,
  isSessionBusyRefusal,
  isStaleLiveSessionRefusal,
  refusalFailureState,
  sessionGoneError,
  turnNotDeliveredError,
} from '../extension/lib/gateway-refusal.mjs';
import { shouldReattachDashboardStream } from '../extension/lib/dashboard-stream-watchdog.mjs';
import { turnRequestFailureState } from '../extension/lib/turn-recovery.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const chatSource = source.slice(
  source.indexOf('async function streamDashboardWsChat(prompt'),
  source.indexOf('async function streamDashboardWsChatAttempt('),
);

const refusal = (code, reason, extra = {}) => {
  const error = new Error(reason || 'session not found');
  error.rpcCode = code;
  error.code = code;
  if (reason) error.data = { reason, ...extra };
  return error;
};

// streamDashboardWsChat as the panel runs it, with the connection and the single
// attempt stubbed. `attempt(n)` throws or returns for the n-th submit.
function chatHarness(attempt, { resume } = {}) {
  const log = { attempts: [], resumes: 0 };
  const context = vm.createContext({
    settings: { sessionId: 'stored-A', remoteDashboardSession: { storedSessionId: 'stored-A', gatewayUrl: 'http://gw' } },
    ensureActiveDashboardWsConnection: async () => context.connection,
    connection: { wsSessionId: 'live-A', wsStoredSessionId: 'stored-A' },
    ensureRemoteWsSession: async (connection) => {
      log.resumes += 1;
      if (resume) await resume(log.resumes, connection);
      connection.wsSessionId = `live-A-${log.resumes}`;
      return connection.wsSessionId;
    },
    streamDashboardWsChatAttempt: async (_connection, sessionId, _prompt, _d, _t, options) => {
      log.attempts.push({ sessionId, submitPrompt: options.submitPrompt });
      if (log.attempts.length > 40) throw Object.assign(new Error('TEST CUTOFF: unbounded loop'), { rpcCode: 0, cutoff: true });
      return attempt(log.attempts.length);
    },
    shouldReattachDashboardStream,
    classifyPromptRefusal, isStaleLiveSessionRefusal, sessionGoneError,
  });
  vm.runInContext(chatSource, context);
  return {
    log, context,
    run: () => vm.runInContext("streamDashboardWsChat('hello', () => {}, () => {}, {})", context),
  };
}

test('classification: only a bare 4001 or a not-found reason says the live id is stale', () => {
  assert.equal(classifyPromptRefusal(refusal(4001, '')), 'stale-session');
  assert.equal(classifyPromptRefusal(refusal(4001, 'not_found')), 'stale-session');
  assert.equal(classifyPromptRefusal(refusal(4001, 'session_busy')), 'session-busy');
  assert.equal(classifyPromptRefusal(refusal(4001, 'admission_conflict')), 'session-busy');
  assert.equal(classifyPromptRefusal(refusal(4009, '')), 'session-busy');
  for (const reason of ['invalid_params', 'permission_denied', 'revision_conflict', 'runtime_draining', 'stale_generation', 'profile_mismatch']) {
    assert.equal(classifyPromptRefusal(refusal(4001, reason)), 'refused', reason);
    assert.equal(isStaleLiveSessionRefusal(refusal(4001, reason)), false, reason);
  }
  assert.equal(classifyPromptRefusal(new Error('socket closed')), '');
  assert.equal(isSessionBusyRefusal(refusal(4001, 'permission_denied')), false);
});

test('a refusal that names a reason is submitted once and never re-resumed (session_busy)', async () => {
  const h = chatHarness(() => { throw refusal(4001, 'session_busy'); });
  await assert.rejects(h.run(), (error) => error.data?.reason === 'session_busy');
  assert.equal(h.log.attempts.length, 1, 'exactly one prompt.submit');
  assert.equal(h.log.resumes, 1, 'only the initial resume, no re-resume');
});

test('invalid_params and permission_denied are not retried either', async () => {
  for (const reason of ['invalid_params', 'permission_denied']) {
    const h = chatHarness(() => { throw refusal(4001, reason); });
    await assert.rejects(h.run());
    assert.equal(h.log.attempts.length, 1, reason);
    assert.equal(h.log.resumes, 1, reason);
  }
});

test('a stale live id is re-resumed once and the prompt resubmitted once', async () => {
  const h = chatHarness((n) => {
    if (n === 1) throw refusal(4001, 'not_found');
    return 'answer';
  });
  assert.equal(await h.run(), 'answer');
  assert.equal(h.log.attempts.length, 2);
  assert.equal(h.log.resumes, 2);
  assert.equal(h.log.attempts[1].submitPrompt, true);
});

test('a second stale refusal ends the turn as session-gone: no third submit, no new session, binding untouched', async () => {
  const h = chatHarness(() => { throw refusal(4001, ''); });
  await assert.rejects(h.run(), (error) => error.sessionGone === true);
  assert.equal(h.log.attempts.length, 2, 'one resubmit at most');
  assert.equal(h.context.settings.sessionId, 'stored-A');
  assert.equal(h.context.settings.remoteDashboardSession.storedSessionId, 'stored-A');
  assert.equal(h.context.connection.wsStoredSessionId, 'stored-A');
});

test('a re-resume that is itself refused never creates a replacement session', async () => {
  const h = chatHarness(() => { throw refusal(4001, 'not_found'); }, {
    resume: (n) => { if (n === 2) throw refusal(4001, 'not_found'); },
  });
  await assert.rejects(h.run(), (error) => error.sessionGone === true);
  assert.equal(h.log.attempts.length, 1, 'the prompt was not resubmitted anywhere');
  assert.equal(h.log.resumes, 2, 'no third ensureRemoteWsSession (which would create a session)');
  assert.equal(h.context.settings.sessionId, 'stored-A');
  assert.equal(h.context.settings.remoteDashboardSession.storedSessionId, 'stored-A');
});

test('a re-resume that fails for another reason surfaces that failure', async () => {
  const h = chatHarness(() => { throw refusal(4001, ''); }, {
    resume: (n) => { if (n === 2) throw new Error('socket gone'); },
  });
  await assert.rejects(h.run(), /socket gone/);
  assert.equal(h.log.attempts.length, 1);
});

test('the reattach path after a dropped socket still resubmits nothing', async () => {
  const dropped = Object.assign(new Error('Dashboard connection closed mid-turn.'), { requestAccepted: true, reattach: true });
  const h = chatHarness((n) => { if (n === 1) throw dropped; return 'recovered'; });
  assert.equal(await h.run(), 'recovered');
  assert.equal(h.log.attempts[1].submitPrompt, false);
});

test('failure states keep the draft and leave the gateway connected', () => {
  for (const error of [
    sessionGoneError(refusal(4001, 'not_found')),
    turnNotDeliveredError(),
    refusal(4001, 'session_busy'),
    refusal(4009, ''),
    refusal(4001, 'permission_denied'),
  ]) {
    const state = turnRequestFailureState(error);
    assert.ok(state, error.message);
    assert.equal(state.preserveDraft, true);
    assert.equal(state.gatewayStatus, 'connected');
    assert.deepEqual(state, refusalFailureState(error));
  }
  assert.equal(turnRequestFailureState(new Error('socket closed')), null);
});
