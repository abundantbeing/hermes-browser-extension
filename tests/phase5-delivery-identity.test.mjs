import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DELIVERY_STATE_STORAGE_KEY,
  DELIVERY_STATE_VERSION,
  MAX_DELIVERY_STATE_ENTRIES,
  clearDeliveryState,
  deliveryIdentityForTurn,
  deliveryStateEntryForIdentity,
  deliveryStateToMap,
  normalizeDeliveryState,
  serializeDeliveryState,
} from '../extension/lib/session-delivery-state.mjs';
import {
  MAX_FULL_CONTEXT_AGE_MS,
  MAX_UNCHANGED_CONTEXT_REFERENCES,
} from '../extension/lib/context-delivery.mjs';

const WS_STORED = 'stored-session-abc';
const WS_LIVE = 'live-session-xyz';
const SETTINGS_SESSION = 'settings-session-123';
const GATEWAY = 'https://hermes.example.test/base';

test('Phase 5 pre-gate: dashboard WS delivery identity requires the exact durable stored id', () => {
  // Fallback-id → stored-id flip must never change the delivery key: with a
  // stored id available the key is the durable identity and the live id is
  // irrelevant.
  const exact = deliveryIdentityForTurn({
    gatewayUrl: GATEWAY,
    isRemoteWs: true,
    wsStoredSessionId: WS_STORED,
    wsSessionId: WS_LIVE,
    settingsSessionId: SETTINGS_SESSION,
  });
  assert.equal(exact.identitySource, 'ws-stored');
  assert.equal(exact.storedSessionId, WS_STORED);
  assert.equal(exact.key, `${GATEWAY}::${WS_STORED}`);

  // Before the gateway returns the stored id, only the live id exists. The
  // delivery key must fail closed (null) instead of keying by the live id —
  // otherwise the first turn records under live-id and the next turn flips to
  // stored-id, producing a duplicate full snapshot.
  const liveOnly = deliveryIdentityForTurn({
    gatewayUrl: GATEWAY,
    isRemoteWs: true,
    wsStoredSessionId: '',
    wsSessionId: WS_LIVE,
    settingsSessionId: SETTINGS_SESSION,
  });
  assert.equal(liveOnly, null);

  // Same failure when no socket identity exists at all.
  assert.equal(deliveryIdentityForTurn({
    gatewayUrl: GATEWAY, isRemoteWs: true, settingsSessionId: SETTINGS_SESSION,
  }), null);
});

test('Phase 5 pre-gate: non-WS modes keep the durable settings session identity', () => {
  const rest = deliveryIdentityForTurn({
    gatewayUrl: GATEWAY,
    isRemoteWs: false,
    wsStoredSessionId: '',
    settingsSessionId: SETTINGS_SESSION,
  });
  assert.equal(rest.identitySource, 'session-settings');
  assert.equal(rest.key, `${GATEWAY}::${SETTINGS_SESSION}`);

  const scoped = deliveryIdentityForTurn({
    gatewayUrl: GATEWAY,
    isRemoteWs: false,
    settingsSessionId: '',
    scopeBindingKey: 'hermesBrowserSession:follow-active',
  });
  assert.equal(scoped.key, `${GATEWAY}::hermesBrowserSession:follow-active`);

  assert.equal(deliveryIdentityForTurn({ gatewayUrl: '', isRemoteWs: false, settingsSessionId: 'x' }), null);
});

test('Phase 5 pre-gate: persisted delivery state is bounded, versioned, minimal, and identity-keyed', () => {
  const now = 5_000_000;
  const identity = deliveryIdentityForTurn({
    gatewayUrl: GATEWAY, isRemoteWs: true, wsStoredSessionId: WS_STORED,
  });
  const memory = new Map([
    [identity.key, { contextHash: 'hash-1', referenceCount: 1, lastFullAt: now - 1000, lastSentAt: now }],
  ]);
  const serialized = serializeDeliveryState(memory, { now });
  assert.equal(serialized.version, DELIVERY_STATE_VERSION);
  assert.equal(serialized.entries.length, 1);
  assert.deepEqual(Object.keys(serialized.entries[0]).sort(), [
    'contextHash', 'gatewayUrl', 'lastFullAt', 'lastSentAt', 'referenceCount', 'storedSessionId',
  ]);
  const json = JSON.stringify(serialized);
  // Never page text/URL/title/transcript — only a context hash and timestamps.
  for (const forbidden of ['pageContext', 'activeTab', '"url"', '"title"', 'transcript', '"text"', 'selectedText']) {
    assert.equal(json.includes(forbidden), false, `persisted delivery state must not contain ${forbidden}`);
  }

  const hydrated = deliveryStateToMap(normalizeDeliveryState(serialized));
  const previous = deliveryStateEntryForIdentity(hydrated, identity);
  assert.equal(previous.contextHash, 'hash-1');
  assert.equal(previous.referenceCount, 1);

  // Identity mismatch fails closed: a different session/gateway yields no previous.
  const otherIdentity = deliveryIdentityForTurn({
    gatewayUrl: GATEWAY, isRemoteWs: true, wsStoredSessionId: 'other-stored',
  });
  assert.equal(deliveryStateEntryForIdentity(hydrated, otherIdentity), null);
});

test('Phase 5 pre-gate: persisted delivery state fails closed on corrupt, wrong-version, or shape-mismatched input', () => {
  assert.deepEqual(normalizeDeliveryState(null), []);
  assert.deepEqual(normalizeDeliveryState('corrupt'), []);
  assert.deepEqual(normalizeDeliveryState({ version: 999, entries: [] }), []);
  assert.deepEqual(normalizeDeliveryState({ version: DELIVERY_STATE_VERSION, entries: 'nope' }), []);
  assert.deepEqual(normalizeDeliveryState({ version: DELIVERY_STATE_VERSION, entries: [{
    gatewayUrl: GATEWAY,
    storedSessionId: WS_STORED,
    contextHash: 'hash',
    referenceCount: 'many',
    lastFullAt: 'soon',
    lastSentAt: 'now',
  }] }), []);
  // Extra keys from a foreign/corrupt write are stripped, never trusted.
  const stripped = normalizeDeliveryState({ version: DELIVERY_STATE_VERSION, entries: [{
    gatewayUrl: GATEWAY,
    storedSessionId: WS_STORED,
    contextHash: 'hash',
    referenceCount: 0,
    lastFullAt: 1,
    lastSentAt: 2,
    pageContext: { text: 'leaked page body' },
    transcript: 'leaked transcript',
  }] });
  assert.equal(stripped.length, 1);
  assert.deepEqual(Object.keys(stripped[0]).sort(), [
    'contextHash', 'gatewayUrl', 'lastFullAt', 'lastSentAt', 'referenceCount', 'storedSessionId',
  ]);
});

test('Phase 5 pre-gate: delivery state is bounded to the newest entries and clears to an empty canonical state', () => {
  const now = 9_000_000;
  const memory = new Map();
  for (let index = 0; index < 12; index += 1) {
    const identity = deliveryIdentityForTurn({
      gatewayUrl: GATEWAY, isRemoteWs: true, wsStoredSessionId: `session-${index}`,
    });
    memory.set(identity.key, {
      contextHash: `hash-${index}`, referenceCount: 0, lastFullAt: now - index, lastSentAt: now - index,
    });
  }
  const serialized = serializeDeliveryState(memory, { now });
  assert.equal(serialized.entries.length, MAX_DELIVERY_STATE_ENTRIES);
  const newest = serialized.entries[0];
  assert.equal(newest.storedSessionId, 'session-0');
  assert.equal(newest.gatewayUrl, GATEWAY);

  const cleared = clearDeliveryState();
  assert.equal(cleared.version, DELIVERY_STATE_VERSION);
  assert.deepEqual(cleared.entries, []);
  assert.deepEqual(normalizeDeliveryState(cleared), []);
});

test('Phase 5 pre-gate: sidepanel establishes durable WS identity before delivery keying, persists on success, and clears on compaction', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const askStart = source.indexOf('async function askHermes(');
  const hashAt = source.indexOf('const contextHash =', askStart);
  assert.ok(askStart >= 0 && hashAt > askStart, 'askHermes context-hash block must exist');
  const beforeHash = source.slice(askStart, hashAt);
  assert.match(
    beforeHash,
    /if \(isRemoteWsMode\(\)\)[\s\S]*ensureRemoteWsClient\(\)[\s\S]*ensureRemoteWsSession\(/,
    'ordinary dashboard-WS turns must establish the durable stored session id before context hashing/keying',
  );
  assert.match(source, /deliveryIdentityForTurn\(/);
  assert.doesNotMatch(source, /wsStoredSessionId \|\| remoteWsConnection\?\.wsSessionId/);
  assert.match(source, /DELIVERY_STATE_STORAGE_KEY/);
  assert.equal(DELIVERY_STATE_STORAGE_KEY, 'hermesBrowserDeliveryState');
  assert.match(source, /serializeDeliveryState\(/);
  assert.match(source, /normalizeDeliveryState\(/);
  // Record happens only after the successful answer path (no recording on failure).
  assert.match(source, /const finalAnswer =[\s\S]*recordContextDelivery\(/);
  // Compaction clears the persisted delivery state too (canonical empty state).
  assert.match(source, /contextDeliveryBySession\.clear\(\)[\s\S]*clearDeliveryState\(\)/);
  // The 3-reference / 10-minute contract stays intact for persisted decisions.
  assert.equal(MAX_UNCHANGED_CONTEXT_REFERENCES, 3);
  assert.equal(MAX_FULL_CONTEXT_AGE_MS, 10 * 60 * 1000);
});
