// Review finding 1: a refusal for one session must not disable Compact for another one.
// Runs the real compactCanonicalSessionContext and renderCompactControl from sidepanel.js
// against the real capability runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCapabilityRuntime } from '../extension/lib/capability-runtime.mjs';
import { dashboardWsGatewayCapabilities } from '../extension/lib/capabilities.mjs';
import { capabilityIdentity } from '../extension/lib/capability-status.mjs';
import { compactControlState } from '../extension/lib/capability-view.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');
function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

const READY = { session_authority: true, heartbeat: true, replay_epoch: 'ep1' };

function harness({ results }) {
  const capabilityRuntime = createCapabilityRuntime();
  capabilityRuntime.sync({
    caps: dashboardWsGatewayCapabilities({ health: true, readyPayload: READY }),
    readyPayload: READY,
    identity: capabilityIdentity({ endpoint: 'http://127.0.0.1:9119', principal: 'me', profile: 'default' }),
    connectionToken: 's1',
    connected: true,
    dashboardWsActive: true,
  });
  const sent = [];
  const staleMarks = [];
  const control = { disabled: null, title: '', textContent: '', hidden: true };
  const status = { textContent: '' };
  const context = vm.createContext({
    capabilityRuntime,
    settings: { sessionId: 'session-a' },
    compactInFlight: false,
    compactPending: null,
    compactRecommendedHint: false,
    sending: false,
    activeRunControl: null,
    els: { contextCompactButton: control, contextControlStatus: status, contextControlRow: { hidden: true } },
    canSwitchActiveSession: () => true,
    compactControlState,
    t: (key) => key,
    getLocale: () => 'en',
    compactResultMessage: (result) => ({ level: 'warn', title: result.status, detail: String(result.reason || '') }),
    setStatus() {},
    showOperationToast() {},
    refreshCapabilityViews() {},
    renderContextWindow() {},
    ensureActiveDashboardWsConnection: async () => ({ wsStoredSessionId: '', client: { request: async () => ({}), readyState: 1, readyPayload: READY } }),
    ensureRemoteWsSession: async () => {},
    compactSessionCanonical: async ({ sessionId }) => {
      sent.push(sessionId);
      if (results[sessionId]?.switchViewTo) context.settings = { sessionId: results[sessionId].switchViewTo };
      return results[sessionId] || { status: 'compacted' };
    },
    markContextBreakdownStale: (store, id) => { staleMarks.push(id); return store; },
    sessionContextStore: {},
    refreshSessionContextTelemetry() {},
    clearContextDeliveryState: async () => {},
    loadSessions: async () => {},
  });
  vm.runInContext(`${functionSource('renderCompactControl')}\n${functionSource('compactCanonicalSessionContext')}`, context);
  return { context, sent, control, capabilityRuntime, staleMarks };
}

test('a refused compaction of session A leaves Compact working for session B', async () => {
  const { context, sent, control, capabilityRuntime } = harness({
    results: { 'session-a': { status: 'blocked', reason: 'compression_checkpoint_required' } },
  });
  const refused = await context.compactCanonicalSessionContext();
  assert.equal(refused.ok, false);
  assert.deepEqual(sent, ['session-a']);

  // Session A: the control says why it is off.
  context.renderCompactControl();
  assert.equal(control.disabled, true);
  assert.match(capabilityRuntime.verdict('sessionCompress', { sessionId: 'session-a' }).reason, /compression_checkpoint_required/);

  // Session B on the same connection: enabled, and a press reaches the gateway.
  context.settings = { sessionId: 'session-b' };
  context.renderCompactControl();
  assert.equal(control.disabled, false, 'another session is not blocked');
  const second = await context.compactCanonicalSessionContext();
  assert.equal(second.ok, true);
  assert.deepEqual(sent, ['session-a', 'session-b'], 'session B reached session.mutate');

  // Back on A it is still refused, without sending anything.
  context.settings = { sessionId: 'session-a' };
  const again = await context.compactCanonicalSessionContext();
  assert.equal(again.reason, 'route-unavailable');
  assert.deepEqual(sent, ['session-a', 'session-b']);
});

// Review finding 8: the outcome belongs to the session that was compacted, not to whatever is viewed when the answer arrives.
test('a compaction that finishes after the view moved on marks the compacted session stale', async () => {
  const { context, staleMarks } = harness({
    results: { 'session-a': { status: 'compacted', switchViewTo: 'session-b' } },
  });
  const outcome = await context.compactCanonicalSessionContext();
  assert.equal(outcome.ok, true);
  assert.deepEqual(staleMarks, ['session-a']);
  assert.equal(outcome.sessionId, 'session-a');
});
