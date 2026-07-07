import { DEFAULT_SETTINGS, normalizeGatewayMode, normalizeGatewayUrl } from './common.mjs';
import { buildBrowserContextReceipt } from './browser-context-protocol.mjs';

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
  runEvents: false,
  runStop: false,
  runSteer: false,
  sessionContext: false,
  sessionCompress: false,
  audioTranscription: false,
  browserPairing: false,
  imageUpload: false,
  browserContextProvider: true,
  browserContextUpload: false,
  browserContextStatus: false,
  browserCompanionPlugin: false,
  browserEvents: false,
  pluginActions: false,
  approvalEvents: false,
  browserControl: false,
  dashboardWs: false,
  endpoints: DEFAULT_ENDPOINTS,
  raw: null,
  warnings: Object.freeze([]),
});

function hasEndpoint(endpoints = {}, names = []) {
  return names.some((name) => Boolean(endpoints?.[name]?.path || endpoints?.[name] === true));
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
    runs: Boolean(healthOk && hasApiKey),
    runEvents: Boolean(healthOk && hasApiKey),
    runStop: Boolean(healthOk && hasApiKey),
    runSteer: false,
    sessionContext: false,
    sessionCompress: false,
    profiles: false,
    audioTranscription: false,
    browserPairing: false,
    imageUpload: false,
    browserContextProvider: true,
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
    profiles: inferredFeature(features, endpoints, ['profiles_api', 'profile_api'], ['profiles', 'profile_active', 'profiles_active']),
    runs: inferredFeature(features, endpoints, ['run_submission', 'runs_api'], ['runs']),
    runEvents: inferredFeature(features, endpoints, ['run_events_sse', 'run_events'], ['run_events']),
    runStop: inferredFeature(features, endpoints, ['run_stop'], ['run_stop']),
    runSteer: inferredFeature(features, endpoints, ['run_steer'], ['run_steer']),
    sessionContext: inferredFeature(features, endpoints, ['session_context', 'context_status', 'contextStatus'], ['session_context', 'session_context_get', 'context_status']),
    sessionCompress: inferredFeature(features, endpoints, ['session_compress', 'context_compress', 'contextCompress'], ['session_compress', 'session_compress_post', 'context_compress']),
    audioTranscription: inferredFeature(features, endpoints, ['audio_api', 'audio_transcription', 'audioTranscription'], ['audio_transcribe', 'audio_transcription']),
    browserPairing: inferredFeature(features, endpoints, ['browser_extension_pairing', 'browserPairing'], ['browser_extension_pair_start', 'browser_pairing', 'pair_start']),
    imageUpload: inferredFeature(features, endpoints, ['browser_image_upload', 'image_upload', 'imageUpload'], ['browser_image_upload', 'image_upload', 'uploads_images']),
    browserContextProvider: true,
    browserContextUpload: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.browserContextUpload, 'browserContextUpload'], ['browser_context_update', 'browser_context']),
    browserContextStatus: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.browserContextStatus, 'browserContextStatus'], ['browser_context_status']),
    browserCompanionPlugin: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.browserCompanionPlugin, 'browserCompanionPlugin'], ['browser_companion_status', 'browser_context_status']),
    browserEvents: inferredFeature(features, endpoints, ['browser_events', 'browserEvents', 'run_events_sse', 'run_events'], ['browser_events', 'run_events']),
    pluginActions: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.pluginActions, 'pluginActions'], ['browser_actions', 'plugin_actions']),
    approvalEvents: inferredFeature(features, endpoints, [BROWSER_CAPABILITY_FLAGS.approvalEvents, 'approvalEvents'], ['approval_events']),
    // Browser releases are support/read-only until a separate reviewed control surface ships.
    // Enable browser control at your own risk; do not infer it
    // from capability discovery alone. Action policy/approval logs come later.
    browserControl: false,
    dashboardWs: inferredFeature(features, endpoints, ['dashboard_ws', 'dashboardWebSocket'], ['dashboard_ws', 'ws_ticket']),
    endpoints,
    raw: payload,
    warnings: [],
  };

  caps.warnings = [...(warning ? [warning] : []), ...missingWarnings(caps)];
  return caps;
}

function statusFor(value, unavailableDetail, availableDetail = 'Available on the connected Hermes runtime.') {
  return value
    ? { status: 'ok', detail: availableDetail }
    : { status: 'warn', detail: unavailableDetail };
}

export function capabilityStatusRows(caps = DEFAULT_GATEWAY_CAPABILITIES, { browserSpeechAvailable = false } = {}) {
  const audioDetail = caps.audioTranscription
    ? 'Hermes STT route available.'
    : browserSpeechAvailable
      ? 'Hermes STT unavailable — browser speech fallback will be used.'
      : 'Hermes STT unavailable and this browser does not expose Web Speech.';
  return [
    { key: 'health', label: 'Health', ...statusFor(caps.health, 'Gateway has not responded yet.') },
    { key: 'auth', label: 'Auth', ...statusFor(caps.auth, 'No token/auth context proven yet.', 'Bearer token/auth context present.') },
    { key: 'models', label: 'Models', ...statusFor(caps.models, 'Model list unavailable.') },
    { key: 'sessions', label: 'Sessions', ...statusFor(caps.sessions, 'Session API unavailable — chat completions fallback will be used.') },
    { key: 'skills', label: 'Skills', ...statusFor(caps.skills, 'Skills API unavailable.') },
    { key: 'profiles', label: 'Profiles', ...statusFor(caps.profiles, WARNING_CAPABILITY_COPY.profiles) },
    { key: 'audioTranscription', label: 'Voice transcription', status: caps.audioTranscription ? 'ok' : 'warn', detail: audioDetail },
    { key: 'imageUpload', label: 'Image upload', ...statusFor(caps.imageUpload, WARNING_CAPABILITY_COPY.imageUpload, 'Pasted images can be saved for local path-backed Hermes vision.') },
    { key: 'browserPairing', label: 'Browser pairing', ...statusFor(caps.browserPairing, WARNING_CAPABILITY_COPY.browserPairing, 'Automatic pairing route available.') },
    { key: 'runs', label: 'Runs API', ...statusFor(caps.runs, 'Runs API unavailable — chat/session routes will be used.') },
    { key: 'runSteer', label: 'Run steering', ...statusFor(caps.runSteer, 'Run steering unavailable — queued drafts can still send after the current turn.', 'Active-run steering route available.') },
    { key: 'browserContextProvider', label: 'Browser Context Protocol', ...statusFor(caps.browserContextProvider !== false, 'Browser context protocol unavailable.', 'Extension can emit hermes.browser.context.v1 payloads.') },
    { key: 'browserContextUpload', label: 'Browser context upload', ...statusFor(caps.browserContextUpload, 'Side-channel browser context route missing — prompt-embedded fallback stays active.', 'Side-channel browser context upload route available.') },
    { key: 'browserCompanionPlugin', label: 'Browser Companion Plugin', ...statusFor(caps.browserCompanionPlugin, 'Optional companion plugin missing — extension remains fully usable with prompt-embedded context.', 'Companion plugin capability detected.') },
    { key: 'sessionContext', label: 'Context status', ...statusFor(caps.sessionContext, 'Native session context status unavailable — Browser uses local/runtime estimates.', 'Native session context inspection available.') },
    { key: 'sessionCompress', label: 'Context compaction', ...statusFor(caps.sessionCompress, 'Native session compaction unavailable — Browser will not show an active compact action.', 'Native session compaction available.') },
  ];
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
