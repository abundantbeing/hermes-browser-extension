// Issue #89: the first send from a fresh draft. The panel keeps a draft
// client-side and materializes it on the first turn through ensureHermesSession.
// These tests run the real function from sidepanel.js in a vm with a scripted
// gateway, so the send path is exercised rather than re-described.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { materializeSessionRoute, sessionRouteError } from '../extension/lib/session-materialization.mjs';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in sidepanel.js`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 3);
}

const ORIGIN = 'moz-extension://19b91a4d-7c3e-4f2a-9d1b-5e6f7a8b9c0d';

function harness(answers, { sessionId = '' } = {}) {
  const calls = [];
  const stored = [];
  const sandbox = {
    settings: { sessionId, sessionTitle: '', sessionSource: '', gatewayUrl: 'http://127.0.0.1:8642' },
    sessionRoutesAvailable: null,
    gatewayCapabilities: {},
    gatewayQuirks: { load: async () => {}, beginProbe: () => false, endProbe: () => {} },
    GATEWAY_QUIRK: { SESSION_SOURCE_PATCH: 'x' },
    browserApi: { storage: { local: { set: async (value) => { stored.push(value); } } } },
    makeBrowserSessionId: () => 'hermes-browser-extension-draft-1',
    makeBrowserSessionTitle: () => 'Hermes Browser Extension draft 1',
    isDefaultBrowserSessionTitle: () => false,
    encodeSessionId: encodeURIComponent,
    currentExtensionOrigin: () => ORIGIN,
    currentModelRequestId: () => 'm',
    currentModelProviderSlug: () => '',
    currentHermesBrowserSystemPrompt: () => '',
    restSessionCreateSource: (value) => value || 'api_server',
    restTurnSourceRepair: () => null,
    readJsonResponse: async (response) => response.json().catch(() => ({})),
    createSessionRouteError: (details) => sessionRouteError({
      action: details.action,
      status: details.status,
      originRefusal: details.originRefusal,
    }),
    materializeSessionRoute,
    apiFetch: async (path, options = {}) => {
      calls.push(`${options.method || 'GET'} ${path}`);
      const answer = answers.shift();
      assert.ok(answer, `unexpected request ${options.method || 'GET'} ${path}`);
      return new Response(answer.body ?? '', { status: answer.status });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction('ensureHermesSession')}; globalThis.ensureHermesSession = ensureHermesSession;`, sandbox);
  return { sandbox, calls, stored };
}

test('a fresh draft is materialized on the first send: id minted, persisted, looked up, then created', async () => {
  const { sandbox, calls, stored } = harness([{ status: 404 }, { status: 201, body: '{}' }]);
  assert.equal(await sandbox.ensureHermesSession(), true);
  assert.equal(sandbox.settings.sessionId, 'hermes-browser-extension-draft-1');
  assert.equal(stored[0].hermesBrowserSettings.sessionId, 'hermes-browser-extension-draft-1');
  assert.deepEqual(calls, [
    'GET /api/sessions/hermes-browser-extension-draft-1',
    'POST /api/sessions',
  ]);
  assert.equal(sandbox.sessionRoutesAvailable, true);
});

test('a bare 403 on create is an origin refusal: it names the origin, keeps the session id, and is not a connection failure', async () => {
  const { sandbox, calls } = harness([{ status: 404 }, { status: 403 }]);
  await assert.rejects(sandbox.ensureHermesSession(), (error) => {
    assert.equal(error.originRefused, true);
    assert.equal(error.originRefusal.envLine, `API_SERVER_CORS_ORIGINS=${ORIGIN}`);
    return true;
  });
  assert.deepEqual(calls, ['GET /api/sessions/hermes-browser-extension-draft-1', 'POST /api/sessions']);
  assert.equal(sandbox.settings.sessionId, 'hermes-browser-extension-draft-1', 'the draft survives so a retry reuses it');
  assert.notEqual(sandbox.sessionRoutesAvailable, false, 'a refusal never turns session routes off');
});

test('a retry after the origin is allowed reuses the same draft id and creates it', async () => {
  const first = harness([{ status: 404 }, { status: 403 }]);
  await assert.rejects(first.sandbox.ensureHermesSession());
  const retryAnswers = [{ status: 404 }, { status: 201, body: '{}' }];
  const retry = harness(retryAnswers, { sessionId: first.sandbox.settings.sessionId });
  assert.equal(await retry.sandbox.ensureHermesSession(), true);
  assert.equal(retry.calls[0], 'GET /api/sessions/hermes-browser-extension-draft-1');
  assert.equal(retry.sandbox.settings.sessionId, first.sandbox.settings.sessionId, 'no new id is minted for a draft that already has one');
});

test('a gateway without session routes returns false and the chat falls back instead of failing', async () => {
  const { sandbox } = harness([{ status: 404 }, { status: 405 }]);
  assert.equal(await sandbox.ensureHermesSession(), false);
  assert.equal(sandbox.sessionRoutesAvailable, false);
});

test('the send path handles a refused materialization before the generic setup error and before it clears the composer', () => {
  const askStart = source.indexOf('async function askHermes(');
  const prepare = source.slice(source.indexOf('value: await ensureHermesSession() };', askStart), source.indexOf("setStatus('error', 'Could not start Hermes session'", askStart));
  assert.match(prepare, /error\?\.originRefused[\s\S]*reportSessionOriginRefusal\(error\);[\s\S]*return false;/);
  assert.doesNotMatch(prepare, /unreachable|markGateway|markConnection/);
});
