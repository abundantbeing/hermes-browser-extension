// Hermes' API server answers a request that carries an Origin header with a bare 403 unless that
// origin is listed in API_SERVER_CORS_ORIGINS, and a request without one is let through. A browser
// adds Origin to this extension's POST and DELETE requests (chat, runs, sessions), so every person
// had to find the extension's id and add it to the gateway's .env before the first message. The
// extension already has host access to the gateway, so the browser does not need CORS to read the
// answer; the header only gets the request refused. These rules remove it from this extension's own
// requests to the address it is connecting to, and from nothing else: not web pages, not other
// addresses, not WebSocket handshakes. The API key still guards every route.
//
// Only the worker writes the active rule (7747), from stored settings, one update at a time, so a
// panel that loaded older settings can never put an old address back. A panel asks it to sync.

import { PROBE_PARAM, originPattern } from './connection-headers.mjs';
import { isLoopbackGatewayUrl } from './connection-modes.mjs';

export const GATEWAY_ORIGIN_RULE_ID = 7747;
export const SYNC_GATEWAY_RULES_MESSAGE = 'HERMES_SYNC_GATEWAY_RULES';

// A test of an unsaved address gets its own rule id, from a range no other rule uses (the header
// probe rules start at 1,000,000 and span 2^30), so two tests never replace or remove each other's.
const DRAFT_RULE_ID_BASE = 1_200_000_000;
const DRAFT_RULE_ID_SPAN = 2 ** 29;

// Dashboard and Cloud connections sign in through a tab and keep their Origin.
const TAB_SIGN_IN_TRANSPORTS = new Set(['remote-dashboard', 'cloud-ticket-ws']);

function removeOrigin(id, condition) {
  return {
    id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: { ...condition, resourceTypes: ['xmlhttprequest'] },
  };
}

/**
 * The worker's rule: the active connection's address, plus the address a panel is pairing with
 * before it is saved (loopback only, since automatic pairing only runs there). None for a
 * connection that signs in through a tab.
 */
export function gatewayOriginRules({ gatewayUrl, connectionTransport, extensionHost, pendingGatewayUrl = '', pendingGatewayUrls = [] } = {}) {
  if (!extensionHost) return [];
  const patterns = [];
  if (!TAB_SIGN_IN_TRANSPORTS.has(String(connectionTransport || ''))) patterns.push(originPattern(gatewayUrl));
  const pending = [...new Set([
    pendingGatewayUrl,
  ...(Array.isArray(pendingGatewayUrls) ? pendingGatewayUrls : []),
  ].map((url) => String(url || '').trim()).filter(Boolean))];
  for (const url of pending) {
    if (isLoopbackGatewayUrl(url)) patterns.push(originPattern(url));
  }
  const unique = [...new Set(patterns.filter(Boolean))];
  if (!unique.length) return [];
  const regexFilter = unique.length === 1 ? unique[0] : `^(?:${unique.map((pattern) => pattern.slice(1)).join('|')})`;
  return [removeOrigin(GATEWAY_ORIGIN_RULE_ID, { regexFilter, initiatorDomains: [extensionHost] })];
}

export async function applyGatewayOriginRule(
  { gatewayUrl, connectionTransport, extensionHost, pendingGatewayUrl, pendingGatewayUrls } = {},
  dnr = globalThis.chrome?.declarativeNetRequest || globalThis.browser?.declarativeNetRequest,
) {
  if (!dnr?.updateSessionRules) return false;
  await dnr.updateSessionRules({
    removeRuleIds: [GATEWAY_ORIGIN_RULE_ID],
    addRules: gatewayOriginRules({ gatewayUrl, connectionTransport, extensionHost, pendingGatewayUrl, pendingGatewayUrls }),
  });
  return true;
}

function newDraftRuleId() {
  const [random] = globalThis.crypto?.getRandomValues?.(new Uint32Array(1)) || [Math.floor(Math.random() * 2 ** 32)];
  return DRAFT_RULE_ID_BASE + (random % DRAFT_RULE_ID_SPAN);
}

/** The rule for one test of an unsaved address: only that test's requests, which carry its marker. */
export function draftOriginRule({ gatewayUrl, extensionHost, marker, id = DRAFT_RULE_ID_BASE } = {}) {
  const pattern = originPattern(gatewayUrl);
  if (!pattern || !extensionHost || !/^[a-z0-9]{6,}$/.test(String(marker || ''))) return null;
  return removeOrigin(id, {
    regexFilter: `${pattern}[^#]*[?&]${PROBE_PARAM}=${marker}(?:&|$)`,
    initiatorDomains: [extensionHost],
  });
}

/**
 * Runs `run` with a rule for one test of an address that is not saved yet, such as a connection
 * being added. The rule matches only requests carrying `marker`, so one left behind by a panel that
 * closed mid-test matches nothing again. Installing it is best effort: if the browser refuses, the
 * test still runs, and a gateway that already lists the extension still answers.
 */
export async function withDraftOriginRule(
  { gatewayUrl, extensionHost, marker } = {},
  run,
  dnr = globalThis.chrome?.declarativeNetRequest || globalThis.browser?.declarativeNetRequest,
) {
  let rule = dnr?.updateSessionRules ? draftOriginRule({ gatewayUrl, extensionHost, marker, id: newDraftRuleId() }) : null;
  if (rule) {
    try {
      await dnr.updateSessionRules({ addRules: [rule] });
    } catch (error) {
      console.warn('[Hermes Browser] Test origin rule failed:', error);
      rule = null;
    }
  }
  try {
    return await run();
  } finally {
    if (rule) await dnr.updateSessionRules({ removeRuleIds: [rule.id] }).catch(() => undefined);
  }
}
