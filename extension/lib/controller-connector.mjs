/**
 * Phase 5 controller transport connector
 *
 * Local/VPS: authenticated registration POST, then a dedicated credential-free
 * controller WebSocket whose one-shot ticket is carried only as a subprotocol.
 *
 * Cloud/dashboard: mint a first-party dashboard ticket from the explicitly
 * trusted tab, connect to a credential-free Gateway endpoint with ticket
 * subprotocols, resume the durable session, and register against that exact
 * live transport session.
 */

import {
  CONTROLLER_HEARTBEAT_METHOD,
  CONTROLLER_METHODS,
  CONTROLLER_TRANSPORT_FAMILIES,
  controllerRegistrationFor,
  controllerWebSocketProtocols,
  controllerWebSocketUrl,
} from './controller-protocol.mjs';
import {
  buildDashboardWsEndpoint,
  createGatewayClient,
  establishGatewaySession,
  gatewayWebSocketProtocols,
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

function normalizedTransport(settings = {}) {
  return String(settings?.connectionTransport || '').trim();
}

function apiHeaders(settings = {}) {
  const apiKey = String(settings?.apiKey || '').trim();
  if (!apiKey) throw new Error('Controller API registration requires an API credential.');
  const profile = String(settings?.activeProfile || '').trim();
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
  async function connectApi({ settings, identity, onFrame, onClose }) {
    if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for controller registration.');
    const family = normalizedTransport(settings);
    const baseUrl = String(settings?.gatewayUrl || '').trim();
    const descriptor = controllerRegistrationFor({ family, baseUrl, identity });
    const controller = new AbortController();
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error('Controller registration timed out.');
        controller.abort(error);
        reject(error);
      }, connectTimeoutMs);
    });
    let response;
    let payload;
    try {
      ({ response, payload } = await Promise.race([
        (async () => {
          const registrationResponse = await fetchImpl(descriptor.registrationUrl, {
            method: 'POST',
            headers: apiHeaders(settings),
            body: JSON.stringify(descriptor.payload),
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
          });
          const registrationPayload = await registrationResponse.json().catch(() => ({}));
          return { response: registrationResponse, payload: registrationPayload };
        })(),
        timeout,
      ]));
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
    if (!response.ok) {
      const message = String(payload?.error?.message || payload?.detail || '').trim();
      // The gateway refuses to mint a controller ticket for a session it does
      // not know (browser_control_session_forbidden). Local drafts mint their
      // session id client-side before the first turn materializes it
      // server-side, so recover by creating the session and retrying once.
      // Without this the reconnect loop would spin forever on a ghost id.
      if (payload?.error?.code === 'browser_control_session_forbidden'
        && API_TRANSPORTS.has(family)
        && String(identity?.hermesSessionId || '').trim()) {
        const materialized = await materializeDraftSession({
          fetchImpl,
          baseUrl,
          sessionId: String(identity.hermesSessionId).trim(),
          title: String(settings?.sessionTitle || 'Hermes Browser Extension'),
          source: String(settings?.sessionSource || 'hermes_browser'),
          headers: apiHeaders(settings),
          signal: controller.signal,
        });
        if (materialized) {
          const retryResponse = await fetchImpl(descriptor.registrationUrl, {
            method: 'POST',
            headers: apiHeaders(settings),
            body: JSON.stringify(descriptor.payload),
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
          });
          const retryPayload = await retryResponse.json().catch(() => ({}));
          if (retryResponse.ok) {
            response = retryResponse;
            payload = retryPayload;
          } else {
            const retryMessage = String(retryPayload?.error?.message || retryPayload?.detail || '').trim();
            throw new Error(retryMessage || `Controller registration failed (HTTP ${retryResponse.status}).`);
          }
        } else {
          throw new Error(message || `Controller registration failed (HTTP ${response.status}).`);
        }
      } else {
        throw new Error(message || `Controller registration failed (HTTP ${response.status}).`);
      }
    }
    const ticket = String(payload?.ticket || '').trim();
    if (!ticket) throw new Error('Controller registration did not return a ticket.');

    return openControllerSocket({
      WebSocketImpl,
      url: controllerWebSocketUrl(baseUrl),
      protocols: controllerWebSocketProtocols(ticket),
      onFrame,
      onClose,
      timeoutMs: connectTimeoutMs,
    });
  }

  /**
   * Create the draft session server-side so the controller can register
   * against it. Mirrors the panel's ensureHermesSession() materialization.
   * Returns true when the session now exists (created or already present).
   */
  async function materializeDraftSession({
    fetchImpl,
    baseUrl,
    sessionId,
    title,
    source,
    headers,
    signal,
  }) {
    try {
      const createResponse = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: sessionId, title, source }),
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
      return createResponse.ok || createResponse.status === 409;
    } catch {
      return false;
    }
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
      await client.request(registration.method, registration.params);
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
