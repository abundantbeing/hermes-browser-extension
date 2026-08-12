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
  sessionStatus: 'session.status',
  promptSubmit: 'prompt.submit',
  sessionInterrupt: 'session.interrupt',
  sessionSteer: 'session.steer',
  modelOptions: 'model.options',
  wakeStart: 'wake.start',
  wakeStop: 'wake.stop',
  wakePause: 'wake.pause',
  wakeResume: 'wake.resume',
  wakeStatus: 'wake.status',
  voiceToggle: 'voice.toggle',
  voiceRecord: 'voice.record',
  voiceTts: 'voice.tts',
  configSet: 'config.set',
});

// Streamed assistant-turn events we care about. Everything else (tool.*,
// reasoning.*, status.*) is surfaced to listeners but not required for chat.
export const WS_EVENTS = Object.freeze({
  ready: 'gateway.ready',
  messageStart: 'message.start',
  messageDelta: 'message.delta',
  messageComplete: 'message.complete',
  wakeDetected: 'wake.detected',
  voiceTranscript: 'voice.transcript',
  voiceStatus: 'voice.status',
  error: 'error',
});

// Gateway sessions have two identities. `session_id` addresses the live
// runtime on the current WebSocket; the stored id survives disconnects and is
// the only safe value to persist or pass to session.resume.
export function remoteSessionIdentity(result = {}, requestedId = '') {
  const liveId = String(result?.session_id || '').trim();
  const storedId = String(
    result?.stored_session_id
    || result?.resumed
    || result?.session_key
    || requestedId
    || liveId
    || '',
  ).trim();
  const profile = String(
    result?.profile
    || result?.profile_name
    || result?.effective_profile
    || result?.session_profile
    || '',
  ).trim();
  return { liveId, storedId, profile };
}

function gatewayHistoryText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(gatewayHistoryText).filter(Boolean).join('');
  if (!value || typeof value !== 'object') return '';
  return gatewayHistoryText(value.text ?? value.output_text ?? value.content ?? '');
}

// The gateway's display projection uses `text`; older dashboard responses and
// the REST session API use `content`. Normalize both before either Browser
// surface filters or persists history so resumed Cloud sessions stay complete.
export function normalizeGatewayHistoryMessages(payload = {}) {
  const rows = Array.isArray(payload)
    ? payload
    : payload?.messages || payload?.data?.messages || payload?.history || payload?.data || [];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((message) => message && typeof message === 'object')
    .map((message) => {
      const candidates = [message.content, message.text, message.context];
      const content = candidates.map(gatewayHistoryText).find(Boolean) || '';
      return {
        ...message,
        role: String(message.role || '').toLowerCase(),
        content,
      };
    })
    .filter((message) => message.role);
}

function comparableGatewayUrl(value = '') {
  try {
    const parsed = new URL(String(value || '').trim());
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function remoteStoredSessionIdForGateway(binding, gatewayUrl = '') {
  const storedSessionId = String(binding?.storedSessionId || '').trim();
  const boundGatewayUrl = comparableGatewayUrl(binding?.gatewayUrl);
  const currentGatewayUrl = comparableGatewayUrl(gatewayUrl);
  if (!storedSessionId || !boundGatewayUrl || boundGatewayUrl !== currentGatewayUrl) return '';
  return storedSessionId;
}

export async function establishGatewaySession({ client, storedSessionId = '', createParams = {} } = {}) {
  if (!client?.request) throw new Error('Hermes gateway client is required.');
  const requestedId = String(storedSessionId || '').trim();
  const action = requestedId ? 'resumed' : 'created';
  const result = requestedId
    ? await client.request(WS_METHODS.sessionResume, { session_id: requestedId })
    : await client.request(WS_METHODS.sessionCreate, createParams);
  const { liveId, storedId, profile } = remoteSessionIdentity(result, requestedId);
  if (!liveId || !storedId) {
    throw new Error(`Dashboard did not return complete ${action === 'resumed' ? 'resume' : 'session'} identity.`);
  }
  return { action, liveId, storedId, profile };
}

export function buildDashboardWsUrl(baseUrl, ticket) {
  return buildDashboardWsUrlWithCredential(baseUrl, 'ticket', ticket);
}

/** Credential-free dashboard Gateway endpoint for subprotocol admission. */
export function buildDashboardWsEndpoint(baseUrl) {
  const parsed = new URL(String(baseUrl || ''));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Dashboard Gateway URL must be credential-free http or https.');
  }
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/ws`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/** One-shot ticket carried only in Sec-WebSocket-Protocol. */
export function gatewayWebSocketProtocols(ticket) {
  const cleanTicket = String(ticket || '').trim();
  if (!cleanTicket) throw new Error('Dashboard WebSocket ticket is required.');
  if (!/^[A-Za-z0-9._~-]+$/.test(cleanTicket)) {
    throw new Error('Dashboard WebSocket ticket contains unsupported characters.');
  }
  return ['hermes-gateway-v1', `hermes-gateway-ticket.${cleanTicket}`];
}

export function buildDashboardWsUrlWithCredential(baseUrl, credentialName, credentialValue) {
  if (credentialName !== 'ticket' && credentialName !== 'token') {
    throw new Error('Dashboard WebSocket credential must be a ticket or token.');
  }
  const parsed = new URL(String(baseUrl || ''));
  const scheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const prefix = parsed.pathname.replace(/\/+$/, '');
  return `${scheme}//${parsed.host}${prefix}/api/ws?${credentialName}=${encodeURIComponent(String(credentialValue || ''))}`;
}

export function buildSessionModelSwitchRequest({ sessionId = '', model = '', provider = '' } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedModel = String(model || '').trim();
  const normalizedProvider = String(provider || '').trim();
  if (!normalizedSessionId) throw new Error('A live Hermes session is required to switch models.');
  if (!normalizedModel) throw new Error('A Hermes model is required to switch models.');
  if (/\s/.test(normalizedModel) || normalizedModel.startsWith('-')) throw new Error('Hermes model identifiers cannot contain command flags or whitespace.');
  if (normalizedProvider && (/\s/.test(normalizedProvider) || normalizedProvider.startsWith('-'))) {
    throw new Error('Hermes provider identifiers cannot contain command flags or whitespace.');
  }
  const providerFlag = normalizedProvider ? ` --provider ${normalizedProvider}` : '';
  return {
    method: WS_METHODS.configSet,
    params: {
      session_id: normalizedSessionId,
      key: 'model',
      value: `${normalizedModel}${providerFlag} --session`,
    },
  };
}

export function runtimeModelFromSessionStatus(output = '') {
  const payload = output && typeof output === 'object' ? output : {};
  const structuredModel = String(payload.model || payload.runtime?.model || '').trim();
  const structuredProvider = String(payload.provider || payload.runtime?.provider || '').trim();
  if (structuredModel || structuredProvider) {
    return {
      model: structuredModel === '(unknown)' ? '' : structuredModel,
      provider: ['unknown', '(unknown)'].includes(structuredProvider) ? '' : structuredProvider,
    };
  }
  const rawText = payload.output ?? payload.text ?? output;
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  const line = String(rawText || '').replace(ansiPattern, '').split(String.fromCharCode(10)).find((entry) => entry.trim().startsWith('Model:')) || '';
  const match = line.trim().match(/^Model:\s*(.+)\s+\(([^()]*)\)\s*$/);
  if (!match) return { model: '', provider: '' };
  const model = String(match[1] || '').trim();
  const provider = String(match[2] || '').trim();
  return {
    model: model === '(unknown)' ? '' : model,
    provider: provider === 'unknown' || provider === '(unknown)' ? '' : provider,
  };
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
export function createGatewayClient({ WebSocketImpl, requestTimeoutMs = 30_000, readyTimeoutMs = 15_000 } = {}) {
  const SocketCtor = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  let socket = null;
  let connectAttempt = null;
  let readyPayload = null;
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
      if (frame.type === WS_EVENTS.ready && connectAttempt) {
        const attempt = connectAttempt;
        connectAttempt = null;
        clearTimeout(attempt.timer);
        readyPayload = frame.payload;
        attempt.resolve(frame.payload);
      }
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

  function connect(url, protocols = undefined) {
    if (!SocketCtor) return Promise.reject(new Error('WebSocket is not available in this context'));
    if (connectAttempt) return Promise.reject(new Error('WebSocket connection already in progress'));
    if (socket?.readyState === 1 && readyPayload) return Promise.resolve(readyPayload);
    return new Promise((resolve, reject) => {
      let opened = false;
      let connectionSocket = null;
      let attempt = null;
      readyPayload = null;
      const timer = setTimeout(() => {
        if (connectAttempt !== attempt) return;
        connectAttempt = null;
        if (socket === connectionSocket) socket = null;
        try {
          connectionSocket?.close();
        } catch {
          /* ignore */
        }
        reject(new Error('Hermes gateway.ready timed out'));
      }, readyTimeoutMs);
      attempt = { resolve, reject, timer };
      connectAttempt = attempt;
      try {
        connectionSocket = protocols === undefined
          ? new SocketCtor(url)
          : new SocketCtor(url, protocols);
        socket = connectionSocket;
      } catch (error) {
        clearTimeout(timer);
        connectAttempt = null;
        reject(error);
        return;
      }
      connectionSocket.addEventListener('open', () => {
        if (socket !== connectionSocket) return;
        opened = true;
      });
      connectionSocket.addEventListener('message', (event) => {
        if (socket !== connectionSocket) return;
        handleFrame(event.data);
      });
      // Defer to 'close' for the rejection so the close code/reason is reported
      // (a pre-accept server rejection surfaces as code 1006 with no frame).
      connectionSocket.addEventListener('error', () => {});
      connectionSocket.addEventListener('close', (event) => {
        if (socket !== connectionSocket) return;
        socket = null;
        readyPayload = null;
        if (connectAttempt) {
          const attempt = connectAttempt;
          connectAttempt = null;
          clearTimeout(attempt.timer);
          const code = event?.code ?? '?';
          const reason = event?.reason ? `: ${event.reason}` : '';
          attempt.reject(new Error(`WebSocket closed before gateway.ready${opened ? '' : ' and open'} (code ${code}${reason})`));
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
    if (connectAttempt) {
      const attempt = connectAttempt;
      connectAttempt = null;
      clearTimeout(attempt.timer);
      attempt.reject(new Error('client closed before gateway.ready'));
    }
    rejectAllPending(new Error('client closed'));
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
    readyPayload = null;
  }

  return {
    connect,
    request,
    on,
    close,
    get readyState() {
      return socket?.readyState ?? -1;
    },
    get readyPayload() {
      return readyPayload;
    },
  };
}
