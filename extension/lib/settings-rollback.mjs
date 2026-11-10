// A Save that fails must undo only what that Save changed. Another panel can update the same
// settings while Save waits for a lock or a consent answer, and a snapshot taken at the start
// would put those older values back over the newer ones.

import { gatewayKey } from './settings-save-effects.mjs';

// Gateway-move side effects must not be undone unless the Save's target address is still live.
const GATEWAY_MOVE_FIELDS = new Set([
  'connectionHeaders',
  'connectionTrustSelfSigned',
  'apiKey',
  'tokenSource',
  'activeProfile',
  'botModeSelectedProfile',
  'botModeReturnProfile',
]);

function saveTargetGatewayStillLive(current = {}, owned = {}) {
  if (!owned.gatewayUrl) return true;
  return gatewayKey(current.gatewayUrl) === gatewayKey(owned.gatewayUrl.to);
}

function same(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!same(a[key], b[key])) return false;
  return true;
}

/** The fields whose value differs between the settings Save started from and the ones it composed. */
export function changesMadeBy(before = {}, after = {}) {
  const owned = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    owned[key] = { had: key in before, from: before[key], to: after[key] };
  }
  return owned;
}

/**
 * Puts back each field Save changed, but only while it still holds the value Save gave it:
 * a field something else has changed since belongs to that newer change and stays.
 */
export function undoChanges(current = {}, owned = {}) {
  const next = { ...current };
  const gatewayUndosAllowed = saveTargetGatewayStillLive(current, owned);
  for (const [key, change] of Object.entries(owned)) {
    if (!same(current[key], change.to)) continue;
    if (GATEWAY_MOVE_FIELDS.has(key) && !gatewayUndosAllowed) continue;
    if (change.had) next[key] = change.from;
    else delete next[key];
  }
  return next;
}
