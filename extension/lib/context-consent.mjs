import { isLoopbackGatewayUrl } from './connection-modes.mjs';
import {
  CONTEXT_SCOPE_MODES,
  normalizeContextScope,
} from './context-scope.mjs';

export const CONTEXT_CONSENT_SCHEMA_VERSION = 1;
export const CONTEXT_CONSENT_STORAGE_KEY = 'hermesBrowserContextConsentLedger';
const CONTEXT_CONSENT_LOCK_NAME = 'hermes-browser-context-consent-ledger';
export const MAX_CONTEXT_CONSENT_ENTRIES = 64;

function cleanIdentityPart(value = '', fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

export function normalizeContextConsentOrigin(raw = '') {
  try {
    const url = new URL(String(raw || '').trim());
    if (!['http:', 'https:', 'file:'].includes(url.protocol) || url.username || url.password) return '';
    return url.protocol === 'file:' ? 'file://' : url.origin;
  } catch {
    return '';
  }
}

export function dashboardPrincipalFromMe(payload = {}) {
  const userId = cleanIdentityPart(payload?.user_id || payload?.userId);
  const provider = cleanIdentityPart(payload?.provider);
  if (!userId || !provider) return '';
  const orgId = cleanIdentityPart(payload?.org_id || payload?.orgId, '-');
  return `${provider}:${userId}:${orgId}`;
}

export async function fingerprintContextCredential(secret = '', cryptoImpl = globalThis.crypto) {
  const value = String(secret || '');
  if (!value || !cryptoImpl?.subtle?.digest) return '';
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const bytes = Array.from(new Uint8Array(digest).slice(0, 16));
  return `sha256:${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function contextConsentIdentity({
  gatewayUrl = '',
  principal = '',
  profile = '',
  controller = '',
  transport = '',
} = {}) {
  const origin = normalizeContextConsentOrigin(gatewayUrl);
  const normalizedPrincipal = cleanIdentityPart(principal);
  const normalizedController = cleanIdentityPart(controller);
  if (!origin || !normalizedPrincipal || !normalizedController) return null;
  return {
    schemaVersion: CONTEXT_CONSENT_SCHEMA_VERSION,
    origin,
    principal: normalizedPrincipal,
    profile: cleanIdentityPart(profile, 'default'),
    controller: normalizedController,
    transport: cleanIdentityPart(transport, 'unknown'),
  };
}

export function contextConsentKey(identity = null) {
  if (!identity) return '';
  const normalized = contextConsentIdentity({
    gatewayUrl: identity.origin,
    principal: identity.principal,
    profile: identity.profile,
    controller: identity.controller,
    transport: identity.transport,
  });
  if (!normalized) return '';
  return JSON.stringify([
    normalized.schemaVersion,
    normalized.origin,
    normalized.principal,
    normalized.profile,
    normalized.controller,
    normalized.transport,
  ]);
}

export function normalizeContextConsentLedger(value = null) {
  const entries = {};
  const sourceEntries = value?.entries && typeof value.entries === 'object' ? value.entries : {};
  for (const [key, record] of Object.entries(sourceEntries)) {
    if (!record || typeof record !== 'object' || typeof record.granted !== 'boolean') continue;
    const identity = contextConsentIdentity({
      gatewayUrl: record.origin,
      principal: record.principal,
      profile: record.profile,
      controller: record.controller,
      transport: record.transport,
    });
    const canonicalKey = contextConsentKey(identity);
    if (!identity || !canonicalKey || canonicalKey !== key) continue;
    const updatedAt = Number.isFinite(Number(record.updatedAt))
      ? Number(record.updatedAt)
      : Number(record.grantedAt || record.revokedAt || 0);
    entries[key] = {
      granted: record.granted,
      updatedAt,
      ...(record.granted ? { grantedAt: Number(record.grantedAt || updatedAt || 0) } : { revokedAt: Number(record.revokedAt || updatedAt || 0) }),
      ...identity,
    };
  }
  const ordered = Object.entries(entries)
    .sort(([, left], [, right]) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, MAX_CONTEXT_CONSENT_ENTRIES);
  return {
    version: CONTEXT_CONSENT_SCHEMA_VERSION,
    entries: Object.fromEntries(ordered),
  };
}

export function consentGrantedForIdentity(ledger = null, identity = null) {
  const key = contextConsentKey(identity);
  if (!key) return false;
  return normalizeContextConsentLedger(ledger).entries[key]?.granted === true;
}

export function withContextConsent(ledger = null, identity = null, granted = false, now = Date.now()) {
  const normalizedLedger = normalizeContextConsentLedger(ledger);
  const key = contextConsentKey(identity);
  if (!key || !identity) return normalizedLedger;
  const updatedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const entries = {
    ...normalizedLedger.entries,
    [key]: {
      granted: Boolean(granted),
      updatedAt,
      ...(granted ? { grantedAt: updatedAt } : { revokedAt: updatedAt }),
      ...identity,
    },
  };
  return normalizeContextConsentLedger({
    version: CONTEXT_CONSENT_SCHEMA_VERSION,
    entries,
  });
}

export function mergeContextConsentLedgers(...ledgers) {
  const entries = {};
  for (const ledger of ledgers) {
    for (const [key, record] of Object.entries(normalizeContextConsentLedger(ledger).entries)) {
      if (!entries[key] || Number(record.updatedAt || 0) >= Number(entries[key].updatedAt || 0)) entries[key] = record;
    }
  }
  return normalizeContextConsentLedger({ version: CONTEXT_CONSENT_SCHEMA_VERSION, entries });
}

export async function persistContextConsentDecision({
  storageArea,
  identity,
  granted,
  now = Date.now(),
  lockManager = globalThis.navigator?.locks,
} = {}) {
  if (!storageArea?.get || !storageArea?.set) throw new TypeError('A browser storage area is required');
  const update = async () => {
    const stored = await storageArea.get([CONTEXT_CONSENT_STORAGE_KEY]);
    const nextLedger = withContextConsent(stored?.[CONTEXT_CONSENT_STORAGE_KEY], identity, granted, now);
    await storageArea.set({ [CONTEXT_CONSENT_STORAGE_KEY]: nextLedger });
    return nextLedger;
  };
  if (lockManager?.request) return lockManager.request(CONTEXT_CONSENT_LOCK_NAME, { mode: 'exclusive' }, update);
  return update();
}

export function consentRequiredForConnection({ gatewayUrl = '' } = {}) {
  const origin = normalizeContextConsentOrigin(gatewayUrl);
  return Boolean(origin) && !isLoopbackGatewayUrl(origin);
}

export function contextScopeWithConsent(scope = {}, {
  gatewayUrl = '',
  identity = null,
  ledger = null,
} = {}) {
  const requested = normalizeContextScope(scope);
  if (!consentRequiredForConnection({ gatewayUrl })) {
    return {
      allowed: true,
      reason: 'loopback',
      scope: requested,
      identity: null,
    };
  }
  const allowed = consentGrantedForIdentity(ledger, identity);
  return {
    allowed,
    reason: allowed ? 'granted' : (identity ? 'consent-required' : 'principal-unavailable'),
    scope: allowed
      ? requested
      : normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.CHAT_ONLY }),
    identity,
  };
}
