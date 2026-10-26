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
