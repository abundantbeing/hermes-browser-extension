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

import { extractHistoryMediaAttachments } from './image-render.mjs';

export const WS_METHODS = Object.freeze({
  sessionCreate: 'session.create',
  sessionResume: 'session.resume',
  sessionDetach: 'session.detach',
  sessionList: 'session.list',
  sessionHistory: 'session.history',
  sessionInfo: 'session.info',
  sessionStatus: 'session.status',
  // Rename / read the session title. Desktop parity: this is the write path
  // that resolves the LIVE runtime session (and persists its row on demand),
  // so it succeeds for runtime-only sessions where a REST PATCH 404s. Read
  // mode (no `title` param) returns the current title.
  sessionTitle: 'session.title',
  sessionEventsSince: 'session.events.since',
  sessionEventsStats: 'session.events.stats',
  profilesList: 'profiles.list',
  profilesDescribe: 'profiles.describe',
  profilesGetAsset: 'profiles.get_asset',
  profilesCreate: 'profiles.create',
  profilesConfigure: 'profiles.configure',
  profilesSetAsset: 'profiles.set_asset',
  promptSubmit: 'prompt.submit',
  sessionInterrupt: 'session.interrupt',
  sessionCompress: 'session.compress',
  // Live sessions in this process with their run state; the one session read a
  // session-authority gateway still serves (it answers -32601 to session.status).
  sessionActiveList: 'session.active_list',
  sessionSteer: 'session.steer',
  promptBtw: 'prompt.btw',
  contextBreakdown: 'session.context_breakdown',
  // Live usage snapshot: context occupancy, compressions, cache hits. The same
  // payload the gateway pushes as the `session.usage` event while a turn runs.
  sessionUsage: 'session.usage',
  sessionStats: 'session.stats',
  imageAttachBytes: 'image.attach_bytes',
  subagentList: 'subagent.list',
  subagentSteer: 'subagent.steer',
  subagentInterrupt: 'subagent.interrupt',
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
  // Liveness probe. The gateway answers it on its read loop, and only when its
  // gateway.ready advertised heartbeat: true.
  gatewayPing: 'gateway.ping',
  // Says once per connection that this client answers server-to-client requests
  // (approval, clarify). Until it is sent the gateway fails those requests fast
  // for this connection instead of waiting for an answer that cannot come.
  clientCapabilities: 'client.capabilities',
  // Authority gateways take the answer to a pending prompt as a generation-fenced
  // method call, not as the reply to a server request.
  approvalRespond: 'approval.respond',
  clarifyRespond: 'clarify.respond',
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
  // The gateway withdrew a server request: it timed out, was answered from
  // another surface, or the turn was interrupted.
  requestCancel: 'request.cancel',
  error: 'error',
});

// Events a session-authority gateway raises for a prompt, plus the two that end
// a turn (and with it every prompt the turn was waiting on).
const PROMPT_EVENT_TYPES = Object.freeze([
  'approval.request',
  'approval.settled',
  'clarify.request',
  'clarify.settled',
  WS_EVENTS.messageComplete,
  WS_EVENTS.error,
]);

// Server-to-client requests that belong to a desktop window (preview, terminal,
// tour). A client with no such window declines them with this code so the agent
// is told at once instead of waiting out the deadline.
export const NOT_SHOWN_CODE = 4404;
const WINDOW_OWNED_REQUESTS = new Set(['terminal.read', 'preview.read', 'window.read', 'preview.act', 'tour']);

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
    || result?.info?.profile_name
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
      const attachments = extractHistoryMediaAttachments(message);
      return {
        ...message,
        role: String(message.role || '').toLowerCase(),
        content,
        ...(attachments.length ? { attachments } : {}),
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

// A session-authority gateway (Hermes Web, Cloud, an account-signed gateway) takes session.create on its
// canonical contract (tui_gateway/contracts/canonical_sessions.py CanonicalCreateParams: a closed key set,
// the same mapping Desktop's prepareCreate applies). The source is a surface name, effort travels as
// `reasoning`, the fast toggle as `service_tier`, and a request id makes a retried create return the same
// session. Any other key or source is refused as invalid_params. A legacy dashboard socket keeps the wider
// legacy keys.
const CANONICAL_CREATE_KEYS = Object.freeze([
  'request_id', 'source', 'cwd', 'model', 'provider', 'toolsets', 'reasoning', 'profile', 'title', 'hidden',
  'follow_profile_config', 'service_tier', 'cwd_explicit',
]);

function newCreateRequestId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // Fall through to the time-based id.
  }
  return `hbe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function buildCanonicalSessionCreateParams(input = {}) {
  const { reasoning_effort: effort, fast, service_tier: pickedTier, ...rest } = input && typeof input === 'object' ? input : {};
  const params = { ...rest };
  let tier = '';
  if (typeof pickedTier === 'string' && pickedTier) tier = pickedTier;
  else if (fast === true) tier = 'priority';
  else if (fast === false) tier = 'normal';
  if (typeof effort === 'string' && effort) params.reasoning = effort;
  if (tier) params.service_tier = tier;
  if (typeof params.cwd_explicit !== 'boolean') delete params.cwd_explicit;
  if (params.follow_profile_config !== true) delete params.follow_profile_config;
  if (params.hidden !== true) delete params.hidden;
  const out = {};
  for (const key of CANONICAL_CREATE_KEYS) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  out.request_id = typeof params.request_id === 'string' && params.request_id ? params.request_id : newCreateRequestId();
  out.source = 'gui';
  return out;
}

/** The session.create params this socket accepts: canonical on a session authority, unchanged otherwise. */
export function sessionCreateParamsFor(client, params = {}) {
  return client?.readyPayload?.session_authority === true ? buildCanonicalSessionCreateParams(params) : params;
}

export async function establishGatewaySession({ client, storedSessionId = '', createParams = {}, profile = '' } = {}) {
  if (!client?.request) throw new Error('Hermes gateway client is required.');
  const requestedId = String(storedSessionId || '').trim();
  const requestedProfile = String(profile || createParams?.profile || '').trim();
  const action = requestedId ? 'resumed' : 'created';
  const result = requestedId
    ? await client.request(WS_METHODS.sessionResume, {
        session_id: requestedId,
        ...(requestedProfile ? { profile: requestedProfile } : {}),
      })
    // A session authority's canonical session.create has a closed key set (reasoning, not
    // reasoning_effort; service_tier, not fast) and refuses anything else with invalid_params.
    : await client.request(WS_METHODS.sessionCreate, sessionCreateParamsFor(client, {
        ...createParams,
        ...(requestedProfile ? { profile: requestedProfile } : {}),
      }));
  const { liveId, storedId, profile: acknowledgedProfile } = remoteSessionIdentity(result, requestedId);
  // Requests still waiting on this session when it was resumed (the frame went
  // to a connection that was gone) are handed over as if they had just arrived.
  if (requestedId && Array.isArray(result?.open_requests)) client.deliverOpenRequests?.(result.open_requests);
  if (!liveId || !storedId) {
    throw new Error(`Dashboard did not return complete ${action === 'resumed' ? 'resume' : 'session'} identity.`);
  }
  if (requestedProfile && acknowledgedProfile !== requestedProfile) {
    throw new Error(`Hermes profile acknowledgement mismatch: requested ${requestedProfile}, received ${acknowledgedProfile || 'none'}.`);
  }
  // A session authority lists the approvals and questions still waiting on the
  // session in its snapshot; they are the same prompts its events announce.
  if (Array.isArray(result?.prompts) && result.prompts.length) client.deliverPrompts?.(result.prompts, liveId);
  return { action, liveId, storedId, profile: acknowledgedProfile };
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

/**
 * Connect with a one-shot dashboard ticket. The ticket goes in
 * Sec-WebSocket-Protocol so it never lands in a URL (proxy and access logs
 * record request targets). A dashboard that predates ticket subprotocol
 * admission refuses the handshake before it opens, and the query-string
 * ticket the older dashboards read is tried instead.
 *
 * A current dashboard spends the ticket before it checks the request's host and
 * origin, so a handshake refused after that point leaves the first ticket used
 * up and looks, from here, exactly like the old dashboard's refusal. Pass
 * `refreshTicket` (an async function returning a fresh ticket, or '') so the
 * retry never offers a ticket that may already be spent. Without it the same
 * ticket is retried, as before.
 */
export async function connectGatewayWithTicket(client, baseUrl, ticket, { refreshTicket = null } = {}) {
  try {
    return await client.connect(buildDashboardWsEndpoint(baseUrl), gatewayWebSocketProtocols(ticket));
  } catch (error) {
    if (!/WebSocket closed before gateway\.ready and open\b/.test(String(error?.message || ''))) throw error;
    let fallbackTicket = ticket;
    if (typeof refreshTicket === 'function') {
      let fresh = '';
      try {
        fresh = String((await refreshTicket()) || '').trim();
      } catch {
        fresh = '';
      }
      // No fresh ticket: report the handshake failure itself rather than
      // presenting a ticket the dashboard has probably consumed.
      if (!fresh) throw error;
      fallbackTicket = fresh;
    }
    return client.connect(buildDashboardWsUrl(baseUrl, fallbackTicket));
  }
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

// Upstream SessionListParams (extra=forbid) accepts only profile, title, limit
// and include_hidden. Sending anything else (e.g. `offset`) fails the call with
// a 4000 invalid-params error, so keep this the single place that builds them.
export function buildSessionListParams({ limit = 200, profile = '' } = {}) {
  return { limit, profile: String(profile || '') };
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

// Stop fencing. Authority-attached gateways require `execution_generation` on
// session.interrupt and answer `stale_generation` when it no longer matches.
// session.resume is the canonical read of the current generation (it returns
// the live snapshot); `omit_messages` keeps that read cheap. Gateways without a
// session authority ignore the fence, so nothing is read from them.
function integerGeneration(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function executionGenerationFrom(payload = null) {
  if (!payload || typeof payload !== 'object') return null;
  for (const candidate of [
    payload.execution_generation,
    payload.handle?.execution_generation,
    payload.session?.execution_generation,
    payload.data?.execution_generation,
  ]) {
    const generation = integerGeneration(candidate);
    if (generation !== null) return generation;
  }
  return null;
}

function gatewayErrorReason(error) {
  return String(error?.data?.reason || error?.message || '').trim().toLowerCase();
}

export function isStaleGenerationError(error) {
  return gatewayErrorReason(error) === 'stale_generation';
}

export function isInvalidParamsError(error) {
  const reason = gatewayErrorReason(error);
  if (reason === 'invalid_params' || reason === 'invalid params') return true;
  return [4000, -32602].includes(Number(error?.rpcCode ?? error?.code))
    && /invalid[ _-]?param/i.test(String(error?.message || ''));
}

export async function readSessionExecutionGeneration(client, sessionId, { storedSessionId = '' } = {}) {
  const target = String(sessionId || '').trim();
  if (!client?.request || !target) return null;
  try {
    const status = await client.request(WS_METHODS.sessionStatus, { session_id: target });
    const generation = executionGenerationFrom(status);
    if (generation !== null) return generation;
  } catch {
    // Fall through to the authority snapshot.
  }
  if (client.readyPayload?.session_authority !== true) return null;
  try {
    const snapshot = await client.request(WS_METHODS.sessionResume, {
      session_id: String(storedSessionId || target).trim(),
      omit_messages: true,
    });
    return executionGenerationFrom(snapshot);
  } catch {
    return null;
  }
}

/**
 * Interrupt a gateway session, fenced by an execution generation.
 *
 * `expectedGeneration` is the generation of the run the person chose to stop, recorded when that
 * run was admitted. It is sent as is, with no read of the current generation first. A gateway that
 * refuses it as `stale_generation` is saying that run already ended (a newer run may be live): the
 * result is `{ ended: true }`, nothing was interrupted, and it is never retried onto the newer run.
 *
 * Without it the generation is unknown. The current one is read just before sending (and re-read
 * once on `stale_generation`), which only protects the read-to-send window: that Stop is
 * best-effort (`bestEffort: true`) and may land on a newer run.
 *
 * A gateway that rejects the params falls back to `restFallback` (REST stop by run id) when one is
 * supplied. Anything else throws so the caller keeps the run in its unconfirmed state.
 */
export async function interruptGatewaySession({
  client,
  sessionId,
  storedSessionId = '',
  expectedGeneration = null,
  withTimeout = (operation) => operation(),
  restFallback = null,
} = {}) {
  const target = String(sessionId || '').trim();
  if (!client?.request || !target) throw new Error('A live Hermes session is required to interrupt it.');
  // The reads that come before Stop is sent are bounded like Stop itself: a
  // gateway that does not answer them must not delay the interrupt by the
  // client's whole request timeout. An unreadable generation is sent as unknown.
  const read = async () => {
    try {
      return await withTimeout(() => readSessionExecutionGeneration(client, target, { storedSessionId }));
    } catch {
      return null;
    }
  };
  const send = (generation) => withTimeout(() => client.request(WS_METHODS.sessionInterrupt, {
    session_id: target,
    ...(generation === null ? {} : { execution_generation: generation }),
  }));
  const fallBack = async (error) => {
    if (typeof restFallback !== 'function') throw error;
    return { via: 'rest', generation: null, retried: false, result: await restFallback() };
  };
  const known = integerGeneration(expectedGeneration);
  if (known !== null) {
    try {
      return { via: 'ws', generation: known, retried: false, bestEffort: false, ended: false, result: await send(known) };
    } catch (error) {
      if (isStaleGenerationError(error)) return { via: 'ws', generation: known, retried: false, bestEffort: false, ended: true, result: null };
      if (isInvalidParamsError(error)) return fallBack(error);
      throw error;
    }
  }
  let generation = await read();
  try {
    return { via: 'ws', generation, retried: false, bestEffort: true, result: await send(generation) };
  } catch (error) {
    if (isInvalidParamsError(error)) return fallBack(error);
    if (!isStaleGenerationError(error)) throw error;
    const fresh = (await read()) ?? integerGeneration(error?.data?.execution_generation);
    if (fresh === null) throw error;
    generation = fresh;
    try {
      return { via: 'ws', generation, retried: true, bestEffort: true, result: await send(generation) };
    } catch (retryError) {
      if (isInvalidParamsError(retryError)) return fallBack(retryError);
      throw retryError;
    }
  }
}

export function buildSessionCompressParams({ sessionId = '', focusTopic = '' } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) throw new Error('A live Hermes session is required to compact context.');
  const focus = String(focusTopic || '').trim();
  return { session_id: normalizedSessionId, ...(focus ? { focus_topic: focus } : {}) };
}

// session.compress answers `compressed: false` when another compressor holds
// the lock, `aborted` when the summary failed, and `pending` when a compute
// host will finish later. Only a real compaction counts as done.
export function normalizeSessionCompressResult(result = null) {
  const payload = result && typeof result === 'object' ? result : {};
  const status = String(payload.status || '').trim().toLowerCase();
  const detail = String(payload.summary?.headline || payload.message || '').trim();
  if (payload.compressed === false || payload.lock_held === true) return { ok: false, reason: 'busy', detail, payload };
  if (status === 'pending') return { ok: false, reason: 'pending', detail, payload };
  if (status === 'aborted' || payload.summary?.aborted === true) return { ok: false, reason: 'aborted', detail, payload };
  return { ok: true, noop: payload.summary?.noop === true, detail, payload };
}

export function isUnknownMethodError(error) {
  return Number(error?.rpcCode ?? error?.code) === -32601
    || String(error?.data?.reason || '').toLowerCase() === 'unknown_method';
}

/**
 * Read whether a live session is still running. `session.status` answers with
 * rendered text ("Agent Running: Yes"); a session authority does not serve it at
 * all (-32601), so there its `session.active_list` row carries the run state
 * (idle | starting | working | waiting), and a session that list leaves out is
 * read from the resume snapshot. Anything unreadable throws, so a caller waiting
 * for Stop to land keeps the run held instead of assuming it ended.
 */
// Session-authority sockets that answered -32601 to session.status: it is not asked again on them
// (an attached view reads the status on every roster poll).
const statusNotServedClients = new WeakSet();

export async function readGatewaySessionStatus(client, sessionId, { storedSessionId = '' } = {}) {
  const target = String(sessionId || '').trim();
  if (!client?.request || !target) throw new Error('A live Hermes session is required to read its status.');
  const authority = client.readyPayload?.session_authority === true;
  if (!(authority && statusNotServedClients.has(client))) {
    try {
      return await client.request(WS_METHODS.sessionStatus, { session_id: target });
    } catch (error) {
      if (!authority || !isUnknownMethodError(error)) throw error;
      statusNotServedClients.add(client);
    }
  }
  const stored = String(storedSessionId || target).trim();
  const listed = await client.request(WS_METHODS.sessionActiveList, { current_session_id: stored });
  const row = (Array.isArray(listed?.sessions) ? listed.sessions : [])
    .find((item) => item && [item.id, item.session_key].some((id) => id === target || id === stored));
  if (row) {
    const state = String(row.status || '').trim().toLowerCase();
    return { status: state === 'idle' ? 'idle' : 'running', source: WS_METHODS.sessionActiveList };
  }
  const snapshot = await client.request(WS_METHODS.sessionResume, { session_id: stored, omit_messages: true });
  const state = String(snapshot?.execution_state || '').trim().toLowerCase();
  const idle = snapshot?.running === false && (!state || state === 'idle' || state === 'terminal');
  return { status: idle ? 'idle' : 'running', source: WS_METHODS.sessionResume };
}

// Classify an inbound frame so callers don't reimplement the JSON-RPC shape.
// Returns one of:
//   { kind: 'response', id, result }        — RPC reply (success)
//   { kind: 'error', id, error }            — RPC reply (failure)
//   { kind: 'event', type, sessionId, payload } — server push (method === 'event')
//   { kind: 'server-request', id, method, sessionId, params }
//                                           — the gateway asks the client a question
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
      ...(typeof frame.params.seq === 'number' && Number.isFinite(frame.params.seq) ? { seq: frame.params.seq } : {}),
      payload: frame.params.payload || {},
    };
  }

  if (frame.id !== undefined && frame.id !== null && typeof frame.method === 'string' && frame.method !== 'event') {
    const params = frame.params && typeof frame.params === 'object' && !Array.isArray(frame.params) ? frame.params : {};
    return {
      kind: 'server-request',
      id: frame.id,
      method: frame.method,
      sessionId: String(params.session_id || ''),
      params,
    };
  }

  return { kind: 'ignore' };
}

// A socket with no close event (a half-open link, a sleeping laptop) is only
// noticed by asking. Once the gateway advertises heartbeat, the client pings
// every interval and drops a socket that stays silent past the deadline, so the
// caller's close handling takes over instead of waiting on a dead connection.
export const GATEWAY_HEARTBEAT_INTERVAL_MS = 30_000;
export const GATEWAY_HEARTBEAT_DEADLINE_MS = 45_000;

// Minimal JSON-RPC client over a WebSocket. WebSocketImpl is injectable so the
// client can be unit-tested with a fake socket.
//
// serverRequests opts a connection into answering the gateway's questions:
//   { handle(request, controls) => boolean, cancel(payload) }
// handle receives {id, method, params} and controls {reply, replyError, client}
// and returns true when it owns the request (it answers later through
// controls). Anything it does not own is declined here. The connection says
// client.capabilities {server_requests: true} only when a handler is given, so
// a client with no card to show never receives a question it cannot answer.
//
// A session-authority gateway announces the same prompts as events
// (approval.request, clarify.request and their .settled partners) and lists the
// open ones in the resume snapshot, so the handler may also carry
//   event(type, event, client)           each prompt event, and the end of a turn
//   prompts(list, {sessionId, client})   the snapshot's open prompts
//   closed(client)                       this connection is gone, however it ended
export function createGatewayClient({
  WebSocketImpl,
  requestTimeoutMs = 30_000,
  readyTimeoutMs = 15_000,
  serverRequests = null,
  heartbeatIntervalMs = GATEWAY_HEARTBEAT_INTERVAL_MS,
  heartbeatDeadlineMs = GATEWAY_HEARTBEAT_DEADLINE_MS,
  // Optional {load() -> {epoch, watermarks}, save({epoch, watermarks})}: replay state that outlives this
  // client (the panel builds a new client for every reconnect). Without it nothing changes.
  replayStore = null,
} = {}) {
  const SocketCtor = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const serverRequestHandler = typeof serverRequests?.handle === 'function' ? serverRequests : null;
  let declinesNotShown = false;
  let socket = null;
  let connectAttempt = null;
  let readyPayload = null;
  let heartbeatTimer = null;
  let heartbeatInFlight = false;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const lastSeenSeq = new Map();
  let replayEpoch = '';
  let replayInFlight = false;
  let replayHold = null;
  // Marks a previous client left behind are only believed once this gateway's epoch is known to match.
  let seededFromStore = false;
  const WATERMARK_CAP = replayStore ? 64 : Number.POSITIVE_INFINITY;

  function persistReplay() {
    if (!replayStore?.save) return;
    try {
      replayStore.save({ epoch: replayEpoch, watermarks: Object.fromEntries(lastSeenSeq) });
    } catch {
      /* the store is a convenience; replay still works from memory */
    }
  }

  function markSeen(sessionId, seq) {
    lastSeenSeq.delete(sessionId);
    lastSeenSeq.set(sessionId, seq);
    while (lastSeenSeq.size > WATERMARK_CAP) lastSeenSeq.delete(lastSeenSeq.keys().next().value);
  }

  const seed = replayStore?.load?.();
  if (seed?.epoch && seed.watermarks && typeof seed.watermarks === 'object') {
    for (const [sessionId, seq] of Object.entries(seed.watermarks)) {
      const number = Number(seq);
      if (sessionId && Number.isFinite(number) && number > 0) markSeen(sessionId, Math.floor(number));
    }
    if (lastSeenSeq.size) {
      replayEpoch = String(seed.epoch);
      seededFromStore = true;
    }
  }

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

  function sendFrame(frame) {
    if (!socket || socket.readyState !== 1) throw new Error('WebSocket is not open');
    socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }));
  }

  function advertiseServerRequests() {
    request(WS_METHODS.clientCapabilities, { server_requests: true })
      .then((result) => { declinesNotShown = result?.declines_not_shown === true; })
      .catch(() => {
        // A gateway that predates the call never sends server requests either.
      });
  }

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function heartbeatOnce() {
    if (heartbeatInFlight) return;
    if (!socket || socket.readyState !== 1 || !readyPayload) {
      stopHeartbeat();
      return;
    }
    heartbeatInFlight = true;
    const probed = socket;
    try {
      await request(WS_METHODS.gatewayPing, {}, { timeoutMs: heartbeatDeadlineMs });
    } catch {
      // No answer inside the deadline: this link is no longer carrying traffic.
      // Close it so the caller's close handling reconnects or reports it.
      stopHeartbeat();
      if (socket === probed) {
        try {
          probed.close();
        } catch {
          /* already closing */
        }
      }
    } finally {
      heartbeatInFlight = false;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    if (!(heartbeatIntervalMs > 0)) return;
    heartbeatTimer = setInterval(() => { void heartbeatOnce(); }, heartbeatIntervalMs);
    heartbeatTimer?.unref?.();
  }

  function declineServerRequest(frame, controls) {
    try {
      if (WINDOW_OWNED_REQUESTS.has(frame.method) && declinesNotShown) {
        controls.replyError(NOT_SHOWN_CODE, 'No window here shows this session');
      } else {
        controls.replyError(-32601, `Method not found: ${frame.method}`);
      }
    } catch {
      // The socket closed first; the gateway withdraws the request itself.
    }
  }

  function dispatchServerRequest(frame) {
    const controls = {
      reply: (result) => sendFrame({ id: frame.id, result: result ?? {} }),
      replyError: (code, message) => sendFrame({ id: frame.id, error: { code, message } }),
      client: api,
    };
    if (!serverRequestHandler) {
      declineServerRequest(frame, controls);
      return;
    }
    let owned = false;
    try {
      owned = serverRequestHandler.handle({ id: frame.id, method: frame.method, params: frame.params }, controls) === true;
    } catch {
      try {
        controls.replyError(-32603, 'Internal error');
      } catch {
        /* ignore */
      }
      return;
    }
    if (!owned) declineServerRequest(frame, controls);
  }

  function handleFrame(raw) {
    const frame = classifyGatewayFrame(raw);
    if (frame.kind === 'server-request') {
      dispatchServerRequest(frame);
      return;
    }
    if (frame.kind === 'response' || frame.kind === 'error') {
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      clearTimeout(call.timer);
      if (frame.kind === 'error') {
        const error = new Error(frame.error?.message || 'Gateway RPC failed');
        const rpcCode = Number.isFinite(Number(frame.error?.code)) ? Number(frame.error.code) : frame.error?.code;
        if (rpcCode !== undefined && rpcCode !== null) {
          error.code = rpcCode;
          error.rpcCode = rpcCode;
        }
        if (frame.error?.data !== undefined) error.data = frame.error.data;
        call.reject(error);
      } else call.resolve(frame.result);
      return;
    }
    if (frame.kind === 'event') {
      if (frame.type === WS_EVENTS.ready && connectAttempt) {
        const attempt = connectAttempt;
        connectAttempt = null;
        clearTimeout(attempt.timer);
        readyPayload = frame.payload;
        const readyEpoch = String(frame.payload?.replay_epoch || '');
        // A gateway that names no epoch cannot vouch for marks left by an earlier client.
        if (seededFromStore && !readyEpoch) {
          lastSeenSeq.clear();
          replayEpoch = '';
        }
        seededFromStore = false;
        adoptReplayEpoch(readyEpoch);
        persistReplay();
        // Sent before the connect promise settles, so it precedes every request
        // the caller makes next on this socket.
        if (serverRequestHandler) advertiseServerRequests();
        // Older gateways do not answer gateway.ping, so only a gateway that
        // advertises heartbeat is probed.
        if (frame.payload?.heartbeat === true) startHeartbeat();
        else stopHeartbeat();
        attempt.resolve(frame.payload);
        queueMicrotask(() => { void fetchReplay(); });
      }
      const event = { type: frame.type, sessionId: frame.sessionId, seq: frame.seq, payload: frame.payload };
      if (replayHold?.has(frame.sessionId) && Number.isFinite(frame.seq)) {
        replayHold.get(frame.sessionId).push(event);
        return;
      }
      dispatchIfNewer(event);
    }
  }

  function adoptReplayEpoch(epoch = '') {
    if (!epoch || replayEpoch === epoch) return;
    if (replayEpoch) lastSeenSeq.clear();
    replayEpoch = epoch;
    persistReplay();
  }

  function dispatchIfNewer(event = {}) {
    const sessionId = String(event.sessionId || event.session_id || '');
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : Number.NaN;
    if (sessionId && Number.isFinite(seq)) {
      const previous = lastSeenSeq.get(sessionId) || 0;
      if (seq <= previous) return;
      if (replayStore) markSeen(sessionId, seq);
      else lastSeenSeq.set(sessionId, seq);
      persistReplay();
    }
    emit(event.type, {
      type: event.type,
      sessionId,
      seq: Number.isFinite(seq) ? seq : null,
      payload: event.payload || {},
    });
  }

  async function fetchReplay() {
    if (replayInFlight || !lastSeenSeq.size || !socket || socket.readyState !== 1) return;
    replayInFlight = true;
    replayHold = new Map([...lastSeenSeq.keys()].map((sessionId) => [sessionId, []]));
    try {
      const watermarks = [...lastSeenSeq.entries()];
      const results = await Promise.allSettled(watermarks.map(([sessionId, lastSeen]) => (
        request(WS_METHODS.sessionEventsSince, { session_id: sessionId, last_seen: lastSeen })
          .then((result) => ({ sessionId, result }))
      )));
      for (const settled of results) {
        if (settled.status !== 'fulfilled') continue;
        const { sessionId, result } = settled.value;
        const epoch = String(result?.epoch || '');
        if (epoch && replayEpoch && epoch !== replayEpoch) {
          adoptReplayEpoch(epoch);
          continue;
        }
        if (Array.isArray(result?.open_requests)) deliverOpenRequests(result.open_requests);
        for (const event of Array.isArray(result?.events) ? result.events : []) {
          if (!event?.type) continue;
          dispatchIfNewer({
            type: event.type,
            sessionId: event.session_id || sessionId,
            seq: event.seq,
            payload: event.payload || {},
          });
        }
        if (result?.truncated === true) {
          // The owner reloads history for the hole, so the mark moves past it: the next reconnect does
          // not report the same hole again.
          const latest = Number(result?.latest_seq);
          if (replayStore && Number.isFinite(latest) && latest > (lastSeenSeq.get(sessionId) || 0)) {
            markSeen(sessionId, Math.floor(latest));
            persistReplay();
          }
          emit('session.replay.truncated', {
            type: 'session.replay.truncated',
            sessionId,
            payload: { latestSeq: Number(result?.latest_seq || 0), epoch },
          });
        }
      }
    } finally {
      const held = replayHold;
      replayHold = null;
      for (const events of held?.values() || []) {
        for (const event of events) dispatchIfNewer(event);
      }
      replayInFlight = false;
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
      stopHeartbeat();
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
        stopHeartbeat();
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
        notifyClosed();
      });
    });
  }

  function request(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
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
      }, timeoutMs);
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

  // Requests the gateway still has open for a resumed session. They are handed
  // to the handler exactly like a live frame; it keys them by id, so a request
  // seen twice is one request.
  function deliverOpenRequests(requests) {
    if (!serverRequestHandler) return;
    for (const item of Array.isArray(requests) ? requests : []) {
      if (!item || typeof item.method !== 'string' || item.id === undefined || item.id === null) continue;
      dispatchServerRequest({
        id: item.id,
        method: item.method,
        sessionId: String(item.params?.session_id || ''),
        params: item.params && typeof item.params === 'object' ? item.params : {},
      });
    }
  }

  // The prompts a session authority lists as open for a session (its resume
  // snapshot), handed over like the events that announced them.
  function deliverPrompts(prompts, sessionId = '') {
    if (typeof serverRequests?.prompts !== 'function') return;
    try {
      serverRequests.prompts(Array.isArray(prompts) ? prompts : [], { sessionId: String(sessionId || ''), client: api });
    } catch {
      // A card that cannot be built must not break the session resume.
    }
  }

  // Whatever this connection carried is withdrawn when it ends, whether the
  // socket dropped or the owner closed it: the browser's own close() raises no
  // socket-close event, and a card left behind could never be answered.
  function notifyClosed() {
    if (typeof serverRequests?.closed !== 'function') return;
    try {
      serverRequests.closed(api);
    } catch {
      /* ignore */
    }
  }

  function close() {
    const hadSocket = Boolean(socket);
    stopHeartbeat();
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
    // A socket that already dropped told the owner when it did.
    if (hadSocket) notifyClosed();
  }

  const api = {
    connect,
    request,
    on,
    close,
    deliverOpenRequests,
    deliverPrompts,
    getSeqWatermarks() {
      return Object.fromEntries(lastSeenSeq);
    },
    get readyState() {
      return socket?.readyState ?? -1;
    },
    get readyPayload() {
      return readyPayload;
    },
  };
  if (typeof serverRequestHandler?.cancel === 'function') {
    on(WS_EVENTS.requestCancel, (event) => serverRequestHandler.cancel(event.payload || {}));
  }
  if (typeof serverRequests?.event === 'function') {
    for (const type of PROMPT_EVENT_TYPES) {
      on(type, (event) => serverRequests.event(type, event, api));
    }
  }
  return api;
}
