// JSON-RPC 2.0 over WebSocket client for the Hermes dashboard gateway (/api/ws).
//
// This is the transport the desktop app uses. The browser extension uses it
// only in remote mode against an OAuth-gated dashboard, where the REST/SSE
// api_server surface is unavailable. Auth is a single-use ws-ticket appended to
// the URL; the ticket itself is minted first-party (see the dashboard bridge in
// sidepanel.js) because the dashboard's CORS rejects the extension origin.
//
// The pure helpers (URL building, frame classification) are exported separately
// so they can be unit-tested without a live socket.

export const WS_METHODS = Object.freeze({
  sessionCreate: 'session.create',
  sessionResume: 'session.resume',
  sessionList: 'session.list',
  sessionHistory: 'session.history',
  sessionInfo: 'session.info',
  promptSubmit: 'prompt.submit',
  sessionInterrupt: 'session.interrupt',
  sessionSteer: 'session.steer',
  modelOptions: 'model.options',
});

// Streamed assistant-turn events we care about. Everything else (tool.*,
// reasoning.*, status.*) is surfaced to listeners but not required for chat.
export const WS_EVENTS = Object.freeze({
  ready: 'gateway.ready',
  messageStart: 'message.start',
  messageDelta: 'message.delta',
  messageComplete: 'message.complete',
  error: 'error',
});

export function withGatewayProfile(params = {}, profile = '') {
  const name = String(profile || '').trim();
  return name ? { ...params, profile: name } : { ...params };
}

function normalizedGatewayBase(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function resolveVerifiedGatewayProfile({ selectedProfile = '', profiles = [], verifiedBaseUrl = '', gatewayUrl = '' } = {}) {
  const selected = String(selectedProfile || '').trim();
  if (!selected) return '';
  const currentBase = normalizedGatewayBase(gatewayUrl);
  const verifiedBase = normalizedGatewayBase(verifiedBaseUrl);
  const exists = (profiles || []).some((profile) => String(profile?.name || '').trim() === selected);
  if (!currentBase || currentBase !== verifiedBase || !exists) {
    throw new Error(`Selected Hermes profile "${selected}" is not verified for this dashboard. Refresh profiles or choose Detect from Hermes gateway.`);
  }
  return selected;
}

export function normalizeRemoteSessionBindings(bindings = {}, limit = 100) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return {};
  const rows = Object.entries(bindings)
    .map(([sessionId, binding]) => {
      const id = String(sessionId || '').trim();
      const profile = String(binding?.profile || '').trim();
      const gatewayUrl = normalizedGatewayBase(binding?.gatewayUrl);
      if (!id || !profile || !gatewayUrl) return null;
      return [id, {
        profile,
        gatewayUrl,
        title: String(binding?.title || id),
        source: String(binding?.source || 'hermes_browser'),
        updatedAt: Number(binding?.updatedAt || 0),
      }];
    })
    .filter(Boolean)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, Math.max(1, Number(limit) || 100));
  return Object.fromEntries(rows);
}

export function rememberRemoteSessionBinding(bindings = {}, session = {}, { profile = '', gatewayUrl = '', now = Date.now() } = {}) {
  const normalized = normalizeRemoteSessionBindings(bindings);
  const id = String(session?.id || '').trim();
  const selected = String(profile || '').trim();
  const baseUrl = normalizedGatewayBase(gatewayUrl);
  if (!id) return normalized;
  if (!selected || !baseUrl) {
    delete normalized[id];
    return normalized;
  }
  return normalizeRemoteSessionBindings({
    ...normalized,
    [id]: {
      profile: selected,
      gatewayUrl: baseUrl,
      title: String(session?.title || id),
      source: String(session?.source || 'hermes_browser'),
      updatedAt: Number(now || Date.now()),
    },
  });
}

export function sessionProfileForGateway(session = {}, bindings = {}, gatewayUrl = '') {
  const currentBase = normalizedGatewayBase(gatewayUrl);
  const sessionBase = normalizedGatewayBase(session?.gatewayUrl || session?.gateway_url);
  const direct = String(session?.profile || session?.profile_name || session?.profileName || '').trim();
  if (direct && (!sessionBase || sessionBase === currentBase)) return direct;
  if (direct) return '';
  const id = String(session?.id || '').trim();
  const binding = normalizeRemoteSessionBindings(bindings)[id];
  return binding && binding.gatewayUrl === currentBase ? binding.profile : '';
}

export function mergeRemoteSessionsForProfile({ listedSessions = [], bindings = {}, gatewayUrl = '', selectedProfile = '' } = {}) {
  const selected = String(selectedProfile || '').trim();
  const baseUrl = normalizedGatewayBase(gatewayUrl);
  const merged = new Map();

  if (selected) {
    for (const [id, binding] of Object.entries(normalizeRemoteSessionBindings(bindings))) {
      if (binding.gatewayUrl !== baseUrl || binding.profile !== selected) continue;
      merged.set(id, {
        id,
        title: binding.title || id,
        source: binding.source || 'hermes_browser',
        profile: binding.profile,
        gatewayUrl: binding.gatewayUrl,
        lastActive: binding.updatedAt,
      });
    }
  }

  for (const session of listedSessions || []) {
    if (!session?.id) continue;
    const profile = String(session.profile || '').trim();
    if ((selected && profile !== selected) || (!selected && profile)) continue;
    merged.set(String(session.id), session);
  }

  return [...merged.values()].sort((a, b) => Number(b.lastActive || 0) - Number(a.lastActive || 0));
}

export function buildDashboardWsUrl(baseUrl, ticket) {
  const parsed = new URL(String(baseUrl || ''));
  const scheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const prefix = parsed.pathname.replace(/\/+$/, '');
  return `${scheme}//${parsed.host}${prefix}/api/ws?ticket=${encodeURIComponent(String(ticket || ''))}`;
}

// Classify an inbound frame so callers don't reimplement the JSON-RPC shape.
// Returns one of:
//   { kind: 'response', id, result }        — RPC reply (success)
//   { kind: 'error', id, error }            — RPC reply (failure)
//   { kind: 'event', type, sessionId, payload } — server push (method === 'event')
//   { kind: 'ignore' }                      — unparseable / unrecognized
export function classifyGatewayFrame(raw) {
  let frame;
  try {
    frame = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { kind: 'ignore' };
  }
  if (!frame || typeof frame !== 'object') return { kind: 'ignore' };

  if (frame.id !== undefined && frame.id !== null && frame.method === undefined) {
    if (frame.error) return { kind: 'error', id: frame.id, error: frame.error };
    return { kind: 'response', id: frame.id, result: frame.result };
  }

  if (frame.method === 'event' && frame.params?.type) {
    return {
      kind: 'event',
      type: frame.params.type,
      sessionId: frame.params.session_id || '',
      payload: frame.params.payload || {},
    };
  }

  return { kind: 'ignore' };
}

// Minimal JSON-RPC client over a WebSocket. WebSocketImpl is injectable so the
// client can be unit-tested with a fake socket.
export function createGatewayClient({ WebSocketImpl, requestTimeoutMs = 30_000 } = {}) {
  const SocketCtor = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  let socket = null;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  function emit(type, event) {
    for (const handler of listeners.get(type) || []) {
      try {
        handler(event);
      } catch {
        // A listener throwing must not break frame dispatch.
      }
    }
    for (const handler of listeners.get('*') || []) {
      try {
        handler({ type, ...event });
      } catch {
        /* ignore */
      }
    }
  }

  function handleFrame(raw) {
    const frame = classifyGatewayFrame(raw);
    if (frame.kind === 'response' || frame.kind === 'error') {
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      clearTimeout(call.timer);
      if (frame.kind === 'error') call.reject(new Error(frame.error?.message || 'Gateway RPC failed'));
      else call.resolve(frame.result);
      return;
    }
    if (frame.kind === 'event') {
      emit(frame.type, { type: frame.type, sessionId: frame.sessionId, payload: frame.payload });
    }
  }

  function rejectAllPending(error) {
    for (const [, call] of pending) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  }

  function connect(url) {
    if (!SocketCtor) return Promise.reject(new Error('WebSocket is not available in this context'));
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        socket = new SocketCtor(url);
      } catch (error) {
        reject(error);
        return;
      }
      socket.addEventListener('open', () => {
        settled = true;
        resolve();
      });
      socket.addEventListener('message', (event) => handleFrame(event.data));
      // Defer to 'close' for the rejection so the close code/reason is reported
      // (a pre-accept server rejection surfaces as code 1006 with no frame).
      socket.addEventListener('error', () => {});
      socket.addEventListener('close', (event) => {
        if (!settled) {
          settled = true;
          const code = event?.code ?? '?';
          const reason = event?.reason ? `: ${event.reason}` : '';
          reject(new Error(`WebSocket closed before open (code ${code}${reason})`));
          return;
        }
        rejectAllPending(new Error('WebSocket closed'));
        emit('close', { type: 'close', payload: { code: event?.code, reason: event?.reason } });
      });
    });
  }

  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== 1) {
        reject(new Error('WebSocket is not open'));
        return;
      }
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Gateway RPC ${method} timed out`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type)?.delete(handler);
  }

  function close() {
    rejectAllPending(new Error('client closed'));
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }

  return {
    connect,
    request,
    on,
    close,
    get readyState() {
      return socket?.readyState ?? -1;
    },
  };
}
