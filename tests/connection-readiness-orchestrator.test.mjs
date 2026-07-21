import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ReadinessStageError,
  runCanonicalConnectionReadiness,
  ticketTransportClosedReadiness,
} from '../extension/lib/connection-readiness-orchestrator.mjs';

function successfulOperations(overrides = {}) {
  return {
    restoreSettings: async () => ({ mode: 'local', transport: 'local-api' }),
    connectGateway: async () => ({ state: 'connected', detail: 'Gateway transport connected.' }),
    loadCapabilities: async () => ({ status: 'ready', detail: 'Capabilities loaded.' }),
    loadModels: async () => ({ status: 'ready', detail: '2 models loaded.' }),
    selectModel: async () => ({ status: 'ready', detail: 'Selected model is requestable.' }),
    loadSkills: async () => ({ status: 'ready', detail: '2 skills available.' }),
    loadProfiles: async () => ({ status: 'ready', detail: '1 profile available.' }),
    loadSessions: async () => ({ ok: true, detail: '3 sessions loaded.' }),
    bindSession: async () => ({ sessionId: 'durable-session-1', detail: 'Session bound.' }),
    ...overrides,
  };
}

test('local readiness reaches ready only after its durable session binding succeeds', async () => {
  const events = [];
  const result = await runCanonicalConnectionReadiness({
    mode: 'local',
    transport: 'local-api',
    operations: successfulOperations(),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ready, true);
  assert.equal(result.sessionId, 'durable-session-1');
  assert.deepEqual(
    events.filter((event) => event.step && event.status === 'ready').map((event) => event.step),
    ['settings', 'gateway', 'capabilities', 'models', 'selectedModel', 'skills', 'profiles', 'sessions', 'sessionBinding'],
  );
  assert.equal(events.at(-1).type, 'ready');
});

test('ticket readiness skips REST-only skills/profiles, falls back from session list failure, and still binds a durable session', async () => {
  const events = [];
  const result = await runCanonicalConnectionReadiness({
    mode: 'cloud',
    transport: 'cloud-ticket-ws',
    operations: successfulOperations({
      restoreSettings: async () => ({ mode: 'cloud', transport: 'cloud-ticket-ws' }),
      loadSessions: async () => ({ ok: false, detail: 'session.list failed; keeping the current list.' }),
      bindSession: async () => ({ sessionId: 'stored-cloud-session', detail: 'Resumed durable Cloud session.' }),
    }),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ready, true);
  assert.equal(result.sessionId, 'stored-cloud-session');
  assert.deepEqual(
    events.filter((event) => ['skills', 'profiles', 'sessions'].includes(event.step) && event.status !== 'active')
      .map((event) => [event.step, event.status]),
    [['skills', 'skipped'], ['profiles', 'skipped'], ['sessions', 'fallback']],
  );
});

test('ticket session create or resume failure is a retryable session-binding gate and leaves no pending stages', async () => {
  const events = [];
  await assert.rejects(
    runCanonicalConnectionReadiness({
      mode: 'remote',
      transport: 'remote-dashboard',
      operations: successfulOperations({
        restoreSettings: async () => ({ mode: 'remote', transport: 'remote-dashboard' }),
        bindSession: async () => {
          throw new Error('session.resume rejected');
        },
      }),
      onEvent: (event) => events.push(event),
    }),
    (error) => error instanceof ReadinessStageError
      && error.stage === 'sessionBinding'
      && error.retryable === true
      && /session\.resume rejected/.test(error.message),
  );

  const terminalSteps = events.filter((event) => event.step && event.status !== 'active');
  assert.deepEqual(
    terminalSteps.map((event) => [event.step, event.status]),
    [
      ['settings', 'ready'],
      ['gateway', 'ready'],
      ['capabilities', 'ready'],
      ['models', 'ready'],
      ['selectedModel', 'ready'],
      ['skills', 'skipped'],
      ['profiles', 'skipped'],
      ['sessions', 'ready'],
      ['sessionBinding', 'error'],
    ],
  );
  assert.equal(events.some((event) => event.type === 'ready'), false);
});

test('gateway failure names its stage and marks every downstream readiness row blocked', async () => {
  const events = [];
  await assert.rejects(
    runCanonicalConnectionReadiness({
      mode: 'remote',
      transport: 'remote-dashboard',
      operations: successfulOperations({
        connectGateway: async () => {
          throw new Error('ticket handshake failed');
        },
      }),
      onEvent: (event) => events.push(event),
    }),
    (error) => error instanceof ReadinessStageError && error.stage === 'gateway',
  );

  assert.deepEqual(
    events.filter((event) => event.status === 'blocked').map((event) => event.step),
    ['capabilities', 'models', 'selectedModel', 'skills', 'profiles', 'sessions', 'sessionBinding'],
  );
});

test('attach-required failures preserve unconfigured state and block downstream stages', async () => {
  const events = [];
  await assert.rejects(
    runCanonicalConnectionReadiness({
      mode: 'cloud',
      transport: 'cloud-ticket-ws',
      operations: successfulOperations({
        restoreSettings: async () => ({ mode: 'cloud', transport: 'cloud-ticket-ws' }),
        connectGateway: async () => {
          const error = new Error('Open the signed-in Hermes Cloud agent, then connect.');
          error.readinessStatus = 'unconfigured';
          throw error;
        },
      }),
      onEvent: (event) => events.push(event),
    }),
    (error) => error instanceof ReadinessStageError && error.stage === 'gateway',
  );

  assert.equal(events.find((event) => event.step === 'gateway' && event.status !== 'active')?.status, 'unconfigured');
  assert.deepEqual(
    events.filter((event) => event.status === 'blocked').map((event) => event.step),
    ['capabilities', 'models', 'selectedModel', 'skills', 'profiles', 'sessions', 'sessionBinding'],
  );
});

test('non-ticket OpenAI-compatible fallback may become usable without a durable session route', async () => {
  const events = [];
  const result = await runCanonicalConnectionReadiness({
    mode: 'remote',
    transport: 'remote-api',
    operations: successfulOperations({
      restoreSettings: async () => ({ mode: 'remote', transport: 'remote-api' }),
      loadSessions: async () => ({ ok: false, detail: 'Session routes unavailable; using chat fallback.' }),
      bindSession: async () => ({ status: 'fallback', sessionId: '', detail: 'OpenAI-compatible chat fallback ready.' }),
    }),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ready, true);
  assert.equal(result.sessionId, '');
  assert.equal(events.find((event) => event.step === 'sessionBinding' && event.status !== 'active')?.status, 'fallback');
});

test('ticket socket close reports reconnecting while preserving the durable session identity', () => {
  assert.deepEqual(ticketTransportClosedReadiness({
    mode: 'cloud',
    transport: 'cloud-ticket-ws',
    sessionId: 'stored-cloud-session',
  }), {
    phase: 'reconnecting',
    gateway: { connected: false, state: 'reconnecting', detail: 'Dashboard socket closed. Reconnect to resume the bound session.' },
    step: 'gateway',
    status: 'degraded',
    detail: 'Dashboard socket closed. Reconnect to resume the bound session.',
    sessionId: 'stored-cloud-session',
  });
});

test('sidepanel routes startup, ticket attach, ticket test, and socket close through canonical readiness', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

  assert.match(source, /from '\.\/lib\/connection-readiness-orchestrator\.mjs';/);
  assert.match(source, /async function runPanelConnectionReadiness\(/);
  assert.match(source, /await runPanelConnectionReadiness\(\{ restoreSettings: true \}\)/);
  assert.match(source, /await runPanelConnectionReadiness\(\{ restoreSettings: false \}\)/);
  assert.match(source, /CONNECTION_ACTIONS\.REMOTE_DASHBOARD_ATTACH[\s\S]*?connectTicketTransport\(\{ cloud: false \}\)/);
  assert.doesNotMatch(source, /await loadSessions\(\{ quiet: true \}\)\.catch\(\(\) => \{\}\);/);
  assert.match(source, /setStartupReadiness\(ticketTransportClosedReadiness\(\{[\s\S]*?sessionId:\s*connection\.wsStoredSessionId\s*\|\|\s*settings\.sessionId/);
  assert.match(source, /connectionController\.transition\(generation, CONNECTION_STATES\.ERROR/);
});
