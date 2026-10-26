import { DEFAULT_SETTINGS, normalizeGatewayMode, normalizeGatewayUrl } from './common.mjs';
import { buildBrowserContextReceipt } from './browser-context-protocol.mjs';
import {
  CAPABILITY_SOURCES,
  CAPABILITY_STATES,
  capabilityRowStatus,
  createCapabilityRecord,
  effectiveCapability,
} from './capability-status.mjs';
import { COMPANION_ROUTE_CAPABILITIES, companionRecordFields, companionRouteRecordFields, isCompanionReasonCode } from './companion-plugin-status.mjs';
import { gatewayAuthorityAvailability } from './projects-client.mjs';

const WARNING_CAPABILITY_COPY = Object.freeze({
  profiles: 'Profile API unavailable — using the currently running Hermes profile.',
  audioTranscription: 'Audio transcription unavailable — voice uses browser speech fallback when available.',
  browserPairing: 'Automatic browser pairing unavailable — manual Gateway URL/token setup required.',
  imageUpload: 'Image upload unavailable — pasted images stay inline only.',
});

const DEFAULT_ENDPOINTS = Object.freeze({});

export const BROWSER_CAPABILITY_FLAGS = Object.freeze({
  browserContextProvider: 'browser_context_provider',
  browserContextUpload: 'browser_context_upload',
  browserContextStatus: 'browser_context_status',
  browserCompanionPlugin: 'browser_companion_plugin',
  pluginActions: 'plugin_actions',
  approvalEvents: 'approval_events',
  browserControl: 'browser_control',
});

export const DEFAULT_GATEWAY_CAPABILITIES = Object.freeze({
  source: 'unknown',
  platform: '',
  health: false,
  auth: false,
  models: false,
  sessions: false,
  sessionChat: false,
  sessionChatStreaming: false,
  chatCompletions: false,
  chatCompletionsStreaming: false,
  skills: false,
  profiles: false,
  runs: false,
  runStatus: false,
  runEvents: false,
  runStop: false,
  runSteer: false,
  // POST /v1/runs/{id}/approval and /clarify: the browser can answer a prompt
  // the run raised. Without them an approval card is informational only.
  runApproval: false,
  runClarify: false,
  sessionModelLock: false,
  // Native asynchronous user input (hermes-agent #103136): the gateway advertises
  // features.session_user_input, or both its pending-replay and answer endpoints.
  // A dashboard socket has no advertisement, so this stays false there; the panel
  // then acts only on a request event it actually receives.
  sessionUserInput: false,
  sessionContext: false,
  sessionCompress: false,
  // Manual compaction as session.mutate operation=compress: a dashboard
  // WebSocket whose gateway.ready carries session_authority serves it. The
  // legacy `sessionCompress` flag keeps meaning "a REST /compress route or the
  // legacy WS session.compress exists" and stays false on an authority gateway.
  sessionCompactCanonical: false,
  // gateway.ready carried session_authority: true on the dashboard WebSocket.
  sessionAuthority: false,
  audioTranscription: false,
  // GET /api/media: stored IMAGE read only (data URLs). Not video, not upload.
  mediaRead: false,
  browserPairing: false,
  // An HTTP image-upload route the gateway advertises. The dashboard WebSocket
  // has its own session-scoped image.attach_bytes RPC; see imageSessionAttach.
  imageUpload: false,
  imageSessionAttach: false,
  // What the gateway SAYS about hermes.browser.context.v1: true or false when it
  // advertises browser_context_provider, null when it says nothing (Hermes 0.22.5
  // does not). null is not "off": the extension builds those payloads itself and
  // sends them inline in the prompt, which the capability record states as an
  // extension-side fact. browserContextUpload says whether the gateway has a
  // side-channel for them.
  browserContextProvider: null,
  browserContextUpload: false,
  browserContextStatus: false,
  browserCompanionPlugin: false,
  browserEvents: false,
  pluginActions: false,
  approvalEvents: false,
  browserControl: false,
  browserControlDeveloperMode: false,
  browserControlArtifactTransport: false,
  dashboardWs: false,
  endpoints: DEFAULT_ENDPOINTS,
  raw: null,
  warnings: Object.freeze([]),
});

// The dashboard WebSocket serves `session.compress` from its legacy session
// handlers. An authority-attached gateway (gateway.ready carries
// `session_authority`) does not route that verb and answers -32601, so it is
// only advertised when the connection proves it is not authority-attached.
export function dashboardWsSupportsCompress(readyPayload = null) {
  return Boolean(readyPayload && typeof readyPayload === 'object' && readyPayload.session_authority !== true);
}

// What the authority gateway serves instead: session.mutate operation=compress
// (see session-compact.mjs). Only a ready payload that says so counts.
export function dashboardWsSupportsCanonicalCompact(readyPayload = null) {
  return Boolean(readyPayload && typeof readyPayload === 'object' && readyPayload.session_authority === true);
}

export function dashboardWsGatewayCapabilities({ health = false, source = 'dashboard-ws', readyPayload = null } = {}) {
  return {
    ...DEFAULT_GATEWAY_CAPABILITIES,
    source,
    health: health === true,
    auth: true,
    models: true,
    sessions: true,
    sessionChat: true,
    sessionChatStreaming: true,
    skills: true,
    profiles: true,
    runSteer: true,
    sessionCompress: dashboardWsSupportsCompress(readyPayload),
    sessionCompactCanonical: dashboardWsSupportsCanonicalCompact(readyPayload),
    sessionAuthority: dashboardWsSupportsCanonicalCompact(readyPayload),
    // image.attach_bytes is part of the dashboard WebSocket contract (the legacy
    // handlers and the canonical session controls both define it). There is no
    // HTTP upload route on this transport, and the old warning that pasted
    // images "stay inline only" was wrong: they attach to the live session.
    imageSessionAttach: true,
    dashboardWs: true,
    warnings: Object.freeze([
      'Dashboard WebSocket transport is active; REST-only API routes are not required.',
      'Voice transcription unavailable - using browser speech fallback when available.',
      'HTTP image upload is not used on this transport - pasted images attach to the live session over the dashboard WebSocket.',
    ]),
  };
}

function hasEndpoint(endpoints = {}, names = []) {
  return names.some((name) => Boolean(endpoints?.[name]?.path || endpoints?.[name] === true));
}

// Both halves are needed unless the gateway states the whole feature: an answer route without
// pending replay would lose a request across a reconnect, and replay without an answer route
// shows a card that cannot be sent.
function completeUserInputCapability(features = {}, endpoints = {}) {
  const explicit = boolFeature(features, ['session_user_input', 'sessionUserInput']);
  if (typeof explicit === 'boolean') return explicit;
  return ['session_user_input_pending', 'session_user_input_answer']
    .every((name) => Boolean(endpoints?.[name]?.path || endpoints?.[name] === true));
}

function boolFeature(features = {}, names = []) {
  for (const name of names) {
    if (typeof features?.[name] === 'boolean') return features[name];
  }
  return undefined;
}

function inferredFeature(features = {}, endpoints = {}, featureNames = [], endpointNames = []) {
  const explicit = boolFeature(features, featureNames);
  if (typeof explicit === 'boolean') return explicit;
  return hasEndpoint(endpoints, endpointNames);
}

function advertisedFeature(features = {}, endpoints = {}, featureNames = [], endpointNames = []) {
  const explicit = boolFeature(features, featureNames);
  if (typeof explicit === 'boolean') return explicit;
  return hasEndpoint(endpoints, endpointNames);
}

function missingWarnings(caps) {
  const warnings = [];
  for (const [key, copy] of Object.entries(WARNING_CAPABILITY_COPY)) {
    if (caps[key] === false) warnings.push(copy);
  }
  return warnings;
}

function legacyCapabilities({ healthOk = false, hasApiKey = false, warning = '' } = {}) {
  const caps = {
    ...DEFAULT_GATEWAY_CAPABILITIES,
    source: 'legacy',
    health: Boolean(healthOk),
    auth: Boolean(hasApiKey),
    models: Boolean(healthOk && hasApiKey),
    sessions: Boolean(healthOk && hasApiKey),
    sessionChat: Boolean(healthOk && hasApiKey),
        sessionChatStreaming: Boolean(healthOk && hasApiKey),
        chatCompletions: Boolean(healthOk && hasApiKey),
        chatCompletionsStreaming: Boolean(healthOk && hasApiKey),
        skills: Boolean(healthOk && hasApiKey),
        runs: false,
        runStatus: false,
        runEvents: false,
        runStop: false,
        runSteer: false,
        sessionModelLock: false,
        sessionUserInput: false,
        sessionContext: false,
        sessionCompress: false,
    profiles: false,
    audioTranscription: false,
    mediaRead: false,
    browserPairing: false,
    imageUpload: false,
    browserContextProvider: null,
    browserContextUpload: false,
    browserContextStatus: false,
    browserCompanionPlugin: false,
    browserEvents: false,
    pluginActions: false,
    approvalEvents: false,
    browserControl: false,
    endpoints: {},
    warnings: [
      'Legacy Hermes gateway compatibility mode — /v1/capabilities was unavailable, so browser-specific features stay disabled unless proven by direct probes.',
      ...(warning ? [warning] : []),
      ...missingWarnings({ profiles: false, audioTranscription: false, browserPairing: false, imageUpload: false }),
    ],
  };
  return caps;
}

export function normalizeGatewayCapabilities(payload = null, { healthOk = false, hasApiKey = false, warning = '' } = {}) {
  if (!payload || typeof payload !== 'object') {
    return legacyCapabilities({ healthOk, hasApiKey, warning });
  }

  const features = payload.features || {};
  const endpoints = payload.endpoints || {};
  const caps = {
    ...DEFAULT_GATEWAY_CAPABILITIES,
    source: payload.platform === 'hermes-agent' || payload.object === 'hermes.api_server.capabilities' ? 'api-server' : 'api-server',
    platform: String(payload.platform || ''),
    health: Boolean(healthOk || hasEndpoint(endpoints, ['health', 'health_detailed'])),
    auth: Boolean(hasApiKey || payload.auth?.required || payload.auth?.type),
    models: inferredFeature(features, endpoints, ['models_api', 'models'], ['models']),
    sessions: inferredFeature(features, endpoints, ['session_resources', 'sessions_api'], ['sessions', 'session', 'session_create']),
    sessionChat: inferredFeature(features, endpoints, ['session_chat'], ['session_chat']),
        sessionChatStreaming: inferredFeature(features, endpoints, ['session_chat_streaming'], ['session_chat_stream']),
        chatCompletions: inferredFeature(features, endpoints, ['chat_completions'], ['chat_completions']),
        chatCompletionsStreaming: inferredFeature(features, endpoints, ['chat_completions_streaming'], ['chat_completions_stream']),
        skills: inferredFeature(features, endpoints, ['skills_api', 'skills'], ['skills']),
        profiles: inferredFeature(features, endpoints, ['profile_roster', 'profiles_api', 'profile_api'], ['profiles', 'profile_active', 'profiles_active']),
        runs: advertisedFeature(features, endpoints, ['run_submission', 'runs_api'], ['runs']),
        runStatus: advertisedFeature(features, endpoints, ['run_status'], ['run_status']),
        runEvents: advertisedFeature(features, endpoints, ['run_events_sse', 'run_events'], ['run_events']),
        runStop: advertisedFeature(features, endpoints, ['run_stop'], ['run_stop']),
        runSteer: advertisedFeature(features, endpoints, ['run_steer'], ['run_steer']),
        runApproval: advertisedFeature(features, endpoints, ['run_approval_response'], ['run_approval']),
        runClarify: advertisedFeature(features, endpoints, ['run_clarify_response'], ['run_clarify']),
        sessionModelLock: inferredFeature(features, endpoints, ['session_model_lock', 'sessionModelLock'], ['session_model_lock', 'session_model']),
        sessionUserInput: completeUserInputCapability(features, endpoints),
        sessionContext: inferredFeature(features, endpoints, ['session_context', 'context_status', 'contextStatus'], ['session_context', 'session_context_get', 'context_status']),
        sessionCompress: hasEndpoint(endpoints, ['session_compress', 'session_compress_post', 'context_compress']),
    audioTranscription: inferredFeature(features, endpoints, ['audio_api', 'audio_transcription', 'audioTranscription'], ['audio_transcribe', 'audio_transcription']),
    mediaRead: inferredFeature(features, endpoints, ['media_api', 'mediaRead'], ['media_read']),
    browserPairing: inferredFeature(features, endpoints, ['browser_extension_pairing', 'browserPairing'], ['browser_extension_pair_start', 'browser_pairing', 'pair_start']),
    imageUpload: inferredFeature(features, endpoints, ['browser_image_upload', 'image_upload', 'imageUpload'], ['browser_image_upload', 'image_upload', 'uploads_images']),
    browserContextProvider: boolFeature(features, [BROWSER_CAPABILITY_FLAGS.browserContextProvider, 'browserContextProvider']) ?? null,
    browserContextUpload: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.browserContextUpload, 'browserContextUpload'], ['browser_context_update', 'browser_context']),
    browserContextStatus: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.browserContextStatus, 'browserContextStatus'], ['browser_context_status']),
    browserCompanionPlugin: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.browserCompanionPlugin, 'browserCompanionPlugin'], ['browser_companion_status', 'browser_context_status']),
    browserEvents: inferredFeature(features, endpoints, ['browser_events', 'browserEvents', 'run_events_sse', 'run_events'], ['browser_events', 'run_events']),
    pluginActions: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.pluginActions, 'pluginActions'], ['browser_actions', 'plugin_actions']),
    approvalEvents: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.approvalEvents, 'approvalEvents'], ['approval_events']),
    browserControl: features?.browser_extension_control?.enabled === true,
    browserControlDeveloperMode: features?.browser_extension_control?.enabled === true
      && features?.browser_extension_control?.developer_mode === true,
    browserControlArtifactTransport: features?.browser_extension_control?.enabled === true
      && Boolean(features?.browser_extension_control?.artifact_transport?.upload?.path)
      && Boolean(features?.browser_extension_control?.artifact_transport?.download?.path),
    dashboardWs: inferredFeature(features, endpoints, ['dashboard_ws', 'dashboardWebSocket'], ['dashboard_ws', 'ws_ticket']),
    endpoints,
    raw: payload,
    warnings: [],
  };

  caps.warnings = [...(warning ? [warning] : []), ...missingWarnings(caps)];
  return caps;
}

// ---- Capability records ------------------------------------------------------
//
// The booleans above are what the rest of the extension branches on. The records
// below say, for the same connection, who reported each one, when, and why it is
// off. They are DERIVED from the booleans plus the gateway.ready handshake, so
// there is one place the facts come from and no view keeps a flag of its own.
//
// Companion plugin: no gateway source advertises browser_companion_plugin,
// browser_context_status, browser_context_upload or plugin_actions (checked
// against the installed api_server `_STATIC_FEATURE_FLAGS` and
// `_CAPABILITY_ENDPOINTS`). So without a probe the honest answer for all four is
// "not advertised by this gateway", never "unavailable": the plugin may well be
// loaded.
//
// The companion plugin can be asked directly, though: it wires one read-only
// metadata route into the API server, and companion-plugin-status.mjs probes it
// (with GET /v1/toolsets as the cross-check). Pass that probe's result as
// `companionPlugin` and the browserCompanionPlugin record says ready, outdated,
// disabled, not installed or unreachable, with its exact reason, from source
// `probe`. A ledger keeps it through ledger.observeProbe(). Without a probe the
// record is unchanged from what /v1/capabilities allows.
//
// Fallback upstream ask, only if that route is ever unreachable: publish
// `features.browser_companion_plugin: true` (and the version) in
// /v1/capabilities when the plugin registry loads hermes-browser-companion for
// the profile that serves the connection.

// One entry per flag whose value comes from /v1/capabilities. `features` and
// `endpoints` are the same names normalizeGatewayCapabilities reads above; a
// test keeps the two in step.
export const ADVERTISED_FLAG_SPECS = Object.freeze([
  { id: 'models', key: 'models', features: ['models_api', 'models'], endpoints: ['models'] },
  { id: 'sessions', key: 'sessions', features: ['session_resources', 'sessions_api'], endpoints: ['sessions', 'session', 'session_create'] },
  { id: 'skills', key: 'skills', features: ['skills_api', 'skills'], endpoints: ['skills'] },
  { id: 'profiles', key: 'profiles', features: ['profile_roster', 'profiles_api', 'profile_api'], endpoints: ['profiles', 'profile_active', 'profiles_active'] },
  { id: 'runs', key: 'runs', features: ['run_submission', 'runs_api'], endpoints: ['runs'] },
  { id: 'runSteer', key: 'runSteer', features: ['run_steer'], endpoints: ['run_steer'] },
  { id: 'sessionUserInput', key: 'sessionUserInput', features: ['session_user_input', 'sessionUserInput'], endpoints: [] },
  { id: 'sessionContext', key: 'sessionContext', features: ['session_context', 'context_status', 'contextStatus'], endpoints: ['session_context', 'session_context_get', 'context_status'] },
  { id: 'sessionModelLock', key: 'sessionModelLock', features: ['session_model_lock', 'sessionModelLock'], endpoints: ['session_model_lock', 'session_model'] },
  { id: 'audioTranscription', key: 'audioTranscription', features: ['audio_api', 'audio_transcription', 'audioTranscription'], endpoints: ['audio_transcribe', 'audio_transcription'] },
  { id: 'mediaRead', key: 'mediaRead', features: ['media_api', 'mediaRead'], endpoints: ['media_read'] },
  { id: 'browserPairing', key: 'browserPairing', features: ['browser_extension_pairing', 'browserPairing'], endpoints: ['browser_extension_pair_start', 'browser_pairing', 'pair_start'] },
  { id: 'imageUpload', key: 'imageUpload', features: ['browser_image_upload', 'image_upload', 'imageUpload'], endpoints: ['browser_image_upload', 'image_upload', 'uploads_images'] },
  { id: 'browserContextUpload', key: 'browserContextUpload', features: [BROWSER_CAPABILITY_FLAGS.browserContextUpload, 'browserContextUpload'], endpoints: ['browser_context_update', 'browser_context'] },
  { id: 'browserContextStatus', key: 'browserContextStatus', features: [BROWSER_CAPABILITY_FLAGS.browserContextStatus, 'browserContextStatus'], endpoints: ['browser_context_status'] },
  { id: 'browserCompanionPlugin', key: 'browserCompanionPlugin', features: [BROWSER_CAPABILITY_FLAGS.browserCompanionPlugin, 'browserCompanionPlugin'], endpoints: ['browser_companion_status', 'browser_context_status'], absentCode: 'not-advertised-plugin' },
  { id: 'pluginActions', key: 'pluginActions', features: [BROWSER_CAPABILITY_FLAGS.pluginActions, 'pluginActions'], endpoints: ['browser_actions', 'plugin_actions'] },
  { id: 'approvalEvents', key: 'approvalEvents', features: [BROWSER_CAPABILITY_FLAGS.approvalEvents, 'approvalEvents'], endpoints: ['approval_events'] },
]);

const WS_SOURCES = new Set(['dashboard-ws', 'remote-dashboard']);

function transportOf(caps = {}) {
  if (WS_SOURCES.has(caps.source)) return 'ws';
  if (caps.source === 'api-server') return 'rest';
  if (caps.source === 'legacy') return 'legacy';
  return 'none';
}

function methodSet(unsupported) {
  return unsupported instanceof Set ? unsupported : new Set(Array.isArray(unsupported) ? unsupported : []);
}

/**
 * The evidence records for one connection, derived from its capability booleans
 * and its gateway.ready payload. `identityKey` (capabilityIdentity().key) ties
 * them to the endpoint + principal + profile they were read under;
 * `unsupportedMethods` carries methods already answered -32601.
 *
 * It never invents a positive: a flag that is false is reported as unsupported
 * only when the gateway said so, and as unknown ("not advertised") otherwise.
 */
export function deriveCapabilityRecords(caps = DEFAULT_GATEWAY_CAPABILITIES, {
  identityKey = '',
  readyPayload = null,
  checkedAt = Date.now(),
  unsupportedMethods = [],
  dashboardWsActive = false,
  sideSocket = false,
  accountSignIn = false,
  companionPlugin = null,
} = {}) {
  const transport = transportOf(caps);
  const features = caps.raw?.features && typeof caps.raw.features === 'object' ? caps.raw.features : {};
  const unsupported = methodSet(unsupportedMethods);
  const records = [];
  const make = (id, state, source, reasonCode, params = {}) => {
    records.push(createCapabilityRecord({ id, state, source, checkedAt, identityKey, reasonCode, params }));
  };
  const S = CAPABILITY_STATES;
  const O = CAPABILITY_SOURCES;
  const hasReady = Boolean(readyPayload && typeof readyPayload === 'object');
  // Session authority, projects, compaction and image attach belong to the
  // dashboard WebSocket. They are read from its own gateway.ready whenever the
  // panel actually talks over it, even if the capability flags came from REST
  // (a named profile chats over the WebSocket while /v1/capabilities answers on
  // the API port).
  const wsRoute = transport === 'ws' || (dashboardWsActive === true && hasReady);
  // A session-authority socket the panel opened beside a REST chat (the Hermes Web socket the paired
  // gateway signs in, or one the held sign-in opens). Chat stays on REST, so only what that socket serves
  // by itself reads from it: session authority, projects and canonical compaction. Image attach belongs to a
  // live session and a turn over the socket, which a REST chat does not have.
  const sideReady = !wsRoute && sideSocket === true && hasReady;

  function flag(id, value, { explicit, absentCode = 'not-advertised' } = {}) {
    if (transport === 'none') return make(id, S.unknown, O.none, 'no-record');
    if (transport === 'legacy') {
      return value === true
        ? make(id, S.degraded, O.derived, 'legacy-assumed')
        : make(id, S.unknown, O.derived, 'legacy-gateway');
    }
    if (transport === 'ws') {
      if (value === true) return hasReady ? make(id, S.available, O.ready, 'ws-connected') : make(id, S.unknown, O.none, 'not-connected');
      return make(id, S.unknown, O.derived, id === 'browserCompanionPlugin' ? 'not-advertised-plugin' : 'ws-not-reported');
    }
    if (value === true) return make(id, S.available, O.capabilities, 'advertised');
    if (explicit === false) return make(id, S.unsupported, O.capabilities, 'advertised-off');
    return make(id, S.unknown, O.capabilities, absentCode);
  }

  // Health and auth are observations of this extension's own calls, not features.
  if (caps.health === true) make('health', S.available, O.probe, 'operation-ok');
  else make('health', S.unknown, O.none, 'no-record');
  if (caps.auth === true) make('auth', transport === 'legacy' ? S.degraded : S.available, O.extension, 'token-present');
  else make('auth', S.unknown, O.none, 'no-record');

  for (const spec of ADVERTISED_FLAG_SPECS) {
    const explicit = boolFeature(features, spec.features);
    flag(spec.id, caps[spec.key] === true, { explicit, absentCode: spec.absentCode });
  }

  // A probe of the companion plugin's own status route replaces the "not
  // advertised" answer. An unreachable probe says nothing about the plugin, so it
  // never overwrites something the gateway did advertise.
  const companion = companionRecordFields(companionPlugin);
  if (companion && transport !== 'none') {
    const at = records.findIndex((record) => record.id === 'browserCompanionPlugin');
    if (at >= 0 && !(companion.state === S.unknown && records[at].state !== S.unknown)) {
      records[at] = createCapabilityRecord({
        id: 'browserCompanionPlugin',
        state: companion.state,
        source: O.probe,
        checkedAt: companion.checkedAt ?? checkedAt,
        identityKey,
        reasonCode: companion.reasonCode,
        params: companion.params,
        reason: companion.reason,
      });
    }
  }

  // The extension builds BCP v2 payloads itself and sends them inline. That is
  // true whatever the gateway says; only an explicit "off" from the gateway
  // changes it, and nothing here claims the gateway has a side-channel for it.
  // caps.browserContextProvider is what the gateway said (true, false or null for
  // nothing); null falls back to the extension-side fact, never to a made-up true.
  if (caps.browserContextProvider === false) make('browserContextProvider', S.unsupported, O.capabilities, 'advertised-off');
  else if (caps.browserContextProvider === true || boolFeature(features, [BROWSER_CAPABILITY_FLAGS.browserContextProvider, 'browserContextProvider']) === true) {
    make('browserContextProvider', S.available, O.capabilities, 'advertised');
  } else make('browserContextProvider', S.available, O.extension, 'extension-side');

  const replace = (id, state, source, reasonCode, params = {}) => {
    const at = records.findIndex((record) => record.id === id);
    const record = createCapabilityRecord({ id, state, source, checkedAt, identityKey, reasonCode, params });
    if (at >= 0) records[at] = record; else records.push(record);
  };
  const current = (id) => records.find((record) => record.id === id);

  // Part of the dashboard WebSocket contract, used by the panel whenever it talks
  // over the socket: the gateway raises approval.request for a client that
  // announced it answers prompts, and the panel reads context from session.usage
  // events. Neither is listed in /v1/capabilities, so "not reported" understated them.
  if (wsRoute && hasReady) {
    if (current('approvalEvents')?.state !== S.available) replace('approvalEvents', S.available, O.derived, 'ws-contract');
    if (current('sessionContext')?.state !== S.available) replace('sessionContext', S.available, O.derived, 'ws-contract');
  }

  // Routes no Hermes release serves. /v1/capabilities answered in full and does not
  // list them, and the matching upstream surfaces (checked against v0.22.5) do not
  // exist either, so say so instead of "not advertised". A gateway that starts to
  // advertise one still wins: this only fills the gap an absent flag leaves.
  if (transport === 'rest' && caps.platform === 'hermes-agent' && caps.raw && typeof caps.raw === 'object') {
    for (const id of ['browserContextUpload', 'browserContextStatus', 'pluginActions']) {
      if (current(id)?.reasonCode === 'not-advertised') replace(id, S.unsupported, O.derived, 'not-in-hermes');
    }
  }

  // The companion plugin serves three of those rows itself. When its own status
  // route lists the route (and the plugin is ready), the row reads "available via
  // the companion plugin"; otherwise it keeps the honest reason above. A gateway
  // that advertised the row itself is left as it said.
  if (transport !== 'none') {
    for (const id of Object.keys(COMPANION_ROUTE_CAPABILITIES)) {
      const via = companionRouteRecordFields(companionPlugin, id);
      if (!via || current(id)?.state === S.available) continue;
      const at = records.findIndex((record) => record.id === id);
      const record = createCapabilityRecord({
        id,
        state: via.state,
        source: O.probe,
        checkedAt: via.checkedAt ?? checkedAt,
        identityKey,
        reasonCode: via.reasonCode,
        params: via.params,
        reason: via.reason,
      });
      if (at >= 0) records[at] = record; else records.push(record);
    }
  }

  // Browser control is negotiated from features.browser_extension_control.
  if (transport === 'rest' && caps.browserControl === true) make('browserControl', S.available, O.capabilities, 'advertised');
  else if (transport === 'rest' && features?.browser_extension_control?.enabled === false) make('browserControl', S.unsupported, O.capabilities, 'advertised-off');
  else make('browserControl', S.unknown, transport === 'none' ? O.none : O.derived, transport === 'legacy' ? 'legacy-gateway' : (transport === 'ws' ? 'ws-not-reported' : 'not-advertised'));

  // Session authority and what hangs off it.
  const authority = gatewayAuthorityAvailability({ dashboardWs: wsRoute || sideReady, readyPayload, unsupportedMethods: unsupported, method: 'session.mutate' });
  if (transport === 'none' && !wsRoute && !sideReady) {
    make('sessionAuthority', S.unknown, O.none, 'no-record');
    make('projects', S.unknown, O.none, 'no-record');
  } else if (!wsRoute && !sideReady) {
    make('sessionAuthority', S.unsupported, O.derived, 'rest-only');
    make('projects', S.unsupported, O.derived, 'rest-only');
  } else if (authority.reason === 'not-connected') {
    make('sessionAuthority', S.unknown, O.none, 'not-connected');
    make('projects', S.unknown, O.none, 'not-connected');
  } else if (authority.reason === 'no-session-authority') {
    make('sessionAuthority', S.unsupported, O.ready, 'no-session-authority');
    make('projects', S.unsupported, O.ready, 'no-session-authority');
  } else {
    make('sessionAuthority', S.available, O.ready, 'authority-ready');
    if (unsupported.has('projects.list')) make('projects', S.unsupported, O.methodNotFound, 'method-not-found', { method: 'projects.list' });
    else make('projects', S.available, O.ready, 'authority-ready');
  }

  // Manual compaction, by whichever route this connection has.
  // `route` says which verb the panel will use, so the control and the record
  // can never disagree about it.
  if (transport === 'ws' && !hasReady) {
    make('sessionCompress', S.unknown, O.none, 'not-connected');
  } else if (wsRoute && readyPayload.session_authority === true) {
    if (unsupported.has('session.mutate')) make('sessionCompress', S.unsupported, O.methodNotFound, 'method-not-found', { method: 'session.mutate', route: 'canonical' });
    else make('sessionCompress', S.available, O.ready, 'authority-compress', { route: 'canonical' });
  } else if (wsRoute) {
    if (unsupported.has('session.compress')) make('sessionCompress', S.unsupported, O.methodNotFound, 'method-not-found', { method: 'session.compress', route: 'legacy-ws' });
    else make('sessionCompress', S.available, O.ready, 'legacy-ws-compress', { route: 'legacy-ws' });
  } else if (sideReady && readyPayload.session_authority === true && !(transport === 'rest' && caps.sessionCompress === true)) {
    // No REST compact route, but the side socket serves session.mutate operation compress by durable id.
    if (unsupported.has('session.mutate')) make('sessionCompress', S.unsupported, O.methodNotFound, 'method-not-found', { method: 'session.mutate', route: 'canonical' });
    else make('sessionCompress', S.available, O.ready, 'authority-compress', { route: 'canonical', sideSocket: true });
  } else if (transport === 'rest') {
    if (caps.sessionCompress === true) make('sessionCompress', S.available, O.capabilities, 'advertised');
    else if (boolFeature(features, ['session_compress']) === false) make('sessionCompress', S.unsupported, O.capabilities, 'advertised-off');
    else make('sessionCompress', S.unsupported, O.capabilities, 'rest-no-compress');
  } else if (transport === 'legacy') {
    make('sessionCompress', S.unknown, O.derived, 'legacy-gateway');
  } else {
    make('sessionCompress', S.unknown, O.none, 'no-record');
  }

  // Images, kept apart: an advertised HTTP upload route (imageUpload), the
  // dashboard WebSocket's own session attach RPC, and the stored-image read
  // (mediaRead, handled in the loop above). None implies another.
  if (wsRoute && (caps.imageSessionAttach === true || transport !== 'ws')) make('imageSessionAttach', S.available, O.derived, 'ws-contract');
  else if (transport === 'none' && !sideReady) make('imageSessionAttach', S.unknown, O.none, 'no-record');
  else if (sideReady) make('imageSessionAttach', S.unsupported, O.derived, 'rest-chat');
  else make('imageSessionAttach', S.unsupported, O.derived, 'rest-only');

  // The gateway asks for a Hermes account sign-in (gated, native flow advertised) and none is held: the rows
  // that need the session-authority socket say that, instead of "REST only". A route the gateway advertised
  // itself (REST compaction) still reads as it said. Image attach stays tied to a chat over the socket, which
  // signing in does not change, so it keeps its own reason.
  if (accountSignIn === true && !wsRoute && !sideReady) {
    for (const id of ['sessionAuthority', 'projects']) replace(id, S.blocked, O.derived, 'account-sign-in');
    if (current('sessionCompress')?.state !== S.available) replace('sessionCompress', S.blocked, O.derived, 'account-sign-in');
  }

  return records;
}

// Each row: the record it reads, a label, and the English consequence shown
// when the record says the feature is not in use (what the extension does
// instead) or in use.
function rowDefinitions({ browserSpeechAvailable = false } = {}) {
  const audioOff = browserSpeechAvailable
    ? 'Hermes STT unavailable — browser speech fallback will be used.'
    : 'Hermes STT unavailable and this browser does not expose Web Speech.';
  return [
    { key: 'health', label: 'Health', off: 'Gateway has not responded yet.' },
    { key: 'auth', label: 'Auth', off: 'No token/auth context proven yet.', on: 'Bearer token/auth context present.' },
    { key: 'models', label: 'Models', off: 'Model list unavailable.' },
    { key: 'sessions', label: 'Sessions', off: 'Session API unavailable — chat completions fallback will be used.' },
    { key: 'skills', label: 'Skills', off: 'Skills API unavailable.' },
    { key: 'profiles', label: 'Profiles', off: WARNING_CAPABILITY_COPY.profiles },
    { key: 'audioTranscription', label: 'Voice transcription', off: audioOff, on: 'Hermes STT route available.' },
    { key: 'imageUpload', label: 'Image upload (HTTP)', off: WARNING_CAPABILITY_COPY.imageUpload, on: 'Pasted images can be saved for local path-backed Hermes vision.' },
    { key: 'imageSessionAttach', label: 'Image attach (session)', off: 'Pasted images cannot attach to the live session on this connection.', on: 'Pasted images attach to the live session so Hermes vision can open them.' },
    { key: 'mediaRead', label: 'Stored image read', off: 'Stored images are read through the Desktop dashboard when it is reachable. Video has its own route and is not covered here.', on: 'Stored images (not video) can be read through this gateway.' },
    { key: 'browserPairing', label: 'Browser pairing', off: WARNING_CAPABILITY_COPY.browserPairing, on: 'Automatic pairing route available.' },
    { key: 'runs', label: 'Runs API', off: 'Runs API unavailable — chat/session routes will be used.' },
    { key: 'runSteer', label: 'Run steering', off: 'Run steering unavailable — queued drafts can still send after the current turn.', on: 'Active-run steering route available.' },
    { key: 'browserContextProvider', label: 'Browser Context Protocol', off: 'The gateway turned the browser context protocol off.', on: 'Extension can emit hermes.browser.context.v1 payloads.' },
    { key: 'browserContextUpload', label: 'Browser context upload', off: 'Hermes has no side-channel route for browser context. Context goes inline with each message, which is how it is read.', on: 'Side-channel browser context upload route available.' },
    { key: 'browserContextStatus', label: 'Browser context status', off: 'Hermes has no browser context status route. The Browser context sent with each message shows what was sent.', on: 'Browser context status route available.' },
    { key: 'browserCompanionPlugin', label: 'Browser Companion Plugin', off: 'Optional companion plugin: the gateway does not advertise it, so the extension cannot tell whether it is loaded. Context still goes inline with each message.', on: 'Companion plugin capability advertised.' },
    { key: 'pluginActions', label: 'Plugin actions', off: 'Hermes has no plugin-actions route. The extension does not run plugin actions.', on: 'Plugin actions advertised.' },
    { key: 'sessionUserInput', label: 'Native async user input', off: 'Hermes did not advertise native asynchronous user input, so the panel only answers a request it actually receives.', on: 'Hermes questions can be answered from the panel and replayed after a reconnect.' },
    { key: 'sessionContext', label: 'Context status', off: 'Native session context status unavailable — Browser uses local/runtime estimates.', on: 'Native session context inspection available.' },
    { key: 'sessionCompress', label: 'Context compaction', off: 'Manual compaction is not available on this connection — Hermes compacts on its own.', on: 'Manual compaction available.' },
    { key: 'sessionAuthority', label: 'Session authority', off: 'Projects and canonical session edits need session authority.', on: 'Canonical session edits (move, compact) are available.' },
    { key: 'projects', label: 'Projects', off: 'Projects are unavailable on this connection. Recents still works.', on: 'Projects are available.' },
    { key: 'sessionModelLock', label: 'Per-session model lock', off: 'The gateway did not offer a per-session model lock, so a model choice applies to the next message only and is not locked.', on: 'The gateway can lock a model to a session.' },
    { key: 'approvalEvents', label: 'Approval events', off: 'Approval events are not advertised — approval cards stay informational.', on: 'Approval events advertised.' },
  ];
}

/**
 * The rows the compatibility panel shows. Each carries the record's state,
 * exact reason, source and age next to the older `status`/`detail`, so the panel
 * and the support diagnostics read one source. Pass `records` (the ledger's) to
 * show the connection's observed and cached state; without it they are derived
 * from `caps` alone.
 */
export function capabilityStatusRows(caps = DEFAULT_GATEWAY_CAPABILITIES, {
  browserSpeechAvailable = false,
  records = null,
  now = Date.now(),
  checkedAt = now,
  identityKey = '',
  readyPayload = null,
  unsupportedMethods = [],
  companionPlugin = null,
} = {}) {
  const supplied = Array.isArray(records) ? records : null;
  const derived = supplied || deriveCapabilityRecords(caps, { identityKey, readyPayload, checkedAt, unsupportedMethods, companionPlugin });
  const byId = new Map(derived.map((record) => [record.id, supplied ? record : effectiveCapability(record, { now })]));
  return rowDefinitions({ browserSpeechAvailable }).map((definition) => {
    const record = byId.get(definition.key) || null;
    const status = capabilityRowStatus(record);
    return {
      key: definition.key,
      label: definition.label,
      status,
      // The companion plugin's own probe has an exact English reason; show it
      // instead of the generic "cannot tell" sentence.
      detail: isCompanionReasonCode(record?.reasonCode) && record.reason
        ? record.reason
        : (status === 'ok'
          ? (definition.on || 'Available on the connected Hermes runtime.')
          : definition.off),
      state: record?.state || 'unknown',
      reason: record?.reason || '',
      reasonCode: record?.reasonCode || '',
      params: record?.params || {},
      source: record?.source || 'none',
      checkedAt: record?.checkedAt ?? null,
      ageMs: record?.checkedAt === null || record?.checkedAt === undefined ? null : Math.max(0, Number(now) - record.checkedAt),
    };
  });
}

function modeLabelFor(mode = DEFAULT_SETTINGS.gatewayMode) {
  const normalized = normalizeGatewayMode(mode);
  if (normalized === 'remote-dashboard') return 'Remote Hermes dashboard';
  if (normalized === 'remote-api') return 'Remote Hermes API';
  return 'Local Hermes API';
}

export function connectionSecuritySummary(settings = {}, now = Date.now()) {
  const mode = normalizeGatewayMode(settings.gatewayMode || DEFAULT_SETTINGS.gatewayMode);
  const apiKey = String(settings.apiKey || '');
  const testedAt = Number(settings.lastConnectionTestedAt || 0);
  return {
    mode,
    modeLabel: modeLabelFor(mode),
    url: normalizeGatewayUrl(settings.gatewayUrl || DEFAULT_SETTINGS.gatewayUrl),
    hasToken: Boolean(apiKey),
    maskedToken: apiKey ? '••••••••••••••••' : 'No token stored',
    tokenLabel: apiKey ? (settings.tokenSource === 'pairing' ? 'Scoped browser pairing' : 'Manual') : 'None',
    lastTestedLabel: testedAt ? new Date(testedAt).toLocaleString() : 'Not tested this session',
    ageMs: testedAt ? Math.max(0, Number(now) - testedAt) : 0,
  };
}

export function buildContextReceipt(options = {}) {
  return buildBrowserContextReceipt(options);
}
