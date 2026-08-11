import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_CONSENT_SCHEMA_VERSION,
  CONTEXT_CONSENT_STORAGE_KEY,
  contextConsentIdentity,
  contextConsentKey,
  contextScopeWithConsent,
  consentGrantedForIdentity,
  consentRequiredForConnection,
  dashboardPrincipalFromMe,
  fingerprintContextCredential,
  mergeContextConsentLedgers,
  normalizeContextConsentLedger,
  persistContextConsentDecision,
  withContextConsent,
} from '../extension/lib/context-consent.mjs';
import { CONTEXT_SCOPE_MODES } from '../extension/lib/context-scope.mjs';

const pinned = {
  mode: CONTEXT_SCOPE_MODES.PINNED_TAB,
  pinnedTabId: 42,
  selectedTabIds: [42],
};

function identity(overrides = {}) {
  return contextConsentIdentity({
    gatewayUrl: 'https://agent.example.test/dashboard/path?ignored=yes',
    principal: 'nous:user-7:org-2',
    profile: 'default',
    controller: 'extension-controller-1',
    transport: 'cloud-ticket-ws',
    ...overrides,
  });
}

test('every non-loopback connection requires explicit browser-context consent', () => {
  for (const gatewayUrl of [
    'https://cloud.example.test',
    'https://remote.example.test/hermes',
    'http://100.64.0.9:8642',
  ]) {
    assert.equal(consentRequiredForConnection({ gatewayUrl }), true);
  }
  for (const gatewayUrl of [
    'http://127.0.0.1:8642',
    'http://localhost:8642',
    'http://[::1]:8642',
  ]) {
    assert.equal(consentRequiredForConnection({ gatewayUrl }), false);
  }
});

test('consent identity is scoped to origin, principal, profile, controller, and transport', () => {
  const base = identity();
  assert.deepEqual(base, {
    schemaVersion: CONTEXT_CONSENT_SCHEMA_VERSION,
    origin: 'https://agent.example.test',
    principal: 'nous:user-7:org-2',
    profile: 'default',
    controller: 'extension-controller-1',
    transport: 'cloud-ticket-ws',
  });
  const baseKey = contextConsentKey(base);
  for (const changed of [
    identity({ gatewayUrl: 'https://other.example.test' }),
    identity({ principal: 'nous:user-8:org-2' }),
    identity({ profile: 'research' }),
    identity({ controller: 'extension-controller-2' }),
    identity({ transport: 'remote-api' }),
  ]) {
    assert.notEqual(contextConsentKey(changed), baseKey);
  }
});

test('unknown dashboard principals fail closed', () => {
  assert.equal(contextConsentIdentity({
    gatewayUrl: 'https://agent.example.test',
    principal: '',
    profile: 'default',
    controller: 'extension-controller-1',
    transport: 'remote-dashboard',
  }), null);
  assert.equal(dashboardPrincipalFromMe({}), '');
  assert.equal(dashboardPrincipalFromMe({ user_id: 'user-7', provider: 'nous', org_id: 'org-2' }), 'nous:user-7:org-2');
  assert.equal(dashboardPrincipalFromMe({ user_id: 'user-7', provider: 'basic', org_id: '' }), 'basic:user-7:-');
});

test('API credential fingerprints are deterministic, rotate with the credential, and never reveal the raw value', async () => {
  const credentialA = ['fixture', 'alpha', 'value'].join(':');
  const credentialB = ['fixture', 'beta', 'value'].join(':');
  const first = await fingerprintContextCredential(credentialA);
  const repeat = await fingerprintContextCredential(credentialA);
  const changed = await fingerprintContextCredential(credentialB);
  assert.equal(first, repeat);
  assert.notEqual(first, changed);
  assert.match(first, /^sha256:[a-f0-9]{32}$/);
  assert.equal(first.includes(credentialA), false);
});

test('consent ledger grants and revokes only the exact scoped identity', () => {
  const base = identity();
  const otherProfile = identity({ profile: 'research' });
  const granted = withContextConsent({}, base, true, 1234);
  assert.equal(granted.version, CONTEXT_CONSENT_SCHEMA_VERSION);
  assert.equal(consentGrantedForIdentity(granted, base), true);
  assert.equal(consentGrantedForIdentity(granted, otherProfile), false);
  assert.equal(JSON.stringify(granted).includes('fixture:alpha:value'), false);

  const revoked = withContextConsent(granted, base, false, 2345);
  assert.equal(consentGrantedForIdentity(revoked, base), false);
  assert.equal(revoked.entries[contextConsentKey(base)].granted, false);
  assert.equal(revoked.entries[contextConsentKey(base)].revokedAt, 2345);
  const merged = mergeContextConsentLedgers(granted, revoked);
  assert.equal(consentGrantedForIdentity(merged, base), false);
  assert.deepEqual(normalizeContextConsentLedger(null), {
    version: CONTEXT_CONSENT_SCHEMA_VERSION,
    entries: {},
  });
});

test('the final context gate blocks non-loopback context and every override until the exact identity is granted', () => {
  const base = identity();
  const denied = contextScopeWithConsent(pinned, {
    gatewayUrl: base.origin,
    identity: base,
    ledger: {},
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope.mode, CONTEXT_SCOPE_MODES.CHAT_ONLY);
  assert.deepEqual(denied.scope.selectedTabIds, []);

  const ledger = withContextConsent({}, base, true, 1234);
  const allowed = contextScopeWithConsent(pinned, {
    gatewayUrl: base.origin,
    identity: base,
    ledger,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.scope.mode, CONTEXT_SCOPE_MODES.PINNED_TAB);
  assert.equal(allowed.scope.pinnedTabId, 42);

  const switched = contextScopeWithConsent(pinned, {
    gatewayUrl: base.origin,
    identity: identity({ profile: 'other' }),
    ledger,
  });
  assert.equal(switched.allowed, false);
  assert.equal(switched.scope.mode, CONTEXT_SCOPE_MODES.CHAT_ONLY);
});

test('loopback scope remains available without storing consent', () => {
  const result = contextScopeWithConsent(pinned, {
    gatewayUrl: 'http://127.0.0.1:8642',
    identity: null,
    ledger: {},
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'loopback');
  assert.equal(result.scope.mode, CONTEXT_SCOPE_MODES.PINNED_TAB);
});

test('consent decisions use a dedicated locked storage key and preserve revocation tombstones', async () => {
  const state = {};
  const storageArea = {
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
    },
    async set(values) {
      Object.assign(state, values);
    },
  };
  const lockCalls = [];
  const lockManager = {
    async request(name, options, operation) {
      lockCalls.push({ name, options });
      return operation();
    },
  };
  const scoped = identity();
  await persistContextConsentDecision({ storageArea, identity: scoped, granted: true, now: 10, lockManager });
  await persistContextConsentDecision({ storageArea, identity: scoped, granted: false, now: 20, lockManager });
  assert.equal(lockCalls.length, 2);
  assert.equal(lockCalls.every((call) => call.options.mode === 'exclusive'), true);
  assert.equal(consentGrantedForIdentity(state[CONTEXT_CONSENT_STORAGE_KEY], scoped), false);
  assert.equal(state[CONTEXT_CONSENT_STORAGE_KEY].entries[contextConsentKey(scoped)].revokedAt, 20);
  assert.equal(Object.hasOwn(state, 'hermesBrowserSettings'), false);
});
