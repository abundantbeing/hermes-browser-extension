// Hermes' API server answers a request that carries an Origin header with a bare 403 unless that
// origin is listed in API_SERVER_CORS_ORIGINS, and a request without one is let through. A browser
// adds Origin to this extension's POST and DELETE requests (chat, runs, sessions), so every person
// had to find the extension's id and add it to the gateway's .env before the first message. The
// extension already has host access to the gateway, so the browser does not need CORS to read the
// answer; the header only gets the request refused. This rule removes it from this extension's own
// requests to the active connection's address, and from nothing else: not web pages, not other
// addresses, not WebSocket handshakes. The API key still guards every route.

import { originPattern } from './connection-headers.mjs';

export const GATEWAY_ORIGIN_RULE_ID = 7747;
export const DRAFT_ORIGIN_RULE_ID = 7748;

// Dashboard and Cloud connections sign in through a tab and keep their Origin.
const TAB_SIGN_IN_TRANSPORTS = new Set(['remote-dashboard', 'cloud-ticket-ws']);

function originRule(id, gatewayUrl, extensionHost) {
  const pattern = originPattern(gatewayUrl);
  if (!pattern || !extensionHost) return null;
  return {
    id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: { regexFilter: pattern, initiatorDomains: [extensionHost], resourceTypes: ['xmlhttprequest'] },
  };
}

/** The rule for the active connection, or none for a connection that signs in through a tab. */
export function gatewayOriginRules({ gatewayUrl, connectionTransport, extensionHost } = {}) {
  if (TAB_SIGN_IN_TRANSPORTS.has(String(connectionTransport || ''))) return [];
  const rule = originRule(GATEWAY_ORIGIN_RULE_ID, gatewayUrl, extensionHost);
  return rule ? [rule] : [];
}

export async function applyGatewayOriginRule(
  { gatewayUrl, connectionTransport, extensionHost } = {},
  dnr = globalThis.chrome?.declarativeNetRequest || globalThis.browser?.declarativeNetRequest,
) {
  if (!dnr?.updateSessionRules) return false;
  await dnr.updateSessionRules({
    removeRuleIds: [GATEWAY_ORIGIN_RULE_ID],
    addRules: gatewayOriginRules({ gatewayUrl, connectionTransport, extensionHost }),
  });
  return true;
}

/** Runs `run` with a rule for an address that is not saved yet, such as a new connection being tested. */
export async function withDraftOriginRule(
  { gatewayUrl, extensionHost } = {},
  run,
  dnr = globalThis.chrome?.declarativeNetRequest || globalThis.browser?.declarativeNetRequest,
) {
  const rule = dnr?.updateSessionRules ? originRule(DRAFT_ORIGIN_RULE_ID, gatewayUrl, extensionHost) : null;
  if (rule) await dnr.updateSessionRules({ removeRuleIds: [DRAFT_ORIGIN_RULE_ID], addRules: [rule] });
  try {
    return await run();
  } finally {
    if (rule) await dnr.updateSessionRules({ removeRuleIds: [DRAFT_ORIGIN_RULE_ID] }).catch(() => undefined);
  }
}
