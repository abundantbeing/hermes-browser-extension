/**
 * Phase 4 — Browser controller wire protocol.
 *
 * One protocol across every controller transport:
 *  - local-api    → api-ticket-ws  (authenticated API ticket WebSocket registration)
 *  - remote-api   → api-ticket-ws  (same transport and payload as local-api)
 *  - cloud-ticket-ws → gateway-rpc (authenticated gateway RPC method call)
 *
 * Two gateway routes carry that protocol: Hermes core's (CONTROLLER_ROUTES.core,
 * on a Hermes that still has extension control) and the Hermes Browser companion
 * plugin's (CONTROLLER_ROUTES.plugin, which gives a stock Hermes the same control).
 * The payload, ticket and frames are identical on both.
 *
 * Protocol version 1. A controller registers `controller.noop` plus the
 * browser actions its adapter reports (filtered to
 * CONTROLLER_BROWSER_CAPABILITIES below). The gateway keeps only the actions
 * its own allowlist permits and ignores the rest.
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

/**
 * Terminal registration result: the gateway has no browser-extension control
 * (the register route is gone, or the register RPC is an unknown method).
 * Retrying cannot change that, so the worker stops until settings change.
 */
export const CONTROLLER_UNSUPPORTED_GATEWAY = 'unsupported_gateway';

/**
 * Registration refused because the session does not exist on the gateway yet
 * (a draft the panel's first turn has not created). Not terminal and not worth a
 * retry loop of its own: the controller never creates a session, it waits for
 * the panel to, and tries again on the normal backoff or the next settings change.
 */
export const CONTROLLER_SESSION_PENDING = 'session_pending';

// Every entry must be an action the Chromium adapter implements
// (CHROMIUM_ACTIONS in browser-controller-adapter.mjs); a drift test pins it.
// browser_batch is run by the executor itself: every step goes through the same
// classification and approval path as a single command. A gateway that does not
// know it drops it at registration, so it stays inert until the gateway adds it.
export const CONTROLLER_BROWSER_CAPABILITIES = Object.freeze([
  'browser_back',
  'browser_batch',
  'browser_click',
  'browser_drag',
  'browser_fill',
  'browser_hover',
  'browser_navigate',
  'browser_press',
  'browser_screenshot',
  'browser_scroll',
  'browser_scroll_to',
  'browser_select',
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

export const CONTROLLER_ROUTES = Object.freeze({ core: 'core', plugin: 'plugin' });

const PLUGIN_BASE_PATH = '/api/plugins/hermes-browser-companion';
const ROUTE_PATHS = Object.freeze({
  [CONTROLLER_ROUTES.core]: Object.freeze({
    register: '/v1/browser-control/register',
    socket: '/v1/browser-control/ws',
  }),
  [CONTROLLER_ROUTES.plugin]: Object.freeze({
    register: `${PLUGIN_BASE_PATH}/control/register`,
    socket: `${PLUGIN_BASE_PATH}/control/ws`,
  }),
});
// The only socket paths a registration may name (its `ws_path`); anything else is ignored.
const KNOWN_SOCKET_PATHS = new Set(Object.values(ROUTE_PATHS).map((paths) => paths.socket));

/**
 * Address a path at a named Hermes profile: `/p/<profile>` in front of it, as the
 * rest of the extension does (hermes-client's profileScopedPath). The gateway
 * ignores the X-Hermes-Profile header for routing, so without the prefix a
 * request lands on the default profile. Core mirrors its routes under the prefix.
 * The companion plugin's routes are wired on the listener only: stock Hermes hands
 * any other `/p/{profile}/{tail}` to that profile's platform ingress, so
 * `/p/default/<plugin route>` is a 404 there while the plain path reaches the same
 * default profile. The default profile therefore keeps the plain address.
 */
export function controllerProfilePath(path = '', profile = '') {
  const normalized = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
  const selected = String(profile || '').trim();
  if (!selected || selected === 'default' || /^\/p\/[^/]+(?:\/|$)/.test(normalized)) return normalized;
  return `/p/${encodeURIComponent(selected)}${normalized}`;
}

function routePaths(route) {
  const paths = ROUTE_PATHS[route];
  if (!paths) throw new Error(`Unsupported controller route: ${String(route || '')}`);
  return paths;
}

/**
 * The socket path to open after a registration on `route`: the `ws_path` the
 * gateway answered when it is one of the two known socket paths, else the route's
 * own. A gateway cannot send the extension to a path of its choosing.
 */
export function controllerSocketPath(route, wsPath) {
  const answered = String(wsPath ?? '').trim();
  return KNOWN_SOCKET_PATHS.has(answered) ? answered : routePaths(route).socket;
}

/**
 * Registration payload shared verbatim by every transport.
 * The controller identity plus its negotiated capability set.
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
 * @param {string} [options.route] - 'core' (default) or 'plugin': which gateway route to register on (API transports only)
 * @param {string} [options.profile] - active Hermes profile; a non-empty one prefixes the register path with /p/<profile>
 * @param {object} options.identity - controller identity ({ controllerId, browserProfileId, hermesSessionId, product })
 * @returns {{ transport: string, registrationUrl?: string, payload?: object, method?: string, params?: object }}
 */
export function controllerRegistrationFor({ family, baseUrl, identity, route = CONTROLLER_ROUTES.core, profile = '' } = {}) {
  if (family === CONTROLLER_TRANSPORT_FAMILIES.LOCAL_API || family === CONTROLLER_TRANSPORT_FAMILIES.REMOTE_API) {
    return {
      transport: TRANSPORT_API_TICKET_WS,
      registrationUrl: joinUrlPath(baseUrl, controllerProfilePath(routePaths(route).register, profile), { family }),
      payload: registrationPayload(identity),
    };
  }
  if (family === CONTROLLER_TRANSPORT_FAMILIES.CLOUD_TICKET_WS) {
    // Upstream BrowserControllerRegisterParams (extra=forbid) has no `product`
    // field, so the gateway-RPC call omits it. The REST registration keeps it.
    // eslint-disable-next-line no-unused-vars
    const { product, ...params } = registrationPayload(identity);
    return {
      transport: TRANSPORT_GATEWAY_RPC,
      method: CONTROLLER_METHODS.register,
      params,
    };
  }
  throw new Error(`Unsupported controller transport family: ${String(family || '')}`);
}

/**
 * Build the credential-free WebSocket URL for the api-ticket-ws transport.
 * The one-shot ticket is carried separately by controllerWebSocketProtocols()
 * so request-target/access logs cannot capture it. `socketPath` is one of the
 * known socket paths (see controllerSocketPath); anything else gives core's. A
 * non-empty `profile` addresses the socket at that profile, like the register.
 */
export function controllerWebSocketUrl(baseUrl, socketPath = ROUTE_PATHS[CONTROLLER_ROUTES.core].socket, profile = '') {
  const url = parsedApiBaseUrl(baseUrl);
  const socket = new URL(url.href);
  socket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  socket.pathname = `${url.pathname.replace(/\/+$/, '')}${controllerProfilePath(controllerSocketPath(CONTROLLER_ROUTES.core, socketPath), profile)}`;
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
