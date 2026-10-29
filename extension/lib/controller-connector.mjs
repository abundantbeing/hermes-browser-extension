/**
 * Phase 5 controller transport connector
 *
 * Local/VPS: authenticated registration POST (Hermes core's route, else the
 * companion plugin's), then a dedicated credential-free controller WebSocket
 * whose one-shot ticket is carried only as a subprotocol.
 *
 * Cloud/dashboard: mint a first-party dashboard ticket from the explicitly
 * trusted tab, connect to a credential-free Gateway endpoint with ticket
 * subprotocols, resume the durable session, and register against that exact
 * live transport session.
 */

import {
  CONTROLLER_HEARTBEAT_METHOD,
  CONTROLLER_METHODS,
  CONTROLLER_ROUTES,
  CONTROLLER_SESSION_PENDING,
  CONTROLLER_UNSUPPORTED_GATEWAY,
  CONTROLLER_TRANSPORT_FAMILIES,
  controllerRegistrationFor,
  controllerSocketPath,
  controllerWebSocketProtocols,
  controllerWebSocketUrl,
} from './controller-protocol.mjs';
import {
  buildDashboardWsEndpoint,
  createGatewayClient,
  establishGatewaySession,
  gatewayWebSocketProtocols,
  isUnknownMethodError,
} from './gateway-ws.mjs';
import {
  isTrustedDashboardOrigin,
  mintWsTicket,
} from './dashboard-bridge.mjs';
import { CONNECTION_TRANSPORTS } from './connection-modes.mjs';

const API_TRANSPORTS = new Set([
  CONNECTION_TRANSPORTS.LOCAL_API,
  CONNECTION_TRANSPORTS.REMOTE_API,
]);
const CLOUD_TRANSPORTS = new Set([
  CONNECTION_TRANSPORTS.CLOUD_TICKET_WS,
  CONNECTION_TRANSPORTS.REMOTE_DASHBOARD,
]);
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

function asError(error, fallback) {
  return error instanceof Error ? error : new Error(String(error || fallback));
}

// A gateway without extension control answers the register route with 404 (or
// 405 when the path matches a different verb) and the register RPC with
// method-not-found. Neither changes on retry, so both are terminal. On the API
// transports that holds only once both routes (Hermes core's and the companion
// plugin's) have answered so.
function unsupportedGatewayError(detail, status) {
  const error = new Error(detail);
  error.code = CONTROLLER_UNSUPPORTED_GATEWAY;
  if (status !== undefined) error.status = status;
  return error;
}

function unsupportedRegisterError(status) {
  return unsupportedGatewayError(`This Hermes does not support Hermes Control (HTTP ${status}).`, status);
}

function isUnsupportedRegisterStatus(status) {
  return Number(status) === 404 || Number(status) === 405;
}

function normalizedTransport(settings = {}) {
  return String(settings?.connectionTransport || '').trim();
}

// The profile the connection is for: it addresses the register and the socket (/p/<profile>)
// and is sent as a header too.
function activeProfileOf(settings = {}) {
  return String(settings?.activeProfile || '').trim();
}

function apiHeaders(settings = {}) {
  const apiKey = String(settings?.apiKey || '').trim();
  if (!apiKey) throw new Error('Controller API registration requires an API credential.');
  const profile = activeProfileOf(settings);
  const authorization = ['Bearer', apiKey].join(' ');
  return {
    'Content-Type': 'application/json',
    Authorization: authorization,
    ...(profile ? { 'X-Hermes-Profile': profile } : {}),
  };
}

function parseSocketFrame(raw) {
  try {
    const frame = JSON.parse(String(raw || ''));
    return frame && typeof frame === 'object' ? frame : null;
  } catch {
    return null;
  }
}

function openControllerSocket({
  WebSocketImpl,
  url,
  protocols,
  onFrame,
  onClose,
  timeoutMs,
}) {
  if (!WebSocketImpl) return Promise.reject(new Error('WebSocket is unavailable for controller transport.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    let heartbeatSequence = 0;
    const pendingHeartbeats = new Map();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket?.close?.(); } catch { /* ignore */ }
      reject(new Error('Controller WebSocket connection timed out.'));
    }, timeoutMs);
    timer?.unref?.();

    try {
      socket = new WebSocketImpl(url, protocols);
    } catch (error) {
      clearTimeout(timer);
      reject(asError(error, 'Controller WebSocket could not be created.'));
      return;
    }

    socket.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        async send(frame) {
          if (socket.readyState !== 1) throw new Error('Controller WebSocket is not open.');
          socket.send(JSON.stringify(frame));
        },
        heartbeat() {
          if (socket.readyState !== 1) return Promise.reject(new Error('Controller WebSocket is not open.'));
          heartbeatSequence += 1;
          const nonce = `heartbeat-${heartbeatSequence}`;
          return new Promise((resolveHeartbeat, rejectHeartbeat) => {
            const heartbeatTimer = setTimeout(() => {
              pendingHeartbeats.delete(nonce);
              rejectHeartbeat(new Error('Controller heartbeat timed out.'));
            }, timeoutMs);
            heartbeatTimer?.unref?.();
            pendingHeartbeats.set(nonce, { resolve: resolveHeartbeat, reject: rejectHeartbeat, timer: heartbeatTimer });
            socket.send(JSON.stringify({ method: CONTROLLER_HEARTBEAT_METHOD, params: { nonce } }));
          });
        },
        close() {
          try { socket.close(); } catch { /* ignore */ }
        },
      });
    });
    socket.addEventListener('message', (event) => {
      const frame = parseSocketFrame(event?.data);
      if (frame?.method === CONTROLLER_HEARTBEAT_METHOD) {
        const nonce = String(frame?.params?.nonce || '').trim();
        const pending = pendingHeartbeats.get(nonce);
        if (pending) {
          pendingHeartbeats.delete(nonce);
          clearTimeout(pending.timer);
          if (frame?.params?.ok === true) pending.resolve({ ok: true });
          else pending.reject(new Error('Controller heartbeat was rejected.'));
        }
        return;
      }
      if (frame) Promise.resolve(onFrame?.(frame)).catch(() => undefined);
    });
    socket.addEventListener('error', () => {
      // The close event owns terminal connection reporting so its code/reason is
      // not replaced by a generic browser error event.
    });
    socket.addEventListener('close', (event) => {
      for (const pending of pendingHeartbeats.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Controller WebSocket closed during heartbeat.'));
      }
      pendingHeartbeats.clear();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Controller WebSocket closed before open (code ${event?.code ?? '?' }).`));
        return;
      }
      onClose?.(new Error(`Controller WebSocket closed (code ${event?.code ?? '?' }).`));
    });
  });
}

export function createControllerConnector({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  WebSocketImpl = globalThis.WebSocket,
  tabsApi = null,
  scriptingApi = null,
  mintDashboardTicket = mintWsTicket,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  // One registration against one gateway route (Hermes core's or the companion
  // plugin's). Resolves to the ticket and the socket path to open; a 404 or 405 is
  // that route's own terminal unsupported_gateway result, so the caller can try the
  // other route before giving up.
  async function registerOnRoute({ route, family, baseUrl, identity, settings, signal }) {
    const descriptor = controllerRegistrationFor({ family, baseUrl, identity, route, profile: activeProfileOf(settings) });
    const response = await fetchImpl(descriptor.registrationUrl, {
      method: 'POST',
      headers: apiHeaders(settings),
      body: JSON.stringify(descriptor.payload),
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (isUnsupportedRegisterStatus(response.status)) throw unsupportedRegisterError(response.status);
      // The gateway refuses a ticket for a session it does not know
      // (browser_control_session_forbidden). A local draft's id is minted
      // client-side and the panel's first turn creates it; the controller never
      // creates a session (that left an empty one in the person's list on every
      // panel open). It reports "not ready" and tries again on the normal backoff.
      if (payload?.error?.code === 'browser_control_session_forbidden') {
        const pending = new Error('This chat does not exist on the gateway yet; Hermes Control connects once its first message has been sent.');
        pending.code = CONTROLLER_SESSION_PENDING;
        throw pending;
      }
      const message = String(payload?.error?.message || payload?.detail || '').trim();
      throw new Error(message || `Controller registration failed (HTTP ${response.status}).`);
    }
    const ticket = String(payload?.ticket || '').trim();
    if (!ticket) throw new Error('Controller registration did not return a ticket.');
    return { ticket, socketPath: controllerSocketPath(route, payload?.ws_path), route };
  }

  // Hermes core's route first. A Hermes without extension control in core answers
  // it 404 or 405, and the companion plugin carries the same protocol on its own
  // route, so try that before declaring the gateway unsupported.
  async function registerOnAnyRoute(options) {
    try {
      return await registerOnRoute({ ...options, route: CONTROLLER_ROUTES.core });
    } catch (coreError) {
      if (coreError?.code !== CONTROLLER_UNSUPPORTED_GATEWAY) throw coreError;
      try {
        return await registerOnRoute({ ...options, route: CONTROLLER_ROUTES.plugin });
      } catch (pluginError) {
        if (pluginError?.code !== CONTROLLER_UNSUPPORTED_GATEWAY) throw pluginError;
        throw unsupportedGatewayError(`${coreError.message} The Hermes Browser Extension plugin's control route is not available on it either (HTTP ${pluginError.status}).`);
      }
    }
  }

  async function connectApi({ settings, identity, onFrame, onClose }) {
    if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for controller registration.');
    const family = normalizedTransport(settings);
    const baseUrl = String(settings?.gatewayUrl || '').trim();
    // Throws on a malformed identity or base URL before any request is made.
    controllerRegistrationFor({ family, baseUrl, identity, profile: activeProfileOf(settings) });
    const controller = new AbortController();
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error('Controller registration timed out.');
        controller.abort(error);
        reject(error);
      }, connectTimeoutMs);
    });
    let registered;
    try {
      registered = await Promise.race([
        registerOnAnyRoute({ family, baseUrl, identity, settings, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }

    const connection = await openControllerSocket({
      WebSocketImpl,
      url: controllerWebSocketUrl(baseUrl, registered.socketPath, activeProfileOf(settings)),
      protocols: controllerWebSocketProtocols(registered.ticket),
      onFrame,
      onClose,
      timeoutMs: connectTimeoutMs,
    });
    // The route decides the names the model's control tools have (control-tool-names.mjs).
    return { ...connection, route: registered.route };
  }

  async function connectCloud({ settings, identity, onFrame, onClose }) {
    const baseUrl = String(settings?.gatewayUrl || '').trim();
    if (!isTrustedDashboardOrigin(baseUrl, settings?.trustedDashboardOrigin)) {
      throw new Error('Controller Cloud connection requires the explicitly trusted dashboard origin.');
    }
    const tabId = Number(settings?.trustedDashboardTabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw new Error('Controller Cloud connection requires the trusted dashboard tab.');
    }

    const minted = await mintDashboardTicket({
      tabsApi,
      scriptingApi,
      baseUrl,
      tabId,
    });
    if (!minted?.ok) {
      throw new Error(`Could not mint a trusted dashboard ticket (${String(minted?.reason || 'unknown')}).`);
    }

    const client = createGatewayClient({
      WebSocketImpl,
      readyTimeoutMs: connectTimeoutMs,
    });
    let liveSessionId = '';
    const unsubscribeCommand = client.on(CONTROLLER_METHODS.command, (event) => {
      if (!liveSessionId || String(event?.sessionId || '') !== liveSessionId) return;
      Promise.resolve(onFrame?.({
        method: 'event',
        params: {
          type: CONTROLLER_METHODS.command,
          session_id: liveSessionId,
          payload: event?.payload || {},
        },
      })).catch(() => undefined);
    });
    const unsubscribeCancel = client.on(CONTROLLER_METHODS.cancel, (event) => {
      if (!liveSessionId || String(event?.sessionId || '') !== liveSessionId) return;
      Promise.resolve(onFrame?.({
        method: 'event',
        params: {
          type: CONTROLLER_METHODS.cancel,
          session_id: liveSessionId,
          payload: event?.payload || {},
        },
      })).catch(() => undefined);
    });
    const unsubscribeClose = client.on('close', (event) => {
      onClose?.(new Error(`Dashboard controller connection closed (code ${event?.payload?.code ?? '?' }).`));
    });

    try {
      await client.connect(
        buildDashboardWsEndpoint(baseUrl),
        gatewayWebSocketProtocols(minted.ticket),
      );
      const session = await establishGatewaySession({
        client,
        storedSessionId: identity.hermesSessionId,
      });
      liveSessionId = session.liveId;
      const liveIdentity = { ...identity, hermesSessionId: liveSessionId };
      const registration = controllerRegistrationFor({
        family: CONTROLLER_TRANSPORT_FAMILIES.CLOUD_TICKET_WS,
        baseUrl,
        identity: liveIdentity,
      });
      try {
        await client.request(registration.method, registration.params);
      } catch (error) {
        if (isUnknownMethodError(error)) {
          throw unsupportedGatewayError('This Hermes does not support Hermes Control (register method not found).');
        }
        throw error;
      }
    } catch (error) {
      unsubscribeCommand?.();
      unsubscribeCancel?.();
      unsubscribeClose?.();
      client.close();
      throw error;
    }

    return {
      heartbeat() {
        return client.request(CONTROLLER_HEARTBEAT_METHOD, { session_id: liveSessionId });
      },
      async send(frame = {}) {
        const method = String(frame?.method || '').trim();
        if (method !== CONTROLLER_METHODS.result && method !== CONTROLLER_METHODS.cancel) {
          throw new Error(`Unsupported outbound controller method: ${method}`);
        }
        return client.request(method, {
          ...(frame.params && typeof frame.params === 'object' ? frame.params : {}),
          session_id: liveSessionId,
        });
      },
      close() {
        unsubscribeCommand?.();
        unsubscribeCancel?.();
        unsubscribeClose?.();
        client.close();
      },
    };
  }

  async function connect(options = {}) {
    const transport = normalizedTransport(options.settings);
    if (API_TRANSPORTS.has(transport)) return connectApi(options);
    if (CLOUD_TRANSPORTS.has(transport)) return connectCloud(options);
    throw new Error(`Unsupported controller connection transport: ${transport || '(missing)'}`);
  }

  return { connect };
}
