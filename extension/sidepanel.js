import {
  AUDIO_TRANSCRIBE_ENDPOINT,
  DEFAULT_SETTINGS,
  HERMES_BROWSER_SYSTEM_PROMPT,
  MODEL_EFFORTS,
  appendOpenAiChunkText,
  autoSessionTitleFromText,
  buildAudioTranscriptionBody,
  buildHermesModelOptions,
  buildHermesPrompt,
  browserContextPayloadHash,
  busyComposerSubmitAction,
  clampText,
  classifyGatewayError,
  classifyRemoteGatewaySetup,
  composerControlState,
  composerKeyAction,
  connectionStateForGateway,
  contextAccountingSnapshot,
  contextChipSummary,
  contextControlState,
  contextMeterDisplay,
  encodeSessionId,
  estimateContextWindow,
  estimateTokens,
  escapeHtml,
  extractAssistantText,
  formatUpdateStatus,
  gatewayConnectionTroubleshooting,
  gatewayConnectionSummary,
  groupModelsForMenu,
  groupSessionsForMenu,
  isDefaultBrowserSessionTitle,
  isMicrophonePermissionError,
  isModelRuntimeSelectable,
  isRestrictedUrl,
  isUsableRemoteGatewayUrl,
  microphonePermissionHelp,
  modelDisplayName,
  modelRefreshControlState,
  modelRuntimeStatus,
  normalizeGitCommit,
  normalizeHermesModels,
  normalizeHermesProfiles,
  normalizeHermesSessions,
  normalizeHermesSkills,
  normalizeExtensionVersion,
  normalizeFastMode,
  normalizeGatewayMode,
  normalizeGatewayUrl,
  normalizeSessionStartupMode,
  normalizeTextSize,
  normalizeToolActivity,
  normalizeReasoningEffort,
  pairingFailureMessage,
  queuedMessageControlState,
  reasoningEffortShortLabel,
  renderMarkdown,
  safeTab,
  shouldStopSessionPaging,
  shouldFallbackToWebSpeechForTranscription,
  shouldAutoOpenSessionGroup,
  shouldAutoFlushQueuedTurn,
  shouldCreateFreshSessionOnOpen,
  skillSuggestionsForInput,
} from './lib/common.mjs';
import { extractYouTubeVideoId } from './lib/transcript.mjs';
import { buildDashboardWsUrl, createGatewayClient, WS_EVENTS, WS_METHODS } from './lib/gateway-ws.mjs';
import { mintWsTicket, ticketFailureHelp } from './lib/dashboard-bridge.mjs';
import {
  deriveStartupView,
  initialStartupReadiness,
  reduceStartupReadiness,
  selectedModelReadiness,
} from './lib/readiness.mjs';
import {
  DEFAULT_GATEWAY_CAPABILITIES,
  buildContextReceipt,
  capabilityStatusRows,
  connectionSecuritySummary,
  normalizeGatewayCapabilities,
} from './lib/capabilities.mjs';
import { normalizeBrowserRuntimeEvent } from './lib/runtime-events.mjs';
import { buildSupportDiagnostics } from './lib/support-diagnostics.mjs';
import {
  DEFAULT_AGENT_PORTS,
  activeAgents,
  discoverLocalAgents,
  normalizeAgentDiscoveryHost,
  normalizeAgentDiscoveryScheme,
  parseAgentPortsInput,
} from './lib/agent-discovery.mjs';
import {
  dashboardModelDiscoveryBaseUrl,
  discoverModelsFromDashboard,
  discoverModelsFromExternalSources,
  discoverModelsFromRegistry,
  discoverModelsFromSessions,
  mergeModelsByRawId,
  mergeModelsWithRegistry,
  modelCatalogRefreshDecision,
  normalizeExternalModelSourceList,
  shouldTrySessionModelFallback,
} from './lib/model-discovery.mjs';
import {
  BUILTIN_COMMANDS,
  parseCommandInput,
  resolveCommandPrompt,
} from './lib/commands.mjs';
import {
  CONTEXT_SCOPE_MODES,
  DEFAULT_CONTEXT_SCOPE,
  compactPinnedTitle,
  contextScopeFromTab,
  filterPromptTabs,
  messageStorageKeyForScope,
  normalizeContextScope,
  resolveContextTargetTab,
  sessionBindingKeyForScope,
  shouldRefreshForTabEvent,
} from './lib/context-scope.mjs';
import {
  PANEL_RESIDENCY_MODES,
  normalizePanelResidencyMode,
  parseSidePanelParams,
} from './lib/panel-residency.mjs';

const $ = (selector) => document.querySelector(selector);
const sidePanelParams = parseSidePanelParams(globalThis.location?.search || '');

const els = {
  appScroll: $('#appScroll'),
  startupScreen: $('#startupScreen'),
  startupTitle: $('#startupTitle'),
  startupDetail: $('#startupDetail'),
  startupProgress: $('#startupProgress'),
  startupStepList: $('#startupStepList'),
  connectPanel: $('#connectPanel'),
  connectButton: $('#connectButton'),
  manualSettingsButton: $('#manualSettingsButton'),
  connectStatus: $('#connectStatus'),
  connectionPill: $('#connectionPill'),
  sessionMenuButton: $('#sessionMenuButton'),
  currentSessionName: $('#currentSessionName'),
  newSessionButton: $('#newSessionButton'),
  sessionMenu: $('#sessionMenu'),
  sessionSearchInput: $('#sessionSearchInput'),
  sessionMenuList: $('#sessionMenuList'),
  createSessionButton: $('#createSessionButton'),
  refreshSessionsButton: $('#refreshSessionsButton'),
  messages: $('#messages'),
  composer: $('#composer'),
  input: $('#promptInput'),
  contextChip: $('#contextChip'),
  contextChipLabel: $('#contextChipLabel'),
  contextPreview: $('#contextPreview'),
  contextScopeButton: $('#contextScopeButton'),
  contextScopeLabel: $('#contextScopeLabel'),
  contextScopeMenu: $('#contextScopeMenu'),
  composerDropZone: $('#composerDropZone'),
  dropOverlay: $('#dropOverlay'),
  skillMenu: $('#skillMenu'),
  queueNotice: $('#queueNotice'),
  sendButton: $('#sendButton'),
  inlineSendButton: $('#inlineSendButton'),
  queueButton: $('#queueButton'),
  steerButton: $('#steerButton'),
  stopButton: $('#stopButton'),
  voiceButton: $('#voiceButton'),
  refreshButton: $('#refreshButton'),
  settingsButton: $('#settingsButton'),
  closeSettingsButton: $('#closeSettingsButton'),
  settingsDialog: $('#settingsDialog'),
  settingsForm: $('#settingsForm'),
  testConnectionButton: $('#testConnectionButton'),
  versionLabel: $('#versionLabel'),
  checkUpdatesButton: $('#checkUpdatesButton'),
  updateStatus: $('#updateStatus'),
  activeTitle: $('#activeTitle'),
  activeUrl: $('#activeUrl'),
  statusDot: $('#statusDot'),
  modelMenuButton: $('#modelMenuButton'),
  currentModelName: $('#currentModelName'),
  currentModelEffort: $('#currentModelEffort'),
  modelMenu: $('#modelMenu'),
  modelSearchInput: $('#modelSearchInput'),
  modelProviderList: $('#modelProviderList'),
  modelMenuList: $('#modelMenuList'),
  modelOptionsList: $('#modelOptionsList'),
  refreshModelsButton: $('#refreshModelsButton'),
  modelRefreshStatus: $('#modelRefreshStatus'),
  editModelsButton: $('#editModelsButton'),
  contextBarButton: $('#contextBarButton'),
  attachMenuButton: $('#attachMenuButton'),
  attachMenu: $('#attachMenu'),
  attachmentList: $('#attachmentList'),
  fileInput: $('#fileInput'),
  imageInput: $('#imageInput'),
  folderInput: $('#folderInput'),
  contextCompactLabel: $('#contextCompactLabel'),
  contextPercentLabel: $('#contextPercentLabel'),
  contextUsageDetail: $('#contextUsageDetail'),
  contextMeterFill: $('#contextMeterFill'),
  contextPopover: $('#contextPopover'),
  contextBreakdown: $('#contextBreakdown'),
  contextControlStatus: $('#contextControlStatus'),
  contextCompactButton: $('#contextCompactButton'),
  gatewayModeInput: $('#gatewayModeInput'),
  remoteTransportRow: $('#remoteTransportRow'),
  gatewayUrlInput: $('#gatewayUrlInput'),
  gatewayHelp: $('#gatewayHelp'),
  apiKeyInput: $('#apiKeyInput'),
  remoteDiagnosticsPanel: $('#remoteDiagnosticsPanel'),
  remoteDiagnosticsList: $('#remoteDiagnosticsList'),
  remoteEnvBlock: $('#remoteEnvBlock'),
  copyRemoteEnvButton: $('#copyRemoteEnvButton'),
  sessionIdInput: $('#sessionIdInput'),
  sessionTitleInput: $('#sessionTitleInput'),
  contextDepthInput: $('#contextDepthInput'),
  includeTabsInput: $('#includeTabsInput'),
  includePageTextInput: $('#includePageTextInput'),
  includeSelectedTextInput: $('#includeSelectedTextInput'),
  panelResidencyInputs: Array.from(document.querySelectorAll('input[name="panelResidencyMode"]')),
  autoNameSessionsInput: $('#autoNameSessionsInput'),
  transcriptProviderInput: $('#transcriptProviderInput'),
  profileSelect: $('#profileSelect'),
  refreshProfilesButton: $('#refreshProfilesButton'),
  profileStatus: $('#profileStatus'),
  compatibilityList: $('#compatibilityList'),
  compatibilityStatus: $('#compatibilityStatus'),
  copyDiagnosticsButton: $('#copyDiagnosticsButton'),
  diagnosticsCopyStatus: $('#diagnosticsCopyStatus'),
  connectionSecuritySummary: $('#connectionSecuritySummary'),
  clearTokenButton: $('#clearTokenButton'),
  agentList: $('#agentList'),
  refreshAgentsButton: $('#refreshAgentsButton'),
  addCustomAgentButton: $('#addCustomAgentButton'),
  agentHostInput: $('#agentHostInput'),
  agentSchemeInput: $('#agentSchemeInput'),
  agentPortsInput: $('#agentPortsInput'),
  agentPickerStatus: $('#agentPickerStatus'),
  customModelSourcesInput: $('#customModelSourcesInput'),
  themeGrid: $('#themeGrid'),
  colorModeButtons: Array.from(document.querySelectorAll('[data-color-mode]')),
  textSizeButtons: Array.from(document.querySelectorAll('[data-text-size]')),
  quickMoreMenu: $('#quickMoreMenu'),
  commandMenuButton: $('#commandMenuButton'),
  template: $('#messageTemplate'),
};

let settings = { ...DEFAULT_SETTINGS };
let startupReadiness = initialStartupReadiness(settings);
let contextScope = normalizeContextScope(DEFAULT_CONTEXT_SCOPE);
let previousConversationScope = normalizeContextScope(DEFAULT_CONTEXT_SCOPE);
let currentContext = { activeTab: null, tabs: [], pageContext: null, contextScope };
let selectedTabs = []; // null = all tabs; array of SafeTab = user-filtered set
let messages = [];
let availableModels = [];
let availableSessions = [];
let availableSkills = [];
let availableProfiles = [];
let attachments = [];
let selectedModelProvider = '';
let modelSelectionVersion = 0;
let pendingModelRuntimeAck = null;
let lastRemoteDiagnostic = null;
let lastVisibleStatus = null;
const openSessionGroups = new Set();
const closedSessionGroups = new Set();
let sending = false;
let queuedTurn = null;
let activeAbortController = null;
let activeRunId = '';
let pendingSteerText = '';
let dragDepth = 0;
let speechRecognition = null;
let voiceRecorder = null;
let voiceRecorderStream = null;
let voiceRecorderChunks = [];
let dictating = false;
let dictationBaseText = '';
let dictationFinalText = '';
let sessionRoutesAvailable = null;

let activeSessionRuntime = {
  sessionId: '',
  usedTokens: 0,
  liveContextTokens: 0,
  nextPromptTokens: 0,
  lastTurnSpendTokens: 0,
  sessionSpendTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  contextTokens: 0,
  model: '',
  provider: '',
  source: '',
};
// The remote-dashboard gateway mode talks to the OAuth-gated dashboard over its
// /api/ws JSON-RPC socket (the api_server REST/SSE surface is unavailable
// cross-origin). This holds the live socket + the dashboard-assigned session id.
let remoteWsConnection = null;
let connectionProbeStatus = 'connecting';
let connectionProbeDetail = '';
let connectionProbeTimer = null;
let connectionProbeInFlight = false;
let gatewayCapabilities = { ...DEFAULT_GATEWAY_CAPABILITIES };
let modelsRefreshing = false;
let contextRefreshingFromButton = false;
const REFRESH_BUTTON_MIN_BUSY_MS = 520;
const CONNECTION_PROBE_INTERVAL_MS = 30_000;

// remote-dashboard mode authenticates over the dashboard WebSocket with a
// first-party ticket; the other modes (local-api, remote-api) use the REST
// api_server with a Bearer key.
function isRemoteWsMode() {
  return normalizeGatewayMode(settings.gatewayMode) === 'remote-dashboard';
}

function isRemoteMode() {
  return normalizeGatewayMode(settings.gatewayMode) !== 'local-api';
}

function currentConnectionState() {
  return connectionStateForGateway({
    gatewayMode: settings.gatewayMode,
    gatewayUrl: settings.gatewayUrl,
    apiKey: settings.apiKey,
    probeStatus: connectionProbeStatus,
    remoteWsReadyState: remoteWsConnection?.client?.readyState ?? -1,
  });
}

function isConnected() {
  return currentConnectionState().connected;
}

function renderStartupReadiness() {
  const view = deriveStartupView(startupReadiness);
  if (els.startupScreen) els.startupScreen.hidden = !view.visible;
  if (els.startupTitle) els.startupTitle.textContent = view.title;
  if (els.startupDetail) els.startupDetail.textContent = view.detail;
  if (els.startupProgress) els.startupProgress.style.width = `${Math.max(0, Math.min(100, view.progress))}%`;
  if (els.startupStepList) {
    els.startupStepList.textContent = '';
    for (const step of view.steps) {
      const item = document.createElement('li');
      item.className = `startup-step startup-step-${step.status}`;
      item.dataset.status = step.status;
      const label = document.createElement('strong');
      label.textContent = step.label;
      const detail = document.createElement('span');
      detail.textContent = step.detail || step.status;
      item.append(label, detail);
      els.startupStepList.appendChild(item);
    }
  }
  document.body?.classList.toggle('startup-active', view.visible);
  els.composer?.classList.toggle('startup-blocked', view.visible);
  if (els.input) els.input.disabled = view.visible;
  if (els.sendButton) els.sendButton.disabled = view.visible || els.sendButton.disabled;
  if (els.inlineSendButton) els.inlineSendButton.disabled = view.visible || els.inlineSendButton.disabled;
  if (els.modelMenuButton) els.modelMenuButton.disabled = view.visible;
  if (els.newSessionButton) els.newSessionButton.disabled = view.visible;
  if (!view.visible) updateComposerBusyState();
}

function setStartupReadiness(event = {}) {
  startupReadiness = reduceStartupReadiness(startupReadiness, event);
  renderStartupReadiness();
}

function connectionStateTitle(state, summary) {
  if (state.state === 'connected') return `Connected to ${summary.normalizedUrl}`;
  if (state.state === 'degraded') return currentConnectionTroubleshooting(state) || `Connected with warnings to ${summary.normalizedUrl}`;
  if (state.state === 'connecting') return `Checking ${summary.normalizedUrl}`;
  if (state.state === 'unreachable') return gatewayConnectionTroubleshooting({
    gatewayMode: settings.gatewayMode,
    gatewayUrl: settings.gatewayUrl,
    state: state.state,
    probeDetail: connectionProbeDetail,
  });
  return 'Not connected to Hermes';
}

function currentConnectionTroubleshooting(state = currentConnectionState()) {
  return gatewayConnectionTroubleshooting({
    gatewayMode: settings.gatewayMode,
    gatewayUrl: settings.gatewayUrl,
    state: state.state,
    probeDetail: connectionProbeDetail,
  });
}

function markConnectionProbe(status, detail = '') {
  connectionProbeStatus = status;
  connectionProbeDetail = detail;
  updateConnectionPrompt();
}

function setStatus(kind, title, detail) {
  lastVisibleStatus = { kind: kind || '', title: title || '', detail: detail || '', ts: Date.now() };
  els.statusDot.className = `status-dot ${kind || ''}`.trim();
  const safeTitle = title || 'Hermes Browser Extension';
  const safeDetail = detail || '';
  els.activeTitle.textContent = safeTitle;
  els.activeTitle.title = safeTitle;
  els.activeUrl.textContent = safeDetail;
  els.activeUrl.title = safeDetail;
}

function openSettingsDialog() {
  renderVersionInfo();
  syncSettingsForm();
  renderCompatibilityPanel();
  renderConnectionSecurity();
  renderRemoteDiagnostics(lastRemoteDiagnostic);
  els.settingsDialog.hidden = false;
  els.settingsDialog.setAttribute('aria-hidden', 'false');
  els.apiKeyInput.focus();
}

function closeSettingsDialog() {
  els.settingsDialog.hidden = true;
  els.settingsDialog.setAttribute('aria-hidden', 'true');
  els.settingsButton.focus();
}

function renderVersionInfo(statusText = '') {
  if (els.versionLabel) els.versionLabel.textContent = `v${CURRENT_EXTENSION_VERSION}`;
  if (els.updateStatus) {
    els.updateStatus.textContent = statusText || 'Updates are checked against the public GitHub repo.';
  }
}

function currentExtensionOrigin() {
  try {
    const url = globalThis.chrome?.runtime?.getURL?.('') || '';
    return url.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function currentGatewaySummary(overrides = {}) {
  return gatewayConnectionSummary({
    gatewayMode: overrides.gatewayMode ?? settings.gatewayMode,
    gatewayUrl: overrides.gatewayUrl ?? settings.gatewayUrl,
    extensionOrigin: currentExtensionOrigin(),
  });
}

function renderGatewayHelp() {
  const summary = currentGatewaySummary({
    gatewayMode: els.gatewayModeInput?.value || settings.gatewayMode,
    gatewayUrl: els.gatewayUrlInput?.value || settings.gatewayUrl,
  });
  if (els.gatewayHelp) els.gatewayHelp.textContent = summary.setupHint;
  if (els.gatewayUrlInput) els.gatewayUrlInput.placeholder = summary.mode.defaultUrl || DEFAULT_SETTINGS.gatewayUrl;
}

function remoteEnvBlockText() {
  const origin = currentExtensionOrigin() || 'chrome-extension://<extension-id>';
  return [
    'API_SERVER_ENABLED=true',
    'API_SERVER_HOST=0.0.0.0',
    'API_SERVER_PORT=8642',
    'API_SERVER_KEY=<strong-token>',
    `API_SERVER_CORS_ORIGINS=${origin}`,
  ].join('\n');
}

function renderRemoteDiagnostics(diagnostic = lastRemoteDiagnostic) {
  if (!els.remoteDiagnosticsPanel) return;
  lastRemoteDiagnostic = diagnostic || null;
  const shouldShow = Boolean(diagnostic) && isRemoteMode();
  els.remoteDiagnosticsPanel.hidden = !shouldShow;
  if (!shouldShow) return;
  const origin = currentExtensionOrigin() || 'chrome-extension://<extension-id>';
  const rows = [
    ['Diagnosis', diagnostic.title || 'Remote setup issue'],
    ['Detail', diagnostic.detail || 'The Browser Extension could not classify this response.'],
    ['Suggested API URL', diagnostic.suggestedUrl || 'Use your API server host with port 8642'],
    ['Required CORS origin', origin],
  ];
  if (els.remoteDiagnosticsList) {
    els.remoteDiagnosticsList.innerHTML = rows.map(([key, value]) => `
      <dt>${escapeHtml(key)}</dt>
      <dd>${escapeHtml(value)}</dd>
    `).join('');
  }
  if (els.remoteEnvBlock) els.remoteEnvBlock.textContent = remoteEnvBlockText();
}

function renderCompatibilityPanel() {
  if (!els.compatibilityList) return;
  const rows = capabilityStatusRows(gatewayCapabilities, { browserSpeechAvailable: Boolean(speechRecognitionConstructor()) });
  els.compatibilityList.innerHTML = '';
  for (const row of rows) {
    const item = document.createElement('li');
    item.className = `compatibility-row ${row.status || 'warn'}`;
    const label = document.createElement('span');
    label.textContent = row.label;
    const state = document.createElement('strong');
    state.textContent = row.status === 'ok' ? 'available' : 'fallback';
    const detail = document.createElement('small');
    detail.textContent = row.detail;
    item.append(label, state, detail);
    els.compatibilityList.appendChild(item);
  }
  if (els.compatibilityStatus) {
    const fallbackCount = rows.filter((row) => row.status !== 'ok').length;
    els.compatibilityStatus.textContent = fallbackCount
      ? `${fallbackCount} feature${fallbackCount === 1 ? '' : 's'} using fallback/manual mode.`
      : 'Connected runtime advertises the full extension compatibility surface.';
  }
}

function renderConnectionSecurity() {
  if (!els.connectionSecuritySummary) return;
  const summary = connectionSecuritySummary(settings);
  els.connectionSecuritySummary.innerHTML = '';
  const rows = [
    ['Connected as', summary.modeLabel],
    ['Gateway URL', summary.url],
    ['Token source', summary.tokenLabel],
    ['Stored token', summary.maskedToken],
    ['Last tested', summary.lastTestedLabel],
  ];
  for (const [labelText, valueText] of rows) {
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = labelText;
    const value = document.createElement('strong');
    value.textContent = valueText;
    row.append(label, value);
    els.connectionSecuritySummary.appendChild(row);
  }
  if (els.clearTokenButton) els.clearTokenButton.disabled = !summary.hasToken;
}

async function copySupportDiagnostics() {
  if (!els.copyDiagnosticsButton) return;
  const originalText = els.copyDiagnosticsButton.textContent || 'Copy Diagnostics';
  els.copyDiagnosticsButton.disabled = true;
  els.copyDiagnosticsButton.textContent = 'Copying...';
  if (els.diagnosticsCopyStatus) els.diagnosticsCopyStatus.textContent = 'Building redacted diagnostics...';
  try {
    const buildInfo = await loadExtensionBuildInfo().catch(() => ({}));
    const state = currentConnectionState();
    const diagnostics = buildSupportDiagnostics({
      extensionVersion: CURRENT_EXTENSION_VERSION,
      buildInfo,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      settings,
      connection: {
        state: state.state,
        detail: connectionProbeDetail || currentConnectionTroubleshooting(state),
      },
      health: {
        ok: state.connected,
        version: gatewayCapabilities.raw?.version || gatewayCapabilities.raw?.hermes_version || '',
        build: gatewayCapabilities.raw?.build || gatewayCapabilities.raw?.commit || '',
      },
      capabilities: gatewayCapabilities,
      selectedModel: currentSelectedModel() || {},
      contextScope,
      lastError: lastVisibleStatus,
      currentContext,
      extractorMode: currentContext?.pageContext?.source || 'extension-dom',
    });
    await navigator.clipboard.writeText(diagnostics.markdown);
    if (els.diagnosticsCopyStatus) els.diagnosticsCopyStatus.textContent = 'Copied redacted diagnostics. Paste them into the GitHub issue or support thread.';
    setStatus('ok', 'Diagnostics copied', 'Redacted support diagnostics are on your clipboard.');
  } catch (error) {
    if (els.diagnosticsCopyStatus) els.diagnosticsCopyStatus.textContent = 'Could not copy diagnostics. Check browser clipboard permissions.';
    setStatus('warn', 'Diagnostics copy failed', error?.message || String(error));
  } finally {
    els.copyDiagnosticsButton.disabled = false;
    els.copyDiagnosticsButton.textContent = originalText;
  }
}

function ensureSidepanelInstanceId() {
  try {
    let id = globalThis.sessionStorage?.getItem('hermesBrowserInstanceId');
    if (!id) {
      id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      globalThis.sessionStorage?.setItem('hermesBrowserInstanceId', id);
    }
    return id;
  } catch {
    return 'default';
  }
}

function contextScopeSessionKey() {
  return `hermesBrowserContextScope:${ensureSidepanelInstanceId()}`;
}

function conversationScopeSessionKey() {
  return `hermesBrowserConversationScope:${ensureSidepanelInstanceId()}`;
}

function conversationScopeForContextScope(scope = contextScope, fallback = previousConversationScope) {
  const normalized = normalizeContextScope(scope);
  if (normalized.mode !== CONTEXT_SCOPE_MODES.CHAT_ONLY) return normalized;
  const conversation = normalizeContextScope(fallback || DEFAULT_CONTEXT_SCOPE);
  return conversation.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY
    ? normalizeContextScope(DEFAULT_CONTEXT_SCOPE)
    : conversation;
}

function saveConversationScopeForInstance() {
  try {
    globalThis.sessionStorage?.setItem(conversationScopeSessionKey(), JSON.stringify(previousConversationScope));
  } catch {
    // Per-panel conversation-scope persistence is best-effort only.
  }
}

function loadConversationScopeForInstance() {
  try {
    const stored = globalThis.sessionStorage?.getItem(conversationScopeSessionKey());
    if (stored) return conversationScopeForContextScope(JSON.parse(stored), previousConversationScope);
  } catch {
    // Fall through to current/default conversation scope.
  }
  return conversationScopeForContextScope(contextScope, previousConversationScope);
}

function rememberConversationScope(scope = contextScope) {
  previousConversationScope = conversationScopeForContextScope(scope, previousConversationScope);
  saveConversationScopeForInstance();
  return previousConversationScope;
}

function isGlobalPanelResidency() {
  return normalizePanelResidencyMode(settings.panelResidencyMode) === PANEL_RESIDENCY_MODES.GLOBAL
    && sidePanelParams.panelMode === PANEL_RESIDENCY_MODES.GLOBAL;
}

function isAttachedPanelResidency() {
  return !isGlobalPanelResidency() && sidePanelParams.panelMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED && Boolean(sidePanelParams.tabId);
}

function syncAttachedPanelContextScope() {
  if (!isAttachedPanelResidency()) return;
  if (contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return;
  if (contextScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB && Number(contextScope.pinnedTabId) === Number(sidePanelParams.tabId)) return;
  contextScope = normalizeContextScope({
    ...contextScope,
    mode: CONTEXT_SCOPE_MODES.PINNED_TAB,
    pinnedTabId: sidePanelParams.tabId,
    pinnedWindowId: contextScope.pinnedWindowId,
    pinnedTitle: contextScope.pinnedTitle || '',
    pinnedUrl: contextScope.pinnedUrl || '',
  });
  rememberConversationScope(contextScope);
  saveContextScopeForInstance();
}

function loadContextScopeForInstance() {
  try {
    const stored = globalThis.sessionStorage?.getItem(contextScopeSessionKey());
    if (stored) {
      contextScope = normalizeContextScope(JSON.parse(stored));
      if (isAttachedPanelResidency()) syncAttachedPanelContextScope();
      previousConversationScope = loadConversationScopeForInstance();
      rememberConversationScope(contextScope);
      return contextScope;
    }
  } catch {
    // Fall through to URL-derived/default scope.
  }
  if (isAttachedPanelResidency()) {
    contextScope = normalizeContextScope({
      mode: CONTEXT_SCOPE_MODES.PINNED_TAB,
      pinnedTabId: sidePanelParams.tabId,
    });
  } else {
    contextScope = normalizeContextScope(DEFAULT_CONTEXT_SCOPE);
  }
  previousConversationScope = loadConversationScopeForInstance();
  rememberConversationScope(contextScope);
  saveContextScopeForInstance();
  return contextScope;
}

function saveContextScopeForInstance() {
  try {
    globalThis.sessionStorage?.setItem(contextScopeSessionKey(), JSON.stringify(contextScope));
  } catch {
    // Per-panel scope persistence is best-effort only.
  }
}

function activeMessagesStorageKey(conversationScope = previousConversationScope) {
  return conversationScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB
    ? messageStorageKeyForScope(contextScope, conversationScope)
    : 'hermesBrowserMessages';
}

async function loadMessagesForActiveScope() {
  const key = activeMessagesStorageKey(previousConversationScope);
  const stored = await chrome.storage.local.get([key]);
  messages = Array.isArray(stored[key]) ? stored[key] : [];
  renderMessagesFromStorage();
}

async function saveMessagesForActiveScope() {
  const key = activeMessagesStorageKey(previousConversationScope);
  await chrome.storage.local.set({ [key]: messages });
}

async function loadSessionBindingForActiveScope() {
  if (previousConversationScope.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB) return null;
  const key = sessionBindingKeyForScope(contextScope, previousConversationScope);
  const stored = await chrome.storage.local.get([key]);
  return stored[key] || null;
}

async function saveSessionBindingForActiveScope(session) {
  if (previousConversationScope.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB || !session?.id) return;
  const key = sessionBindingKeyForScope(contextScope, previousConversationScope);
  await chrome.storage.local.set({
    [key]: {
      sessionId: session.id,
      sessionTitle: session.title || session.id,
      pinnedTabId: previousConversationScope.pinnedTabId,
      pinnedTitle: previousConversationScope.pinnedTitle || '',
      pinnedUrl: previousConversationScope.pinnedUrl || '',
      updatedAt: Date.now(),
    },
  });
}

function syncSelectedTabsFromContextScope(tabs = currentContext.tabs || []) {
  if (!Array.isArray(contextScope.selectedTabIds)) {
    selectedTabs = null;
    return;
  }
  const ids = new Set(contextScope.selectedTabIds.map(Number));
  selectedTabs = tabs.filter((tab) => ids.has(Number(tab.id)));
}

function syncSelectedTabsToContextScope() {
  contextScope = normalizeContextScope({
    ...contextScope,
    selectedTabIds: Array.isArray(selectedTabs)
      ? selectedTabs.map((tab) => Number(tab.id)).filter(Number.isFinite)
      : null,
  });
  saveContextScopeForInstance();
}

function contextScopeLabel() {
  if (contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return 'Chat only';
  if (contextScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB) {
    if (isAttachedPanelResidency() && Number(contextScope.pinnedTabId) === Number(sidePanelParams.tabId)) {
      return contextScope.pinnedTitle ? `Attached: ${contextScope.pinnedTitle}` : 'Attached tab';
    }
    return contextScope.pinnedTitle ? `Pinned: ${contextScope.pinnedTitle}` : 'Pinned tab';
  }
  return isGlobalPanelResidency() ? 'Follow active tab' : 'Attached tab';
}

function renderContextScopeControls() {
  if (!els.contextScopeButton || !els.contextScopeLabel) return;
  const pinned = contextScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB;
  const chatOnly = contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY;
  els.contextScopeLabel.textContent = contextScopeLabel();
  els.contextScopeButton.classList.toggle('active', pinned || chatOnly);
  els.contextScopeButton.setAttribute('aria-expanded', String(!els.contextScopeMenu?.hidden));
  els.contextScopeButton.title = chatOnly
    ? 'Hermes is in Chat only mode and will not read browser context'
    : pinned
      ? (isAttachedPanelResidency() && Number(contextScope.pinnedTabId) === Number(sidePanelParams.tabId)
        ? `Hermes is attached to ${contextScope.pinnedUrl || contextScope.pinnedTitle || 'this browser tab'}`
        : `Hermes is pinned to ${contextScope.pinnedUrl || contextScope.pinnedTitle || 'this tab'}`)
      : (isGlobalPanelResidency() ? 'Hermes follows the active browser tab' : 'Hermes is attached to this browser tab');
}

function appendContextScopeMenuButton({ action, label, detail = '', selected = false, parent = els.contextScopeMenu }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.scopeAction = action;
  if (selected) button.classList.add('selected');
  const text = document.createElement('span');
  text.textContent = label;
  const meta = document.createElement('small');
  meta.textContent = selected ? '✓' : detail;
  button.append(text, meta);
  parent?.appendChild(button);
  return button;
}

function promptTabsCount(tabs = currentContext.tabs || []) {
  return selectedTabs === null ? tabs.length : selectedTabs.length;
}

function isPromptTabSelected(tab) {
  if (selectedTabs === null) return true;
  return selectedTabs.some((candidate) => Number(candidate.id) === Number(tab.id));
}

function setPromptTabsSelection(nextSelection) {
  selectedTabs = nextSelection;
  syncSelectedTabsToContextScope();
}

function togglePromptTabSelection(tab) {
  const tabs = currentContext.tabs || [];
  if (!tab) return;
  if (selectedTabs === null) {
    setPromptTabsSelection(tabs.filter((candidate) => Number(candidate.id) !== Number(tab.id)));
    return;
  }
  const exists = selectedTabs.some((candidate) => Number(candidate.id) === Number(tab.id));
  const next = exists
    ? selectedTabs.filter((candidate) => Number(candidate.id) !== Number(tab.id))
    : [...selectedTabs, tab];
  setPromptTabsSelection(next.length === tabs.length ? null : next);
}

function currentContextScopeSearchQuery() {
  return els.contextScopeMenu?.querySelector('.context-scope-search')?.value || '';
}

function tabMatchesContextScopeQuery(tab, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return [tab.title, tab.url]
    .map((value) => String(value || '').toLowerCase())
    .some((value) => value.includes(needle));
}

function renderContextScopeTabList(query = '') {
  const list = els.contextScopeMenu?.querySelector('.context-scope-list');
  if (!list) return;
  list.innerHTML = '';
  const tabs = currentContext.tabs || [];
  const filteredTabs = tabs.filter((tab) => tabMatchesContextScopeQuery(tab, query));
  for (const tab of filteredTabs) {
    const isPinned = contextScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB && Number(tab.id) === Number(contextScope.pinnedTabId);
    const isActive = Boolean(tab.active);
    const isIncluded = isPromptTabSelected(tab);
    const row = document.createElement('div');
    row.className = 'context-scope-tab-row';
    appendContextScopeMenuButton({
      action: `pin-tab:${tab.id}`,
      label: `Pin: ${compactPinnedTitle(tab.title || tab.url || 'Untitled tab', 88)}`,
      detail: isPinned ? 'current' : isActive ? 'active' : '',
      selected: isPinned,
      parent: row,
    }).classList.add('context-scope-pin-action');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'context-scope-include-toggle';
    toggle.dataset.promptTabToggle = String(tab.id);
    toggle.setAttribute('aria-pressed', String(isIncluded));
    toggle.title = isIncluded ? 'Remove this tab from the prompt tab list' : 'Include this tab in the prompt tab list';
    toggle.textContent = isIncluded ? 'IN' : 'OUT';
    if (isIncluded) toggle.classList.add('selected');
    row.appendChild(toggle);
    list.appendChild(row);
  }
  if (!filteredTabs.length) {
    const empty = document.createElement('p');
    empty.className = 'context-scope-empty';
    empty.textContent = 'No matching tabs';
    list.appendChild(empty);
  }
}

function rerenderContextScopePromptSelectionPreservingScroll(query = currentContextScopeSearchQuery()) {
  const list = els.contextScopeMenu?.querySelector('.context-scope-list');
  const promptControls = els.contextScopeMenu?.querySelector('.context-scope-prompt-controls');
  if (!list) {
    if (promptControls) promptControls.replaceWith(renderContextScopePromptControls(currentContext.tabs || []));
    renderContextScopeControls();
    return;
  }
  const previousScrollTop = list.scrollTop;
  if (promptControls) promptControls.replaceWith(renderContextScopePromptControls(currentContext.tabs || []));
  renderContextScopeTabList(query);
  list.scrollTop = Math.min(previousScrollTop, Math.max(0, list.scrollHeight - list.clientHeight));
  renderContextScopeControls();
}

function renderContextScopePromptControls(tabs = currentContext.tabs || []) {
  const section = document.createElement('section');
  section.className = 'context-scope-prompt-controls';

  const header = document.createElement('div');
  header.className = 'context-scope-section-head';
  const title = document.createElement('span');
  title.textContent = 'Tabs in prompt';
  const count = document.createElement('small');
  count.textContent = `${promptTabsCount(tabs)}/${tabs.length}`;
  header.append(title, count);

  const actions = document.createElement('div');
  actions.className = 'context-scope-prompt-actions';
  appendContextScopeMenuButton({
    action: 'prompt-tabs-all',
    label: 'Include all tabs',
    detail: `${tabs.length}`,
    selected: selectedTabs === null,
    parent: actions,
  });
  appendContextScopeMenuButton({
    action: 'prompt-tabs-none',
    label: 'Page only',
    detail: '0',
    selected: Array.isArray(selectedTabs) && selectedTabs.length === 0,
    parent: actions,
  });

  section.append(header, actions);
  return section;
}

function renderContextScopeMenu(query = '', { focusSearch = false } = {}) {
  if (!els.contextScopeMenu) return;
  const searchQuery = String(query || '');
  els.contextScopeMenu.innerHTML = '';

  const actions = document.createElement('div');
  actions.className = 'context-scope-actions';
  appendContextScopeMenuButton({
    action: 'chat-only',
    label: 'Chat only',
    detail: 'no page',
    selected: contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY,
    parent: actions,
  });
  if (isGlobalPanelResidency()) {
    appendContextScopeMenuButton({
      action: 'follow-active',
      label: 'Follow active tab',
      detail: 'live',
      selected: contextScope.mode === CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE,
      parent: actions,
    });
  } else if (contextScope.mode === CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE) {
    syncAttachedPanelContextScope();
  }
  appendContextScopeMenuButton({ action: 'pin-active', label: 'Pin current tab', detail: 'lock', parent: actions });
  if (isGlobalPanelResidency() && contextScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB) {
    appendContextScopeMenuButton({ action: 'unlock', label: 'Unlock pinned tab', detail: 'follow', parent: actions });
  }
  els.contextScopeMenu.appendChild(actions);

  const tabs = currentContext.tabs || [];
  if (tabs.length) {
    els.contextScopeMenu.appendChild(renderContextScopePromptControls(tabs));

    const search = document.createElement('input');
    search.className = 'context-scope-search';
    search.type = 'search';
    search.placeholder = 'Search tabs';
    search.autocomplete = 'off';
    search.value = searchQuery;
    els.contextScopeMenu.appendChild(search);

    const list = document.createElement('div');
    list.className = 'context-scope-list';
    list.setAttribute('role', 'listbox');
    els.contextScopeMenu.appendChild(list);
    renderContextScopeTabList(searchQuery);

    if (focusSearch) {
      requestAnimationFrame(() => {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      });
    }
  }

  els.contextScopeMenu.hidden = false;
  renderContextScopeControls();
}

function makePinnedTabSessionTitle(tab = {}) {
  const prefix = 'Hermes Browser Extension · ';
  const maxTitleLength = Math.max(12, 100 - prefix.length);
  const title = compactPinnedTitle(tab.title || tab.pinnedTitle || tab.url || tab.pinnedUrl || 'Pinned browser tab', maxTitleLength);
  return `${prefix}${title}`;
}

// Used for explicit scope changes inside an already-open panel. Startup uses
// initializeSessionForPanelOpen() so opening the extension does not silently
// resume a previous Browser session.
async function ensureSessionForActiveScope({ focus = false } = {}) {
  if (previousConversationScope.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB) {
    await ensureDefaultBrowserSession({ focus });
    return;
  }
  if (!settings.apiKey || !isConnected()) return;
  const binding = await loadSessionBindingForActiveScope();
  if (binding?.sessionId) {
    const session = availableSessions.find((item) => item.id === binding.sessionId) || {
      id: binding.sessionId,
      title: binding.sessionTitle || binding.sessionId,
      source: DEFAULT_SETTINGS.sessionSource,
    };
    await openHermesSession(session);
    return;
  }
  await createHermesBrowserSession({ title: makePinnedTabSessionTitle(currentContext.activeTab || previousConversationScope), focus });
}

async function initializeSessionForPanelOpen({ focus = false } = {}) {
  if (!settings.apiKey || !isConnected()) return;
  if (shouldCreateFreshSessionOnOpen(settings)) {
    await createHermesBrowserSession({ title: makeBrowserSessionTitle(), focus });
    setStatus('ok', 'New Hermes Browser Extension session', settings.sessionId);
    return;
  }
  await ensureSessionForActiveScope({ focus });
}

async function applyContextScope(nextScope, { ensureSession = false } = {}) {
  contextScope = normalizeContextScope(nextScope);
  previousConversationScope = conversationScopeForContextScope(contextScope, previousConversationScope);
  if (contextScope.mode !== CONTEXT_SCOPE_MODES.CHAT_ONLY) rememberConversationScope(contextScope);
  else saveConversationScopeForInstance();
  saveContextScopeForInstance();
  syncSelectedTabsFromContextScope(currentContext.tabs || []);
  renderContextScopeControls();
  await loadMessagesForActiveScope();
  if (ensureSession) await ensureSessionForActiveScope({ focus: false });
  await refreshContext();
}

async function pinContextTab(tab) {
  if (!tab?.id) return;
  await applyContextScope(contextScopeFromTab(tab, contextScope), { ensureSession: true });
}

async function pinContextTabById(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return;
  let tab = currentContext.tabs.find((item) => Number(item.id) === id) || null;
  try {
    const freshTab = await chrome.tabs.get(id);
    if (freshTab?.id) tab = safeTab(freshTab);
  } catch (_error) {
    // The tab may have closed between render and click. Fall back to the
    // snapshot from the menu when available so the user does not need a manual
    // refresh just because the tab list is stale.
  }
  if (!tab) throw new Error('Tab is closed or no longer available.');
  await pinContextTab(tab);
}

async function unlockContextScope() {
  await applyContextScope({
    ...contextScope,
    mode: CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE,
    pinnedTabId: null,
    pinnedWindowId: null,
    pinnedTitle: '',
    pinnedUrl: '',
    selectedTabIds: [],
  });
}

function setGatewayCapabilities(caps) {
  gatewayCapabilities = caps || { ...DEFAULT_GATEWAY_CAPABILITIES };
  renderCompatibilityPanel();
  updateVoiceButtonState();
}

async function loadGatewayCapabilities({ quiet = false, publicOnly = false, healthOk = false } = {}) {
  if (isRemoteWsMode()) {
    setGatewayCapabilities({
      ...DEFAULT_GATEWAY_CAPABILITIES,
      source: 'remote-dashboard',
      health: remoteWsConnection?.client?.readyState === 1,
      auth: true,
      models: true,
      sessions: true,
      sessionChat: true,
      sessionChatStreaming: true,
      skills: true,
      dashboardWs: true,
      warnings: [
        'Remote dashboard mode uses WebSocket session/chat APIs; REST-only browser extension APIs stay unavailable.',
        'Voice transcription unavailable — using browser speech fallback when available.',
        'Image upload unavailable — pasted images stay inline only.',
        'Automatic browser pairing unavailable — manual dashboard sign-in is required.',
      ],
    });
    return gatewayCapabilities;
  }
  try {
    const fetcher = publicOnly || !settings.apiKey ? publicApiFetch : apiFetch;
    const response = await fetcher('/v1/capabilities', { method: 'GET', cache: 'no-store' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(`GET /v1/capabilities failed (${response.status})`);
    setGatewayCapabilities(normalizeGatewayCapabilities(payload, { healthOk: true, hasApiKey: Boolean(settings.apiKey) }));
  } catch (error) {
    setGatewayCapabilities(normalizeGatewayCapabilities(null, {
      healthOk,
      hasApiKey: Boolean(settings.apiKey),
      warning: error?.message || String(error),
    }));
    if (!quiet) setStatus('warn', 'Hermes compatibility fallback', 'This gateway does not expose /v1/capabilities yet. Browser-specific routes will stay in fallback mode.');
  }
  return gatewayCapabilities;
}

// The gateway mode is stored as a flat value (local-api/remote-api/
// remote-dashboard) but the UI only asks one thing: Local or Remote. For
// Remote, the transport is inferred from the API key field — a key present
// means a remote API server, a blank key means the dashboard WebSocket. A
// hidden <select> (#gatewayModeInput) stays the source of truth so the rest of
// the settings code keeps reading one value.
function gatewayLocationOf(mode) {
  return normalizeGatewayMode(mode) === 'local-api' ? 'local' : 'remote';
}

function remoteGatewayModeForKey(apiKey) {
  return String(apiKey || '').trim() ? 'remote-api' : 'remote-dashboard';
}

function renderGatewayModeCards() {
  const location = gatewayLocationOf(els.gatewayModeInput?.value || settings.gatewayMode);
  for (const card of document.querySelectorAll('[data-gateway-location]')) {
    const selected = card.dataset.gatewayLocation === location;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-checked', String(selected));
  }
}

function applyGatewayMode(mode) {
  if (!els.gatewayModeInput) return;
  els.gatewayModeInput.value = normalizeGatewayMode(mode);
  // Reuse the existing change handler (URL default + help text), then repaint.
  els.gatewayModeInput.dispatchEvent(new Event('change'));
  renderGatewayModeCards();
}

async function fetchJsonNoStore(url) {
  const response = await fetch(`${url}${String(url).includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Fetch failed (${response.status})`);
  return response.json();
}

async function loadExtensionBuildInfo() {
  const runtime = globalThis.chrome?.runtime;
  const candidates = ['build-info.json', 'extension/build-info.json'];
  for (const candidate of candidates) {
    try {
      const url = typeof runtime?.getURL === 'function' ? runtime.getURL(candidate) : candidate;
      const payload = await fetchJsonNoStore(url);
      const commit = normalizeGitCommit(payload?.commit);
      if (commit || payload?.version) return { ...payload, commit };
    } catch {
      // Build metadata is generated for dist builds. Source-loaded dev copies may not have it.
    }
  }
  return null;
}

async function fetchLatestUpdateInfo() {
  const [packagePayload, commitPayload] = await Promise.all([
    fetchJsonNoStore(UPDATE_PACKAGE_URL),
    fetchJsonNoStore(UPDATE_MAIN_COMMIT_URL).catch(() => ({})),
  ]);
  const latestVersion = String(packagePayload.version || '').trim();
  if (!latestVersion) throw new Error('Latest package version was missing.');
  return {
    latestVersion,
    latestCommit: normalizeGitCommit(commitPayload?.sha),
  };
}

async function commitsBehindMainForBuild(currentCommit = '', latestCommit = '') {
  const currentSha = normalizeGitCommit(currentCommit);
  const latestSha = normalizeGitCommit(latestCommit);
  if (!currentSha) return null;
  if (latestSha && currentSha === latestSha) return 0;
  const head = latestSha || 'main';
  const response = await fetch(`${UPDATE_COMPARE_URL}/${encodeURIComponent(currentSha)}...${encodeURIComponent(head)}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => ({}));
  return Math.max(0, Number.parseInt(payload.ahead_by, 10) || 0);
}

async function checkForUpdates() {
  if (!els.checkUpdatesButton) return;
  els.checkUpdatesButton.disabled = true;
  els.checkUpdatesButton.textContent = 'Checking...';
  renderVersionInfo('Checking GitHub main and this loaded build commit...');
  try {
    const [buildInfo, latestInfo] = await Promise.all([
      loadExtensionBuildInfo(),
      fetchLatestUpdateInfo(),
    ]);
    const currentCommit = normalizeGitCommit(buildInfo?.commit);
    const commitsBehind = await commitsBehindMainForBuild(currentCommit, latestInfo.latestCommit);
    renderVersionInfo(formatUpdateStatus({
      latestVersion: latestInfo.latestVersion,
      currentVersion: CURRENT_EXTENSION_VERSION,
      currentCommit,
      latestCommit: latestInfo.latestCommit,
      commitsBehind,
      buildDirty: Boolean(buildInfo?.dirty),
    }));
  } catch (error) {
    renderVersionInfo(`${error?.message || String(error)} Open ${REPO_URL} for manual update instructions.`);
  } finally {
    els.checkUpdatesButton.disabled = false;
    els.checkUpdatesButton.textContent = 'Check updates';
  }
}

function updateConnectionPrompt() {
  const state = currentConnectionState();
  const connected = state.connected;
  const summary = currentGatewaySummary();
  els.connectPanel.hidden = connected;
  els.connectionPill.textContent = '●';
  els.connectionPill.className = `connection-pill ${state.pillClass || 'warn'}`;
  els.connectionPill.title = connectionStateTitle(state, summary);
  els.connectionPill.setAttribute('aria-label', connected ? 'Hermes connected' : `Hermes ${state.state}`);
  if (!connected) {
    if (state.state === 'connecting') {
      els.sendButton.textContent = 'Checking...';
      els.connectStatus.textContent = `Checking ${summary.title} at ${summary.normalizedUrl}...`;
      setStatus('warn', 'Checking Hermes', `${summary.title}: ${summary.normalizedUrl}`);
    } else if (state.state === 'unreachable') {
      els.sendButton.textContent = 'Reconnect';
      els.connectStatus.textContent = currentConnectionTroubleshooting(state);
      setStatus('error', 'Hermes API unavailable', currentConnectionTroubleshooting(state) || `${summary.title} is not responding. Start Hermes Desktop/Gateway, then reconnect.`);
    } else {
      els.sendButton.textContent = 'Connect first';
      if (isRemoteWsMode()) {
        els.connectStatus.textContent = 'Enter your dashboard https URL in Settings and sign in to it in a browser tab.';
        setStatus('warn', 'Set a remote dashboard', 'Enter your dashboard https URL in Settings and sign in to it in a browser tab.');
      } else {
        els.connectStatus.textContent = `${summary.title}. Click Connect to Hermes or use Manual setup.`;
        setStatus('warn', 'Connect Hermes', `${summary.title}. Click Connect to Hermes or use Manual setup.`);
      }
    }
  } else {
    els.sendButton.textContent = sending ? 'Hermes running' : 'Ask Hermes';
    els.connectStatus.textContent = state.state === 'degraded'
      ? `Connected to Hermes with a runtime warning. ${currentConnectionTroubleshooting(state)}`
      : 'Connected to Hermes. You can start chatting with page context.';
  }
  updateComposerBusyState();
}

function setComposerButtonState(button, state = {}) {
  if (!button) return;
  button.hidden = Boolean(state.hidden);
  button.disabled = Boolean(state.disabled);
  if (state.label) {
    button.title = state.label;
    button.setAttribute('aria-label', state.label);
  }
}

function canSteerActiveRun() {
  return Boolean(isRemoteWsMode() || gatewayCapabilities.runSteer);
}

function currentComposerDraftState() {
  return composerControlState({
    connected: isConnected(),
    sending,
    draftText: els.input?.value || '',
    attachmentCount: attachments.length,
    canSteer: canSteerActiveRun(),
  });
}

function updateComposerBusyState() {
  const state = currentComposerDraftState();
  const startupBlocking = !startupReadiness.ready;
  setComposerButtonState(els.inlineSendButton, state.controls.inlineSend);
  setComposerButtonState(els.stopButton, state.controls.stop);
  setComposerButtonState(els.queueButton, state.controls.queue);
  setComposerButtonState(els.steerButton, state.controls.steer);
  if (startupBlocking) {
    [els.inlineSendButton, els.stopButton, els.queueButton, els.steerButton, els.voiceButton].filter(Boolean).forEach((button) => { button.disabled = true; });
  }
  els.composerDropZone?.classList.toggle('busy-draft', state.busyDraft);
  els.composerDropZone?.classList.toggle('can-steer', state.busyDraft && !state.controls.steer.hidden);
  if (els.sendButton) {
    els.sendButton.disabled = startupBlocking || state.mainButton.disabled;
    if (isConnected()) els.sendButton.textContent = state.mainButton.label;
  }
  renderQueueNotice();
}

function queuedTurnSteerText(turn = queuedTurn) {
  return String(turn?.text || '').trim();
}

function renderQueueNotice() {
  if (!els.queueNotice) return;
  if (!queuedTurn) {
    els.queueNotice.hidden = true;
    els.queueNotice.textContent = '';
    return;
  }
  const count = queuedTurn.attachments?.length || 0;
  const steerText = queuedTurnSteerText(queuedTurn);
  const actionState = queuedMessageControlState({ sending, text: steerText, canSteer: canSteerActiveRun() });
  els.queueNotice.hidden = false;
  els.queueNotice.textContent = '';

  const main = document.createElement('span');
  main.className = 'queue-notice-main';
  main.textContent = `Queued next message${count ? ` · ${count} attachment${count === 1 ? '' : 's'}` : ''}. It will send after the current turn stops or finishes.`;

  const actions = document.createElement('div');
  actions.className = 'queue-notice-actions';

  const steer = document.createElement('button');
  steer.type = 'button';
  steer.dataset.queuedAction = 'steer';
  steer.textContent = actionState.steer.label;
  steer.title = actionState.steer.title;
  steer.disabled = actionState.steer.disabled;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.dataset.queuedAction = 'delete';
  remove.textContent = actionState.delete.label;
  remove.title = actionState.delete.title;

  if (!actionState.steer.hidden) actions.append(steer);
  actions.append(remove);
  els.queueNotice.append(main, actions);
}

function queueCurrentDraft() {
  const text = els.input.value.trim();
  if (!text && !attachments.length) return false;
  queuedTurn = { text, attachments: [...attachments], kind: 'queued', autoSend: true };
  els.input.value = '';
  clearAttachments();
  renderSkillSuggestions();
  updateComposerBusyState();
  setStatus('ok', 'Message queued', 'Hermes will send it after the current turn finishes or stops.');
  els.input.focus();
  return true;
}

function restoreBackendQueuedSteerDraft(text) {
  const steerText = String(text || '').trim();
  if (!steerText) return false;
  pendingSteerText = '';
  const currentDraft = String(els.input?.value || '').trim();
  if (els.input && !currentDraft) {
    els.input.value = steerText;
  } else if (els.input && currentDraft && !currentDraft.includes(steerText)) {
    els.input.value = `${currentDraft}\n\n${steerText}`;
  }
  renderSkillSuggestions();
  updateComposerBusyState();
  setStatus('warn', 'Steer not injected', 'Hermes accepted the steer but did not expose an active injection point. The text is back in the composer; click Steer again while Hermes is working, or send it after this turn finishes.');
  els.input?.focus();
  return true;
}

function deleteQueuedTurn() {
  if (!queuedTurn) return false;
  queuedTurn = null;
  renderQueueNotice();
  setStatus('ok', 'Queued message deleted', 'The current Hermes turn will continue without sending the queued draft.');
  els.input.focus();
  return true;
}

async function sendSteerText(text) {
  const steerText = String(text || '').trim();
  if (!steerText) return false;
  if (!sending) {
    setStatus('warn', 'Nothing to steer', 'Hermes is not currently running. Send or queue the message instead.');
    return false;
  }
  pendingSteerText = steerText;
  if (isRemoteWsMode()) {
    const connection = await ensureRemoteWsClient();
    const sessionId = await ensureRemoteWsSession(connection);
    await connection.client.request(WS_METHODS.sessionSteer, { session_id: sessionId, text: steerText });
    return true;
  }
  if (!canSteerActiveRun()) {
    throw new Error('Connected Hermes runtime does not advertise active-run steering yet. Queue the draft instead, or update Hermes Gateway when /v1/runs/{run_id}/steer is available.');
  }
  if (!activeRunId) {
    throw new Error('Active run id is not available yet. Wait for Hermes to start streaming, then steer again.');
  }
  const response = await apiFetch(`/v1/runs/${encodeURIComponent(activeRunId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({ input: steerText, message: steerText, text: steerText }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || payload?.message || `Hermes steer failed (${response.status})`;
    if (response.status === 404) {
      throw new Error(`${detail}. Update Hermes Gateway to a build with /v1/runs/{run_id}/steer support, then reload the extension.`);
    }
    throw new Error(detail);
  }
  return true;
}

async function steerCurrentDraft() {
  const text = els.input.value.trim();
  if (!text) return false;
  try {
    await sendSteerText(text);
    els.input.value = '';
    renderSkillSuggestions();
    updateComposerBusyState();
    setStatus('ok', 'Steer sent to active run', 'Hermes will consume it if the current turn reaches an injection point; otherwise the draft will return here.');
    els.input.focus();
    return true;
  } catch (error) {
    pendingSteerText = '';
    setStatus('warn', 'Steer failed', error?.message || String(error));
    els.input.focus();
    return false;
  }
}

async function steerQueuedTurn() {
  if (!queuedTurn) return false;
  const text = queuedTurnSteerText(queuedTurn);
  if (!text) return false;
  try {
    await sendSteerText(text);
    if (queuedTurn.attachments?.length) queuedTurn = { text: '', attachments: queuedTurn.attachments };
    else queuedTurn = null;
    renderQueueNotice();
    setStatus('ok', 'Steer sent to active run', 'Hermes will consume the queued text if the current turn reaches an injection point.');
    els.input.focus();
    return true;
  } catch (error) {
    pendingSteerText = '';
    setStatus('warn', 'Steer failed', error?.message || String(error));
    els.input.focus();
    return false;
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error || ''));
}

async function stopCurrentTurn() {
  if (!sending) return;
  setStatus('warn', 'Stopping Hermes', activeRunId ? `Interrupt requested for ${activeRunId}` : 'Closing the active browser stream');
  if (activeRunId && !isRemoteWsMode()) {
    apiFetch(`/v1/runs/${encodeURIComponent(activeRunId)}/stop`, { method: 'POST' }).catch(() => {});
  }
  activeAbortController?.abort();
}

const VOICE_AUDIO_MIME_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
]);
const MICROPHONE_PERMISSION_PAGE = 'request-permissions.html';
const VOICE_DICTATION_PAGE = 'voice-dictation.html';
const VOICE_DRAFT_STORAGE_KEY = 'hermesVoiceDraft';
const VOICE_DRAFT_MAX_AGE_MS = 10 * 60 * 1000;

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function canRecordVoiceAudio() {
  return Boolean(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
}

function canUseHermesVoiceTranscription() {
  return Boolean(settings.apiKey && gatewayCapabilities.audioTranscription && canRecordVoiceAudio());
}

function browserSpeechAvailable() {
  return Boolean(speechRecognitionConstructor());
}

function preferredVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return VOICE_AUDIO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function chromeRuntimeErrorMessage() {
  try {
    return globalThis.chrome?.runtime?.lastError?.message || '';
  } catch {
    return '';
  }
}

function chromePermissionCall(method, details) {
  return new Promise((resolve, reject) => {
    try {
      method.call(globalThis.chrome.permissions, details, (value) => {
        const runtimeError = chromeRuntimeErrorMessage();
        if (runtimeError) reject(new Error(runtimeError));
        else resolve(Boolean(value));
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function ensureExtensionAudioPermission() {
  const permissions = globalThis.chrome?.permissions;
  if (!permissions) return true;
  const details = { permissions: ['audioCapture'] };
  try {
    if (permissions.request) return await chromePermissionCall(permissions.request, details);
    if (permissions.contains) return await chromePermissionCall(permissions.contains, details);
    return true;
  } catch (error) {
    console.warn('Hermes Browser could not request audioCapture permission', error);
    return false;
  }
}

function microphonePermissionError(message = microphonePermissionHelp()) {
  const error = new Error(message);
  error.name = 'NotAllowedError';
  return error;
}

async function microphonePermissionState() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' });
    return permission.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function openMicrophonePermissionPage() {
  const url = globalThis.chrome?.runtime?.getURL?.(MICROPHONE_PERMISSION_PAGE) || MICROPHONE_PERMISSION_PAGE;
  if (globalThis.chrome?.tabs?.create) {
    await globalThis.chrome.tabs.create({ url, active: true });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function microphoneSettingsUrl() {
  const runtimeId = globalThis.chrome?.runtime?.id || '';
  const site = encodeURIComponent(`chrome-extension://${runtimeId}/`);
  return `chrome://settings/content/siteDetails?site=${site}`;
}

async function openMicrophoneSettingsPage() {
  const url = microphoneSettingsUrl();
  if (globalThis.chrome?.tabs?.create) {
    await globalThis.chrome.tabs.create({ url, active: true });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function openVoiceDictationPage(detail = 'Opening a Hermes Voice Dictation tab. Record there; the transcript will return to this composer automatically.') {
  setStatus('warn', 'Opening voice dictation tab', detail);
  const url = globalThis.chrome?.runtime?.getURL?.(VOICE_DICTATION_PAGE) || VOICE_DICTATION_PAGE;
  if (globalThis.chrome?.tabs?.create) {
    await globalThis.chrome.tabs.create({ url, active: true });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function insertExternalVoiceTranscript(transcript = '', source = 'voice dictation') {
  const spoken = String(transcript || '').trim();
  if (!spoken) return false;
  const current = els.input.value.trim();
  els.input.value = [current, spoken].filter(Boolean).join(current && spoken ? ' ' : '');
  renderContextWindow();
  renderSkillSuggestions();
  els.input.focus();
  setStatus('ok', 'Voice dictation ready', `Transcript inserted from ${source}.`);
  return true;
}

async function consumeVoiceDraft(draft = null) {
  if (!draft?.transcript) return false;
  const age = Math.abs(Date.now() - Number(draft.ts || 0));
  if (!Number.isFinite(age) || age > VOICE_DRAFT_MAX_AGE_MS) {
    await globalThis.chrome?.storage?.local?.remove?.(VOICE_DRAFT_STORAGE_KEY);
    return false;
  }
  const inserted = insertExternalVoiceTranscript(draft.transcript, draft.source || 'voice dictation tab');
  if (inserted) await globalThis.chrome?.storage?.local?.remove?.(VOICE_DRAFT_STORAGE_KEY);
  return inserted;
}

async function consumePendingVoiceDraft() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.get) return false;
  const stored = await storage.get([VOICE_DRAFT_STORAGE_KEY]);
  return consumeVoiceDraft(stored?.[VOICE_DRAFT_STORAGE_KEY]);
}

async function waitForMicrophonePermission({ timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await microphonePermissionState();
    if (state === 'granted') return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function requestMicrophoneOriginPermissionViaPage(detail = 'Opening a temporary Hermes permission tab because Chrome can suppress mic prompts inside extension side panels.') {
  setStatus('warn', 'Microphone permission needed', detail);
  await openMicrophonePermissionPage();
  const granted = await waitForMicrophonePermission();
  if (granted) {
    setStatus('ok', 'Microphone permission enabled', 'Starting Hermes voice recording now.');
    return true;
  }
  throw microphonePermissionError('Microphone access was not granted. Use the Hermes permission tab or Chrome extension details to enable Microphone, then click the mic again.');
}

async function ensureMicrophoneOriginPermission() {
  const state = await microphonePermissionState();
  if (state === 'granted' || state === 'unknown') return true;
  const error = microphonePermissionError('Microphone access is blocked or pending for this extension origin. Use the Hermes Voice Dictation tab to grant/record from a visible extension page.');
  error.voiceDictationPageFallback = true;
  throw error;
}

async function getMicrophoneStreamWithPermissionRetry() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    if (isMicrophonePermissionError(error)) error.voiceDictationPageFallback = true;
    throw error;
  }
}

function updateVoiceButtonState() {
  if (!els.voiceButton) return;
  const supported = canUseHermesVoiceTranscription() || browserSpeechAvailable();
  els.voiceButton.disabled = !supported;
  els.voiceButton.classList.toggle('recording', dictating);
  els.voiceButton.classList.toggle('active', dictating);
  const mode = canUseHermesVoiceTranscription() ? 'Hermes STT' : 'browser speech fallback';
  els.voiceButton.title = !supported
    ? 'Voice dictation is not supported in this browser or connected Hermes runtime'
    : (dictating ? `Stop voice dictation (${mode})` : `Start voice dictation (${mode})`);
  els.voiceButton.setAttribute('aria-label', els.voiceButton.title);
}

function applyDictationTranscript(transcript = '') {
  const spoken = String(transcript || '').trim();
  els.input.value = [dictationBaseText, spoken].filter(Boolean).join(dictationBaseText && spoken ? ' ' : '');
  renderContextWindow();
  renderSkillSuggestions();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read voice recording'));
    reader.readAsDataURL(blob);
  });
}

function cleanupVoiceRecorder() {
  voiceRecorderStream?.getTracks?.().forEach((track) => track.stop());
  voiceRecorderStream = null;
  voiceRecorder = null;
  voiceRecorderChunks = [];
}

async function transcribeVoiceRecording(blob) {
  if (!canUseHermesVoiceTranscription()) {
    const error = new Error('Hermes audio transcription is unavailable on this gateway.');
    error.fallbackToWebSpeech = true;
    throw error;
  }
  const dataUrl = await blobToDataUrl(blob);
  const response = await apiFetch(AUDIO_TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(buildAudioTranscriptionBody(dataUrl, blob.type || 'audio/webm')),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(body || `Hermes voice transcription failed (${response.status})`);
    error.status = response.status;
    error.fallbackToWebSpeech = shouldFallbackToWebSpeechForTranscription(response.status);
    throw error;
  }
  const payload = await response.json();
  return String(payload?.transcript || '').trim();
}

function ensureSpeechRecognition() {
  if (speechRecognition) return speechRecognition;
  const Recognition = speechRecognitionConstructor();
  if (!Recognition) return null;
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  recognition.onresult = (event) => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index]?.[0]?.transcript || '';
      if (event.results[index]?.isFinal) dictationFinalText = `${dictationFinalText} ${transcript}`.trim();
      else interim = `${interim} ${transcript}`.trim();
    }
    applyDictationTranscript([dictationFinalText, interim].filter(Boolean).join(' '));
  };
  recognition.onerror = (event) => {
    if (isMicrophonePermissionError(event)) {
      setStatus('warn', 'Microphone permission blocked', microphonePermissionHelp());
      return;
    }
    setStatus('warn', 'Voice dictation stopped', event.error || 'Speech recognition error');
  };
  recognition.onend = () => {
    dictating = false;
    updateVoiceButtonState();
  };
  speechRecognition = recognition;
  return speechRecognition;
}

function startWebSpeechDictation(detail = 'Speak to dictate into the Hermes composer.') {
  const recognition = ensureSpeechRecognition();
  if (!recognition) return false;
  dictationFinalText = '';
  try {
    recognition.start();
    dictating = true;
    updateVoiceButtonState();
    setStatus('ok', 'Listening', detail);
    return true;
  } catch (error) {
    dictating = false;
    updateVoiceButtonState();
    setStatus('warn', 'Voice dictation unavailable', error?.message || String(error));
    return false;
  }
}

async function startRecorderDictation() {
  const permitted = await ensureExtensionAudioPermission();
  if (!permitted) {
    throw microphonePermissionError();
  }
  await ensureMicrophoneOriginPermission();
  const stream = await getMicrophoneStreamWithPermissionRetry();
  const mimeType = preferredVoiceMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  voiceRecorderStream = stream;
  voiceRecorder = recorder;
  voiceRecorderChunks = [];

  recorder.ondataavailable = (event) => {
    if (event.data?.size > 0) voiceRecorderChunks.push(event.data);
  };
  recorder.onerror = (event) => {
    cleanupVoiceRecorder();
    dictating = false;
    updateVoiceButtonState();
    setStatus('warn', 'Voice recording failed', event?.error?.message || 'Could not capture microphone audio.');
  };
  recorder.onstop = async () => {
    const chunks = voiceRecorderChunks;
    const recordingType = recorder.mimeType || mimeType || 'audio/webm';
    cleanupVoiceRecorder();
    dictating = false;
    updateVoiceButtonState();
    if (!chunks.length) {
      setStatus('warn', 'No speech captured', 'Try recording again.');
      return;
    }
    try {
      setStatus('ok', 'Transcribing voice', 'Using Hermes speech-to-text, matching Desktop dictation.');
      const transcript = await transcribeVoiceRecording(new Blob(chunks, { type: recordingType }));
      if (!transcript) {
        setStatus('warn', 'No speech detected', 'Try recording again.');
        return;
      }
      applyDictationTranscript(transcript);
      setStatus('ok', 'Voice dictation ready', 'Transcript inserted into the composer.');
    } catch (error) {
      if (error?.fallbackToWebSpeech && startWebSpeechDictation('Hermes transcription route is unavailable. Using browser speech fallback; speak again.')) {
        return;
      }
      setStatus('warn', 'Voice transcription failed', error?.message || String(error));
    }
  };

  recorder.start();
  dictating = true;
  updateVoiceButtonState();
  setStatus('ok', 'Recording voice', 'Click the mic again to transcribe with Hermes speech-to-text.');
}

function stopRecorderDictation() {
  const recorder = voiceRecorder;
  if (!recorder) return false;
  try {
    if (recorder.state !== 'inactive') recorder.stop();
  } catch (error) {
    cleanupVoiceRecorder();
    dictating = false;
    updateVoiceButtonState();
    setStatus('warn', 'Voice recording failed', error?.message || String(error));
  }
  return true;
}

async function toggleVoiceDictation() {
  if (dictating) {
    if (stopRecorderDictation()) return;
    speechRecognition?.stop?.();
    return;
  }
  dictationBaseText = els.input.value.trim();
  dictationFinalText = '';
  await loadGatewayCapabilities({ quiet: true, healthOk: isConnected() }).catch(() => {});
  if (!canUseHermesVoiceTranscription() && startWebSpeechDictation('Hermes transcription route is unavailable. Using browser speech fallback.')) return;
  if (canUseHermesVoiceTranscription()) {
    try {
      await startRecorderDictation();
      return;
    } catch (error) {
      console.warn('Hermes voice recorder unavailable', error);
      cleanupVoiceRecorder();
      dictating = false;
      updateVoiceButtonState();
      if (isMicrophonePermissionError(error)) {
        await openVoiceDictationPage('Comet/Chromium blocked microphone capture inside the side panel. Use this visible Hermes Voice tab once; it will transcribe locally through Hermes and send the text back here.');
        return;
      }
      if (startWebSpeechDictation('Hermes microphone capture failed. Using browser speech fallback.')) return;
      setStatus('warn', 'Voice dictation unavailable', error?.message || String(error));
      return;
    }
  }
  if (startWebSpeechDictation()) return;
  await openVoiceDictationPage('This side panel context cannot capture microphone audio directly. Use the Hermes Voice tab to dictate into the composer.');
  updateVoiceButtonState();
}

function formatNumber(value = 0) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function formatTokens(tokens = 0) {
  if (!tokens) return '0 tokens';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens`;
  return `${formatNumber(tokens)} tokens`;
}

function estimateLocalSessionTokens(userText = '') {
  const messageTokens = messages.reduce((total, message) => total + estimateTokens(message.content || ''), 0);
  return messageTokens + estimateTokens(userText || '') + estimateAttachmentTokens();
}

function numericTokenField(value = 0) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function usageTokenTotal(usage = {}) {
  if (!usage || typeof usage !== 'object') return 0;
  const explicit = numericTokenField(usage.total_tokens || usage.totalTokens);
  if (explicit) return explicit;
  return numericTokenField(usage.input_tokens || usage.prompt_tokens || usage.inputTokens || usage.promptTokens)
    + numericTokenField(usage.output_tokens || usage.completion_tokens || usage.outputTokens || usage.completionTokens)
    + numericTokenField(usage.cache_read_tokens || usage.cacheReadTokens)
    + numericTokenField(usage.cache_write_tokens || usage.cacheWriteTokens)
    + numericTokenField(usage.reasoning_tokens || usage.reasoningTokens);
}

function sessionTokenTotal(session = {}) {
  if (!session || typeof session !== 'object') return 0;
  const explicit = numericTokenField(session.total_tokens || session.totalTokens);
  if (explicit) return explicit;
  return numericTokenField(session.input_tokens || session.inputTokens)
    + numericTokenField(session.output_tokens || session.outputTokens)
    + numericTokenField(session.cache_read_tokens || session.cacheReadTokens)
    + numericTokenField(session.cache_write_tokens || session.cacheWriteTokens)
    + numericTokenField(session.reasoning_tokens || session.reasoningTokens);
}

function runtimeContextTokens(runtime = {}) {
  if (!runtime || typeof runtime !== 'object') return 0;
  return numericTokenField(runtime.context_length || runtime.contextLength || runtime.context_tokens || runtime.contextTokens);
}

function applySessionRuntimeSnapshot({ session = null, usage = null, runtime = null, sessionId = settings.sessionId, source = 'session' } = {}) {
  const id = String(sessionId || session?.id || activeSessionRuntime.sessionId || settings.sessionId || '');
  const sameSession = !activeSessionRuntime.sessionId || activeSessionRuntime.sessionId === id;
  const accounting = contextAccountingSnapshot({
    runtime,
    usage,
    session,
    modelContextTokens: sameSession ? activeSessionRuntime.contextTokens || settings.modelContextTokens : settings.modelContextTokens,
  });
  const contextTokens = accounting.contextLimitTokens;
  const existingModel = sameSession ? String(activeSessionRuntime.model || '').trim() : '';
  const existingProvider = sameSession ? String(activeSessionRuntime.provider || '').trim() : '';
  activeSessionRuntime = {
    sessionId: id,
    usedTokens: Math.max(
      sameSession ? numericTokenField(activeSessionRuntime.usedTokens) : 0,
      accounting.sessionSpendTokens,
      accounting.lastTurnSpendTokens,
    ),
    liveContextTokens: accounting.liveContextTokens,
    nextPromptTokens: accounting.nextPromptTokens,
    lastTurnSpendTokens: accounting.lastTurnSpendTokens,
    sessionSpendTokens: Math.max(
      sameSession ? numericTokenField(activeSessionRuntime.sessionSpendTokens) : 0,
      accounting.sessionSpendTokens,
    ),
    inputTokens: Math.max(
      sameSession ? numericTokenField(activeSessionRuntime.inputTokens) : 0,
      numericTokenField(session?.input_tokens || session?.inputTokens),
      numericTokenField(usage?.input_tokens || usage?.prompt_tokens || usage?.inputTokens || usage?.promptTokens),
    ),
    outputTokens: Math.max(
      sameSession ? numericTokenField(activeSessionRuntime.outputTokens) : 0,
      numericTokenField(session?.output_tokens || session?.outputTokens),
      numericTokenField(usage?.output_tokens || usage?.completion_tokens || usage?.outputTokens || usage?.completionTokens),
    ),
    contextTokens,
    model: String(runtime?.model || existingModel || session?.model || '').trim(),
    provider: String(runtime?.provider || existingProvider || session?.provider || '').trim(),
    source: accounting.source === 'runtime' ? source : 'local-estimate',
  };
  if (contextTokens && contextTokens !== settings.modelContextTokens) {
    settings = { ...settings, modelContextTokens: contextTokens };
  }
  renderContextWindow();
}

function syncActiveSessionRuntimeFromList() {
  const session = availableSessions.find((item) => item.id === settings.sessionId);
  if (session) applySessionRuntimeSnapshot({ session, sessionId: session.id, source: 'Hermes session' });
}

const TEXT_ATTACHMENT_LIMIT = 12_000;
const IMAGE_ATTACHMENT_TOKEN_ESTIMATE = 1_200;
const BROWSER_IMAGE_UPLOAD_ENDPOINT = '/api/browser-extension/uploads/images';
const UPDATE_PACKAGE_URL = 'https://raw.githubusercontent.com/abundantbeing/hermes-browser-extension/main/package.json';
const UPDATE_MAIN_COMMIT_URL = 'https://api.github.com/repos/abundantbeing/hermes-browser-extension/commits/main';
const UPDATE_COMPARE_URL = 'https://api.github.com/repos/abundantbeing/hermes-browser-extension/compare';
const REPO_URL = 'https://github.com/abundantbeing/hermes-browser-extension';
const runtimeManifest = globalThis.chrome?.runtime?.getManifest?.() || {};
const CURRENT_EXTENSION_VERSION = normalizeExtensionVersion(runtimeManifest, els.versionLabel?.textContent);

const COLOR_MODES = new Set(['light', 'dark', 'system']);
const APPEARANCE_THEMES = Object.freeze([
  {
    value: 'nous',
    name: 'Nous',
    description: 'Ink blue with soft-white Desktop accents',
    preview: { bg: '#0505e8', panel: '#0505e8', text: '#f8faff', muted: '#dbe6ff', accent: '#f8faff' },
  },
  {
    value: 'midnight',
    name: 'Midnight',
    description: 'Deep blue-violet with cool accents',
    preview: { bg: '#07061a', panel: '#0d0b25', text: '#d9d2ff', muted: '#8e88bd', accent: '#1d1850' },
  },
  {
    value: 'ember',
    name: 'Ember',
    description: 'Warm crimson and bronze forge',
    preview: { bg: '#1a0600', panel: '#250800', text: '#ffd0a4', muted: '#c98f65', accent: '#4b1603' },
  },
  {
    value: 'mono',
    name: 'Mono',
    description: 'Clean grayscale minimal focus',
    preview: { bg: '#0d0d0d', panel: '#111111', text: '#eeeeee', muted: '#9b9b9b', accent: '#1f1f1f' },
  },
  {
    value: 'cyberpunk',
    name: 'Cyberpunk',
    description: 'Neon green terminal',
    preview: { bg: '#001004', panel: '#001b08', text: '#12ff68', muted: '#00a947', accent: '#002d10' },
  },
  {
    value: 'slate',
    name: 'Slate',
    description: 'Cool slate blue developer focus',
    preview: { bg: '#081015', panel: '#0e171e', text: '#d0dbe2', muted: '#94a3ad', accent: '#172c3d' },
  },
]);
const DEFAULT_APPEARANCE_THEME = APPEARANCE_THEMES[0].value;
const systemColorQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function normalizeColorMode(value = DEFAULT_SETTINGS.colorMode) {
  const raw = String(value || DEFAULT_SETTINGS.colorMode || 'dark').trim().toLowerCase();
  return COLOR_MODES.has(raw) ? raw : (DEFAULT_SETTINGS.colorMode || 'dark');
}

function normalizeAppearanceTheme(value = DEFAULT_SETTINGS.appearanceTheme) {
  const raw = String(value || DEFAULT_SETTINGS.appearanceTheme || DEFAULT_APPEARANCE_THEME).trim().toLowerCase();
  return APPEARANCE_THEMES.some((theme) => theme.value === raw) ? raw : DEFAULT_APPEARANCE_THEME;
}

function resolvedColorMode(value = settings.colorMode) {
  const mode = normalizeColorMode(value);
  if (mode === 'system') return systemColorQuery?.matches ? 'dark' : 'light';
  return mode;
}

function applyAppearanceSettings() {
  const theme = normalizeAppearanceTheme(settings.appearanceTheme);
  const colorMode = normalizeColorMode(settings.colorMode);
  const textSize = normalizeTextSize(settings.textSize);
  const resolvedMode = resolvedColorMode(colorMode);
  const root = document.documentElement;
  root.dataset.hermesTheme = theme;
  root.dataset.hermesColorMode = colorMode;
  root.dataset.hermesTextSize = textSize;
  root.dataset.hermesMode = resolvedMode;
  root.style.colorScheme = resolvedMode;
}

function renderAppearanceControls() {
  applyAppearanceSettings();
  const colorMode = normalizeColorMode(settings.colorMode);
  const activeTheme = normalizeAppearanceTheme(settings.appearanceTheme);
  for (const button of els.colorModeButtons || []) {
    const selected = button.dataset.colorMode === colorMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  }
  const textSize = normalizeTextSize(settings.textSize);
  for (const button of els.textSizeButtons || []) {
    const selected = button.dataset.textSize === textSize;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  }
  if (!els.themeGrid) return;
  els.themeGrid.innerHTML = APPEARANCE_THEMES.map((theme) => {
    const selected = theme.value === activeTheme;
    const p = theme.preview;
    return `
      <button class="theme-card ${selected ? 'selected' : ''}" type="button" data-theme="${theme.value}" role="radio" aria-checked="${selected}" aria-label="${theme.name}: ${theme.description}" title="${theme.name}: ${theme.description}" style="--preview-bg:${p.bg};--preview-panel:${p.panel};--preview-text:${p.text};--preview-muted:${p.muted};--preview-accent:${p.accent};">
        <span class="theme-preview" aria-hidden="true"><span></span><span></span><span></span></span>
        <span class="theme-card-copy"><strong>${theme.name}</strong></span>
        <span class="theme-check" aria-hidden="true">${selected ? '✓' : ''}</span>
      </button>
    `;
  }).join('');
}

function persistAppearanceSettings() {
  chrome.storage.local.set({ hermesBrowserSettings: settings });
}

function setAppearanceOption(key, value, { persist = true } = {}) {
  if (key === 'colorMode') settings = { ...settings, colorMode: normalizeColorMode(value) };
  if (key === 'appearanceTheme') settings = { ...settings, appearanceTheme: normalizeAppearanceTheme(value) };
  if (key === 'textSize') settings = { ...settings, textSize: normalizeTextSize(value) };
  renderAppearanceControls();
  if (persist) persistAppearanceSettings();
}


function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function attachmentIcon(kind = '') {
  return ({ file: '📄', folder: '📁', image: '🖼', url: '🔗' })[kind] || '📎';
}

function attachmentId(kind, label) {
  return `${kind}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2)}:${label}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

async function readFileAsText(file) {
  try {
    return await file.text();
  } catch {
    return '';
  }
}

function isLikelyTextFile(file) {
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return type.startsWith('text/') || /\.(txt|md|markdown|json|csv|ts|tsx|js|jsx|mjs|css|html|xml|yaml|yml|toml|py|rs|go|java|c|cpp|h|hpp|sql|log)$/i.test(name);
}

function addAttachment(attachment) {
  attachments = [...attachments.filter((item) => item.id !== attachment.id), attachment];
  renderAttachments();
  renderContextWindow();
}

function removeAttachment(id) {
  attachments = attachments.filter((item) => item.id !== id);
  renderAttachments();
  renderContextWindow();
}

function clearAttachments() {
  attachments = [];
  renderAttachments();
  renderContextWindow();
}

function renderAttachments() {
  els.attachmentList.innerHTML = '';
  els.attachmentList.hidden = attachments.length === 0;
  for (const attachment of attachments) {
    const pill = document.createElement('div');
    pill.className = `attachment-pill ${attachment.kind === 'image' ? 'image' : ''}`.trim();
    pill.title = attachment.detail || attachment.label;

    const icon = attachment.kind === 'image' && attachment.dataUrl
      ? document.createElement('img')
      : document.createElement('strong');
    if (icon.tagName === 'IMG') {
      icon.className = 'attachment-thumb';
      icon.src = attachment.dataUrl;
      icon.alt = '';
    } else {
      icon.textContent = attachmentIcon(attachment.kind);
    }

    const label = document.createElement('span');
    label.textContent = attachment.localPath ? `${attachment.label} · saved` : attachment.label;

    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', `Remove ${attachment.label}`);
    close.textContent = '×';
    close.addEventListener('click', () => removeAttachment(attachment.id));

    pill.append(icon, label, close);
    els.attachmentList.appendChild(pill);
  }
  updateComposerBusyState();
}

async function uploadImageAttachment(attachment) {
  if (!attachment || attachment.kind !== 'image' || !attachment.dataUrl || attachment.localPath || !settings.apiKey) {
    return attachment;
  }
  if (!gatewayCapabilities.imageUpload) {
    return {
      ...attachment,
      uploadSkipped: true,
      uploadError: 'Image upload unavailable — pasted image stayed inline only.',
    };
  }
  const response = await apiFetch(BROWSER_IMAGE_UPLOAD_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({
      data_url: attachment.dataUrl,
      filename: attachment.label,
      session_id: settings.sessionId,
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok || !payload?.path) {
    throw new Error(payload?.error?.message || payload?.error || `Image upload failed (${response.status})`);
  }
  return {
    ...attachment,
    localPath: payload.path,
    savedFilename: payload.filename,
    mimeType: payload.mime_type,
    savedSize: payload.size,
    detail: `${attachment.detail || payload.mime_type || 'image'} · local path ready`,
    uploadError: '',
  };
}

async function ensureImageAttachmentsSaved() {
  if (!attachments.some((attachment) => attachment.kind === 'image' && attachment.dataUrl && !attachment.localPath)) return;
  if (!settings.apiKey) return;
  const next = await saveImageAttachmentsForTurn(attachments);
  attachments = next;
  renderAttachments();
  renderContextWindow();
}

async function saveImageAttachmentsForTurn(items = []) {
  if (!items.some((attachment) => attachment.kind === 'image' && attachment.dataUrl && !attachment.localPath)) return items;
  if (!settings.apiKey) return items;
  let saved = 0;
  let failed = 0;
  let skipped = 0;
  const next = [];
  for (const attachment of items) {
    if (attachment.kind !== 'image' || !attachment.dataUrl || attachment.localPath) {
      next.push(attachment);
      continue;
    }
    try {
      const uploaded = await uploadImageAttachment(attachment);
      if (uploaded.localPath) saved += 1;
      if (uploaded.uploadSkipped) skipped += 1;
      next.push(uploaded);
    } catch (error) {
      failed += 1;
      next.push({ ...attachment, uploadError: error?.message || String(error) });
    }
  }
  if (saved) setStatus('ok', 'Image ready for Hermes vision', `${saved} pasted image${saved === 1 ? '' : 's'} saved locally`);
  if (skipped) setStatus('warn', 'Image stayed inline only', `${skipped} image${skipped === 1 ? '' : 's'} kept as inline context because this Hermes runtime has no image upload route.`);
  if (failed) setStatus('warn', 'Image stayed inline only', `${failed} image${failed === 1 ? '' : 's'} could not be saved locally`);
  return next;
}

async function attachFiles(fileList, { imagesOnly = false } = {}) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (!file) continue;
    const isImage = String(file.type || '').startsWith('image/');
    if (imagesOnly && !isImage) continue;
    if (isImage) {
      const dataUrl = await readFileAsDataUrl(file);
      addAttachment({
        id: attachmentId('image', file.name),
        kind: 'image',
        label: file.name || 'image',
        detail: `${file.type || 'image'} · ${formatBytes(file.size)}`,
        dataUrl,
      });
      continue;
    }
    const text = isLikelyTextFile(file) ? clampText(await readFileAsText(file), TEXT_ATTACHMENT_LIMIT) : '';
    addAttachment({
      id: attachmentId('file', file.name),
      kind: 'file',
      label: file.name || 'file',
      detail: `${file.type || 'file'} · ${formatBytes(file.size)}`,
      text: text || `[${file.name || 'file'} attached as metadata only: ${formatBytes(file.size)}. Browser cannot expose a stable local path; use Hermes Desktop for path-backed file refs.]`,
    });
  }
}

async function attachFolder(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const firstPath = files[0].webkitRelativePath || files[0].name || 'folder';
  const folderName = firstPath.split('/')[0] || 'folder';
  const manifest = files
    .slice(0, 300)
    .map((file) => `${file.webkitRelativePath || file.name} (${formatBytes(file.size)})`)
    .join('\n');
  const omitted = files.length > 300 ? `\n... ${files.length - 300} more files omitted` : '';
  addAttachment({
    id: attachmentId('folder', folderName),
    kind: 'folder',
    label: folderName,
    detail: `${files.length} file${files.length === 1 ? '' : 's'}`,
    text: `Folder: ${folderName}\nFiles:\n${manifest}${omitted}`,
  });
}

async function pasteClipboardImage() {
  if (!navigator.clipboard?.read) {
    throw new Error('Use Ctrl+V inside the Ask Hermes box to paste images. Chrome does not expose global clipboard image read here.');
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const file = new File([blob], `clipboard-${Date.now()}.png`, { type });
      await attachFiles([file], { imagesOnly: true });
      setStatus('ok', 'Image attached from clipboard', file.name);
      return;
    }
    throw new Error('Clipboard does not contain an image.');
  } catch (error) {
    throw new Error(`${error?.message || String(error)} Try Ctrl+V in the message box; Hermes Browser Extension handles pasted image data directly from that paste event.`);
  }
}

function imageFilesFromPasteEvent(event) {
  const data = event?.clipboardData;
  if (!data) return [];
  const files = [];
  for (const item of Array.from(data.items || [])) {
    if (!String(item.type || '').startsWith('image/')) continue;
    const file = item.getAsFile?.();
    if (file) files.push(new File([file], file.name || `pasted-image-${Date.now()}.png`, { type: file.type || item.type }));
  }
  for (const file of Array.from(data.files || [])) {
    if (String(file.type || '').startsWith('image/') && !files.some((candidate) => candidate.name === file.name && candidate.size === file.size)) {
      files.push(file);
    }
  }
  return files;
}

function imageDataUrlsFromPasteEvent(event) {
  const data = event?.clipboardData;
  if (!data) return [];
  const urls = [];
  const html = data.getData?.('text/html') || '';
  const plain = data.getData?.('text/plain') || '';
  const dataUrlPattern = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
  for (const source of [html, plain]) {
    for (const match of source.matchAll(dataUrlPattern)) {
      if (!urls.includes(match[0])) urls.push(match[0]);
    }
  }
  return urls.slice(0, 6);
}

async function handlePasteImages(event) {
  const imageFiles = imageFilesFromPasteEvent(event);
  const dataUrls = imageDataUrlsFromPasteEvent(event);
  if (!imageFiles.length && !dataUrls.length) return false;
  event.preventDefault();
  if (imageFiles.length) await attachFiles(imageFiles, { imagesOnly: true });
  for (const dataUrl of dataUrls) {
    addAttachment({
      id: attachmentId('image', 'pasted-image'),
      kind: 'image',
      label: `pasted-image-${Date.now()}.png`,
      detail: 'image data pasted from clipboard',
      dataUrl,
    });
  }
  const total = imageFiles.length + dataUrls.length;
  setStatus('ok', 'Image pasted into Hermes', `${total} image${total === 1 ? '' : 's'} attached`);
  els.input.focus();
  return true;
}

function dragEventHasFiles(event) {
  return Array.from(event?.dataTransfer?.types || []).includes('Files');
}

function setDropActive(active) {
  els.composerDropZone?.classList.toggle('dragging', Boolean(active));
  if (els.dropOverlay) els.dropOverlay.hidden = !active;
}

async function handleComposerDrop(event) {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dragDepth = 0;
  setDropActive(false);
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  await attachFiles(files);
  setStatus('ok', 'Files attached', `${files.length} file${files.length === 1 ? '' : 's'} added from drag/drop`);
  els.input.focus();
}

function attachUrl() {
  const value = window.prompt('Attach URL');
  if (!value) return;
  let url = value.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  addAttachment({
    id: attachmentId('url', url),
    kind: 'url',
    label: url,
    detail: url,
    text: `URL attachment: ${url}`,
  });
}

function imageAttachmentPromptLine(image, index) {
  const lines = [`- Image ${index + 1}: ${image.label} (${image.detail || 'image'})`];
  if (image.localPath) {
    lines.push(`  - Local file path: ${image.localPath}`);
    lines.push('  - These are the actual pasted pixels saved by Hermes Browser Extension; use this path with vision tools if inline image input is unavailable.');
  } else {
    lines.push('  - Inline image data is included in the structured message payload.');
    if (image.uploadError) lines.push(`  - Local save warning: ${image.uploadError}`);
  }
  return lines.join('\n');
}

function attachmentContextText(items = attachments) {
  const blocks = items
    .filter((attachment) => attachment.kind !== 'image')
    .map((attachment) => `### ${attachment.kind.toUpperCase()}: ${attachment.label}\n${attachment.text || attachment.detail || ''}`);
  const images = items.filter((attachment) => attachment.kind === 'image');
  if (images.length) blocks.push(`### IMAGES\n${images.map(imageAttachmentPromptLine).join('\n')}`);
  return blocks.length ? `\n\n--- Browser Attachments ---\n${blocks.join('\n\n')}` : '';
}

function estimateAttachmentTokens(items = attachments) {
  return estimateTokens(attachmentContextText(items)) + (items.filter((attachment) => attachment.kind === 'image').length * IMAGE_ATTACHMENT_TOKEN_ESTIMATE);
}

function userTextWithAttachments(userText = '', items = attachments) {
  const text = String(userText || '').trim();
  return `${text || 'Attachment-only turn.'}${attachmentContextText(items)}`;
}

function outboundContent(prompt = '', items = attachments) {
  const images = items.filter((attachment) => attachment.kind === 'image' && attachment.dataUrl);
  if (!images.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.slice(0, 6).map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } })),
  ];
}

function modelProviderLabel(model = {}) {
  return String(model.providerLabel || model.provider || model.owner || 'Models');
}

function updateModelButtonMeta() {
  const effort = reasoningEffortShortLabel(settings.reasoningEffort);
  const fastMode = normalizeFastMode(settings.fastMode);
  const fast = fastMode ? ' Fast' : '';
  els.currentModelEffort.textContent = `${fast}${effort}`.trim();
  els.currentModelEffort.title = `Reasoning effort: ${effort}${fastMode ? ' · Fast' : ''}`;
}

function renderModelOptions(models = availableModels) {
  const normalized = models.length ? models : normalizeHermesModels([], settings.model);
  availableModels = normalized;
  const selectedIsDefaultFallback =
    settings.model === DEFAULT_SETTINGS.model &&
    normalized.length > 1 &&
    normalized[0]?.id !== settings.model;
  const selectedModel = normalized.find((model) => model.id === settings.model);
  if (selectedModel?.source === 'external') {
    const runtimeModel = normalized.find((model) => isModelRuntimeSelectable(model));
    settings.model = runtimeModel?.id || DEFAULT_SETTINGS.model;
  } else if (selectedIsDefaultFallback || !selectedModel) {
    settings.model = normalized[0]?.id || DEFAULT_SETTINGS.model;
  }
  const selected = normalized.find((model) => model.id === settings.model) || normalized[0];
  if (selected) {
    settings.modelContextTokens = selected.contextTokens || 0;
    const providerLabel = modelProviderLabel(selected);
    if (!selectedModelProvider || !normalized.some((model) => modelProviderLabel(model) === selectedModelProvider)) {
      selectedModelProvider = providerLabel;
    }
    const runtimeStatus = modelRuntimeStatus(selected);
    els.currentModelName.textContent = modelDisplayName(selected);
    els.currentModelName.title = `${selected.providerLabel || selected.provider || ''} ${selected.rawModelId || selected.id} · ${runtimeStatus.detail}`.trim();
    updateModelButtonMeta();
  }
  renderModelMenu();
  renderModelRuntimeOptions();
  renderContextWindow();
}

function renderModelMenu(query = els.modelSearchInput?.value || '') {
  const allGroups = groupModelsForMenu(availableModels, settings.model, '');
  const needle = String(query || '').trim().toLowerCase();
  const matchingGroups = needle ? groupModelsForMenu(availableModels, settings.model, needle) : allGroups;
  els.modelProviderList.innerHTML = '';
  els.modelMenuList.innerHTML = '';

  if (!allGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'model-group-title';
    empty.textContent = 'No providers found';
    els.modelMenuList.appendChild(empty);
    return;
  }

  const selectedModel = availableModels.find((model) => model.id === settings.model);
  const selectedProvider = selectedModel ? modelProviderLabel(selectedModel) : '';
  if (!selectedModelProvider) selectedModelProvider = selectedProvider || allGroups[0].label;
  if (!allGroups.some((group) => group.label === selectedModelProvider)) selectedModelProvider = allGroups[0].label;

  const providerGroups = needle ? matchingGroups : allGroups;
  for (const group of providerGroups) {
    const providerButton = document.createElement('button');
    providerButton.type = 'button';
    providerButton.className = `model-provider-option ${group.label === selectedModelProvider ? 'selected' : ''}`.trim();
    providerButton.dataset.provider = group.label;

    const providerName = document.createElement('span');
    providerName.className = 'model-provider-name';
    providerName.textContent = group.label;

    const providerCount = document.createElement('span');
    providerCount.className = 'model-provider-count';
    providerCount.textContent = String(group.models.length);

    providerButton.append(providerName, providerCount);
    providerButton.addEventListener('click', () => {
      selectedModelProvider = group.label;
      els.modelSearchInput.value = '';
      renderModelMenu('');
      els.modelSearchInput.focus();
    });
    els.modelProviderList.appendChild(providerButton);
  }

  const groupsToRender = needle
    ? matchingGroups
    : [allGroups.find((group) => group.label === selectedModelProvider) || allGroups[0]];

  if (!groupsToRender.length) {
    const empty = document.createElement('div');
    empty.className = 'model-group-title';
    empty.textContent = 'No models match';
    els.modelMenuList.appendChild(empty);
    return;
  }

  for (const group of groupsToRender) {
    const title = document.createElement('div');
    title.className = 'model-group-title';
    title.textContent = needle ? `${group.label} ${group.models.length}` : `${group.label} ${group.models.length}/${group.models.length}`;
    els.modelMenuList.appendChild(title);

    for (const model of group.models) {
      const runtimeStatus = modelRuntimeStatus(model);
      const requestable = isModelRuntimeSelectable(model);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `model-option ${model.selected ? 'selected' : ''} ${requestable ? '' : 'observed'}`.trim();
      button.dataset.modelId = model.id;
      button.title = runtimeStatus.detail;
      if (model.source === 'external') {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
      }

      const name = document.createElement('span');
      name.className = 'model-option-name';
      name.textContent = modelDisplayName(model);

      const meta = document.createElement('span');
      meta.className = 'model-option-meta';
      meta.textContent = model.selected ? '✓' : (!requestable ? 'observed' : (model.contextTokens ? formatTokens(model.contextTokens).replace(' tokens', '') : runtimeStatus.label));

      button.append(name, meta);
      button.addEventListener('click', () => applySelectedModel(model.id, { keepOpen: true }));
      els.modelMenuList.appendChild(button);
    }
  }
}

function renderModelRuntimeOptions() {
  if (!els.modelOptionsList) return;
  const thinkingEnabled = settings.thinkingEnabled !== false;
  const fastMode = normalizeFastMode(settings.fastMode);
  const effort = normalizeReasoningEffort(settings.reasoningEffort);
  const effortRows = MODEL_EFFORTS.map((item) => `
    <button class="model-effort-option ${item.value === effort ? 'selected' : ''}" type="button" data-effort="${item.value}">
      <span>${item.label}</span><strong>${item.value === effort ? '✓' : ''}</strong>
    </button>
  `).join('');
  els.modelOptionsList.innerHTML = `
    <div class="model-options-heading">Options</div>
    <button class="model-toggle-option" type="button" data-toggle="thinking" aria-pressed="${String(thinkingEnabled)}">
      <span>Thinking</span><strong class="toggle-switch ${thinkingEnabled ? 'on' : ''}" aria-hidden="true"></strong>
    </button>
    <button class="model-toggle-option" type="button" data-toggle="fast" aria-pressed="${String(fastMode)}">
      <span>Fast</span><strong class="toggle-switch ${fastMode ? 'on' : ''}" aria-hidden="true"></strong>
    </button>
    <div class="model-options-heading effort-heading">Effort</div>
    <div class="model-effort-list">${effortRows}</div>
  `;
}

function persistModelRuntimeOptions() {
  chrome.storage.local.set({ hermesBrowserSettings: settings });
}

function setModelRuntimeOption(key, value) {
  settings = { ...settings, [key]: value };
  renderModelRuntimeOptions();
  updateModelButtonMeta();
  persistModelRuntimeOptions();
}

function renderContextWindow(userText = els.input?.value || '') {
  const stats = estimateContextWindow({
    userText,
    activeTab: currentContext.activeTab,
    tabs: currentContext.tabs,
    selectedTabs: currentContext.selectedTabs,
    pageContext: currentContext.pageContext,
    contextScope,
    settings,
  });
  const attachmentTokens = estimateAttachmentTokens();
  const accounting = contextAccountingSnapshot({
    localPromptTokens: stats.estimatedTokens,
    draftTokens: attachmentTokens,
    runtime: activeSessionRuntime.sessionId === settings.sessionId ? activeSessionRuntime : {},
    modelContextTokens: stats.modelContextTokens,
  });
  const contextLimit = accounting.contextLimitTokens || stats.modelContextTokens;
  const runtimeLabel = [activeSessionRuntime.provider, activeSessionRuntime.model].filter(Boolean).join(' · ');
  const meter = contextMeterDisplay({ accounting, runtimeLabel, modelContextTokens: contextLimit });

  els.contextCompactLabel.textContent = meter.compactLabel;
  els.contextPercentLabel.textContent = meter.percentLabel;
  els.contextBarButton.title = meter.title;
  els.contextUsageDetail.textContent = meter.detail;
  els.contextMeterFill.style.width = contextLimit ? `${Math.min(100, Math.max(0, meter.percent))}%` : '0%';
  const controls = contextControlState({ capabilities: gatewayCapabilities, percentUsed: meter.percent });
  if (els.contextControlStatus) {
    els.contextControlStatus.textContent = controls.compactRecommended
      ? 'Context is getting full — compact when the runtime supports it.'
      : controls.label;
  }
  if (els.contextCompactButton) {
    els.contextCompactButton.disabled = !controls.canCompact || !settings.sessionId;
    els.contextCompactButton.textContent = controls.compactRecommended ? 'Compact recommended' : 'Compact context';
    els.contextCompactButton.title = controls.canCompact
      ? 'Ask Hermes to compact this session context.'
      : 'The connected Hermes runtime does not advertise native session compaction.';
  }

  const pc = currentContext?.pageContext;
  if (contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) {
    els.contextChipLabel.textContent = '💬 Chat only';
    els.contextChip.title = 'No browser tab, selected text, open tabs, metadata, transcript, or page text will be attached.';
    els.contextPreview.textContent = 'Chat only mode is active. Hermes will not read or attach browser context for this turn.';
  } else {
    const chip = contextChipSummary({ pageContext: pc, activeTab: currentContext.activeTab, parts: stats.parts });
    els.contextChipLabel.textContent = chip.label;
    els.contextChip.title = chip.title;
    els.contextPreview.textContent = [
      currentContext.activeTab?.title || '(unknown tab)',
      currentContext.activeTab?.url || '',
      '',
      clampText(pc?.selectedText || pc?.text || pc?.reason || pc?.error || 'No readable page text captured yet.', 900),
    ].filter(Boolean).join('\n');
  }

  const rows = [
    ['User draft', stats.parts.userRequest],
    ['Active tab', stats.parts.activeTab],
    ['Open tabs', stats.parts.openTabs],
    ['Selection', stats.parts.selectedText],
    ['Metadata', stats.parts.pageMetadata],
    ['YouTube transcript', stats.parts.youtubeTranscript],
    ['Page text', stats.parts.pageText],
  ];
  els.contextBreakdown.innerHTML = rows.map(([label, part]) => `
    <dt>${label}</dt>
    <dd title="${part.enabled ? 'included' : 'disabled'}">${part.enabled ? `${formatNumber(part.estimatedTokens)} tok · ${formatNumber(part.chars)} chars` : 'disabled'}</dd>
  `).join('');
}

function applySelectedModel(selectedId, { persist = true, keepOpen = false } = {}) {
  const nextId = selectedId || DEFAULT_SETTINGS.model;
  const selected = availableModels.find((model) => model.id === nextId);
  if (selected?.source === 'external') {
    selectedModelProvider = modelProviderLabel(selected);
    renderModelMenu();
    setStatus('warn', 'Custom model source is discovery-only', 'This model was discovered from a custom endpoint, but Hermes must expose it through the connected runtime before Browser can route requests to it.');
    return;
  }
  if (selected) selectedModelProvider = modelProviderLabel(selected);
  settings = {
    ...settings,
    model: nextId,
    modelContextTokens: selected?.contextTokens || 0,
  };
  sessionRoutesAvailable = null;
  renderModelOptions(availableModels);
  if (keepOpen) {
    els.modelMenu.hidden = false;
    els.modelMenuButton.setAttribute('aria-expanded', 'true');
    els.modelSearchInput.focus();
  } else {
    els.modelMenu.hidden = true;
    els.modelMenuButton.setAttribute('aria-expanded', 'false');
  }
  if (persist) chrome.storage.local.set({ hermesBrowserSettings: settings });
  if (persist && selected) {
    modelSelectionVersion += 1;
    pendingModelRuntimeAck = {
      version: modelSelectionVersion,
      model: selected.rawModelId || selected.model || selected.id || nextId,
      provider: selected.provider || '',
      modelLabel: modelDisplayName(selected),
      providerLabel: modelProviderLabel(selected),
    };
    const status = modelRuntimeStatus(selected);
    const detail = `${modelProviderLabel(selected)} · ${modelDisplayName(selected)} — requested; Hermes will confirm the effective runtime model on the next turn.`;
    if (!isModelRuntimeSelectable(selected)) {
      setStatus('warn', 'Observed model requested', `${detail} ${status.detail}`);
    } else {
      setStatus('warn', 'Hermes model requested', detail);
    }
  }
}

function renderModelRefreshState() {
  const state = modelRefreshControlState({ refreshing: modelsRefreshing });
  if (els.refreshModelsButton) {
    els.refreshModelsButton.disabled = state.disabled;
    els.refreshModelsButton.textContent = state.label;
    els.refreshModelsButton.title = state.title;
    els.refreshModelsButton.setAttribute('aria-label', state.title);
    els.refreshModelsButton.setAttribute('aria-busy', state.ariaBusy);
    els.refreshModelsButton.classList.toggle('model-refreshing', modelsRefreshing);
  }
  if (els.modelRefreshStatus) {
    els.modelRefreshStatus.textContent = state.status;
    els.modelRefreshStatus.hidden = !state.status;
  }
}

async function loadModels({ quiet = false, payload = null, refresh = false } = {}) {
  const previousSelectedModel = settings.model;
  const trackRefresh = Boolean(refresh && !payload);
  if (trackRefresh) {
    if (modelsRefreshing) return;
    modelsRefreshing = true;
    renderModelRefreshState();
    if (!quiet) setStatus('ok', 'Refreshing models', 'Syncing Hermes model catalog… this can take 20–30 seconds.');
  }
  try {
    let data = payload;
    let registryModels = [];
    let registrySource = '';

    if (!data && isRemoteWsMode()) {
      // Remote reads go over the WS (REST is CORS-blocked). Only possible once
      // a socket is open; otherwise keep the default model until connected.
      if (remoteWsConnection?.client?.readyState !== 1) {
        availableModels = normalizeHermesModels([], settings.model);
        renderModelOptions(availableModels);
        return;
      }
      data = await remoteWsConnection.client.request(WS_METHODS.modelOptions);
      registrySource = 'dashboard';
    }

    if (data) {
      registryModels = normalizeHermesModels(data, settings.model);
    } else {
      const registryResult = await discoverModelsFromRegistry({ apiFetch, readJsonResponse, refresh });
      if (registryResult.ok && registryResult.models.length) {
        registryModels = normalizeHermesModels(registryResult.models, settings.model);
        registrySource = 'registry';
      } else {
        const dashboardResult = await discoverModelsFromDashboard({
          baseUrl: dashboardModelDiscoveryBaseUrl({
            gatewayMode: settings.gatewayMode,
            gatewayUrl: settings.gatewayUrl,
          }),
          refresh,
          profile: settings.activeProfile,
        });
        if (dashboardResult.ok && dashboardResult.models.length) {
          registryModels = normalizeHermesModels(dashboardResult.models, settings.model);
          registrySource = 'dashboard';
        } else {
          const response = await apiFetch('/v1/models', { method: 'GET' });
          data = await readJsonResponse(response);
          if (!response.ok) throw new Error(data?.error?.message || data?.error || `Model list failed (${response.status})`);
          registryModels = normalizeHermesModels(data, settings.model);
          registrySource = 'v1';
          if (!quiet && registryResult.error && registryResult.error !== 'status-404') {
            setStatus('warn', 'Model registry unavailable', `Falling back to /v1/models (${registryResult.error}).`);
          }
        }
      }
    }

    // If the gateway only exposes a single OpenAI-compatible row, keep a
    // best-effort session-history fallback. The durable source is
    // /api/model/options; sessions are only for older API-server gateways.
    const shouldTrySessionFallback = shouldTrySessionModelFallback({
      registryModels,
      registrySource,
      defaultModelId: DEFAULT_SETTINGS.model,
    });
    if (shouldTrySessionFallback) {
      const sessionResult = await discoverModelsFromSessions({ apiFetch, readJsonResponse });
      if (sessionResult.ok && sessionResult.models.length) {
        const merged = mergeModelsWithRegistry({ registryModels, sessionModels: sessionResult.models });
        if (merged.length > registryModels.length) {
          registryModels = normalizeHermesModels(merged, settings.model);
          registrySource = 'sessions';
          if (!quiet) {
            setStatus(
              'ok',
              'Hermes models synced',
              `${registryModels.length} models available · ${sessionResult.models.length} discovered from session history`,
            );
          }
        }
      } else if (!sessionResult.ok && !quiet) {
        setStatus('warn', 'Model discovery limited', `Gateway exposes only one /v1/models row and /api/sessions was unavailable (${sessionResult.error}).`);
      }
    }

    const customSources = normalizeExternalModelSourceList(settings.customModelSources || []);
    if (customSources.length) {
      const externalResult = await discoverModelsFromExternalSources({
        sourceUrls: customSources,
        fetchFn: globalThis.fetch?.bind(globalThis),
        timeoutMs: 5000,
      });
      if (externalResult.models.length) {
        registryModels = normalizeHermesModels(mergeModelsByRawId([registryModels, externalResult.models]), settings.model);
        registrySource = registrySource ? `${registrySource}+external` : 'external';
      } else if (!quiet && externalResult.results?.length) {
        const failed = externalResult.results.filter((result) => !result.ok).length;
        if (failed) setStatus('warn', 'Custom model source unavailable', `${failed} custom model source${failed === 1 ? '' : 's'} did not respond.`);
      }
    }

    const refreshDecision = modelCatalogRefreshDecision({
      previousSelectedModel,
      discoveredModels: registryModels,
      refresh,
    });
    if (refreshDecision.keepPreviousSelection) {
      settings = { ...settings, model: refreshDecision.selectedModel };
      registryModels = normalizeHermesModels(registryModels, refreshDecision.selectedModel);
      if (!quiet) {
        setStatus('warn', 'Model refresh limited', 'Hermes returned only fallback model data. Keeping your selected model until a real catalog is available.');
      }
    }

    availableModels = registryModels;
    renderModelOptions(availableModels);
    applySelectedModel(settings.model, { persist: false });
    if (!quiet) {
      const sourceLabel = registrySource === 'registry'
        ? 'from Hermes model registry'
        : registrySource === 'dashboard'
          ? 'from Hermes dashboard'
          : registrySource === 'sessions'
            ? 'from session history'
            : registrySource.includes('external')
              ? 'from Hermes plus custom model sources'
              : 'from local Hermes';
      setStatus('ok', 'Hermes models synced', `${availableModels.length} model${availableModels.length === 1 ? '' : 's'} available ${sourceLabel}`);
    }
  } catch (error) {
    availableModels = normalizeHermesModels([], settings.model);
    renderModelOptions(availableModels);
    renderContextWindow();
    const diagnostic = classifyGatewayError(error);
    if (diagnostic.probeStatus === 'degraded') markGatewayDegraded(error);
    if (!quiet) setStatus('warn', diagnostic.kind === 'unknown' ? 'Model sync failed' : diagnostic.title, diagnostic.kind === 'unknown' ? (error?.message || String(error)) : diagnostic.detail);
  } finally {
    if (trackRefresh) {
      modelsRefreshing = false;
      renderModelRefreshState();
    }
  }
}

async function refreshModelsFromMenu() {
  await loadModels({ refresh: true });
}

async function loadSkills({ quiet = false } = {}) {
  if (!settings.apiKey) {
    availableSkills = [];
    renderSkillSuggestions();
    return;
  }
  try {
    const response = await apiFetch('/v1/skills', { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Skills list failed (${response.status})`);
    availableSkills = normalizeHermesSkills(payload);
    renderSkillSuggestions();
    if (!quiet) setStatus('ok', 'Hermes skills synced', `${availableSkills.length} /skill commands available`);
  } catch (error) {
    availableSkills = [];
    renderSkillSuggestions();
    if (!quiet) setStatus('warn', 'Skill sync failed', error?.message || String(error));
  }
}

function replaceActiveSkillToken(command = '') {
  const value = els.input.value;
  const next = value.replace(/(^|\s)([/@][a-z0-9][a-z0-9_-]*)$/i, (_match, prefix) => `${prefix}${command} `);
  els.input.value = next === value ? `${value}${value && !value.endsWith(' ') ? ' ' : ''}${command} ` : next;
  els.skillMenu.hidden = true;
  renderContextWindow();
  els.input.focus();
}

function renderSkillSuggestions() {
  if (!els.skillMenu) return;
  const value = els.input?.value || '';
  const suggestions = skillSuggestionsForInput(value, availableSkills);

  // If user types /, merge builtin commands with skill suggestions
  let builtinSuggestions = [];
  if (value.startsWith('/')) {
    const needle = value.slice(1).toLowerCase();
    builtinSuggestions = BUILTIN_COMMANDS.filter((c) => {
      return !needle || c.name.startsWith(needle) || c.description.toLowerCase().includes(needle);
    }).slice(0, 4);
  }

  if (!builtinSuggestions.length && !suggestions.length) {
    els.skillMenu.hidden = true;
    return;
  }

  els.skillMenu.innerHTML = '';

  // Render builtin commands first
  for (const cmd of builtinSuggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-option builtin-cmd';
    button.setAttribute('role', 'option');
    button.dataset.command = `/${cmd.name}`;
    const name = document.createElement('span');
    name.className = 'skill-option-name';
    name.textContent = `${cmd.icon} ${cmd.name}`;
    const command = document.createElement('span');
    command.className = 'skill-option-command';
    command.textContent = `/${cmd.name}`;
    button.append(name, command);
    button.addEventListener('click', () => {
      els.input.value = `/${cmd.name} `;
      els.input.focus();
      if (!cmd.requiresInput) els.composer.requestSubmit();
    });
    els.skillMenu.appendChild(button);
  }

  // Render gateway skill suggestions
  for (const skill of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-option';
    button.setAttribute('role', 'option');
    button.dataset.command = skill.command;
    const name = document.createElement('span');
    name.className = 'skill-option-name';
    name.textContent = skill.name;
    const command = document.createElement('span');
    command.className = 'skill-option-command';
    command.textContent = skill.command;
    button.append(name, command);
    button.addEventListener('click', () => replaceActiveSkillToken(skill.command));
    els.skillMenu.appendChild(button);
  }
  els.skillMenu.hidden = false;
}

/* ── Composer quick-command menu ── */
function setQuickCommandMenuOpen(open) {
  if (!els.quickMoreMenu) return;
  els.quickMoreMenu.hidden = !open;
  els.commandMenuButton?.setAttribute('aria-expanded', String(Boolean(open)));
  if (!open) clearQuickCommandDetail();
}

function clearQuickCommandDetail() {
  const detail = els.quickMoreMenu?.querySelector('[data-command-detail]');
  if (detail) detail.hidden = true;
  els.quickMoreMenu?.classList.remove('has-command-detail');
}

function showQuickCommandDetail(cmd) {
  const detail = els.quickMoreMenu?.querySelector('[data-command-detail]');
  if (!detail || !cmd) return;
  detail.querySelector('[data-command-detail-token]').textContent = `/${cmd.name}`;
  detail.querySelector('[data-command-detail-category]').textContent = cmd.category || 'Command';
  detail.querySelector('[data-command-detail-description]').textContent = cmd.description;
  detail.querySelector('[data-command-detail-hint]').textContent = cmd.promptHint || (cmd.requiresInput
    ? 'Add instructions after the slash command before sending.'
    : 'Runs immediately against the current browser context.');
  detail.querySelector('[data-command-detail-footnote]').textContent = cmd.requiresInput
    ? 'Click to insert, then add details.'
    : 'Click or press Enter to run.';
  detail.hidden = false;
  els.quickMoreMenu?.classList.add('has-command-detail');
}

function applyQuickCommand(cmd) {
  setQuickCommandMenuOpen(false);
  els.input.value = `/${cmd.name} `;
  els.input.focus();
  if (!cmd.requiresInput) els.composer.requestSubmit();
}

function renderQuickMoreMenu(category = 'all') {
  if (!els.quickMoreMenu) return;
  const commands = category === 'all'
    ? BUILTIN_COMMANDS
    : BUILTIN_COMMANDS.filter((c) => c.category === category);
  if (!commands.length) { setQuickCommandMenuOpen(false); return; }

  els.quickMoreMenu.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'quick-more-heading';
  const headerLabel = document.createElement('span');
  headerLabel.textContent = 'Commands';
  const headerHint = document.createElement('small');
  headerHint.textContent = 'Slash helpers';
  header.append(headerLabel, headerHint);
  els.quickMoreMenu.appendChild(header);

  const detail = document.createElement('aside');
  detail.id = 'quickCommandDetail';
  detail.className = 'quick-command-detail';
  detail.dataset.commandDetail = 'true';
  detail.hidden = true;
  detail.setAttribute('aria-live', 'polite');
  detail.setAttribute('aria-label', 'Command details');

  const detailTop = document.createElement('div');
  detailTop.className = 'qmd-top';
  const detailToken = document.createElement('span');
  detailToken.className = 'qmd-token';
  detailToken.dataset.commandDetailToken = 'true';
  const detailCategory = document.createElement('span');
  detailCategory.className = 'qmd-category';
  detailCategory.dataset.commandDetailCategory = 'true';
  detailTop.append(detailToken, detailCategory);

  const detailDescription = document.createElement('strong');
  detailDescription.className = 'qmd-description';
  detailDescription.dataset.commandDetailDescription = 'true';

  const detailHint = document.createElement('p');
  detailHint.className = 'qmd-hint';
  detailHint.dataset.commandDetailHint = 'true';

  const detailFootnote = document.createElement('span');
  detailFootnote.className = 'qmd-footnote';
  detailFootnote.dataset.commandDetailFootnote = 'true';

  detail.append(detailTop, detailDescription, detailHint, detailFootnote);
  els.quickMoreMenu.appendChild(detail);

  const list = document.createElement('div');
  list.className = 'quick-command-list';
  list.setAttribute('role', 'none');

  for (const cmd of commands) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'quick-more-item';
    item.dataset.command = cmd.name;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-describedby', 'quickCommandDetail');

    const token = document.createElement('span');
    token.className = 'qmi-token';
    token.textContent = `/${cmd.name}`;

    const copy = document.createElement('span');
    copy.className = 'qmi-copy';
    const description = document.createElement('span');
    description.className = 'qmi-description';
    description.textContent = cmd.description;
    const categoryTag = document.createElement('span');
    categoryTag.className = 'qmi-category';
    categoryTag.textContent = cmd.category || '';
    copy.append(description, categoryTag);

    item.append(token, copy);
    item.addEventListener('mouseenter', () => showQuickCommandDetail(cmd));
    item.addEventListener('focus', () => showQuickCommandDetail(cmd));
    item.addEventListener('click', () => applyQuickCommand(cmd));
    list.appendChild(item);
  }
  els.quickMoreMenu.appendChild(list);
  showQuickCommandDetail(commands[0]);
  setQuickCommandMenuOpen(true);
}

function renderProfiles() {
  if (!els.profileSelect) return;
  const selected = settings.activeProfile || availableProfiles.find((profile) => profile.active)?.name || '';
  els.profileSelect.innerHTML = '<option value="">Detect from Hermes gateway</option>';
  for (const profile of availableProfiles) {
    const option = document.createElement('option');
    option.value = profile.name;
    option.textContent = `${profile.name}${profile.active ? ' · active' : ''}${profile.model ? ` · ${profile.model}` : ''}`;
    option.selected = profile.name === selected;
    els.profileSelect.appendChild(option);
  }
  els.profileSelect.value = selected;
  if (!settings.activeProfile && selected) settings = { ...settings, activeProfile: selected };
  if (availableProfiles.length) {
    const active = availableProfiles.find((profile) => profile.name === selected) || availableProfiles.find((profile) => profile.active);
    els.profileStatus.textContent = active
      ? `Using ${active.name}${active.model ? ` · ${active.model}` : ''}${active.skillCount ? ` · ${active.skillCount} skills` : ''}`
      : `${availableProfiles.length} profiles available`;
  } else {
    els.profileStatus.textContent = 'Profile API unavailable. Browser will use the currently running Hermes gateway profile.';
  }
}

async function loadProfiles({ quiet = false } = {}) {
  if (!settings.apiKey || gatewayCapabilities.profiles === false) {
    availableProfiles = [];
    renderProfiles();
    if (!quiet && settings.apiKey && gatewayCapabilities.profiles === false) {
      setStatus('warn', 'Profile API unavailable', 'Using the currently running Hermes gateway profile.');
    }
    return;
  }
  try {
    const response = await apiFetch('/v1/profiles', { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Profiles list failed (${response.status})`);
    availableProfiles = normalizeHermesProfiles(payload, settings.activeProfile || payload.active);
    renderProfiles();
    if (!quiet) setStatus('ok', 'Hermes profiles synced', `${availableProfiles.length} profile${availableProfiles.length === 1 ? '' : 's'} available`);
  } catch (error) {
    availableProfiles = [];
    renderProfiles();
    if (!quiet) setStatus('warn', 'Profile sync unavailable', 'This Hermes gateway does not expose /v1/profiles yet. Using the currently running profile.');
  }
}

async function applySelectedProfile(profileName = '') {
  settings = { ...settings, activeProfile: profileName };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  renderProfiles();
  if (!profileName || !settings.apiKey) return;
  try {
    const response = await apiFetch('/v1/profiles/active', {
      method: 'POST',
      body: JSON.stringify({ name: profileName }),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Profile switch failed (${response.status})`);
    setStatus('ok', 'Hermes profile switched', payload.restart_required ? `${profileName} selected. Restart Hermes gateway if the running profile does not change immediately.` : profileName);
    await loadProfiles({ quiet: true });
    await loadModels({ quiet: true });
    await loadSkills({ quiet: true });
  } catch (error) {
    setStatus('warn', 'Profile switch unavailable', `${error?.message || String(error)}. Browser will use the currently running Hermes profile.`);
  }
}

// ---------------------------------------------------------------------------
// Agent picker — multi-gateway discovery (v0.1.4)
//
// Hermes installs can expose multiple API gateways on adjacent ports, either on
// localhost or a private remote host (for example a Tailscale hostname). The
// picker probes /health without Authorization first, then only uses the token
// after the endpoint identifies itself as Hermes.
// ---------------------------------------------------------------------------

let discoveredAgents = [];

function getAgentPorts() {
  const stored = settings.agentPorts;
  if (Array.isArray(stored) && stored.length) return stored;
  return [...DEFAULT_AGENT_PORTS];
}

async function persistAgentDiscoverySettings({ ports = getAgentPorts(), host = settings.agentDiscoveryHost, scheme = settings.agentDiscoveryScheme } = {}) {
  settings = {
    ...settings,
    agentPorts: ports,
    agentDiscoveryHost: normalizeAgentDiscoveryHost(host || DEFAULT_SETTINGS.agentDiscoveryHost),
    agentDiscoveryScheme: normalizeAgentDiscoveryScheme(scheme || DEFAULT_SETTINGS.agentDiscoveryScheme),
  };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  syncSettingsForm();
}

function renderAgentList(agents = discoveredAgents) {
  if (!els.agentList) return;
  els.agentList.innerHTML = '';
  if (!agents.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No agents scanned yet. Click "Scan agents".';
    els.agentList.appendChild(empty);
    return;
  }
  const currentUrl = normalizeGatewayUrl(settings.gatewayUrl);
  for (const agent of agents) {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.setAttribute('role', 'listitem');
    if (normalizeGatewayUrl(agent.url) === currentUrl) {
      card.classList.add('agent-card-active');
    }
    const name = document.createElement('strong');
    name.className = 'agent-card-name';
    name.textContent = agent.name || `port ${agent.port}`;
    const meta = document.createElement('span');
    meta.className = 'agent-card-meta';
    if (agent.ok) {
      const bits = [`port ${agent.port}`];
      if (agent.version) bits.push(agent.version);
      if (agent.model && agent.model !== 'hermes-agent') bits.push(agent.model);
      meta.textContent = bits.join(' · ');
    } else {
      meta.textContent = agent.error ? `port ${agent.port} · ${agent.error}` : `port ${agent.port} · offline`;
    }
    const status = document.createElement('span');
    status.className = `agent-card-status ${agent.ok ? 'agent-card-status-ok' : 'agent-card-status-off'}`;
    status.textContent = agent.ok ? 'online' : 'offline';
    card.append(name, meta, status);
    if (agent.ok && normalizeGatewayUrl(agent.url) !== currentUrl) {
      const switchButton = document.createElement('button');
      switchButton.type = 'button';
      switchButton.className = 'secondary';
      switchButton.textContent = 'Switch to this agent';
      switchButton.addEventListener('click', () => switchAgentGateway(agent));
      card.appendChild(switchButton);
    }
    els.agentList.appendChild(card);
  }
}

async function loadAgents({ quiet = false } = {}) {
  if (!els.agentList) return;
  const ports = getAgentPorts();
  if (!ports.length) {
    els.agentList.innerHTML = '<p class="hint">No agent ports configured. Set ports in the field below.</p>';
    return;
  }
  let host;
  let scheme;
  try {
    host = normalizeAgentDiscoveryHost(els.agentHostInput?.value || settings.agentDiscoveryHost || DEFAULT_SETTINGS.agentDiscoveryHost);
    scheme = normalizeAgentDiscoveryScheme(els.agentSchemeInput?.value || settings.agentDiscoveryScheme || DEFAULT_SETTINGS.agentDiscoveryScheme);
    await persistAgentDiscoverySettings({ ports, host, scheme });
  } catch (error) {
    if (els.agentPickerStatus) els.agentPickerStatus.textContent = error?.message || String(error);
    setStatus('warn', 'Agent host invalid', error?.message || String(error));
    return;
  }
  if (els.agentPickerStatus) els.agentPickerStatus.textContent = `Scanning ${scheme}://${host} across ${ports.length} port${ports.length === 1 ? '' : 's'}...`;
  const key = settings.apiKey || '';
  discoveredAgents = await discoverLocalAgents({ ports, host, scheme, apiKey: key });
  const healthy = activeAgents(discoveredAgents);
  renderAgentList(discoveredAgents);
  if (els.agentPickerStatus) {
    if (healthy.length === 0) {
      els.agentPickerStatus.textContent = `Scanned ${scheme}://${host} across ${ports.length} ports — no Hermes agents online.`;
    } else if (healthy.length === 1) {
      els.agentPickerStatus.textContent = `1 agent online at ${scheme}://${host}:${healthy[0].port}.`;
    } else {
      els.agentPickerStatus.textContent = `${healthy.length} agents online on ${scheme}://${host} across ${ports.length} ports scanned.`;
    }
  }
  if (!quiet) setStatus('ok', 'Agents scanned', `${healthy.length} of ${ports.length} ${scheme}://${host} ports responding as Hermes`);
}

async function switchAgentGateway(agent) {
  if (!agent || !agent.url) return;
  const nextUrl = agent.url;
  if (normalizeGatewayUrl(nextUrl) === normalizeGatewayUrl(settings.gatewayUrl)) {
    setStatus('ok', 'Already connected', `${agent.name} is already the active gateway.`);
    return;
  }
  settings = { ...settings, gatewayMode: 'local-api', gatewayUrl: nextUrl };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  setStatus('ok', 'Switched gateway', `Reconnecting to ${agent.name} (${nextUrl})...`);
  // Re-run the full connect flow against the new gateway.
  try {
    await testConnection();
    await loadAgents({ quiet: true });
  } catch (error) {
    setStatus('warn', 'Switch partially failed', error?.message || String(error));
  }
}

function renderEmptyState() {
  if (messages.length) return;
  const setupCopy = settings.apiKey
    ? 'Ask Hermes about what you are viewing. Active tab, selected text, page text, and open tabs are attached as untrusted context.'
    : 'Click Connect to Hermes, approve locally, then start chatting with page context. Manual API key setup is still available in settings.';
  els.messages.innerHTML = `<div class="empty-state"><strong>THE PAGE IS THE PROMPT</strong><span>${setupCopy}</span></div>`;
}

function sessionDisplayName(session = {}) {
  return String(session.title || session.id || settings.sessionTitle || 'Hermes Browser Extension');
}

function updateSessionLabel() {
  const current = availableSessions.find((session) => session.id === settings.sessionId);
  const label = current ? sessionDisplayName(current) : (settings.sessionTitle || settings.sessionId || 'Hermes Browser Extension');
  els.currentSessionName.textContent = label;
  els.currentSessionName.title = `${label} · ${settings.sessionId}`;
}

function renderSessionMenu(query = els.sessionSearchInput?.value || '') {
  const groups = groupSessionsForMenu(availableSessions, settings.sessionId, query);
  const searching = Boolean(String(query || '').trim());
  els.sessionMenuList.innerHTML = '';
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'session-group-title';
    empty.textContent = 'No sessions found';
    els.sessionMenuList.appendChild(empty);
    return;
  }

  for (const group of groups) {
    if (shouldAutoOpenSessionGroup(group, groups, closedSessionGroups)) openSessionGroups.add(group.label);
    const isOpen = searching || openSessionGroups.has(group.label);

    const title = document.createElement('button');
    title.type = 'button';
    title.className = `session-group-title session-group-toggle ${isOpen ? 'open' : ''}`.trim();
    title.setAttribute('aria-expanded', String(isOpen));

    const titleLabel = document.createElement('span');
    titleLabel.textContent = `${isOpen ? '▾' : '▸'} ${group.label}`;

    const titleCount = document.createElement('strong');
    titleCount.textContent = String(group.sessions.length);

    title.append(titleLabel, titleCount);
    title.addEventListener('click', () => {
      if (openSessionGroups.has(group.label)) {
        openSessionGroups.delete(group.label);
        closedSessionGroups.add(group.label);
      } else {
        openSessionGroups.add(group.label);
        closedSessionGroups.delete(group.label);
      }
      renderSessionMenu(els.sessionSearchInput.value);
    });
    els.sessionMenuList.appendChild(title);

    if (!isOpen) continue;

    for (const session of group.sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `session-option ${session.selected ? 'selected' : ''}`.trim();
      button.dataset.sessionId = session.id;

      const name = document.createElement('span');
      name.className = 'session-option-name';
      name.textContent = sessionDisplayName(session);

      const meta = document.createElement('span');
      meta.className = 'session-option-meta';
      meta.textContent = session.selected ? '✓' : (session.messageCount ? `${session.messageCount}` : '');

      button.append(name, meta);
      button.addEventListener('click', () => openHermesSession(session));
      els.sessionMenuList.appendChild(button);
    }
  }
}

async function loadAllHermesSessions() {
  const limit = 500;
  let offset = 0;
  const merged = [];
  for (let page = 0; page < 10; page += 1) {
    const response = await apiFetch(`/api/sessions?limit=${limit}&offset=${offset}&include_children=true&order=recent`, { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session list failed (${response.status})`);
    const rows = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.sessions)
        ? payload.sessions
        : Array.isArray(payload.results)
          ? payload.results
          : [];
    merged.push(...rows);
    const hasMore = Boolean(payload.has_more ?? payload.hasMore ?? payload.pagination?.hasMore);
    const total = Number(payload.total || payload.pagination?.total || 0);
    offset += rows.length;
    if (shouldStopSessionPaging({ rowCount: rows.length, offset, total, hasMore })) break;
  }
  return { data: merged };
}

async function loadSessions({ quiet = false } = {}) {
  if (isRemoteWsMode()) {
    // Remote reads go over the WS; only possible once a socket is open.
    if (remoteWsConnection?.client?.readyState !== 1) {
      availableSessions = [];
      updateSessionLabel();
      renderSessionMenu();
      return;
    }
    try {
      const result = await remoteWsConnection.client.request(WS_METHODS.sessionList, { limit: 200 });
      availableSessions = normalizeHermesSessions(result);
      syncActiveSessionRuntimeFromList();
      updateSessionLabel();
      renderSessionMenu();
      if (!quiet) setStatus('ok', 'Hermes sessions synced', `${availableSessions.length} sessions available`);
    } catch (error) {
      updateSessionLabel();
      renderSessionMenu();
      if (!quiet) setStatus('warn', 'Session sync failed', error?.message || String(error));
    }
    return;
  }
  if (!settings.apiKey) {
    availableSessions = [];
    updateSessionLabel();
    renderSessionMenu();
    return;
  }
  try {
    const payload = await loadAllHermesSessions();
    availableSessions = normalizeHermesSessions(payload);
    syncActiveSessionRuntimeFromList();
    updateSessionLabel();
    renderSessionMenu();
    if (!quiet) setStatus('ok', 'Hermes sessions synced', `${availableSessions.length} sessions available`);
  } catch (error) {
    updateSessionLabel();
    renderSessionMenu();
    if (!quiet) setStatus('warn', 'Session sync failed', error?.message || String(error));
  }
}

async function renameHermesSessionTitle(sessionId, title, { quiet = false } = {}) {
  const nextTitle = String(title || '').trim();
  if (!sessionId || !nextTitle) return false;
  if (isRemoteWsMode()) {
    // Dashboard WS currently exposes create/resume/list/history but not rename.
    availableSessions = availableSessions.map((session) => (session.id === sessionId ? { ...session, title: nextTitle } : session));
    settings = { ...settings, sessionTitle: nextTitle };
    await chrome.storage.local.set({ hermesBrowserSettings: settings });
    updateSessionLabel();
    renderSessionMenu();
    if (!quiet) setStatus('warn', 'Session title saved locally', 'Remote dashboard rename RPC is not available yet.');
    return false;
  }
  if (!settings.apiKey) return false;
  const response = await apiFetch(`/api/sessions/${encodeSessionId(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: nextTitle }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session rename failed (${response.status})`);
  const updated = normalizeHermesSessions({ data: [payload.session || payload] })[0] || { id: sessionId, title: nextTitle, source: settings.sessionSource };
  availableSessions = normalizeHermesSessions({ data: [updated, ...availableSessions.filter((session) => session.id !== sessionId)] });
  settings = { ...settings, sessionTitle: updated.title || nextTitle };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  updateSessionLabel();
  renderSessionMenu();
  if (!quiet) setStatus('ok', 'Session title updated', settings.sessionTitle);
  return true;
}

async function maybeRenameCurrentSessionTitle(previousSettings = {}, nextTitle = settings.sessionTitle) {
  const cleanTitle = String(nextTitle || '').trim() || DEFAULT_SETTINGS.sessionTitle;
  const sessionId = settings.sessionId || previousSettings.sessionId;
  const current = availableSessions.find((session) => session.id === sessionId);
  const previousTitle = String(current?.title || previousSettings.sessionTitle || '').trim();
  if (!sessionId || !cleanTitle || cleanTitle === previousTitle) return false;
  try {
    return await renameHermesSessionTitle(sessionId, cleanTitle);
  } catch (error) {
    setStatus('warn', 'Could not rename session', error?.message || String(error));
    return false;
  }
}

function autoTitleForCurrentTurn(userText = '') {
  if (settings.autoNameSessions === false || !String(userText || '').trim()) return '';
  if (messages.some((message) => message.role === 'user' && String(message.content || '').trim())) return '';
  const current = availableSessions.find((session) => session.id === settings.sessionId);
  const currentTitle = current?.title || settings.sessionTitle || DEFAULT_SETTINGS.sessionTitle;
  if (!isDefaultBrowserSessionTitle(currentTitle)) return '';
  return autoSessionTitleFromText(userText);
}

async function maybeAutoNameCurrentSession(title = '') {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return false;
  try {
    return await renameHermesSessionTitle(settings.sessionId, cleanTitle, { quiet: true });
  } catch (error) {
    setStatus('warn', 'Auto-name skipped', error?.message || String(error));
    return false;
  }
}

function makeBrowserSessionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `hermes-browser-extension-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeBrowserSessionTitle(date = new Date()) {
  const stamp = date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
  return `Hermes Browser Extension · ${stamp}`;
}

async function createHermesBrowserSession({ title = makeBrowserSessionTitle(), focus = true } = {}) {
  if (isRemoteWsMode()) {
    const connection = await ensureRemoteWsClient();
    const result = await connection.client.request(WS_METHODS.sessionCreate, {
      title,
      reasoning_effort: normalizeReasoningEffort(settings.reasoningEffort),
      fast: normalizeFastMode(settings.fastMode),
    });
    const id = result?.session_id;
    if (!id) throw new Error('Dashboard did not return a session id.');
    connection.wsSessionId = id;
    const session = normalizeHermesSessions({ sessions: [{ id, title, source: settings.sessionSource || DEFAULT_SETTINGS.sessionSource }] })[0]
      || { id, title, source: settings.sessionSource };
    availableSessions = normalizeHermesSessions({ sessions: [session, ...availableSessions.filter((item) => item.id !== id)] });
    settings = { ...settings, sessionId: id, sessionTitle: session.title || title };
    activeSessionRuntime = { ...activeSessionRuntime, sessionId: id, usedTokens: 0, inputTokens: 0, outputTokens: 0, model: '', provider: '', source: '' };
    messages = [];
    await chrome.storage.local.set({ hermesBrowserSettings: settings, [activeMessagesStorageKey(previousConversationScope)]: [] });
    await saveSessionBindingForActiveScope(session);
    renderMessagesFromStorage();
    updateSessionLabel();
    renderSessionMenu();
    if (focus) els.input.focus();
    return session;
  }
  const sessionId = makeBrowserSessionId();
  const response = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: sessionId,
      title,
      source: settings.sessionSource || DEFAULT_SETTINGS.sessionSource,
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      system_prompt: HERMES_BROWSER_SYSTEM_PROMPT,
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Could not create session (${response.status})`);
  const session = normalizeHermesSessions({ data: [payload.session || payload] })[0] || { id: sessionId, title, source: settings.sessionSource };
  availableSessions = normalizeHermesSessions({ data: [session, ...availableSessions.filter((item) => item.id !== session.id)] });
  settings = { ...settings, sessionId: session.id, sessionTitle: session.title || title };
  activeSessionRuntime = { ...activeSessionRuntime, sessionId: session.id, usedTokens: 0, inputTokens: 0, outputTokens: 0, model: '', provider: '', source: '' };
  sessionRoutesAvailable = true;
  messages = [];
  await chrome.storage.local.set({ hermesBrowserSettings: settings, [activeMessagesStorageKey(previousConversationScope)]: [] });
  await saveSessionBindingForActiveScope(session);
  renderMessagesFromStorage();
  updateSessionLabel();
  renderSessionMenu();
  if (focus) els.input.focus();
  return session;
}

async function openHermesSession(session) {
  els.sessionMenu.hidden = true;
  els.sessionMenuButton.setAttribute('aria-expanded', 'false');
  if (isRemoteWsMode()) {
    try {
      const connection = await ensureRemoteWsClient();
      await connection.client.request(WS_METHODS.sessionResume, { session_id: session.id });
      connection.wsSessionId = session.id;
    } catch (error) {
      setStatus('error', 'Could not open session', error?.message || String(error));
      return;
    }
  }
  settings = { ...settings, sessionId: session.id, sessionTitle: session.title || session.id };
  activeSessionRuntime = { ...activeSessionRuntime, sessionId: session.id, usedTokens: 0, inputTokens: 0, outputTokens: 0, model: '', provider: '', source: '' };
  sessionRoutesAvailable = true;
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  await saveSessionBindingForActiveScope(session);
  updateSessionLabel();
  renderSessionMenu();
  await loadSessionMessages(session.id);
  setStatus('ok', 'Session opened', `${session.sourceLabel || session.source || 'Hermes'} · ${session.id}`);
}

async function loadSessionMessages(sessionId = settings.sessionId) {
  if (isRemoteWsMode()) {
    if (remoteWsConnection?.client?.readyState !== 1) return;
    try {
      const result = await remoteWsConnection.client.request(WS_METHODS.sessionHistory, { session_id: sessionId });
      const rows = Array.isArray(result?.messages) ? result.messages : [];
      messages = rows
        .filter((message) => ['user', 'assistant', 'system'].includes(message.role))
        .map((message) => ({ role: message.role, content: coerceWsMessageContent(message.content), ts: Number(message.timestamp || message.ts || Date.now()) }))
        .filter((message) => message.content)
        .slice(-settings.maxLocalMessages);
      await chrome.storage.local.set({ [activeMessagesStorageKey(previousConversationScope)]: messages });
      renderMessagesFromStorage();
    } catch (error) {
      addMessage('system', `Could not load session messages: ${error?.message || String(error)}`);
    }
    return;
  }
  if (!settings.apiKey) return;
  try {
    const response = await apiFetch(`/api/sessions/${encodeSessionId(sessionId)}/messages`, { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Messages failed (${response.status})`);
    if (payload.session) applySessionRuntimeSnapshot({ session: payload.session, sessionId: payload.session.id || sessionId, source: 'Hermes session' });
    const rows = Array.isArray(payload.data) ? payload.data : [];
    messages = rows
      .filter((message) => ['user', 'assistant', 'system'].includes(message.role) && message.content)
      .map((message) => ({ role: message.role, content: String(message.content), ts: Number(message.timestamp || Date.now()) }))
      .slice(-settings.maxLocalMessages);
    await chrome.storage.local.set({ [activeMessagesStorageKey(previousConversationScope)]: messages });
    renderMessagesFromStorage();
  } catch (error) {
    addMessage('system', `Could not load session messages: ${error?.message || String(error)}`);
  }
}

function isHermesBrowserSession(session = {}) {
  return String(session.source || '').toLowerCase() === DEFAULT_SETTINGS.sessionSource;
}

async function ensureDefaultBrowserSession({ focus = false } = {}) {
  if (!settings.apiKey || settings.sessionId !== DEFAULT_SETTINGS.sessionId) return;
  const current = availableSessions.find((session) => session.id === settings.sessionId);
  if (isHermesBrowserSession(current)) return;
  if (current) {
    try {
      const response = await apiFetch(`/api/sessions/${encodeSessionId(current.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ source: DEFAULT_SETTINGS.sessionSource }),
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session migration failed (${response.status})`);
      const migrated = normalizeHermesSessions({ data: [payload.session || payload] })[0];
      if (migrated) {
        availableSessions = normalizeHermesSessions({ data: [migrated, ...availableSessions.filter((item) => item.id !== migrated.id)] });
        updateSessionLabel();
        renderSessionMenu();
        return;
      }
    } catch (error) {
      setStatus('warn', 'Could not migrate Browser session', error?.message || String(error));
    }
  }
  const existingBrowserSession = availableSessions.find(isHermesBrowserSession);
  if (existingBrowserSession) {
    await openHermesSession(existingBrowserSession);
    return;
  }
  await createHermesBrowserSession({ title: makeBrowserSessionTitle(), focus });
}

const THINKING_PLACEHOLDER = 'Hermes is thinking...';
const THINKING_STATUSES = ['thinking', 'brainstorming', 'contemplating', 'reasoning', 'processing', 'analyzing', 'reflecting', 'pondering', 'deliberating', 'formulating'];

function renderThinkingIndicator(element) {
  const phrases = THINKING_STATUSES
    .map((word) => `
        <span class="thinking-line">
          <span class="thinking-word">${escapeHtml(word)}</span>
          <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </span>
      `.trim())
    .join('');
  element.innerHTML = `
    <span class="thinking-indicator" role="status" aria-live="polite" aria-label="Hermes is thinking, brainstorming, contemplating, reasoning, processing, analyzing, reflecting, pondering, deliberating, and formulating">
      <span class="thinking-glyph" aria-hidden="true">(o_o)</span>
      <span class="thinking-words" aria-hidden="true">${phrases}</span>
    </span>
  `;
}

function renderMessageContentElement(element, content = '') {
  if (String(content || '').trim() === THINKING_PLACEHOLDER) {
    renderThinkingIndicator(element);
    return;
  }
  element.innerHTML = renderMarkdown(content || '');
}

function renderToolActivity(activity = {}) {
  const category = activity.category || 'meta';
  const root = document.createElement('div');
  root.className = `tool-activity tool-kind-${category}`;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-label', `${activity.label || 'Using tool'}${activity.rawName ? `: ${activity.rawName}` : ''}`);

  const head = document.createElement('div');
  head.className = 'tool-activity-head';

  const glyph = document.createElement('span');
  glyph.className = `tool-activity-glyph tool-kind-${category}`;
  glyph.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'tool-activity-label';
  label.textContent = activity.label || 'Using tool';

  const name = document.createElement('span');
  name.className = 'tool-activity-name';
  name.textContent = activity.rawName || 'Hermes tool';

  head.append(glyph, label, name);
  root.appendChild(head);

  if (activity.preview) {
    const preview = document.createElement('div');
    preview.className = 'tool-activity-preview';
    preview.textContent = activity.preview;
    root.appendChild(preview);
  }

  const meter = document.createElement('div');
  meter.className = 'tool-activity-meter';
  meter.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 4; index += 1) meter.appendChild(document.createElement('i'));
  root.appendChild(meter);
  return root;
}

function setToolActivity(node, activity = null) {
  if (!node) return;
  let slot = node.querySelector('.message-tool-activity');
  if (!activity) {
    slot?.remove();
    return;
  }
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'message-tool-activity';
    const content = node.querySelector('.message-content');
    if (content?.nextSibling) node.insertBefore(slot, content.nextSibling);
    else node.appendChild(slot);
  }
  slot.replaceChildren(renderToolActivity(activity));
  requestAnimationFrame(() => {
    els.appScroll.scrollTop = els.appScroll.scrollHeight;
  });
}

function addMessage(role, content, { persist = true } = {}) {
  if (!messages.length) els.messages.innerHTML = '';
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector('.message-role').textContent = role === 'assistant' ? 'Hermes' : role;
  renderMessageContentElement(node.querySelector('.message-content'), content || '');
  els.messages.appendChild(node);
  requestAnimationFrame(() => {
    els.appScroll.scrollTop = els.appScroll.scrollHeight;
  });
  const record = { role, content: content || '', ts: Date.now() };
  if (persist) {
    messages.push(record);
    trimAndSaveMessages();
  }
  return { node, record };
}

function appendContextReceipt(messageNode, receipt = { title: 'What Hermes saw', items: [] }) {
  if (!messageNode || !receipt?.items?.length) return;
  const details = document.createElement('details');
  details.className = 'context-receipt';
  const summary = document.createElement('summary');
  summary.textContent = receipt.title || 'What Hermes saw';
  const list = document.createElement('dl');
  for (const item of receipt.items) {
    const term = document.createElement('dt');
    term.textContent = item.label;
    const value = document.createElement('dd');
    value.textContent = item.value;
    list.append(term, value);
  }
  details.append(summary, list);
  messageNode.appendChild(details);
}

function setMessageContent(node, content) {
  renderMessageContentElement(node.querySelector('.message-content'), content || '');
  requestAnimationFrame(() => {
    els.appScroll.scrollTop = els.appScroll.scrollHeight;
  });
}

function createStreamingMessageUpdater(node) {
  let pending = '';
  let frame = 0;
  const flush = (content = pending) => {
    pending = content || '';
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    setToolActivity(node, null);
    setMessageContent(node, pending);
  };
  const updateText = (content = '') => {
    pending = content || '';
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      setMessageContent(node, pending || THINKING_PLACEHOLDER);
    });
  };
  function updateTool(tool = null) {
    setToolActivity(node, tool);
  }
  return { update: updateText, updateText, updateTool, flush };
}

async function trimAndSaveMessages() {
  const max = Number(settings.maxLocalMessages || DEFAULT_SETTINGS.maxLocalMessages);
  if (messages.length > max) messages = messages.slice(-max);
  await saveMessagesForActiveScope();
}

async function loadSettings({ restoreMessages = false } = {}) {
  loadContextScopeForInstance();
  const messageKey = activeMessagesStorageKey(previousConversationScope);
  const stored = await chrome.storage.local.get(['hermesBrowserSettings', messageKey]);
  const storedSettings = stored.hermesBrowserSettings || {};
  const migrateDesktopOptionDefaults = !storedSettings.modelOptionsVersion && storedSettings.reasoningEffort === 'medium';
  settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  settings = {
    ...settings,
    thinkingEnabled: settings.thinkingEnabled !== false,
    gatewayMode: normalizeGatewayMode(settings.gatewayMode),
    gatewayUrl: normalizeGatewayUrl(settings.gatewayUrl),
    fastMode: normalizeFastMode(settings.fastMode),
    reasoningEffort: migrateDesktopOptionDefaults ? DEFAULT_SETTINGS.reasoningEffort : normalizeReasoningEffort(settings.reasoningEffort),
    modelOptionsVersion: DEFAULT_SETTINGS.modelOptionsVersion,
    agentDiscoveryHost: normalizeAgentDiscoveryHost(settings.agentDiscoveryHost || DEFAULT_SETTINGS.agentDiscoveryHost),
    agentDiscoveryScheme: normalizeAgentDiscoveryScheme(settings.agentDiscoveryScheme || DEFAULT_SETTINGS.agentDiscoveryScheme),
    autoNameSessions: settings.autoNameSessions !== false,
    sessionStartupMode: normalizeSessionStartupMode(settings.sessionStartupMode),
    colorMode: normalizeColorMode(settings.colorMode),
    appearanceTheme: normalizeAppearanceTheme(settings.appearanceTheme),
    textSize: normalizeTextSize(settings.textSize),
    panelResidencyMode: normalizePanelResidencyMode(settings.panelResidencyMode),
  };
  applyAppearanceSettings();
  if (migrateDesktopOptionDefaults) {
    await chrome.storage.local.set({ hermesBrowserSettings: settings });
  }
  messages = restoreMessages && Array.isArray(stored[messageKey]) ? stored[messageKey] : [];
  syncSettingsForm();
  renderMessagesFromStorage();
}

function renderMessagesFromStorage() {
  els.messages.innerHTML = '';
  const old = messages;
  messages = [];
  for (const message of old) addMessage(message.role, message.content, { persist: false });
  messages = old;
  renderEmptyState();
}

function syncSettingsForm() {
  renderAppearanceControls();
  renderProfiles();
  renderModelOptions(availableModels);
  if (els.gatewayModeInput) els.gatewayModeInput.value = settings.gatewayMode || DEFAULT_SETTINGS.gatewayMode;
  els.gatewayUrlInput.value = settings.gatewayUrl;
  renderGatewayHelp();
  renderGatewayModeCards();
  els.apiKeyInput.value = settings.apiKey || '';
  els.sessionIdInput.value = settings.sessionId;
  els.sessionTitleInput.value = settings.sessionTitle;
  els.contextDepthInput.value = settings.contextDepth;
  els.includeTabsInput.checked = Boolean(settings.includeTabs);
  els.includePageTextInput.checked = Boolean(settings.includePageText);
  els.includeSelectedTextInput.checked = Boolean(settings.includeSelectedText);
  for (const input of els.panelResidencyInputs || []) {
    input.checked = input.value === normalizePanelResidencyMode(settings.panelResidencyMode);
  }
  if (els.autoNameSessionsInput) els.autoNameSessionsInput.checked = settings.autoNameSessions !== false;
  if (els.agentHostInput) els.agentHostInput.value = settings.agentDiscoveryHost || DEFAULT_SETTINGS.agentDiscoveryHost;
  if (els.agentSchemeInput) els.agentSchemeInput.value = normalizeAgentDiscoveryScheme(settings.agentDiscoveryScheme || DEFAULT_SETTINGS.agentDiscoveryScheme);
  if (els.agentPortsInput) els.agentPortsInput.value = getAgentPorts().join(',');
  if (els.customModelSourcesInput) {
    els.customModelSourcesInput.value = normalizeExternalModelSourceList(settings.customModelSources || []).join('\n');
  }
  els.transcriptProviderInput.value = settings.transcriptProvider || DEFAULT_SETTINGS.transcriptProvider;
  renderCompatibilityPanel();
  renderConnectionSecurity();
  renderRemoteDiagnostics(lastRemoteDiagnostic);
}

async function saveSettingsFromForm() {
  const previousSettings = { ...settings };
  const selected = availableModels.find((model) => model.id === settings.model);
  const apiKey = els.apiKeyInput.value.trim();
  const previousApiKey = String(previousSettings.apiKey || '');
  const tokenSource = apiKey ? (apiKey === previousApiKey ? (previousSettings.tokenSource || settings.tokenSource || 'manual') : 'manual') : '';
  // The UI only picks Local vs Remote; for Remote the transport is inferred
  // from the key (present = API server, blank = dashboard WebSocket).
  const remote = gatewayLocationOf(els.gatewayModeInput?.value || settings.gatewayMode) === 'remote';
  const gatewayMode = remote ? remoteGatewayModeForKey(apiKey) : 'local-api';
  const rawGatewayUrl = els.gatewayUrlInput.value.trim();
  // In remote mode, don't coerce an empty field to the loopback default — that
  // would persist a misleading remote+localhost config. Leave it empty.
  const gatewayUrl = rawGatewayUrl ? normalizeGatewayUrl(rawGatewayUrl) : (remote ? '' : normalizeGatewayUrl(''));
  settings = {
    ...settings,
    gatewayMode,
    gatewayUrl,
    apiKey,
    tokenSource,
    model: settings.model || DEFAULT_SETTINGS.model,
    modelContextTokens: selected?.contextTokens || settings.modelContextTokens || 0,
    sessionId: els.sessionIdInput.value.trim() || DEFAULT_SETTINGS.sessionId,
    sessionTitle: els.sessionTitleInput.value.trim() || DEFAULT_SETTINGS.sessionTitle,
    activeProfile: els.profileSelect?.value || settings.activeProfile || DEFAULT_SETTINGS.activeProfile,
    contextDepth: els.contextDepthInput.value,
    includeTabs: els.includeTabsInput.checked,
    includePageText: els.includePageTextInput.checked,
    includeSelectedText: els.includeSelectedTextInput.checked,
    panelResidencyMode: normalizePanelResidencyMode(els.panelResidencyInputs?.find((input) => input.checked)?.value || settings.panelResidencyMode),
    autoNameSessions: els.autoNameSessionsInput ? els.autoNameSessionsInput.checked : settings.autoNameSessions !== false,
    agentDiscoveryHost: normalizeAgentDiscoveryHost(els.agentHostInput?.value || settings.agentDiscoveryHost || DEFAULT_SETTINGS.agentDiscoveryHost),
    agentDiscoveryScheme: normalizeAgentDiscoveryScheme(els.agentSchemeInput?.value || settings.agentDiscoveryScheme || DEFAULT_SETTINGS.agentDiscoveryScheme),
    agentPorts: parseAgentPortsInput(els.agentPortsInput?.value || '').length ? parseAgentPortsInput(els.agentPortsInput?.value || '') : getAgentPorts(),
    customModelSources: normalizeExternalModelSourceList(els.customModelSourcesInput?.value?.split(/\n+/) || settings.customModelSources || []),
    transcriptProvider: els.transcriptProviderInput.value.trim() || DEFAULT_SETTINGS.transcriptProvider,
    colorMode: normalizeColorMode(settings.colorMode),
    appearanceTheme: normalizeAppearanceTheme(settings.appearanceTheme),
    textSize: normalizeTextSize(settings.textSize),
  };
  applyAppearanceSettings();
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  await maybeRenameCurrentSessionTitle(previousSettings, settings.sessionTitle);
  syncSettingsForm();
  updateConnectionPrompt();
}

async function clearStoredToken() {
  settings = { ...settings, apiKey: '', tokenSource: '', lastConnectionTestedAt: 0 };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  if (els.apiKeyInput) els.apiKeyInput.value = '';
  sessionRoutesAvailable = null;
  markConnectionProbe('unconfigured', 'Token cleared by user.');
  setGatewayCapabilities(normalizeGatewayCapabilities(null, { healthOk: false, hasApiKey: false, warning: 'Token cleared; reconnect to refresh capabilities.' }));
  syncSettingsForm();
  setStatus('warn', 'Hermes token cleared', 'Paste a Gateway API key or reconnect when you are ready.');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? safeTab(tab) : null;
}

async function currentWindowTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs.map(safeTab);
}

async function tabsForCurrentScope() {
  const tabs = await currentWindowTabs();
  if (contextScope.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB || contextScope.pinnedTabId === null) return tabs;
  if (tabs.some((tab) => Number(tab.id) === Number(contextScope.pinnedTabId))) return tabs;
  try {
    const pinned = await chrome.tabs.get(Number(contextScope.pinnedTabId));
    return [safeTab(pinned), ...tabs.filter((tab) => Number(tab.id) !== Number(contextScope.pinnedTabId))];
  } catch {
    return tabs;
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_error) {
    // Static content scripts or restricted pages may make this unnecessary/impossible.
  }
}

function collectPageContextFallback(options = {}) {
  const TEXT_LIMITS = { minimal: 4_000, normal: 12_000, full: 30_000 };
  function normalizeReadableWhitespace(value = '') {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t\f\v ]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  function textOf(node) {
    return normalizeReadableWhitespace(node?.innerText || node?.textContent || '');
  }
  function textContentWithoutJunk(root) {
    if (!root) return '';
    const clone = root.cloneNode?.(true);
    if (!clone) return normalizeReadableWhitespace(root.textContent || '');
    clone.querySelectorAll?.('script, style, noscript, svg, canvas, template, iframe').forEach((node) => node.remove());
    return normalizeReadableWhitespace(clone.textContent || '');
  }
  function uniqueReadableLines(values = []) {
    const seen = new Set();
    const lines = [];
    for (const value of values) {
      for (const rawLine of normalizeReadableWhitespace(value).split('\n')) {
        const line = rawLine.trim();
        if (line.length < 2) continue;
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(line);
      }
    }
    return lines.join('\n');
  }
  function collectReadablePageText(doc = document, { minSemanticChars = 80 } = {}) {
    const root = doc?.body || doc?.documentElement;
    if (!root) return '';
    const innerText = normalizeReadableWhitespace(root.innerText || doc?.documentElement?.innerText || '');
    const semanticText = uniqueReadableLines(Array.from(doc.querySelectorAll?.('main, article, [role="main"], h1, h2, h3, h4, p, li, blockquote, figcaption, td, th, a[href], button, summary, [aria-label]') || []).map(textOf));
    const fallbackText = textContentWithoutJunk(root);
    if (semanticText.length >= Math.max(minSemanticChars, innerText.length * 1.2)) return semanticText;
    if (innerText) return innerText;
    if (semanticText) return semanticText;
    return fallbackText;
  }
  function clamp(value, limit) {
    const text = String(value || '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
  }
  function redact(value) {
    // Mirror of redactSensitiveText in lib/common.mjs. Kept inline because the
    // content script cannot import the module; the canonical version and tests
    // live in lib/common.mjs and prompt-build re-redacts the same text.
    return String(value || '')
      .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
      .replace(/\bBearer\s+[^\s'"`;&]+/gi, 'Bearer [REDACTED_BEARER]')
      .replace(new RegExp('\\bsk-[A-Za-z0-9_-]{12,}\\b', 'g'), '[REDACTED_SECRET]')
      .replace(/\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g, '[REDACTED_SECRET]')
      .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g, '[REDACTED_SECRET]')
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_SECRET]')
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SECRET]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
      .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|password|passwd|secret|private[_-]?key)\b["'`]?\s*[:=]\s*["'`]?([^\s'"`;&]+)/gi, (_match, key) => `${key}=[REDACTED_SECRET]`);
  }
  function pageMeta() {
    const description = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '';
    const language = document.documentElement?.lang || document.querySelector('meta[http-equiv="content-language"]')?.content || '';
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 25)
      .map((node) => ({ level: node.tagName.toLowerCase(), text: textOf(node).slice(0, 240) }))
      .filter((item) => item.text);
    const interactive = Array.from(document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"]')).slice(0, 80)
      .map((node) => {
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute('role');
        const kind = role || tag;
        const label = node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('name') || node.getAttribute('placeholder') || '';
        const href = tag === 'a' ? node.href : '';
        const text = textOf(node) || label || href;
        return { kind, text: text.slice(0, 220), href };
      })
      .filter((item) => item.text || item.href)
      .slice(0, 40);
    return { description, language, canonical, headings, interactive, forms: [] };
  }
  const depth = options.depth || 'normal';
  const limit = TEXT_LIMITS[depth] || TEXT_LIMITS.normal;
  const selection = globalThis.getSelection?.().toString() || '';
  const text = collectReadablePageText(document);
  return {
    ok: true,
    source: 'scripting-fallback',
    title: document.title || '',
    url: location.href,
    selectedText: clamp(redact(selection), Math.min(limit, 8_000)),
    text: clamp(redact(text), limit),
    meta: pageMeta(),
    capturedAt: new Date().toISOString(),
  };
}

async function getPageContextViaScripting(tabId, options, originalError) {
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectPageContextFallback,
      args: [options],
    });
    if (injected?.result) {
      return {
        ...injected.result,
        warning: originalError?.message || String(originalError || ''),
      };
    }
  } catch (fallbackError) {
    return {
      ok: false,
      error: originalError?.message || String(originalError || fallbackError),
      reason: fallbackError?.message || String(fallbackError),
      text: '',
      selectedText: '',
      meta: {},
    };
  }
  return {
    ok: false,
    error: originalError?.message || String(originalError || 'No context result returned'),
    text: '',
    selectedText: '',
    meta: {},
  };
}

async function getPageContext(tab) {
  if (!tab?.id || isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      restricted: true,
      reason: 'Hermes Browser Extension does not read browser internals, extension pages, or sensitive account/payment/password pages in v0.1.',
      text: '',
      selectedText: '',
      meta: {},
    };
  }

  const options = { depth: settings.contextDepth };
  try {
    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'HERMES_GET_PAGE_CONTEXT', options });
    // A response that claims ok but carries no actual page text is the signature
    // of a stale/orphaned content script that returned a bare ack. Run the
    // scripting fallback so the user still gets real page text instead of 0.
    if (response?.ok && (response.text || response.selectedText || response.meta?.headings?.length)) return response;
    if (response?.ok) {
      const fallback = await getPageContextViaScripting(tab.id, options, new Error('Stale content script: empty page context'));
      if (fallback?.ok) return fallback;
    }
    return response || { ok: false, error: 'No page context response', text: '', selectedText: '', meta: {} };
  } catch (error) {
    const fallback = await getPageContextViaScripting(tab.id, options, error);
    if (fallback?.ok) return fallback;
    return {
      ok: false,
      error: fallback?.error || error?.message || String(error),
      reason: fallback?.reason || error?.message || String(error),
      text: '',
      selectedText: '',
      meta: {},
    };
  }
}

async function getYoutubeTranscriptForTab(tab) {
  const videoId = extractYouTubeVideoId(tab?.url || '');
  const provider = settings.transcriptProvider || DEFAULT_SETTINGS.transcriptProvider;
  if (!videoId || String(provider).trim().toLowerCase() === 'off') return null;
  try {
    await ensureContentScript(tab.id);
    return await chrome.runtime.sendMessage({
      type: 'HERMES_GET_YOUTUBE_TRANSCRIPT',
      videoId,
      tabId: tab.id,
      provider,
    });
  } catch (error) {
    return { ok: false, videoId, reason: error?.message || String(error), source: 'sidepanel' };
  }
}

async function refreshContext() {
  if (contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) {
    currentContext = { activeTab: null, tabs: [], selectedTabs: [], pageContext: null, contextScope };
    selectedTabs = [];
    setStatus('ok', 'Chat only', 'No browser context will be read or attached.');
    renderContextScopeControls();
    renderContextWindow();
    return currentContext;
  }

  const [active, tabs] = await Promise.all([activeTab(), tabsForCurrentScope()]);
  const tab = resolveContextTargetTab({ activeTab: active, tabs, scope: contextScope });
  if (contextScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB && tab) {
    const nextScope = contextScopeFromTab(tab, contextScope);
    if (JSON.stringify(nextScope) !== JSON.stringify(contextScope)) {
      contextScope = nextScope;
      saveContextScopeForInstance();
    }
  }
  const pinnedMissing = contextScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB && !tab;
  const pageContext = tab
    ? await getPageContext(tab)
    : pinnedMissing
      ? { ok: false, restricted: true, reason: 'Pinned tab is closed or no longer available.', text: '', selectedText: '', meta: {} }
      : null;
  const youtubeTranscript = tab ? await getYoutubeTranscriptForTab(tab) : null;
  if (pageContext && youtubeTranscript) pageContext.youtubeTranscript = youtubeTranscript;
  syncSelectedTabsFromContextScope(tabs);
  const promptTabs = filterPromptTabs(tabs, contextScope);
  currentContext = {
    activeTab: tab,
    tabs,
    selectedTabs: Array.isArray(contextScope.selectedTabIds) ? promptTabs : tabs,
    pageContext,
    contextScope,
  };

  if (pinnedMissing) {
    setStatus('warn', 'Pinned tab closed', 'Choose another tab or follow the active tab.');
  } else if (!tab) {
    setStatus('warn', 'No active tab detected', 'Open a normal browser tab and try again.');
  } else if (pageContext?.restricted) {
    setStatus('warn', tab.title || 'Restricted page', `${tab.url} - context restricted`);
  } else if (pageContext?.ok) {
    setStatus('ok', tab.title || 'Active tab ready', tab.url || '');
  } else {
    setStatus('warn', tab.title || 'Page context partial', pageContext?.error || tab.url || '');
  }
  renderContextScopeControls();
  renderContextWindow();
  return currentContext;
}

function setRefreshButtonBusy(busy) {
  if (!els.refreshButton) return;
  els.refreshButton.classList.toggle('is-refreshing', Boolean(busy));
  els.refreshButton.setAttribute('aria-busy', String(Boolean(busy)));
  els.refreshButton.disabled = Boolean(busy);
}

function waitForRefreshButtonSpin(startedAt) {
  const elapsed = performance.now() - startedAt;
  const remaining = Math.max(0, REFRESH_BUTTON_MIN_BUSY_MS - elapsed);
  return remaining ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}

async function refreshContextWithSpin() {
  if (contextRefreshingFromButton) return currentContext;
  contextRefreshingFromButton = true;
  const startedAt = performance.now();
  setRefreshButtonBusy(true);
  try {
    return await refreshContext();
  } finally {
    await waitForRefreshButtonSpin(startedAt);
    contextRefreshingFromButton = false;
    setRefreshButtonBusy(false);
  }
}

function authHeaders({ json = false } = {}) {
  const headers = json ? { 'Content-Type': 'application/json' } : {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  if (settings.activeProfile) headers['X-Hermes-Profile'] = settings.activeProfile;
  return headers;
}

async function apiFetch(path, options = {}) {
  const base = normalizeGatewayUrl(settings.gatewayUrl);
  const hasBody = typeof options.body !== 'undefined';
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...authHeaders({ json: hasBody }),
      ...(options.headers || {}),
    },
  });
}

async function compactCurrentSessionContext() {
  if (!settings.sessionId) {
    setStatus('warn', 'No active session', 'Open or create a Hermes Browser Extension session before compacting context.');
    return;
  }
  if (!gatewayCapabilities.sessionCompress) {
    setStatus('warn', 'Context compaction unavailable', 'The connected Hermes runtime does not advertise native session compaction.');
    return;
  }
  const button = els.contextCompactButton;
  if (button) {
    button.disabled = true;
    button.textContent = 'Compacting…';
  }
  try {
    const response = await apiFetch(`/api/sessions/${encodeSessionId(settings.sessionId)}/compress`, {
      method: 'POST',
      body: JSON.stringify({ source: 'hermes_browser' }),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.error || payload?.message || `Context compaction failed (${response.status})`);
    }
    const compactedSessionId = String(payload?.rotated_session_id || payload?.session_id || '').trim();
    if (compactedSessionId && compactedSessionId !== settings.sessionId) {
      settings = { ...settings, sessionId: compactedSessionId };
      await chrome.storage.local.set({ hermesBrowserSettings: settings });
    }
    if (payload && typeof payload === 'object') {
      applySessionRuntimeSnapshot({
        session: { id: compactedSessionId || settings.sessionId, input_tokens: payload.last_prompt_tokens || payload.estimated_prompt_tokens || 0 },
        runtime: payload.runtime,
        sessionId: compactedSessionId || settings.sessionId,
        source: 'context compaction',
      });
    }
    setStatus('ok', 'Context compacted', payload?.summary || 'Hermes compacted the active session context.');
    await loadSessions({ quiet: true });
  } catch (error) {
    setStatus('warn', 'Context compaction failed', error?.message || String(error));
  } finally {
    renderContextWindow();
  }
}

function stopConnectionProbeLoop() {
  clearTimeout(connectionProbeTimer);
  connectionProbeTimer = null;
}

function scheduleConnectionProbe(delayMs = CONNECTION_PROBE_INTERVAL_MS) {
  stopConnectionProbeLoop();
  connectionProbeTimer = setTimeout(() => {
    probeGatewayLiveness({ quiet: true }).catch(() => {});
  }, delayMs);
}

async function probeGatewayLiveness({ quiet = false } = {}) {
  if (connectionProbeInFlight) return currentConnectionState();
  const state = currentConnectionState();
  if (state.state === 'unconfigured') {
    stopConnectionProbeLoop();
    updateConnectionPrompt();
    return state;
  }
  if (isRemoteWsMode()) {
    if (remoteWsConnection?.client?.readyState === 1) {
      markConnectionProbe('connected', normalizeGatewayUrl(settings.gatewayUrl));
      scheduleConnectionProbe();
      return currentConnectionState();
    }
    markConnectionProbe(remoteWsConnection?.client?.readyState === 0 ? 'connecting' : 'unreachable', 'Remote dashboard socket is not open.');
    scheduleConnectionProbe();
    return currentConnectionState();
  }
  connectionProbeInFlight = true;
  if (!quiet) markConnectionProbe('connecting', normalizeGatewayUrl(settings.gatewayUrl));
  try {
    const response = await apiFetch('/health', { method: 'GET', cache: 'no-store' });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    markConnectionProbe('connected', normalizeGatewayUrl(settings.gatewayUrl));
  } catch (error) {
    markConnectionProbe('unreachable', `${normalizeGatewayUrl(settings.gatewayUrl)} · ${error?.message || String(error)}`);
  } finally {
    connectionProbeInFlight = false;
    scheduleConnectionProbe();
  }
  return currentConnectionState();
}

function markGatewayReachable(detail = normalizeGatewayUrl(settings.gatewayUrl)) {
  markConnectionProbe('connected', detail);
  scheduleConnectionProbe();
}

function markGatewayUnreachable(error) {
  markConnectionProbe('unreachable', error?.message || String(error || 'Gateway disconnected'));
  scheduleConnectionProbe();
}

function markGatewayDegraded(error) {
  const diagnostic = classifyGatewayError(error);
  markConnectionProbe('degraded', diagnostic.kind === 'unknown' ? (error?.message || String(error || 'Gateway degraded')) : gatewayConnectionTroubleshooting({
    gatewayMode: settings.gatewayMode,
    gatewayUrl: settings.gatewayUrl,
    state: 'degraded',
    probeDetail: error?.message || String(error || ''),
  }));
  scheduleConnectionProbe();
  return diagnostic;
}

async function ensureHermesSession() {
  if (sessionRoutesAvailable === false || gatewayCapabilities.sessions === false || gatewayCapabilities.sessionChat === false) return false;
  const sessionPath = `/api/sessions/${encodeSessionId(settings.sessionId)}`;
  const getResponse = await apiFetch(sessionPath, { method: 'GET' });
  if (getResponse.ok) {
    sessionRoutesAvailable = true;
    return true;
  }
  if (getResponse.status !== 404) {
    const text = await getResponse.text();
    throw new Error(`Could not inspect Hermes session (${getResponse.status}): ${text.slice(0, 500)}`);
  }

  const createResponse = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: settings.sessionId,
      title: settings.sessionTitle,
      source: settings.sessionSource || DEFAULT_SETTINGS.sessionSource,
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      system_prompt: HERMES_BROWSER_SYSTEM_PROMPT,
    }),
  });
  if (createResponse.status === 404 || createResponse.status === 405) {
    sessionRoutesAvailable = false;
    return false;
  }
  if (!createResponse.ok && createResponse.status !== 409) {
    const text = await createResponse.text();
    throw new Error(`Could not create Hermes Browser Extension session (${createResponse.status}): ${text.slice(0, 500)}`);
  }
  sessionRoutesAvailable = true;
  return true;
}

function parseSseBlock(block) {
  const event = { type: 'message', data: '' };
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event.type = line.slice(6).trim();
    if (line.startsWith('data:')) event.data += `${line.slice(5).trim()}\n`;
  }
  event.data = event.data.trim();
  if (!event.data) return event;
  try {
    event.json = JSON.parse(event.data);
  } catch {
    event.json = null;
  }
  return event;
}

function sseBlocksFromBuffer(buffer, { flush = false } = {}) {
  const blocks = [];
  let match;
  const boundary = /\r?\n\r?\n/g;
  let start = 0;
  while ((match = boundary.exec(buffer)) !== null) {
    blocks.push(buffer.slice(start, match.index));
    start = boundary.lastIndex;
  }
  const rest = buffer.slice(start);
  if (flush && rest.trim()) {
    blocks.push(rest);
    return { blocks, rest: '' };
  }
  return { blocks, rest };
}

function textFromRunCompleted(data = {}) {
  const messagesList = Array.isArray(data.messages) ? data.messages : [];
  for (let index = messagesList.length - 1; index >= 0; index -= 1) {
    const message = messagesList[index];
    if (message?.role === 'assistant' && message.content) return String(message.content);
  }
  return data.content ? String(data.content) : '';
}


async function readSseResponse(response, onDelta, onTool, { signal, onRun, onSteerQueued, onRuntime } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';

  async function processBlock(block) {
    const event = parseSseBlock(block);
    const data = event.json || {};
    if (event.type === 'run.started' && data.run_id) {
      onRun?.(data.run_id);
    } else if (event.type === 'assistant.delta' && data.delta) {
      finalText += data.delta;
      onDelta(finalText);
    } else if (event.type === 'assistant.completed' && data.content) {
      finalText = finalText || data.content;
      onDelta(finalText);
    } else if (event.type === 'run.completed') {
      onRuntime?.(data);
      const completedText = textFromRunCompleted(data);
      if (completedText) {
        finalText = completedText;
        onDelta(finalText);
      }
    } else if (event.type === 'steer.queued' && data.text) {
      onSteerQueued?.(data.text);
    } else if (event.type === 'chat.completion.chunk' || event.type === 'message') {
      const nextText = appendOpenAiChunkText(event, finalText);
      if (nextText !== finalText) {
        finalText = nextText;
        onDelta(finalText);
      }
    } else if (event.type?.startsWith('tool.') && onTool) {
      onTool(normalizeBrowserRuntimeEvent({ type: event.type, data }));
    } else if (event.type === 'hermes.tool.progress' && onTool) {
      onTool(normalizeBrowserRuntimeEvent({ type: event.type, data }));
    } else if (event.type === 'error') {
      throw new Error(data.message || event.data || 'Hermes stream error');
    }
  }

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new DOMException('Hermes turn stopped by user', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = sseBlocksFromBuffer(buffer);
    buffer = parsed.rest;
    for (const block of parsed.blocks) await processBlock(block);
  }

  buffer += decoder.decode();
  const parsed = sseBlocksFromBuffer(buffer, { flush: true });
  for (const block of parsed.blocks) await processBlock(block);
  return finalText;
}

function currentModelOptionsPayload() {
  return buildHermesModelOptions(settings);
}

function currentSelectedModel() {
  return availableModels.find((model) => model.id === settings.model) || null;
}

function currentModelRequestId() {
  const selected = currentSelectedModel();
  return selected?.rawModelId || selected?.model || settings.model;
}

function currentModelProviderSlug() {
  const selected = currentSelectedModel();
  return selected?.provider || '';
}

function runtimeValueMatches(requested = '', effective = '') {
  const req = String(requested || '').trim().toLowerCase();
  const got = String(effective || '').trim().toLowerCase();
  if (!req || !got) return true;
  return req === got || req.endsWith(`/${got}`) || got.endsWith(`/${req}`) || req.endsWith(`:${got}`) || got.endsWith(`:${req}`);
}

function applyPendingModelRuntimeAck(runtime = {}) {
  if (!pendingModelRuntimeAck || !runtime || typeof runtime !== 'object') return;
  const effectiveModel = runtime.model || runtime.model_id || runtime.modelId || runtime.effective_model || '';
  const effectiveProvider = runtime.provider || runtime.provider_id || runtime.providerId || runtime.effective_provider || '';
  if (!effectiveModel && !effectiveProvider) return;
  const modelOk = runtimeValueMatches(pendingModelRuntimeAck.model, effectiveModel);
  const providerOk = runtimeValueMatches(pendingModelRuntimeAck.provider, effectiveProvider);
  const requestedLabel = [pendingModelRuntimeAck.providerLabel, pendingModelRuntimeAck.modelLabel].filter(Boolean).join(' · ');
  const runtimeLabel = [effectiveProvider, effectiveModel].filter(Boolean).join(' · ');
  if (modelOk && providerOk) {
    setStatus('ok', 'Hermes model confirmed', runtimeLabel || requestedLabel || 'Runtime metadata matched the requested model.');
  } else {
    setStatus('warn', 'Model mismatch', `Requested ${requestedLabel || pendingModelRuntimeAck.model}; runtime used ${runtimeLabel || 'unknown model'}.`);
  }
  pendingModelRuntimeAck = null;
}

function applyTurnRuntimePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return;
  const runtime = payload.runtime || {};
  applySessionRuntimeSnapshot({
    sessionId: payload.session_id || payload.sessionId || settings.sessionId,
    usage: payload.usage,
    runtime,
    source: 'Hermes turn',
  });
  applyPendingModelRuntimeAck(runtime);
}

async function ensureRemoteWsClient() {
  const baseUrl = normalizeGatewayUrl(settings.gatewayUrl);
  if (!isUsableRemoteGatewayUrl(baseUrl)) {
    throw new Error('Set a remote https gateway URL in Settings before connecting.');
  }
  if (remoteWsConnection?.client && remoteWsConnection.client.readyState === 1 && remoteWsConnection.baseUrl === baseUrl) {
    return remoteWsConnection;
  }
  try {
    remoteWsConnection?.client?.close();
  } catch {
    /* ignore */
  }
  remoteWsConnection = null;

  console.info('[Hermes] remote: minting ws-ticket via dashboard tab for', baseUrl);
  const ticket = await mintWsTicket({ tabsApi: chrome.tabs, scriptingApi: chrome.scripting, baseUrl });
  if (!ticket.ok) {
    console.warn('[Hermes] remote: ws-ticket mint failed:', ticket.reason, ticket);
    const error = new Error(ticketFailureHelp(ticket.reason, ticket.origin));
    error.ticketReason = ticket.reason;
    throw error;
  }
  const wsUrl = buildDashboardWsUrl(baseUrl, ticket.ticket);
  console.info(
    `[Hermes] remote: ticket ok (ttl=${ticket.ttlSeconds}s, ${String(ticket.ticket || '').length} chars); connecting`,
    wsUrl.replace(/ticket=[^&]+/, `ticket=<${String(ticket.ticket || '').length} chars>`),
  );
  const client = createGatewayClient();
  try {
    await client.connect(wsUrl);
  } catch (error) {
    console.warn('[Hermes] remote: WebSocket connect failed:', error?.message || error);
    throw error;
  }
  const connection = { client, baseUrl, wsSessionId: '' };
  client.on('close', () => {
    if (remoteWsConnection === connection) {
      remoteWsConnection = null;
      markGatewayUnreachable(new Error('Remote dashboard socket closed'));
    }
  });
  remoteWsConnection = connection;
  return connection;
}

async function ensureRemoteWsSession(connection) {
  if (connection.wsSessionId) return connection.wsSessionId;
  const result = await connection.client.request(WS_METHODS.sessionCreate, {
    title: settings.sessionTitle,
    reasoning_effort: normalizeReasoningEffort(settings.reasoningEffort),
    fast: normalizeFastMode(settings.fastMode),
  });
  connection.wsSessionId = result?.session_id || '';
  if (!connection.wsSessionId) throw new Error('Dashboard did not return a session id.');
  // Reflect the dashboard-assigned id so the session menu/label track the live
  // remote session instead of the local default placeholder.
  settings = { ...settings, sessionId: connection.wsSessionId };
  await chrome.storage.local.set({ hermesBrowserSettings: settings });
  updateSessionLabel();
  return connection.wsSessionId;
}

// Dashboard history content may be a string, an array of text parts, or a
// single block object; flatten to plain text for the message pane.
function coerceWsMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('');
  }
  if (content && typeof content === 'object') return String(content.text || '');
  return '';
}

async function streamRemoteWsChat(prompt, onDelta, onTool, { signal, onRun } = {}) {
  const connection = await ensureRemoteWsClient();
  const sessionId = await ensureRemoteWsSession(connection);
  onRun?.(sessionId);
  const { client } = connection;

  return new Promise((resolve, reject) => {
    let finalText = '';
    let settled = false;
    const offs = [];
    const forThisSession = (event) => !event.sessionId || event.sessionId === sessionId;

    const cleanup = () => {
      for (const off of offs) off();
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    function onAbort() {
      client.request(WS_METHODS.sessionInterrupt, { session_id: sessionId }).catch(() => {});
      finish(reject, new DOMException('Hermes turn stopped by user', 'AbortError'));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });

    offs.push(client.on(WS_EVENTS.messageDelta, (event) => {
      if (!forThisSession(event)) return;
      finalText += event.payload?.text || '';
      onDelta(finalText);
    }));
    offs.push(client.on(WS_EVENTS.messageComplete, (event) => {
      if (!forThisSession(event)) return;
      finalText = event.payload?.text || finalText;
      onDelta(finalText);
      finish(resolve, finalText);
    }));
    offs.push(client.on('tool.start', (event) => {
      if (forThisSession(event) && onTool) onTool({ tool_name: event.payload?.name });
    }));
    offs.push(client.on(WS_EVENTS.error, (event) => {
      finish(reject, new Error(event.payload?.message || 'Dashboard stream error'));
    }));
    offs.push(client.on('close', () => finish(reject, new Error('Dashboard connection closed mid-turn.'))));

    client.request(WS_METHODS.promptSubmit, { session_id: sessionId, text: prompt }).catch((error) => finish(reject, error));
  });
}

async function streamSessionChat(prompt, onDelta, onTool, { signal, attachments: turnAttachments = attachments, onRun, onSteerQueued, onRuntime } = {}) {
  if (isRemoteWsMode()) return streamRemoteWsChat(prompt, onDelta, onTool, { signal, onRun });
  const hasSessionRoutes = await ensureHermesSession();
  if (!hasSessionRoutes) return streamChatCompletions(prompt, onDelta, onTool, { signal, attachments: turnAttachments, onRun });

  const response = await apiFetch(`/api/sessions/${encodeSessionId(settings.sessionId)}/chat/stream`, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      client_runtime_version: modelSelectionVersion,
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      model_options: currentModelOptionsPayload(),
      message: outboundContent(prompt, turnAttachments),
      system_message: HERMES_BROWSER_SYSTEM_PROMPT,
    }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Hermes stream failed (${response.status}): ${text.slice(0, 900)}`);
  }
  return readSseResponse(response, onDelta, onTool, { signal, onRun, onSteerQueued, onRuntime });
}

async function streamChatCompletions(prompt, onDelta, onTool, { signal, attachments: turnAttachments = attachments, onRun } = {}) {
  const response = await apiFetch('/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'X-Hermes-Session-Id': settings.sessionId,
      'X-Hermes-Session-Key': settings.sessionId,
    },
    body: JSON.stringify({
      client_runtime_version: modelSelectionVersion,
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      model_options: currentModelOptionsPayload(),
      stream: true,
      messages: [
        { role: 'system', content: HERMES_BROWSER_SYSTEM_PROMPT },
        { role: 'user', content: outboundContent(prompt, turnAttachments) },
      ],
    }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Hermes chat-completions stream failed (${response.status}): ${text.slice(0, 900)}`);
  }
  return readSseResponse(response, onDelta, onTool, { signal, onRun });
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function publicApiFetch(path, options = {}) {
  const base = normalizeGatewayUrl(settings.gatewayUrl);
  const hasBody = typeof options.body !== 'undefined';
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openApprovalUrl(url) {
  if (!url) return;
  try {
    await chrome.tabs.create({ url });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

async function pollPairing(pairingId, { attempts = 90, delay = 1500 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const response = await publicApiFetch(`/api/browser-extension/pair/status/${encodeURIComponent(pairingId)}`, { method: 'GET' });
    const payload = await readJsonResponse(response);
    if (payload.status === 'approved' && payload.token) return payload.token;
    if (payload.status === 'expired' || response.status === 410) throw new Error('Pairing expired. Click Connect again.');
    if (response.status === 404) throw new Error('Pairing request was not found. Click Connect again.');
    els.connectStatus.textContent = 'Waiting for Hermes Desktop approval...';
    await sleep(delay);
  }
  throw new Error('Timed out waiting for Hermes Desktop approval.');
}

async function connectToHermes() {
  settings.gatewayUrl = normalizeGatewayUrl(settings.gatewayUrl || els.gatewayUrlInput.value || DEFAULT_SETTINGS.gatewayUrl);
  settings.gatewayMode = normalizeGatewayMode(settings.gatewayMode || els.gatewayModeInput?.value || DEFAULT_SETTINGS.gatewayMode);
  const summary = currentGatewaySummary();
  markConnectionProbe('connecting', summary.normalizedUrl);
  els.connectButton.disabled = true;
  els.connectButton.textContent = 'Connecting...';
  els.connectStatus.textContent = `Looking for ${summary.title} at ${summary.normalizedUrl}...`;
  try {
    const health = await publicApiFetch('/health', { method: 'GET' });
    if (!health.ok) throw new Error(`Hermes API server is not reachable (${health.status}).`);

    const capabilities = await loadGatewayCapabilities({ quiet: true, publicOnly: true, healthOk: true });
    if (!capabilities.browserPairing) {
      markConnectionProbe('unconfigured', 'Manual setup required; automatic browser pairing is not advertised by this Hermes runtime.');
      els.connectStatus.textContent = 'Automatic pairing is not available on this Hermes runtime. Open Settings and use Manual setup with your Gateway URL and API token.';
      setStatus('warn', 'Manual setup required', 'This Hermes runtime does not advertise browser pairing yet.');
      openSettingsDialog();
      return;
    }

    const start = await publicApiFetch('/api/browser-extension/pair/start', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Hermes Browser Extension',
        extensionId: chrome.runtime?.id || '',
      }),
    });
    const payload = await readJsonResponse(start);
    if (!start.ok) throw new Error(pairingFailureMessage(start.status, payload));

    if (payload.token) {
      settings.apiKey = payload.token;
    } else {
      els.connectStatus.textContent = 'Approval opened. Approve Hermes Browser Extension, then return here.';
      await openApprovalUrl(payload.approval_url);
      settings.apiKey = await pollPairing(payload.pairing_id);
    }

    settings.tokenSource = 'pairing';
    settings.lastConnectionTestedAt = Date.now();
    await chrome.storage.local.set({ hermesBrowserSettings: settings });
    syncSettingsForm();
    updateConnectionPrompt();
    await loadGatewayCapabilities({ quiet: true, healthOk: true });
    await loadModels({ quiet: true });
    await loadSkills({ quiet: true });
    await loadProfiles({ quiet: true });
    await loadSessions({ quiet: true });
    await initializeSessionForPanelOpen({ focus: false });
    els.connectStatus.textContent = 'Connected to Hermes. You can start chatting with page context.';
    markGatewayReachable(normalizeGatewayUrl(settings.gatewayUrl));
    setStatus('ok', 'Hermes Browser Extension connected', normalizeGatewayUrl(settings.gatewayUrl));
  } catch (error) {
    markGatewayUnreachable(error);
    els.connectStatus.textContent = `${currentConnectionTroubleshooting() || error?.message || String(error)} Manual setup is still available in settings.`;
    openSettingsDialog();
  } finally {
    els.connectButton.disabled = false;
    els.connectButton.textContent = 'Connect to Hermes';
  }
}

async function fallbackSessionChat(prompt, turnAttachments = attachments, { onRuntime } = {}) {
  const hasSessionRoutes = await ensureHermesSession();
  if (!hasSessionRoutes) return fallbackChatCompletions(prompt, turnAttachments);

  const response = await apiFetch(`/api/sessions/${encodeSessionId(settings.sessionId)}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      model_options: currentModelOptionsPayload(),
      message: outboundContent(prompt, turnAttachments),
      system_message: HERMES_BROWSER_SYSTEM_PROMPT,
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Hermes request failed (${response.status})`);
  onRuntime?.(payload);
  return extractAssistantText(payload);
}

async function fallbackChatCompletions(prompt, turnAttachments = attachments) {
  const response = await apiFetch('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'X-Hermes-Session-Id': settings.sessionId,
      'X-Hermes-Session-Key': settings.sessionId,
    },
    body: JSON.stringify({
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      model_options: currentModelOptionsPayload(),
      stream: false,
      messages: [
        { role: 'system', content: HERMES_BROWSER_SYSTEM_PROMPT },
        { role: 'user', content: outboundContent(prompt, turnAttachments) },
      ],
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Hermes request failed (${response.status})`);
  return extractAssistantText(payload);
}

async function askHermes(userText, turnAttachments = [...attachments]) {
  if (!isConnected()) {
    updateConnectionPrompt();
    addMessage('system', isRemoteWsMode()
      ? 'Remote setup needed: enter your dashboard https URL in Settings and sign in to that dashboard in a browser tab. Your draft is still in the composer.'
      : 'Connection setup needed: click Connect to Hermes if your install supports pairing, or open Settings and use Manual setup with your Gateway URL and token. Your draft is still in the composer.');
    els.connectButton.focus();
    return false;
  }

  const autoTitle = autoTitleForCurrentTurn(userText);
  sending = true;
  const selectedModel = currentSelectedModel();
  if (selectedModel && !isModelRuntimeSelectable(selectedModel)) {
    setStatus('warn', 'Sending observed model request', `${modelDisplayName(selectedModel)} was discovered from session history. The extension will request it, but the connected Hermes gateway may use its configured model if it does not support per-request overrides.`);
  }
  activeAbortController = new AbortController();
  activeRunId = '';
  updateComposerBusyState();
  els.input.value = '';
  attachments = [];
  renderAttachments();
  renderSkillSuggestions();
  renderContextWindow('');

  let didSend = false;
  let shouldFlushQueue = false;
  try {
    const preparedAttachments = await saveImageAttachmentsForTurn(turnAttachments);
    const context = await refreshContext();

    // Detect /command at the start of userText and resolve to a command prompt.
    // Attachments are appended after command expansion so /summarize + file/text
    // carries the same attachment context as a normal chat turn.
    const parsedCommand = parseCommandInput(userText);
    let basePromptText = userText;
    if (parsedCommand) {
      const resolved = resolveCommandPrompt(parsedCommand.command.name, parsedCommand.userInput, {
        activeTab: context.activeTab,
        tabs: context.tabs,
        pageContext: context.pageContext,
        settings,
      });
      basePromptText = resolved?.prompt || userText;
    }
    const promptUserText = userTextWithAttachments(basePromptText, preparedAttachments);
    const displayUserText = preparedAttachments.length
      ? `${userText || 'Attachment-only turn.'}\n${preparedAttachments.map((attachment) => `${attachmentIcon(attachment.kind)} ${attachment.label}`).join('\n')}`
      : userText;
    const promptTabs = filterPromptTabs(context.tabs, contextScope);
    const selectedPromptTabs = Array.isArray(contextScope.selectedTabIds) ? promptTabs : undefined;
    const contextHash = contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY ? '' : browserContextPayloadHash({
      activeTab: context.activeTab,
      selectedTabs: selectedPromptTabs || promptTabs,
      pageContext: context.pageContext,
      settings,
    });
    const prompt = buildHermesPrompt({
      userText: promptUserText,
      activeTab: context.activeTab,
      tabs: context.tabs,
      pageContext: context.pageContext,
      selectedTabs: selectedPromptTabs,
      contextScope,
      settings,
    });

    const receipt = buildContextReceipt({ context, attachments: preparedAttachments, settings, contextHash });
    const { node: userNode } = addMessage('user', displayUserText);
    appendContextReceipt(userNode, receipt);
    const { node } = addMessage('assistant', THINKING_PLACEHOLDER, { persist: false });
    const streamView = createStreamingMessageUpdater(node);
    let answer = '';
    let liveText = '';
    try {
      answer = await streamSessionChat(
        prompt,
        (partial) => {
          liveText = partial || '';
          streamView.updateText(liveText || THINKING_PLACEHOLDER);
        },
        (tool) => streamView.updateTool(normalizeToolActivity(tool.data || tool)),
        {
          signal: activeAbortController.signal,
          attachments: preparedAttachments,
          onRun: (runId) => {
            activeRunId = runId;
          },
          onSteerQueued: restoreBackendQueuedSteerDraft,
          onRuntime: applyTurnRuntimePayload,
        },
      );
    } catch (streamError) {
      if (isAbortError(streamError)) {
        answer = liveText ? `${liveText}\n\n[stopped by user]` : '[stopped by user]';
      } else if (isRemoteWsMode()) {
        // No REST fallback in remote-dashboard mode — the api_server surface is
        // not reachable cross-origin. Surface the WS/ticket error directly.
        streamView.update(`Could not reach the Hermes dashboard.\n${streamError.message}`);
        throw streamError;
      } else {
        streamView.update(`Streaming failed, retrying non-streaming...\n${streamError.message}`);
        answer = await fallbackSessionChat(prompt, preparedAttachments, { onRuntime: applyTurnRuntimePayload });
      }
    }
    const finalAnswer = answer || liveText || '(empty response)';
    streamView.flush(finalAnswer);
    messages.push({ role: 'assistant', content: finalAnswer, ts: Date.now() });
    await trimAndSaveMessages();
    if (autoTitle) await maybeAutoNameCurrentSession(autoTitle);
    await loadSessions({ quiet: true });
    didSend = true;
  } catch (error) {
    if (!isAbortError(error)) {
      const diagnostic = classifyGatewayError(error);
      if (diagnostic.probeStatus === 'degraded') {
        markGatewayDegraded(error);
      } else {
        markGatewayUnreachable(error);
      }
      addMessage('system', diagnostic.kind === 'unknown'
        ? `Hermes Browser Extension error: ${error?.message || String(error)}`
        : `Hermes Browser Extension warning: ${diagnostic.userMessage}`);
    } else {
      addMessage('system', `Hermes Browser Extension error: ${error?.message || String(error)}`);
    }
  } finally {
    activeAbortController = null;
    activeRunId = '';
    pendingSteerText = '';
    sending = false;
    updateComposerBusyState();
    renderContextWindow();
    els.input.focus();
    shouldFlushQueue = shouldAutoFlushQueuedTurn(queuedTurn);
  }
  if (shouldFlushQueue) {
    const next = queuedTurn;
    queuedTurn = null;
    renderQueueNotice();
    await askHermes(next.text, next.attachments || []);
  }
  return didSend;
}

let testConnectionFlashTimer = null;

function flashTestConnectionResult(ok) {
  const button = els.testConnectionButton;
  if (!button) return;
  clearTimeout(testConnectionFlashTimer);
  button.classList.remove('success', 'error');
  button.classList.add(ok ? 'success' : 'error');
  button.textContent = ok ? 'Connected ✓' : 'Failed';
  testConnectionFlashTimer = setTimeout(() => {
    button.classList.remove('success', 'error');
    button.textContent = 'Test connection';
  }, 2600);
}

async function testConnection() {
  await saveSettingsFromForm();
  markConnectionProbe('connecting', normalizeGatewayUrl(settings.gatewayUrl));
  els.testConnectionButton.disabled = true;
  els.testConnectionButton.textContent = 'Testing...';
  els.testConnectionButton.classList.remove('success', 'error');
  clearTimeout(testConnectionFlashTimer);
  let ok = false;
  try {
    if (isRemoteWsMode()) {
      // The dashboard's REST surface (including /api/status) is CORS-blocked
      // from the extension origin, so the WebSocket is the only thing we can
      // exercise. Minting a ticket + opening the socket validates the whole
      // path: a signed-in dashboard tab, the ticket flow, and the handshake.
      const connection = await ensureRemoteWsClient();
      let modelNote = '';
      try {
        const models = await connection.client.request(WS_METHODS.modelOptions);
        await loadModels({ quiet: true, payload: models });
        modelNote = availableModels.length ? ` · ${availableModels.length} models` : '';
      } catch {
        // model.options shape varies across gateways; the socket is already proven.
      }
      updateConnectionPrompt();
      markGatewayReachable(`${normalizeGatewayUrl(settings.gatewayUrl)}${modelNote}`);
      lastRemoteDiagnostic = null;
      renderRemoteDiagnostics(null);
      setStatus('ok', 'Remote Hermes dashboard connected', `${normalizeGatewayUrl(settings.gatewayUrl)}${modelNote}`);
      settings = { ...settings, lastConnectionTestedAt: Date.now() };
      await chrome.storage.local.set({ hermesBrowserSettings: settings });
      renderConnectionSecurity();
      ok = true;
      return;
    }
    const response = await apiFetch('/health', { method: 'GET' });
    const text = await response.text();
    if (!response.ok) {
      if (isRemoteMode()) {
        const diagnostic = classifyRemoteGatewaySetup({
          url: settings.gatewayUrl,
          status: response.status,
          location: response.headers?.get?.('location') || '',
          body: text,
        });
        lastRemoteDiagnostic = diagnostic;
        renderRemoteDiagnostics(diagnostic);
        throw new Error(`${diagnostic.title}: ${diagnostic.detail}`);
      }
      throw new Error(`${response.status}: ${text}`);
    }
    await loadGatewayCapabilities({ quiet: true, healthOk: true });

    const modelsResponse = await apiFetch('/v1/models', { method: 'GET' });
    const modelsPayload = await readJsonResponse(modelsResponse);
    let degradedDiagnostic = null;
    if (!modelsResponse.ok) {
      if (isRemoteMode()) {
        const remoteDiagnostic = classifyRemoteGatewaySetup({
          url: settings.gatewayUrl,
          healthOk: true,
          status: modelsResponse.status,
          body: JSON.stringify(modelsPayload).slice(0, 700),
        });
        lastRemoteDiagnostic = remoteDiagnostic;
        renderRemoteDiagnostics(remoteDiagnostic);
      }
      const diagnostic = classifyGatewayError(`Health OK, auth/model probe failed (${modelsResponse.status}): ${JSON.stringify(modelsPayload).slice(0, 500)}`);
      if (diagnostic.probeStatus === 'degraded') {
        degradedDiagnostic = diagnostic;
      } else {
        throw new Error(`Health OK, auth/model probe failed (${modelsResponse.status}): ${JSON.stringify(modelsPayload).slice(0, 500)}`);
      }
    } else {
      await loadModels({ quiet: true });
    }
    await loadSkills({ quiet: true });
    await loadProfiles({ quiet: true });

    const hasSessionRoutes = await ensureHermesSession();
    if (degradedDiagnostic) {
      setStatus('warn', 'Hermes gateway connected with runtime warning', degradedDiagnostic.detail);
      markGatewayDegraded(degradedDiagnostic.detail);
    } else {
      setStatus(
        'ok',
        hasSessionRoutes ? 'Hermes gateway + session API connected' : 'Hermes gateway connected',
        hasSessionRoutes ? normalizeGatewayUrl(settings.gatewayUrl) : `${normalizeGatewayUrl(settings.gatewayUrl)} - OpenAI-compatible fallback mode`,
      );
      markGatewayReachable(normalizeGatewayUrl(settings.gatewayUrl));
      lastRemoteDiagnostic = null;
      renderRemoteDiagnostics(null);
    }

    settings = { ...settings, lastConnectionTestedAt: Date.now() };
    await chrome.storage.local.set({ hermesBrowserSettings: settings });
    renderConnectionSecurity();

    ok = true;
  } catch (error) {
    markGatewayUnreachable(error);
    if (isRemoteMode()) {
      const diagnostic = classifyRemoteGatewaySetup({
        url: settings.gatewayUrl,
        error: error?.message || String(error),
      });
      if (diagnostic.kind !== 'unknown') {
        lastRemoteDiagnostic = diagnostic;
        renderRemoteDiagnostics(diagnostic);
        setStatus('error', diagnostic.title, diagnostic.detail);
      } else {
        setStatus('error', 'Hermes gateway test failed', currentConnectionTroubleshooting() || error?.message || String(error));
      }
    } else {
      setStatus('error', 'Hermes gateway test failed', currentConnectionTroubleshooting() || error?.message || String(error));
    }
  } finally {
    els.testConnectionButton.disabled = false;
    flashTestConnectionResult(ok);
  }
}

function closeFloatingPanels() {
  els.modelMenu.hidden = true;
  els.modelMenuButton.setAttribute('aria-expanded', 'false');
  els.sessionMenu.hidden = true;
  els.sessionMenuButton.setAttribute('aria-expanded', 'false');
  els.attachMenu.hidden = true;
  els.attachMenuButton.setAttribute('aria-expanded', 'false');
  if (els.skillMenu) els.skillMenu.hidden = true;
  els.contextPopover.hidden = true;
  els.contextBarButton.setAttribute('aria-expanded', 'false');
}

function eventPathContains(event, node) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path.includes(node) || node.contains(event.target);
}

function bindEvents() {
  els.settingsButton.addEventListener('click', openSettingsDialog);
  els.manualSettingsButton.addEventListener('click', openSettingsDialog);
  [els.modelMenu, els.sessionMenu, els.contextPopover, els.attachMenu, els.skillMenu].filter(Boolean).forEach((panel) => {
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('pointerdown', (event) => event.stopPropagation());
  });
  els.connectButton.addEventListener('click', connectToHermes);
  els.sessionMenuButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    const nextHidden = !els.sessionMenu.hidden;
    closeFloatingPanels();
    els.sessionMenu.hidden = nextHidden;
    els.sessionMenuButton.setAttribute('aria-expanded', String(!nextHidden));
    if (!nextHidden) {
      await loadSessions({ quiet: true });
      els.sessionSearchInput.focus();
      els.sessionSearchInput.select();
    }
  });
  els.newSessionButton.addEventListener('click', async () => {
    if (!isConnected()) {
      updateConnectionPrompt();
      els.connectButton.focus();
      return;
    }
    try {
      await createHermesBrowserSession();
      await loadSessions({ quiet: true });
      setStatus('ok', 'New Hermes Browser Extension session', settings.sessionId);
    } catch (error) {
      setStatus('error', 'Could not create session', error?.message || String(error));
    }
  });
  els.createSessionButton.addEventListener('click', async () => {
    try {
      await createHermesBrowserSession();
      els.sessionMenu.hidden = true;
      els.sessionMenuButton.setAttribute('aria-expanded', 'false');
      await loadSessions({ quiet: true });
    } catch (error) {
      setStatus('error', 'Could not create session', error?.message || String(error));
    }
  });
  els.refreshSessionsButton.addEventListener('click', () => loadSessions());
  els.sessionSearchInput.addEventListener('input', () => renderSessionMenu(els.sessionSearchInput.value));
  els.closeSettingsButton.addEventListener('click', closeSettingsDialog);
  els.copyRemoteEnvButton?.addEventListener('click', async () => {
    const text = els.remoteEnvBlock?.textContent || remoteEnvBlockText();
    try {
      await navigator.clipboard.writeText(text);
      setStatus('ok', 'Remote env copied', 'Paste this into the Hermes API-server environment on the remote machine.');
    } catch (error) {
      setStatus('warn', 'Could not copy env block', error?.message || String(error));
    }
  });
  els.settingsDialog.addEventListener('click', (event) => {
    if (event.target === els.settingsDialog) closeSettingsDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.settingsDialog.hidden) closeSettingsDialog();
      closeFloatingPanels();
    }
  });
  document.addEventListener('click', (event) => {
    if (!els.modelMenu.hidden && !eventPathContains(event, els.modelMenu) && !eventPathContains(event, els.modelMenuButton)) {
      els.modelMenu.hidden = true;
      els.modelMenuButton.setAttribute('aria-expanded', 'false');
    }
    if (!els.sessionMenu.hidden && !eventPathContains(event, els.sessionMenu) && !eventPathContains(event, els.sessionMenuButton)) {
      els.sessionMenu.hidden = true;
      els.sessionMenuButton.setAttribute('aria-expanded', 'false');
    }
    if (!els.attachMenu.hidden && !eventPathContains(event, els.attachMenu) && !eventPathContains(event, els.attachMenuButton)) {
      els.attachMenu.hidden = true;
      els.attachMenuButton.setAttribute('aria-expanded', 'false');
    }
    if (els.skillMenu && !els.skillMenu.hidden && !eventPathContains(event, els.skillMenu) && event.target !== els.input) {
      els.skillMenu.hidden = true;
    }
    if (!els.contextPopover.hidden && !eventPathContains(event, els.contextPopover) && !eventPathContains(event, els.contextBarButton)) {
      els.contextPopover.hidden = true;
      els.contextBarButton.setAttribute('aria-expanded', 'false');
    }
  });
  els.refreshButton.addEventListener('click', () => {
    refreshContextWithSpin().catch((error) => setStatus('warn', 'Context refresh unavailable', error?.message || String(error)));
  });
  els.stopButton?.addEventListener('click', stopCurrentTurn);
  els.queueButton?.addEventListener('click', queueCurrentDraft);
  els.steerButton?.addEventListener('click', () => { steerCurrentDraft(); });
  els.queueNotice?.addEventListener('click', (event) => {
    const action = event.target?.closest?.('[data-queued-action]')?.dataset?.queuedAction;
    if (action === 'delete') deleteQueuedTurn();
    if (action === 'steer') steerQueuedTurn();
  });
  els.voiceButton?.addEventListener('click', toggleVoiceDictation);
  els.checkUpdatesButton?.addEventListener('click', checkForUpdates);
  els.refreshModelsButton.addEventListener('click', refreshModelsFromMenu);
  renderModelRefreshState();
  els.refreshProfilesButton?.addEventListener('click', () => loadProfiles());
  els.profileSelect?.addEventListener('change', () => applySelectedProfile(els.profileSelect.value));
  els.refreshAgentsButton?.addEventListener('click', () => loadAgents());
  els.addCustomAgentButton?.addEventListener('click', () => {
    const ports = parseAgentPortsInput(els.agentPortsInput?.value || '');
    if (!ports.length) {
      setStatus('warn', 'No agent ports', 'Enter at least one port number, e.g. 8642,8643,8644,8645,8646');
      return;
    }
    persistAgentDiscoverySettings({
      ports,
      host: els.agentHostInput?.value || settings.agentDiscoveryHost,
      scheme: els.agentSchemeInput?.value || settings.agentDiscoveryScheme,
    }).then(() => loadAgents()).catch((error) => setStatus('warn', 'Agent settings invalid', error?.message || String(error)));
  });
  els.agentPortsInput?.addEventListener('change', () => {
    const ports = parseAgentPortsInput(els.agentPortsInput.value);
    if (ports.length) {
      persistAgentDiscoverySettings({ ports }).catch((error) => setStatus('warn', 'Agent ports invalid', error?.message || String(error)));
    }
  });
  els.agentHostInput?.addEventListener('change', () => {
    persistAgentDiscoverySettings({ host: els.agentHostInput.value }).catch((error) => setStatus('warn', 'Agent host invalid', error?.message || String(error)));
  });
  els.agentSchemeInput?.addEventListener('change', () => {
    persistAgentDiscoverySettings({ scheme: els.agentSchemeInput.value }).catch((error) => setStatus('warn', 'Agent scheme invalid', error?.message || String(error)));
  });
  els.editModelsButton.addEventListener('click', () => {
    closeFloatingPanels();
    openSettingsDialog();
    setStatus('warn', 'Edit models in Hermes Desktop', 'Use Hermes Desktop model settings or the Hermes model command, then Refresh Models here.');
  });
  els.modelMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextHidden = !els.modelMenu.hidden;
    closeFloatingPanels();
    els.modelMenu.hidden = nextHidden;
    els.modelMenuButton.setAttribute('aria-expanded', String(!nextHidden));
    if (!nextHidden) {
      els.modelSearchInput.focus();
      els.modelSearchInput.select();
    }
  });
  els.modelOptionsList.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      if (key === 'thinking') setModelRuntimeOption('thinkingEnabled', settings.thinkingEnabled === false);
      if (key === 'fast') setModelRuntimeOption('fastMode', !normalizeFastMode(settings.fastMode));
      return;
    }
    const effort = event.target.closest('[data-effort]');
    if (effort) {
      setModelRuntimeOption('reasoningEffort', normalizeReasoningEffort(effort.dataset.effort));
    }
  });
  els.modelSearchInput.addEventListener('input', () => renderModelMenu(els.modelSearchInput.value));
  els.attachMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextHidden = !els.attachMenu.hidden;
    closeFloatingPanels();
    els.attachMenu.hidden = nextHidden;
    els.attachMenuButton.setAttribute('aria-expanded', String(!nextHidden));
  });
  els.attachMenu.addEventListener('click', async (event) => {
    const attachButton = event.target.closest('[data-attach]');
    const snippetButton = event.target.closest('[data-snippet]');
    if (snippetButton) {
      const text = snippetButton.dataset.snippet || '';
      els.input.value = els.input.value ? `${els.input.value}\n${text}` : text;
      renderContextWindow();
      els.input.focus();
      return;
    }
    if (!attachButton) return;
    const kind = attachButton.dataset.attach;
    try {
      if (kind === 'files') els.fileInput.click();
      if (kind === 'folder') els.folderInput.click();
      if (kind === 'images') els.imageInput.click();
      if (kind === 'paste-image') await pasteClipboardImage();
      if (kind === 'url') attachUrl();
    } catch (error) {
      addMessage('system', `Attach failed: ${error?.message || String(error)}`);
    }
  });
  els.fileInput.addEventListener('change', async () => {
    await attachFiles(els.fileInput.files);
    els.fileInput.value = '';
  });
  els.imageInput.addEventListener('change', async () => {
    await attachFiles(els.imageInput.files, { imagesOnly: true });
    els.imageInput.value = '';
  });
  els.folderInput.addEventListener('change', async () => {
    await attachFolder(els.folderInput.files);
    els.folderInput.value = '';
  });
  els.contextChip.addEventListener('click', () => {
    const nextHidden = !els.contextPreview.hidden;
    els.contextPreview.hidden = nextHidden;
    els.contextChip.setAttribute('aria-expanded', String(!nextHidden));
  });
  els.contextBarButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextHidden = !els.contextPopover.hidden;
    closeFloatingPanels();
    els.contextPopover.hidden = nextHidden;
    els.contextBarButton.setAttribute('aria-expanded', String(!nextHidden));
  });
  els.contextCompactButton?.addEventListener('click', () => {
    compactCurrentSessionContext().catch((error) => setStatus('warn', 'Context compaction failed', error?.message || String(error)));
  });
  els.testConnectionButton.addEventListener('click', testConnection);
  els.copyDiagnosticsButton?.addEventListener('click', () => {
    copySupportDiagnostics().catch((error) => setStatus('warn', 'Diagnostics copy failed', error?.message || String(error)));
  });
  els.clearTokenButton?.addEventListener('click', () => {
    clearStoredToken().catch((error) => setStatus('warn', 'Could not clear token', error?.message || String(error)));
  });
  els.gatewayModeInput?.addEventListener('change', () => {
    const summary = currentGatewaySummary({ gatewayMode: els.gatewayModeInput.value, gatewayUrl: els.gatewayUrlInput.value });
    if (!els.gatewayUrlInput.value.trim() || els.gatewayUrlInput.value.trim() === DEFAULT_SETTINGS.gatewayUrl) {
      els.gatewayUrlInput.value = summary.mode.defaultUrl || DEFAULT_SETTINGS.gatewayUrl;
    }
    renderGatewayHelp();
  });
  els.gatewayUrlInput?.addEventListener('input', renderGatewayHelp);
  for (const card of document.querySelectorAll('[data-gateway-location]')) {
    card.addEventListener('click', () => {
      const local = card.dataset.gatewayLocation === 'local';
      applyGatewayMode(local ? 'local-api' : remoteGatewayModeForKey(els.apiKeyInput?.value));
    });
  }
  // In remote mode the key field decides the transport: a key means a remote
  // API server, blank means the dashboard WebSocket. Re-derive as the user types.
  els.apiKeyInput?.addEventListener('input', () => {
    if (gatewayLocationOf(els.gatewayModeInput?.value) === 'remote') {
      applyGatewayMode(remoteGatewayModeForKey(els.apiKeyInput.value));
    }
  });
  for (const button of els.colorModeButtons || []) {
    button.addEventListener('click', () => setAppearanceOption('colorMode', button.dataset.colorMode));
  }
  for (const button of els.textSizeButtons || []) {
    button.addEventListener('click', () => setAppearanceOption('textSize', button.dataset.textSize));
  }
  els.themeGrid?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-theme]');
    if (!card) return;
    setAppearanceOption('appearanceTheme', card.dataset.theme);
  });
  systemColorQuery?.addEventListener?.('change', () => {
    if (normalizeColorMode(settings.colorMode) === 'system') renderAppearanceControls();
  });
  els.settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await saveSettingsFromForm();
      await probeGatewayLiveness({ quiet: false });
      if (settings.apiKey && isConnected()) {
        await loadGatewayCapabilities({ quiet: true, healthOk: true });
        await loadModels({ quiet: true });
        await loadSkills({ quiet: true });
        await loadProfiles({ quiet: true });
        await loadSessions({ quiet: true });
        await initializeSessionForPanelOpen({ focus: false });
      }
      closeSettingsDialog();
      await refreshContext();
    } catch (error) {
      setStatus('warn', 'Settings not saved', error?.message || String(error));
    }
  });
  els.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (sending) {
      const action = busyComposerSubmitAction({
        sending,
        draftText: els.input.value,
        attachmentCount: attachments.length,
        canSteer: canSteerActiveRun(),
      });
      if (action === 'steer') await steerCurrentDraft();
      else if (action === 'queue') queueCurrentDraft();
      return;
    }
    const userText = els.input.value.trim();
    if (!userText && !attachments.length) return;
    await askHermes(userText, [...attachments]);
  });
  els.input.addEventListener('keydown', (event) => {
    if (!els.skillMenu.hidden && (event.key === 'Tab' || event.key === 'ArrowRight')) {
      const first = els.skillMenu.querySelector('[data-command]');
      if (first?.dataset.command) {
        event.preventDefault();
        replaceActiveSkillToken(first.dataset.command);
        return;
      }
    }
    const action = composerKeyAction(event, {
      sending,
      draftText: els.input.value,
      attachmentCount: attachments.length,
      canSteer: canSteerActiveRun(),
    });
    if (action !== 'none') {
      event.preventDefault();
      if (action === 'submit') els.composer.requestSubmit();
      else if (action === 'steer') steerCurrentDraft();
      else if (action === 'queue') queueCurrentDraft();
    }
  });
  els.input.addEventListener('paste', (event) => {
    handlePasteImages(event).catch((error) => addMessage('system', `Paste failed: ${error?.message || String(error)}`));
  });
  document.addEventListener('paste', (event) => {
    const tag = String(event.target?.tagName || '').toUpperCase();
    const editable = event.target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
    if (event.target === els.input || editable) return;
    handlePasteImages(event).catch((error) => addMessage('system', `Paste failed: ${error?.message || String(error)}`));
  });
  ['dragenter', 'dragover'].forEach((type) => {
    els.composerDropZone?.addEventListener(type, (event) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      if (type === 'dragenter') dragDepth += 1;
      setDropActive(true);
    });
  });
  els.composerDropZone?.addEventListener('dragleave', (event) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDropActive(false);
  });
  els.composerDropZone?.addEventListener('drop', (event) => {
    handleComposerDrop(event).catch((error) => addMessage('system', `Drop attach failed: ${error?.message || String(error)}`));
  });
  els.input.addEventListener('input', () => {
    renderContextWindow();
    renderSkillSuggestions();
    updateComposerBusyState();
  });
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', async () => {
      els.input.value = button.dataset.prompt || '';
      els.composer.requestSubmit();
    });
  });

  els.contextScopeButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!els.contextScopeMenu) return;
    if (!els.contextScopeMenu.hidden) {
      els.contextScopeMenu.hidden = true;
      renderContextScopeControls();
      return;
    }
    renderContextScopeMenu();
  });
  els.contextScopeMenu?.addEventListener('input', (event) => {
    if (!event.target?.matches?.('.context-scope-search')) return;
    renderContextScopeTabList(event.target.value);
  });
  els.contextScopeMenu?.addEventListener('click', (event) => {
    event.stopPropagation();
    const promptToggle = event.target.closest('[data-prompt-tab-toggle]');
    if (promptToggle) {
      event.stopPropagation();
      const tabId = Number(promptToggle.dataset.promptTabToggle);
      const tab = (currentContext.tabs || []).find((item) => Number(item.id) === tabId);
      togglePromptTabSelection(tab);
      rerenderContextScopePromptSelectionPreservingScroll(currentContextScopeSearchQuery());
      return;
    }

    const button = event.target.closest('[data-scope-action]');
    if (!button) return;
    const action = button.dataset.scopeAction || '';
    if (action === 'prompt-tabs-all') {
      setPromptTabsSelection(null);
      rerenderContextScopePromptSelectionPreservingScroll(currentContextScopeSearchQuery());
      return;
    }
    if (action === 'prompt-tabs-none') {
      setPromptTabsSelection([]);
      rerenderContextScopePromptSelectionPreservingScroll(currentContextScopeSearchQuery());
      return;
    }

    els.contextScopeMenu.hidden = true;
    if (action === 'chat-only') {
      applyContextScope({ mode: CONTEXT_SCOPE_MODES.CHAT_ONLY }, { ensureSession: false })
        .catch((error) => setStatus('warn', 'Could not switch to Chat only', error?.message || String(error)));
      return;
    }
    if (action === 'follow-active' || action === 'unlock') {
      unlockContextScope().catch((error) => setStatus('warn', 'Could not unlock tab scope', error?.message || String(error)));
      return;
    }
    if (action === 'pin-active') {
      activeTab().then(pinContextTab).catch((error) => setStatus('warn', 'Could not pin active tab', error?.message || String(error)));
      return;
    }
    if (action.startsWith('pin-tab:')) {
      const tabId = Number(action.slice('pin-tab:'.length));
      pinContextTabById(tabId).catch((error) => setStatus('warn', 'Could not pin tab', error?.message || String(error)));
    }
  });

  els.commandMenuButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!els.quickMoreMenu) return;
    if (!els.quickMoreMenu.hidden) {
      setQuickCommandMenuOpen(false);
      return;
    }
    renderQuickMoreMenu('all');
  });

  // Close floating menus on outside click
  document.addEventListener('click', (event) => {
    if (els.quickMoreMenu && !els.quickMoreMenu.hidden && !event.target.closest('#quickMoreMenu, #commandMenuButton')) {
      setQuickCommandMenuOpen(false);
    }
    if (els.contextScopeMenu && !els.contextScopeMenu.hidden && !event.target.closest('#contextScopeMenu, #contextScopeButton')) {
      els.contextScopeMenu.hidden = true;
      renderContextScopeControls();
    }
  });
  chrome.tabs?.onActivated?.addListener?.((activeInfo) => {
    if (shouldRefreshForTabEvent({ scope: contextScope, eventType: 'activated', eventTabId: activeInfo?.tabId })) refreshContext();
  });
  chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
    if (!(changeInfo.status === 'complete' || changeInfo.title || changeInfo.url)) return;
    if (shouldRefreshForTabEvent({ scope: contextScope, eventType: 'updated', eventTabId: tabId })) refreshContext();
  });
  chrome.tabs?.onRemoved?.addListener?.((tabId) => {
    if (shouldRefreshForTabEvent({ scope: contextScope, eventType: 'removed', eventTabId: tabId })) refreshContext();
  });
  chrome.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type === 'HERMES_VOICE_TRANSCRIPT') {
      consumeVoiceDraft(message).then((ok) => sendResponse?.({ ok })).catch((error) => sendResponse?.({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === 'HERMES_VOICE_STATUS') {
      setStatus(message.kind || 'ok', message.title || 'Voice dictation', message.detail || '');
      sendResponse?.({ ok: true });
      return false;
    }
    return false;
  });
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== 'local' || !changes?.[VOICE_DRAFT_STORAGE_KEY]?.newValue) return;
    consumeVoiceDraft(changes[VOICE_DRAFT_STORAGE_KEY].newValue).catch((error) => {
      setStatus('warn', 'Voice transcript handoff failed', error?.message || String(error));
    });
  });
}

async function runStartupReadiness() {
  startupReadiness = initialStartupReadiness(settings);
  renderStartupReadiness();
  try {
    setStartupReadiness({ phase: 'settings', step: 'settings', status: 'active', detail: 'Loading Browser settings…' });
    await loadSettings({ restoreMessages: false });
    startupReadiness = reduceStartupReadiness(initialStartupReadiness(settings), {
      phase: 'gateway-probe',
      step: 'settings',
      status: 'ready',
      detail: 'Settings restored.',
    });
    renderStartupReadiness();

    setStartupReadiness({ phase: 'gateway-probe', step: 'gateway', status: 'active', detail: `Checking ${normalizeGatewayUrl(settings.gatewayUrl)}…` });
    const state = await probeGatewayLiveness({ quiet: true });
    if (!settings.apiKey || !state.connected) {
      const missingToken = !settings.apiKey;
      setStartupReadiness({
        step: 'gateway',
        status: missingToken ? 'unconfigured' : (state.state === 'unreachable' ? 'unreachable' : 'error'),
        detail: missingToken ? 'Add a Hermes API token or complete pairing to use full Hermes Browser mode.' : currentConnectionTroubleshooting(state),
      });
      renderModelOptions();
      renderSessionMenu();
      renderProfiles();
      renderSkillSuggestions();
      updateSessionLabel();
      return;
    }
    setStartupReadiness({ step: 'gateway', status: 'ready', gateway: { connected: true, state: state.state }, detail: connectionStateTitle(state, currentGatewaySummary()) });

    setStartupReadiness({ phase: 'capabilities', step: 'capabilities', status: 'active', detail: 'Loading runtime capability map…' });
    await loadGatewayCapabilities({ quiet: true, healthOk: true });
    setStartupReadiness({
      step: 'capabilities',
      status: gatewayCapabilities.source === 'legacy' ? 'legacy' : 'ready',
      detail: gatewayCapabilities.source === 'legacy' ? 'Legacy runtime detected; Browser-specific controls are capability-gated.' : 'Capabilities loaded.',
    });

    setStartupReadiness({ phase: 'models', step: 'models', status: 'active', detail: 'Loading model catalog…' });
    await loadModels({ quiet: true });
    setStartupReadiness({ step: 'models', status: availableModels.length ? 'ready' : 'fallback', detail: availableModels.length ? `${availableModels.length} models loaded.` : 'Model catalog unavailable; using fallback runtime metadata.' });

    const modelReady = selectedModelReadiness({ settings, availableModels, activeSessionRuntime });
    setStartupReadiness({
      step: 'selectedModel',
      status: modelReady.status === 'error' && settings.model ? 'fallback' : modelReady.status,
      detail: modelReady.detail,
      selectedModel: modelReady.selectedModel,
    });

    setStartupReadiness({ phase: 'skills', step: 'skills', status: 'active', detail: 'Loading skills…' });
    await loadSkills({ quiet: true });
    setStartupReadiness({ step: 'skills', status: gatewayCapabilities.skills ? 'ready' : 'skipped', detail: gatewayCapabilities.skills ? `${availableSkills.length} skills available.` : 'Skills route unavailable on this runtime.' });

    setStartupReadiness({ phase: 'profiles', step: 'profiles', status: 'active', detail: 'Loading profiles…' });
    await loadProfiles({ quiet: true });
    setStartupReadiness({ step: 'profiles', status: gatewayCapabilities.profiles ? 'ready' : 'skipped', detail: gatewayCapabilities.profiles ? `${availableProfiles.length} profiles available.` : 'Profiles route unavailable on this runtime.' });

    setStartupReadiness({ phase: 'sessions', step: 'sessions', status: 'active', detail: 'Loading sessions…' });
    await loadSessions({ quiet: true });
    setStartupReadiness({ step: 'sessions', status: sessionRoutesAvailable === false ? 'fallback' : 'ready', detail: sessionRoutesAvailable === false ? 'Session routes unavailable; using chat fallback.' : `${availableSessions.length} sessions loaded.` });

    setStartupReadiness({ phase: 'session-ready', step: 'sessionBinding', status: 'active', detail: 'Binding Browser panel to a Hermes session…' });
    await initializeSessionForPanelOpen({ focus: false });
    setStartupReadiness({ step: 'sessionBinding', status: sessionRoutesAvailable === false ? 'fallback' : 'ready', detail: settings.sessionId ? `Session ready: ${settings.sessionId}` : 'Chat fallback ready.' });
    await consumePendingVoiceDraft();
  } catch (error) {
    setStartupReadiness({ phase: 'error', step: 'gateway', status: 'error', blockingError: error?.message || String(error), detail: error?.message || String(error) });
    setStatus('error', 'Startup readiness failed', error?.message || String(error));
    renderEmptyState();
  }
}

bindEvents();
await runStartupReadiness();
try {
  await refreshContext();
} catch (error) {
  setStatus('warn', 'Context refresh unavailable', error?.message || String(error));
}
updateConnectionPrompt();
renderVersionInfo();
renderContextScopeControls();
updateVoiceButtonState();
renderEmptyState();
