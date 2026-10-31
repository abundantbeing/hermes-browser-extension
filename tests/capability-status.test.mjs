import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_MAX_AGE_MS,
  CAPABILITY_REASONS,
  CAPABILITY_SOURCES,
  CAPABILITY_STATES,
  canExecute,
  capabilityIdentity,
  capabilityReasonText,
  capabilityRowStatus,
  createCapabilityLedger,
  createCapabilityRecord,
  describeCapability,
  effectiveCapability,
  formatAge,
} from '../extension/lib/capability-status.mjs';

const HOST = 'http://127.0.0.1:9119';
const identityA = capabilityIdentity({ endpoint: HOST, principal: 'alice', profile: 'default' });

function record(over = {}) {
  return createCapabilityRecord({
    id: 'contextCompact',
    state: CAPABILITY_STATES.available,
    source: CAPABILITY_SOURCES.ready,
    checkedAt: 1_000,
    identityKey: identityA.key,
    reasonCode: 'authority-ready',
    ...over,
  });
}

test('an identity is endpoint plus principal plus profile plus controller, and ws URLs normalize to the http origin', () => {
  const same = capabilityIdentity({ endpoint: 'ws://127.0.0.1:9119/api/ws?token=x', principal: 'alice', profile: 'default' });
  assert.equal(same.key, identityA.key);
  assert.equal(same.endpoint, HOST);
  for (const other of [
    { endpoint: 'http://127.0.0.1:9120', principal: 'alice', profile: 'default' },
    { endpoint: HOST, principal: 'bob', profile: 'default' },
    { endpoint: HOST, principal: 'alice', profile: 'work' },
    { endpoint: HOST, principal: 'alice', profile: 'default', controller: 'ctl-1' },
  ]) {
    assert.notEqual(capabilityIdentity(other).key, identityA.key);
  }
  assert.equal(capabilityIdentity({ endpoint: '' }), null);
  assert.equal(capabilityIdentity({ endpoint: 'not a url' }), null);
  assert.equal(capabilityIdentity({ endpoint: 'http://user:pw@host.example' }), null, 'credentials in a URL are not an identity');
});

test('a record needs a known state and source and carries the exact English reason for its code', () => {
  const made = record({ reasonCode: 'method-not-found', params: { method: 'session.mutate' }, state: CAPABILITY_STATES.unsupported });
  assert.equal(made.reason, 'The gateway answered "method not found" (-32601) for session.mutate.');
  assert.equal(made.checkedAt, 1_000);
  assert.ok(Object.isFrozen(made));
  assert.throws(() => createCapabilityRecord({ id: 'x', state: 'maybe' }), /Unknown capability state/);
  assert.throws(() => createCapabilityRecord({ id: 'x', source: 'rumor' }), /Unknown capability source/);
  assert.throws(() => createCapabilityRecord({ id: ' ' }), /needs an id/);
  assert.equal(createCapabilityRecord({ id: 'x' }).checkedAt, null);
  assert.equal(createCapabilityRecord({ id: 'x', reason: 'custom', reasonCode: 'nope' }).reason, 'custom');
});

test('every reason code yields a sentence and every state has a label-free code', () => {
  for (const code of Object.keys(CAPABILITY_REASONS)) {
    assert.ok(capabilityReasonText(code, { method: 'm', detail: 'd', ageMs: 5000 }).length > 8, code);
  }
  assert.equal(capabilityReasonText('no-such-code'), '');
  assert.deepEqual(Object.values(CAPABILITY_STATES).sort(), ['available', 'blocked', 'cached', 'degraded', 'unknown', 'unsupported']);
});

test('a current available record may authorize a mutation', () => {
  const verdict = canExecute(record(), { now: 2_000, identityKey: identityA.key });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.state, 'available');
});

test('a stale positive record is shown as cached and is NOT permission to execute', () => {
  const fetched = record({ source: CAPABILITY_SOURCES.capabilities, reasonCode: 'advertised', checkedAt: 0 });
  const limit = CAPABILITY_MAX_AGE_MS[CAPABILITY_SOURCES.capabilities];
  assert.equal(canExecute(fetched, { now: limit }).allowed, true, 'exactly at the limit is still current');
  const old = canExecute(fetched, { now: limit + 1, identityKey: identityA.key });
  assert.equal(old.allowed, false);
  assert.equal(old.state, 'cached');
  assert.equal(old.reasonCode, 'stale');
  assert.match(old.reason, /Last confirmed 5 min ago/);
  const shown = effectiveCapability(fetched, { now: limit + 60_000 });
  assert.equal(shown.state, 'cached');
  assert.equal(shown.checkedAt, 0, 'the original timestamp is kept so the age stays honest');
  assert.equal(effectiveCapability(fetched, { now: limit + 1, maxAgeMs: Infinity }).state, 'available', 'a caller may widen the window for a read');
});

test('a closed connection demotes a positive record to cached however fresh it is', () => {
  const ready = record();
  const verdict = canExecute(ready, { now: 1_001, connected: false });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reasonCode, 'connection-closed');
  assert.equal(effectiveCapability(ready, { now: 1_001, connected: false }).state, 'cached');
  // A statement about the extension itself does not depend on the socket.
  const own = createCapabilityRecord({ id: 'browserContextProvider', state: 'available', source: CAPABILITY_SOURCES.extension, reasonCode: 'extension-side' });
  assert.equal(effectiveCapability(own, { connected: false }).state, 'available');
});

test('degraded, blocked, unsupported and unknown records never authorize', () => {
  for (const state of ['degraded', 'blocked', 'unsupported', 'unknown']) {
    const verdict = canExecute(record({ state, reasonCode: 'legacy-assumed' }), { now: 1_001 });
    assert.equal(verdict.allowed, false, state);
    assert.equal(verdict.state, state);
  }
  assert.equal(canExecute(null).allowed, false);
  assert.equal(canExecute(null).reasonCode, 'no-record');
});

test('a record for another identity, or one with no identity, cannot authorize', () => {
  const other = capabilityIdentity({ endpoint: HOST, principal: 'alice', profile: 'work' });
  assert.equal(canExecute(record(), { now: 1_001, identityKey: other.key }).allowed, false);
  assert.equal(canExecute(record(), { now: 1_001, identityKey: other.key }).reasonCode, 'identity-changed');
  assert.equal(canExecute(record({ identityKey: '' }), { now: 1_001 }).allowed, false);
});

test('the ledger drops everything when the endpoint, account, profile or controller changes', () => {
  const ledger = createCapabilityLedger({ now: () => 1_500 });
  assert.equal(ledger.rebind(identityA), true);
  assert.equal(ledger.rebind(identityA), false, 'the same identity keeps its records');
  ledger.ingest([record()]);
  ledger.observeMethodNotFound('projects', 'projects.list');
  ledger.revoke('browserControl', 'user turned it off');
  assert.equal(ledger.all().length, 3);
  for (const next of [
    { endpoint: 'http://127.0.0.1:9120', principal: 'alice', profile: 'default' },
    { endpoint: HOST, principal: 'bob', profile: 'default' },
    { endpoint: HOST, principal: 'alice', profile: 'work' },
    { endpoint: HOST, principal: 'alice', profile: 'default', controller: 'ctl-2' },
  ]) {
    ledger.rebind(identityA);
    ledger.ingest([record()]);
    ledger.revoke('browserControl', 'x');
    assert.equal(ledger.rebind(capabilityIdentity(next)), true);
    assert.deepEqual(ledger.all(), [], JSON.stringify(next));
    assert.equal(ledger.get('contextCompact'), null);
    assert.equal(ledger.canExecute('contextCompact').allowed, false);
  }
});

test('an answer that arrives after the identity moved is rejected, not shown under the new identity', () => {
  const ledger = createCapabilityLedger({ now: () => 1_500 });
  const identityB = capabilityIdentity({ endpoint: HOST, principal: 'alice', profile: 'work' });
  ledger.rebind(identityB);
  const result = ledger.ingest([record()]);
  assert.deepEqual(result, { accepted: 0, rejected: 1 });
  assert.equal(ledger.get('contextCompact'), null);
});

test('a fresh advertisement replaces the last one as a whole', () => {
  const ledger = createCapabilityLedger({ now: () => 1_500 });
  ledger.rebind(identityA);
  ledger.ingest([record({ id: 'a' }), record({ id: 'b' })]);
  ledger.ingest([record({ id: 'a' })]);
  assert.deepEqual(ledger.all().map((item) => item.id), ['a']);
});

test('an observed method-not-found overrides the advertisement until the next connection', () => {
  const ledger = createCapabilityLedger({ now: () => 1_500 });
  ledger.rebind(identityA);
  ledger.connect('socket-1');
  ledger.ingest([record()]);
  assert.equal(ledger.canExecute('contextCompact').allowed, true);
  const seen = ledger.observeMethodNotFound('contextCompact', 'session.mutate');
  assert.equal(seen.state, 'unsupported');
  assert.equal(seen.source, 'method-not-found');
  assert.equal(ledger.canExecute('contextCompact').allowed, false);
  ledger.ingest([record()]);
  assert.equal(ledger.get('contextCompact').state, 'unsupported', 'a repeated advertisement does not erase what was observed');
  assert.equal(ledger.connect('socket-1'), false);
  assert.equal(ledger.connect('socket-2'), true);
  assert.equal(ledger.get('contextCompact').state, 'available', 'a new connection starts from its own advertisement');
});

test('an operation result is evidence both ways', () => {
  const ledger = createCapabilityLedger({ now: () => 1_500 });
  ledger.rebind(identityA);
  ledger.ingest([record({ state: 'unknown', reasonCode: 'not-advertised' })]);
  const refused = ledger.observeOperation('contextCompact', { ok: false, detail: 'compression_checkpoint_required' });
  assert.equal(refused.state, 'blocked');
  assert.match(refused.reason, /compression_checkpoint_required/);
  const worked = ledger.observeOperation('contextCompact', { ok: true });
  assert.equal(worked.state, 'available');
  assert.equal(worked.source, 'operation-result');
  assert.equal(ledger.canExecute('contextCompact', { now: 1_500 }).allowed, true);
  assert.equal(ledger.canExecute('contextCompact', { now: 1_500 + CAPABILITY_MAX_AGE_MS[CAPABILITY_SOURCES.operation] + 1 }).allowed, false);
});

test('an explicit revocation outlives a reconnect and a fresh advertisement, and only clearRevocation or a new identity lifts it', () => {
  const ledger = createCapabilityLedger({ now: () => 1_500 });
  ledger.rebind(identityA);
  ledger.connect('s1');
  ledger.ingest([record()]);
  ledger.revoke('contextCompact', 'permission withdrawn');
  ledger.connect('s2');
  ledger.ingest([record()]);
  const current = ledger.get('contextCompact');
  assert.equal(current.state, 'blocked');
  assert.equal(current.source, 'revocation');
  assert.equal(ledger.canExecute('contextCompact').allowed, false);
  assert.equal(ledger.clearRevocation('contextCompact'), true);
  assert.equal(ledger.canExecute('contextCompact').allowed, true);
});

test('closing the connection demotes the ledger to cached without losing the answer', () => {
  let clock = 1_500;
  const ledger = createCapabilityLedger({ now: () => clock });
  ledger.rebind(identityA);
  ledger.ingest([record()]);
  ledger.setConnected(false);
  clock = 61_500;
  const shown = ledger.get('contextCompact');
  assert.equal(shown.state, 'cached');
  assert.equal(shown.reasonCode, 'connection-closed');
  assert.equal(shown.params.ageMs, 60_500);
  assert.equal(ledger.canExecute('contextCompact').allowed, false);
  ledger.setConnected(true);
  assert.equal(ledger.canExecute('contextCompact').allowed, true);
});

test('rows report ok for a feature in use (available or degraded) and warn otherwise', () => {
  assert.equal(capabilityRowStatus(record()), 'ok');
  assert.equal(capabilityRowStatus(record({ state: 'degraded', reasonCode: 'legacy-assumed' })), 'ok');
  assert.equal(capabilityRowStatus(record({ state: 'unknown', reasonCode: 'not-advertised' })), 'warn');
  assert.equal(capabilityRowStatus(record({ state: 'cached', reasonCode: 'stale' })), 'warn');
  assert.equal(capabilityRowStatus(null), 'warn');
  const described = describeCapability(record({ checkedAt: 4_000 }), { now: 9_000 });
  assert.equal(described.ageMs, 5_000);
  assert.equal(described.status, 'ok');
  assert.equal(describeCapability(null), null);
});

test('ages read as seconds, minutes, hours and days', () => {
  assert.equal(formatAge(4_200), '4 s');
  assert.equal(formatAge(90_000), '2 min');
  assert.equal(formatAge(3 * 3_600_000), '3 h');
  assert.equal(formatAge(72 * 3_600_000), '3 d');
  assert.equal(formatAge(NaN), 'an unknown time');
});
