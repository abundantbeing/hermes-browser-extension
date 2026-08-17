/**
 * Phase 4 — Browser controller wire protocol.
 *
 * One protocol across every controller transport:
 *  - local-api    → api-ticket-ws  (authenticated API ticket WebSocket registration)
 *  - remote-api   → api-ticket-ws  (same transport and payload as local-api)
 *  - cloud-ticket-ws → gateway-rpc (authenticated gateway RPC method call)
 *
 * Protocol version 1. Capabilities are intentionally limited to
 * `controller.noop`; every real browser action stays disabled in Phase 4.
 */

export const CONTROLLER_PROTOCOL_VERSION = 1;

export const CONTROLLER_METHODS = Object.freeze({
  register: 'browser.controller.register',
  command: 'browser.controller.command',
  result: 'browser.controller.result',
  cancel: 'browser.controller.cancel',
});

/**
 * Phase 5 heartbeat protocol. Kept separate from CONTROLLER_METHODS so the
 * Phase 4 method table stays exact; the lifecycle uses this cadence for its
 * (dormant, fail-closed) heartbeat/reconcile alarms.
 */
export const CONTROLLER_HEARTBEAT_METHOD = 'browser.controller.heartbeat';
export const CONTROLLER_HEARTBEAT_INTERVAL_MS = 60_000;

export const CONTROLLER_NOOP_CAPABILITY = 'controller.noop';

export const CONTROLLER_BROWSER_CAPABILITIES = Object.freeze([
  'browser_back',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_navigate',
  'browser_press',
  'browser_screenshot',
  'browser_scroll',
  'browser_scroll_to',
  'browser_snapshot',
  'browser_tab_activate',
  'browser_tab_close',
  'browser_tab_create',
  'browser_tab_group',
  'browser_tab_ungroup',
  'browser_tabs',
  'browser_type',
]);

const KNOWN_CONTROLLER_CAPABILITIES = new Set([
  CONTROLLER_NOOP_CAPABILITY,
  ...CONTROLLER_BROWSER_CAPABILITIES,
]);

function registrationCapabilities(identity = {}) {
  const requested = Array.isArray(identity.capabilities) ? identity.capabilities : [];
  const allowed = requested
    .map((capability) => String(capability || '').trim())
    .filter((capability) => capability !== CONTROLLER_NOOP_CAPABILITY && KNOWN_CONTROLLER_CAPABILITIES.has(capability));
  return [CONTROLLER_NOOP_CAPABILITY, ...new Set(allowed)].sort((a, b) => {
    if (a === CONTROLLER_NOOP_CAPABILITY) return -1;
    if (b === CONTROLLER_NOOP_CAPABILITY) return 1;
    return a.localeCompare(b);
  });
}

export const CONTROLLER_TRANSPORT_FAMILIES = Object.freeze({
  LOCAL_API: 'local-api',
  REMOTE_API: 'remote-api',
  CLOUD_TICKET_WS: 'cloud-ticket-ws',
});

const TRANSPORT_API_TICKET_WS = 'api-ticket-ws';
const TRANSPORT_GATEWAY_RPC = 'gateway-rpc';

const REGISTER_PATH = '/v1/browser-control/register';
const WEBSOCKET_PATH = '/v1/browser-control/ws';

/**
 * Registration payload shared verbatim by every transport.
 * The controller identity plus the Phase 4 no-op capability set.
 */
function registrationPayload(identity = {}) {
  const controllerId = String(identity.controllerId || '').trim();
  const browserProfileId = String(identity.browserProfileId || '').trim();
  const sessionId = String(identity.hermesSessionId || '').trim();
  if (!controllerId || !browserProfileId || !sessionId) {
    throw new Error('Controller id, browser profile id, and session id are required.');
  }
  const sourceProduct = identity.product && typeof identity.product === 'object' ? identity.product : {};
  const product = {
    id: String(sourceProduct.id || '').trim(),
    engine: String(sourceProduct.engine || '').trim(),
    label: String(sourceProduct.label || '').trim(),
  };
  if (!product.id || !product.engine || !product.label) {
    throw new Error('Controller product id, engine, and label are required.');
  }
  return {
    controller_id: controllerId,
    browser_profile_id: browserProfileId,
    session_id: sessionId,
    capabilities: registrationCapabilities(identity),
    protocol_version: CONTROLLER_PROTOCOL_VERSION,
    product,
  };
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parsedApiBaseUrl(baseUrl, { family = '' } = {}) {
  let url;
  try {
    url = new URL(String(baseUrl || ''));
  } catch {
    throw new Error(`Controller API base URL must be http or https: ${String(baseUrl || '')}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Controller API base URL must be http or https: ${String(baseUrl || '')}`);
  }
  if (url.username || url.password) {
    throw new Error('Controller API base URL must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw new Error('Controller API base URL must not contain query parameters or a fragment.');
  }
  if (family === CONTROLLER_TRANSPORT_FAMILIES.LOCAL_API && !isLoopbackHost(url.hostname)) {
    throw new Error('Local controller API base URL must use a loopback host.');
  }
  if (family === CONTROLLER_TRANSPORT_FAMILIES.REMOTE_API && url.protocol !== 'https:') {
    throw new Error('Remote controller API base URL must use HTTPS.');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('HTTP controller API base URL is allowed only for a loopback host.');
  }
  return url;
}

/** Join a parsed base URL (with optional base path) and a fixed protocol path. */
function joinUrlPath(baseUrl, path, options) {
  const url = parsedApiBaseUrl(baseUrl, options);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${path}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Build the controller registration descriptor for a transport family.
 *
 * @param {object} options
 * @param {string} options.family - 'local-api' | 'remote-api' | 'cloud-ticket-ws'
 * @param {string} options.baseUrl - Hermes runtime base URL (http/https)
 * @param {object} options.identity - controller identity ({ controllerId, browserProfileId, hermesSessionId, product })
 * @returns {{ transport: string, registrationUrl?: string, payload?: object, method?: string, params?: object }}
 */
export function controllerRegistrationFor({ family, baseUrl, identity } = {}) {
  if (family === CONTROLLER_TRANSPORT_FAMILIES.LOCAL_API || family === CONTROLLER_TRANSPORT_FAMILIES.REMOTE_API) {
    return {
      transport: TRANSPORT_API_TICKET_WS,
      registrationUrl: joinUrlPath(baseUrl, REGISTER_PATH, { family }),
      payload: registrationPayload(identity),
    };
  }
  if (family === CONTROLLER_TRANSPORT_FAMILIES.CLOUD_TICKET_WS) {
    return {
      transport: TRANSPORT_GATEWAY_RPC,
      method: CONTROLLER_METHODS.register,
      params: registrationPayload(identity),
    };
  }
  throw new Error(`Unsupported controller transport family: ${String(family || '')}`);
}

/**
 * Build the credential-free WebSocket URL for the api-ticket-ws transport.
 * The one-shot ticket is carried separately by controllerWebSocketProtocols()
 * so request-target/access logs cannot capture it.
 */
export function controllerWebSocketUrl(baseUrl) {
  const url = parsedApiBaseUrl(baseUrl);
  const socket = new URL(url.href);
  socket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  socket.pathname = `${url.pathname.replace(/\/+$/, '')}${WEBSOCKET_PATH}`;
  socket.search = '';
  socket.hash = '';
  return socket.href;
}

/** Build the WebSocket subprotocol list carrying a short-lived one-shot ticket. */
export function controllerWebSocketProtocols(ticket) {
  const cleanTicket = String(ticket ?? '').trim();
  if (!cleanTicket) throw new Error('Controller WebSocket ticket is required.');
  if (!/^[A-Za-z0-9._~-]+$/.test(cleanTicket)) {
    throw new Error('Controller WebSocket ticket contains unsupported characters.');
  }
  return [
    'hermes-browser-control-v1',
    `hermes-browser-control-ticket.${cleanTicket}`,
  ];
}
