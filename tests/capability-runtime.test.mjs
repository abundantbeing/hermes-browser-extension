import test from 'node:test';
import assert from 'node:assert/strict';

import { createCapabilityRuntime } from '../extension/lib/capability-runtime.mjs';
import { dashboardWsGatewayCapabilities, normalizeGatewayCapabilities } from '../extension/lib/capabilities.mjs';
import { capabilityIdentity } from '../extension/lib/capability-status.mjs';

const READY = { session_authority: true, heartbeat: true, replay_epoch: 'ep1' };
const A = capabilityIdentity({ endpoint: 'http://127.0.0.1:9119', principal: 'me', profile: 'default' });

function harness() {
  let clock = 1_000_000;
  const runtime = createCapabilityRuntime({ now: () => clock });
  return { runtime, advance: (ms) => { clock += ms; }, clock: () => clock };
}

function wsCaps(ready = READY) {
  return dashboardWsGatewayCapabilities({ health: true, readyPayload: ready });
}

test('a synced authority connection lets compaction run, and says why', () => {
  const { runtime } = harness();
  const caps = wsCaps();
  assert.equal(runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true }), true);
  const verdict = runtime.verdict('sessionCompress');
  assert.equal(verdict.allowed, true);
  assert.equal(runtime.record('sessionCompress').reasonCode, 'authority-compress');
  assert.equal(runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true }), false, 'nothing changed, nothing to redraw');
});

test('before gateway.ready, nothing may run and the reason is exact', () => {
  const { runtime } = harness();
  runtime.sync({ caps: wsCaps(null), readyPayload: null, identity: A, connectionToken: 's1', connected: true });
  const verdict = runtime.verdict('sessionCompress');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reasonCode, 'not-connected');
});

test('a closed socket turns a positive into cached, with its age, and reopening restores it', () => {
  const { runtime, advance } = harness();
  const caps = wsCaps();
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  advance(125_000);
  assert.equal(runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: false }), true);
  const verdict = runtime.verdict('sessionCompress');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.state, 'cached');
  assert.equal(verdict.reasonCode, 'connection-closed');
  const row = runtime.rows(caps).find((item) => item.key === 'sessionCompress');
  assert.equal(row.state, 'cached');
  assert.equal(row.ageMs, 125_000, 're-reading the ledger did not make the answer look fresh');
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  assert.equal(runtime.verdict('sessionCompress').allowed, true);
});

test('re-deriving after a new -32601 keeps the original timestamps', () => {
  const { runtime, advance, clock } = harness();
  const caps = wsCaps();
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  const started = clock();
  advance(60_000);
  runtime.unsupportedMethods.add('session.mutate');
  assert.equal(runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true }), true);
  assert.equal(runtime.record('sessionCompress').state, 'unsupported');
  assert.equal(runtime.record('sessionCompress').source, 'method-not-found');
  assert.equal(runtime.record('sessions').checkedAt, started, 'untouched records keep when they were read');
});

test('a new socket forgets what the old one refused; a new identity forgets everything', () => {
  const { runtime } = harness();
  const caps = wsCaps();
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  runtime.unsupportedMethods.add('session.mutate');
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  assert.equal(runtime.verdict('sessionCompress').allowed, false);

  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's2', connected: true });
  assert.equal(runtime.unsupportedMethods.size, 0);
  assert.equal(runtime.verdict('sessionCompress').allowed, true);

  const other = capabilityIdentity({ endpoint: 'http://127.0.0.1:9119', principal: 'me', profile: 'work' });
  runtime.sync({ identity: other, connectionToken: 's2', connected: true });
  assert.equal(runtime.record('sessionCompress'), null, 'the old profile\'s answers are gone until the new one is read');
  assert.equal(runtime.verdict('sessionCompress').allowed, false);
});

test('a controller change invalidates the records like any other identity change', () => {
  const { runtime } = harness();
  const caps = wsCaps();
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  const withController = capabilityIdentity({ endpoint: 'http://127.0.0.1:9119', principal: 'me', profile: 'default', controller: 'ctl-9' });
  runtime.sync({ identity: withController, connectionToken: 's1', connected: true });
  assert.equal(runtime.verdict('sessionCompress').allowed, false);
  runtime.sync({ caps, readyPayload: READY, identity: withController, connectionToken: 's1', connected: true });
  assert.equal(runtime.verdict('sessionCompress').allowed, true);
});

test('what an operation taught us outranks the advertisement and survives a re-read', () => {
  const { runtime } = harness();
  const caps = wsCaps();
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  runtime.noteOperation('sessionCompress', { ok: false, detail: 'compression_checkpoint_required' });
  assert.equal(runtime.verdict('sessionCompress').allowed, false);
  assert.equal(runtime.record('sessionCompress').state, 'blocked');
  assert.match(runtime.record('sessionCompress').reason, /compression_checkpoint_required/);
  runtime.sync({ caps: wsCaps(), readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  assert.equal(runtime.record('sessionCompress').state, 'blocked');
  runtime.noteOperation('sessionCompress', { ok: true });
  assert.equal(runtime.verdict('sessionCompress').allowed, true);
});

test('an explicit revocation blocks until the identity changes', () => {
  const { runtime } = harness();
  const caps = wsCaps();
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's1', connected: true });
  runtime.revoke('sessionCompress', 'the user turned compaction off');
  runtime.sync({ caps, readyPayload: READY, identity: A, connectionToken: 's2', connected: true });
  assert.equal(runtime.verdict('sessionCompress').allowed, false);
  assert.equal(runtime.record('sessionCompress').source, 'revocation');
});

test('a REST connection read minutes ago is shown cached and may not run a mutation', () => {
  const { runtime, advance } = harness();
  const caps = normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities',
    features: { session_chat: true },
    endpoints: { session_compress: { method: 'POST', path: '/api/sessions/{session_id}/compress' } },
  }, { healthOk: true, hasApiKey: true });
  runtime.sync({ caps, identity: A, connectionToken: '', connected: true });
  assert.equal(runtime.verdict('sessionCompress').allowed, true);
  advance(6 * 60_000);
  assert.equal(runtime.verdict('sessionCompress').allowed, false);
  assert.equal(runtime.verdict('sessionCompress').reasonCode, 'stale');
  const row = runtime.rows(caps).find((item) => item.key === 'sessionCompress');
  assert.equal(row.state, 'cached');
  assert.match(row.reason, /Last confirmed 6 min ago/);
});

test('rows before anything was synced are all unknown, not available', () => {
  const { runtime } = harness();
  const rows = runtime.rows(wsCaps());
  assert.ok(rows.length > 20);
  assert.ok(rows.every((row) => row.state === 'unknown' && row.status === 'warn'));
});
