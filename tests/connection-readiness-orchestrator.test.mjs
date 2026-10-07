import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
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

test('profile roster unavailability is degraded without blocking API readiness', async () => {
  const events = [];
  const result = await runCanonicalConnectionReadiness({
    mode: 'remote',
    transport: 'remote-api',
    operations: successfulOperations({
      restoreSettings: async () => ({ mode: 'remote', transport: 'remote-api' }),
      loadProfiles: async () => ({
        status: 'degraded',
        detail: 'Profile roster unavailable in Remote API mode.',
      }),
    }),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ready, true);
  assert.equal(events.find((event) => event.step === 'profiles' && event.status !== 'active')?.status, 'degraded');
  assert.equal(events.find((event) => event.step === 'profiles' && event.status !== 'active')?.detail,
    'Profile roster unavailable in Remote API mode.');
  assert.equal(events.at(-1).type, 'ready');
});

test('a successful empty profile roster remains ready and distinct from an unavailable roster', async () => {
  const events = [];
  const result = await runCanonicalConnectionReadiness({
    mode: 'remote',
    transport: 'remote-api',
    operations: successfulOperations({
      restoreSettings: async () => ({ mode: 'remote', transport: 'remote-api' }),
      loadProfiles: async () => ({ status: 'ready', detail: '0 PROFILES LOADED.' }),
    }),
    onEvent: (event) => events.push(event),
  });

  const profileStage = events.find((event) => event.step === 'profiles' && event.status !== 'active');
  assert.equal(result.ready, true);
  assert.equal(profileStage?.status, 'ready');
  assert.equal(profileStage?.detail, '0 PROFILES LOADED.');
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

test('skills endpoint failure plus hung dashboard recovery cannot strand startup', async () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function loadSkills(');
  const loader = source.slice(start, source.indexOf('\nfunction replaceActiveSkillToken', start));
  let requested = false;
  let recovering = false;
  const context = {
    settings: { apiKey: 'fixture-only' }, availableSkills: [],
    safeActiveProfile: () => 'default', normalizeHermesSkills: () => [],
    renderSkillSuggestions() {}, setStatus() {}, isRemoteWsMode: () => false,
    remoteWsConnection: null, profileWsConnection: null, activeDashboardWsConnection: null,
    restSkillsFallbackAllowed: () => true, shouldRecoverSkillsFromDashboard: () => true,
    apiFetch: async () => { requested = true; return { ok: false, status: 500 }; },
    readJsonResponse: async () => ({ error: { message: 'Skills list failed' } }),
    ensureProfileWsConnection: () => { recovering = true; return new Promise(() => {}); },
    WS_METHODS: { profilesDescribe: 'profiles.describe' }, AbortSignal,
  };
  vm.createContext(context);
  vm.runInContext(`${loader}\nthis.load = loadSkills;`, context);
  const events = [];
  const pending = runCanonicalConnectionReadiness({
    stageTimeoutMs: { skills: 20 },
    operations: successfulOperations({ loadSkills: () => context.load({ quiet: true }) }),
    onEvent: (event) => events.push(event),
  });
  const outcome = await Promise.race([pending, delay(250).then(() => null)]);
  assert.ok(outcome, 'startup must stop awaiting an optional catalog');
  assert.equal(requested, true);
  assert.equal(recovering, true);
  assert.equal(outcome.ready, true);
  assert.equal(outcome.sessionId, 'durable-session-1');
  assert.equal(events.find((event) => event.step === 'skills' && event.status !== 'active')?.status, 'fallback');
});

test('a hung required binding times out visibly and never claims ready', async () => {
  const events = [];
  const pending = runCanonicalConnectionReadiness({
    stageTimeoutMs: { sessionBinding: 20 },
    operations: successfulOperations({ bindSession: () => new Promise(() => {}) }),
    onEvent: (event) => events.push(event),
  }).then(() => null, (error) => error);
  const error = await Promise.race([pending, delay(250).then(() => null)]);
  assert.ok(error instanceof ReadinessStageError);
  assert.equal(error.stage, 'sessionBinding');
  assert.match(error.message, /timed out/);
  assert.equal(events.some((event) => event.type === 'ready'), false);
});

test('profile timeout is fallback and a late resolution cannot emit a second readiness result', async () => {
  const events = [];
  let finish;
  const pending = runCanonicalConnectionReadiness({
    stageTimeoutMs: { profiles: 20 },
    operations: successfulOperations({ loadProfiles: () => new Promise((resolve) => { finish = resolve; }) }),
    onEvent: (event) => events.push(event),
  });
  const result = await Promise.race([pending, delay(250).then(() => null)]);
  assert.ok(result?.ready);
  const count = events.length;
  finish({ status: 'ready', detail: 'Profiles loaded.' });
  await delay(0);
  assert.equal(events.length, count);
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
