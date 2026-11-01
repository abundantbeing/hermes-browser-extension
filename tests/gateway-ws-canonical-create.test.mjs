// "New session in this project" failed with invalid_params on a session-authority gateway: the panel sent the
// legacy session.create keys (source hermes_browser, reasoning_effort, fast) that CanonicalCreateParams refuses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildCanonicalSessionCreateParams, sessionCreateParamsFor } from '../extension/lib/gateway-ws.mjs';

// tui_gateway/contracts/canonical_sessions.py CanonicalCreateParams, minus fields the panel never sends.
const CANONICAL_KEYS = new Set([
  'request_id', 'source', 'cwd', 'model', 'provider', 'toolsets', 'reasoning', 'profile', 'title', 'hidden',
  'follow_profile_config', 'service_tier', 'cwd_explicit',
]);
const SURFACES = new Set(['cli', 'tui', 'gui', 'acp', 'tool', 'oneshot']);

const legacy = {
  title: 'Hermes Browser session',
  hidden: false,
  cwd: '/srv/app',
  cwd_explicit: true,
  source: 'hermes_browser',
  model: 'gpt-x',
  provider: 'openai',
  reasoning_effort: 'high',
  fast: true,
  profile: 'work',
};

test('a canonical create carries only keys the contract accepts and a surface source', () => {
  const params = buildCanonicalSessionCreateParams(legacy);
  for (const key of Object.keys(params)) assert.ok(CANONICAL_KEYS.has(key), `${key} is a canonical key`);
  assert.ok(SURFACES.has(params.source));
  assert.equal(params.reasoning, 'high');
  assert.equal(params.service_tier, 'priority');
  assert.equal(params.cwd, '/srv/app');
  assert.equal(params.cwd_explicit, true);
  assert.equal(params.profile, 'work');
  assert.ok(params.request_id.length > 8);
  assert.equal('fast' in params, false);
  assert.equal('reasoning_effort' in params, false);
  assert.equal('hidden' in params, false, 'a visible session leaves hidden off');
});

test('fast false pins the normal tier, an omitted fast inherits', () => {
  assert.equal(buildCanonicalSessionCreateParams({ fast: false }).service_tier, 'normal');
  assert.equal('service_tier' in buildCanonicalSessionCreateParams({}), false);
  assert.equal(buildCanonicalSessionCreateParams({ service_tier: 'priority', fast: false }).service_tier, 'priority');
});

test('a bot-mode create keeps follow_profile_config and hidden', () => {
  const params = buildCanonicalSessionCreateParams({ ...legacy, hidden: true, follow_profile_config: true, source: 'hermes_bot_mode' });
  assert.equal(params.hidden, true);
  assert.equal(params.follow_profile_config, true);
  assert.equal(params.source, 'gui');
});

test('a caller request id survives so a retry returns the same session', () => {
  assert.equal(buildCanonicalSessionCreateParams({ request_id: 'abc-123' }).request_id, 'abc-123');
});

test('only a session-authority socket gets the canonical shape', () => {
  assert.equal(sessionCreateParamsFor({ readyPayload: { session_authority: true } }, legacy).source, 'gui');
  assert.equal(sessionCreateParamsFor({ readyPayload: { session_authority: false } }, legacy), legacy);
  assert.equal(sessionCreateParamsFor({ readyPayload: null }, legacy), legacy);
  assert.equal(sessionCreateParamsFor(null, legacy), legacy);
});

test('createHermesBrowserSession routes its dashboard create through the socket-aware builder', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /createParams: sessionCreateParamsFor\(connection\.client, \{/);
});

test('the chat path creates its session in the canonical shape on a session authority, and as before elsewhere', async () => {
  const { establishGatewaySession } = await import('../extension/lib/gateway-ws.mjs');
  const chatCreate = { title: 'Browser chat', model: 'gpt-6.1', provider: 'openai', reasoning_effort: 'high', fast: true, profile: 'default' };
  for (const authority of [true, false]) {
    const sent = [];
    const client = {
      readyPayload: { session_authority: authority },
      async request(method, params) {
        sent.push([method, params]);
        return { session_id: 'live-1', stored_session_id: 'stored-1', profile: 'default' };
      },
    };
    await establishGatewaySession({ client, createParams: chatCreate });
    const [method, params] = sent[0];
    assert.equal(method, 'session.create');
    if (authority) {
      for (const key of Object.keys(params)) assert.ok(CANONICAL_KEYS.has(key), `${key} is a canonical create key`);
      assert.equal(params.reasoning, 'high');
      assert.equal(params.service_tier, 'priority');
      assert.equal(params.source, 'gui');
      assert.equal(params.profile, 'default');
    } else {
      assert.deepEqual(params, chatCreate, 'a gateway without a session authority gets the same request as before');
    }
  }
});

test('a picker session.list asks a session authority for stored sessions; a title lookup and other sockets are unchanged', async () => {
  const { sessionListParamsFor } = await import('../extension/lib/gateway-ws.mjs');
  const authority = { readyPayload: { session_authority: true } };
  const legacy = { readyPayload: {} };
  assert.deepEqual(sessionListParamsFor(authority, { limit: 200, profile: 'default' }), { limit: 200, profile: 'default', scope: 'stored' });
  // The authority refuses title together with scope; a title lookup already reads stored rows.
  assert.deepEqual(sessionListParamsFor(authority, { title: 'Bot Chat', include_hidden: true }), { title: 'Bot Chat', include_hidden: true });
  // A legacy sidecar refuses an unknown key.
  assert.deepEqual(sessionListParamsFor(legacy, { limit: 200 }), { limit: 200 });
});

test('session.list never sends a session authority an empty profile, which it refuses as invalid_params', async () => {
  const { sessionListParamsFor } = await import('../extension/lib/gateway-ws.mjs');
  const authority = { readyPayload: { session_authority: true } };
  const legacy = { readyPayload: {} };
  // "Detect from Hermes gateway" leaves the active profile empty.
  assert.deepEqual(sessionListParamsFor(authority, { limit: 200, profile: '' }), { limit: 200, scope: 'stored' });
  assert.deepEqual(sessionListParamsFor(authority, { title: 'Bot Chat', profile: '' }), { title: 'Bot Chat' });
  // A named profile is still sent: the authority routes or strips it itself.
  assert.deepEqual(sessionListParamsFor(authority, { limit: 200, profile: 'juniper' }), { limit: 200, profile: 'juniper', scope: 'stored' });
  // A legacy sidecar's session.list takes profile as it always did.
  assert.deepEqual(sessionListParamsFor(legacy, { limit: 200, profile: '' }), { limit: 200, profile: '' });
});
