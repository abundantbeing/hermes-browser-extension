import {
  contextAccountingSnapshot,
  contextCompactionState,
  contextMeterDisplay,
  estimateTokens,
  applySessionModelBindings,
  groupSessionsForMenu,
  messageDisplayText,
  isModelRuntimeSelectable,
  normalizeHermesModels,
  normalizeHermesSessions,
  normalizeHermesSkills,
  normalizeToolActivity,
  sessionModelBindingFromRuntime,
  shouldAutoFlushQueuedTurn,
  shouldAutoOpenSessionGroup,
  shouldRequireModelLock,
  skillSuggestionsForInput,
} from './lib/common.mjs';
import { renderMarkdownSafe } from './lib/sanitizer.mjs';
import {
  assistModelRoutingSupported,
  resolveAssistModelBindingFromCatalog,
} from './lib/assist-model-contract.mjs';
import {
  DEFAULT_GATEWAY_CAPABILITIES,
  normalizeGatewayCapabilities,
} from './lib/capabilities.mjs';
import { createHermesClient } from './lib/hermes-client.mjs';
import { migrateConnectionSettings, normalizeConnectionMode } from './lib/connection-modes.mjs';
import { SURFACE_KINDS, fullTabEntryPathForPage, parseFullTabHandoff } from './lib/surface-protocol.mjs';
import { WAKE_MESSAGES, WAKE_STORAGE_KEYS, normalizeWakeWordSettings, wakeTurnIsFresh } from './lib/wake-word.mjs';
import {
  APPEARANCE_THEMES,
  normalizeAppearanceTheme,
  normalizeColorMode,
  resolveColorMode,
} from './lib/appearance-themes.mjs';
import {
  appearancePreferencesForSurface,
  applyAppearancePreferences,
  normalizeTextZoomPercent,
  sanitizeLocalFontFamily,
  stepTextZoomPercent,
  withAppearancePreferenceUpdate,
} from './lib/appearance-preferences.mjs';
import {
  CUSTOM_THEME_MAX_INPUT_BYTES,
  CUSTOM_THEME_STORAGE_KEY,
  customThemePaletteForMode,
  customThemeSelection,
  serializeThemeDocument,
  themeCssVariables,
  validateThemeDocument,
} from './lib/custom-themes.mjs';
import {
  deleteCustomTheme,
  installCustomTheme,
  readCustomThemeStore,
  resetCustomThemeStore,
} from './lib/custom-theme-store.mjs';
import { createVscodeMarketplaceClient } from './lib/vscode-marketplace.mjs';
import { createThemeMarketplaceController } from './lib/theme-marketplace-controller.mjs';
import { createThemeMarketplaceTransport } from './lib/theme-marketplace-transport.mjs';
import { getLocale, initI18n, populateLanguageSelect, setLocale, subscribeLocale, t, translateUiText } from './lib/i18n.mjs';
import { mountContextMenuEditor } from './lib/context-menu-editor-client.mjs';
import {
  MODEL_CATALOG_CACHE_STORAGE_KEY,
  dashboardModelDiscoveryBaseUrl,
  discoverCanonicalProviderCatalog,
  discoverGatewayVirtualModels,
  discoverModelsFromDashboard,
  discoverModelsFromRegistry,
  discoverModelsFromSessions,
  mergeModelsWithRegistry,
  mergeVirtualModelRows,
  modelCatalogCacheKey,
  modelCatalogRefreshDecision,
  modelRowsFromGatewayOptions,
  normalizeCachedModelCatalog,
  selectModelCatalogFallback,
  shouldEnrichCanonicalProviderCatalog,
  shouldTrySessionModelFallback,
} from './lib/model-discovery.mjs';
import {
  appendUserImageAttachments,
  extractMediaTags,
  preserveUserImageAttachments,
  resolveImageSource,
  resolvedGeneratedImageSources,
  stripGeneratedImageEchoes,
} from './lib/image-render.mjs';
import { modelLockRequestOutcome, readHermesSse, runSteerFailureState } from './lib/fulltab-runtime.mjs';
import { parseBrowserCommand, resolveCommandPrompt } from './lib/commands.mjs';
import { createDiffusionCanvas } from './lib/diffusion-canvas.mjs';
import {
  MODEL_REASONING_EFFORTS,
  modelRuntimeCapabilities,
  modelRuntimeOptionsPayload as buildModelRuntimeOptionsPayload,
  normalizeModelRuntimeOptions,
} from './lib/model-runtime-options.mjs';
import { extractSelectedWebSkills } from './lib/web-skill-selection.mjs';
import {
  WEB_COMMANDS,
  webComposerSuggestionMode,
  webCommandSuggestions,
} from './lib/web-commands.mjs';
import { artifactActionState, describeArtifact, toFileUrl } from './lib/web-artifacts.mjs';
import { browserDisplayMessages, isRenderableAssistantMessage, shouldPreserveImageGenerationRun } from './lib/web-run-state.mjs';
import { thinkingIndicatorMarkup } from './lib/web-thinking-indicator.mjs';
import { createImageViewerState, imageViewerReducer } from './lib/image-viewer.mjs';
import { writeAssistantClipboardEvent } from './lib/assistant-clipboard.mjs';
import { taskStackFromToolEvent, taskStackProgress, updateTaskStackStore } from './lib/task-stack.mjs';
import {
  DELEGATION_WATCH_STORAGE_KEY,
  createDelegationWatchManager,
  delegationDispatchFromToolEvent,
  delegationDispatchesFromMessages,
  delegationScopeKey,
  isDelegationCompletionMarkerMessage,
  mergeDelegationWatchStores,
} from './lib/async-delegation.mjs';
import { normalizeInlineDraftRoutePreference } from './lib/inline-draft-policy.mjs';
import {
  hermesGatewayTurnError,
  hermesRequestError,
  sessionContextFailureRecovery,
  turnRequestFailureState,
} from './lib/turn-recovery.mjs';
import { buildDashboardWsUrl, buildSessionModelSwitchRequest, createGatewayClient, establishGatewaySession, normalizeGatewayHistoryMessages, runtimeModelFromSessionStatus, WS_EVENTS, WS_METHODS } from './lib/gateway-ws.mjs';
import { isTrustedDashboardOrigin, mintWsTicket, originOf, ticketFailureHelp } from './lib/dashboard-bridge.mjs';
import {
  CONTEXT_CONSENT_STORAGE_KEY,
  consentGrantedForIdentity,
  consentRequiredForConnection,
  contextConsentIdentity,
  dashboardPrincipalFromMe,
  fingerprintContextCredential,
  normalizeContextConsentLedger,
  normalizeContextConsentOrigin,
  persistContextConsentDecision,
} from './lib/context-consent.mjs';
import {
  SESSION_SURFACE_SOURCES,
  requiresSessionOwnershipConfirmation,
  sessionOwnershipNotice,
} from './lib/session-ownership.mjs';
import {
  RUN_CONTROL_PHASES,
  RUN_CONTROL_REQUEST_TIMEOUT_MS,
  RUN_STATUS_POLL_MS,
  RUN_TERMINAL_CONFIRM_TIMEOUT_MS,
  acknowledgeStopRequest,
  beginRunControl,
  canSwitchActiveSession,
  dashboardTerminalStatus,
  markRunStreamClosed,
  markRunTerminal,
  markStopRequestFailed,
  markTerminalTimeout,
  requestRunStop,
  restTerminalStatus,
  runControlGenerationMatches,
  runControlRequestWithTimeout,
  runStopFailureTerminalStatus,
  waitForTerminalStatus,
  withRunControlId,
} from './lib/run-control-lifecycle.mjs';
import { resolveBrowserApi } from './lib/browser-api.mjs';

const $ = (selector) => document.querySelector(selector);
const browserApiResolution = resolveBrowserApi();
const browserApi = browserApiResolution.api;
globalThis.addEventListener('error', (event) => {
  document.documentElement.dataset.hermesWebBootError = String(event?.error?.message || event?.message || 'Hermes Web boot error').slice(0, 320);
});
globalThis.addEventListener('unhandledrejection', (event) => {
  document.documentElement.dataset.hermesWebBootError = String(event?.reason?.message || event?.reason || 'Hermes Web boot rejection').slice(0, 320);
});
const ASSIST_ROUTING_FALLBACK_ENGLISH = 'Your Assist model choice stays saved. This gateway cannot enforce an exact model, so Assist uses the gateway default and labels every fallback result.';
const handoff = parseFullTabHandoff(globalThis.location.search);

const els = {
  shell: $('.web-shell'),
  sessionRail: $('#sessionRail'),
  navToggle: $('#navToggle'),
  inspectorToggle: $('#inspectorToggle'),
  drawerScrim: $('#drawerScrim'),
  sessionSearch: $('#sessionSearch'),
  sessionList: $('#sessionList'),
  sessionCount: $('#sessionCount'),
  sessionTitle: $('#sessionTitle'),
  railVisibilityToggle: $('#railVisibilityToggle'),

  copySessionId: $('#copySessionId'),
  sessionActionsMenu: $('#sessionActionsMenu'),
  messageList: $('#messageList'),
  loadingState: $('#loadingState'),
  loadingTitle: $('#loadingTitle'),
  loadingDetail: $('#loadingDetail'),
  emptyState: $('#emptyState'),
  errorState: $('#errorState'),
  errorTitle: $('#errorTitle'),
  errorDetail: $('#errorDetail'),
  connectionTruth: $('#connectionTruth'),
  connectionDot: $('#connectionDot'),
  connectionLabel: $('#connectionLabel'),
  modelLabel: $('#modelLabel'),
  modelPickerButton: $('#modelPickerButton'),
  modelPicker: $('#modelPicker'),
  modelPickerTitle: $('#modelPickerTitle'),
  closeModelPicker: $('#closeModelPicker'),
  modelSearch: $('#modelSearch'),
  modelProviderList: $('#modelProviderList'),
  modelList: $('#modelList'),
  modelOptionsList: $('#modelOptionsList'),
  refreshModels: $('#refreshModels'),
  profileLabel: $('#profileLabel'),
  railAgentGlyph: $('#railAgentGlyph'),
  railAgentLabel: $('#railAgentLabel'),
  composerSessionLabel: $('#composerSessionLabel'),
  webSessionOwnershipNotice: $('#webSessionOwnershipNotice'),
  webSessionOwnershipTitle: $('#webSessionOwnershipTitle'),
  webSessionOwnershipDetail: $('#webSessionOwnershipDetail'),
  composerModelControl: $('#composerModelControl'),
  composerModelName: $('#composerModelName'),
  composerRuntimeMeta: $('#composerRuntimeMeta'),
  returnToPageButton: $('#returnToPageButton'),
  handoffDetail: $('#handoffDetail'),
  contextMode: $('#contextMode'),
  contextSource: $('#contextSource'),
  contextWindowCard: $('#contextWindowCard'),
  contextWindowMeter: $('#contextWindowMeter'),
  contextWindowPercent: $('#contextWindowPercent'),
  contextWindowFill: $('#contextWindowFill'),
  contextWindowDetail: $('#contextWindowDetail'),
  diagConnection: $('#diagConnection'),
  diagGateway: $('#diagGateway'),
  diagSession: $('#diagSession'),
  diagModel: $('#diagModel'),
  diagProfile: $('#diagProfile'),
  copyDiagnostics: $('#copyDiagnostics'),
  newChatButton: $('#newChatButton'),
  composer: $('#fullTabComposer'),
  prompt: $('#fullTabPrompt'),
  commandMenuButton: $('#commandMenuButton'),
  skillMenu: $('#skillMenu'),
  composerDropOverlay: $('#composerDropOverlay'),
  send: $('#fullTabSend'),
  stopRun: $('#stopRun'),
  composerStatus: $('#composerStatus'),
  conversationScroll: $('#conversationScroll'),
  toolActivityList: $('#toolActivityList'),
  taskStack: $('#taskStack'),
  taskStackToggle: $('#taskStackToggle'),
  taskStackSummary: $('#taskStackSummary'),
  taskStackProgress: $('#taskStackProgress'),
  taskStackList: $('#taskStackList'),
  settingsButton: $('#settingsButton'),
  wakeButton: $('#wakeButton'),
  settingsDialog: $('#settingsDialog'),
  settingsForm: $('#settingsForm'),
  closeSettings: $('#closeSettings'),
  settingsColorMode: $('#settingsColorMode'),
  settingsTheme: $('#settingsTheme'),
  webCustomThemeManager: $('#settingsCustomThemeManager'),
  webCustomThemeImportTextarea: $('#settingsCustomThemeImportTextarea'),
  webCustomThemeFileInput: $('#settingsCustomThemeFileInput'),
  webCustomThemePreviewButton: $('#settingsCustomThemePreviewButton'),
  webCustomThemePreview: $('#settingsCustomThemePreview'),
  webCustomThemeInstallButton: $('#settingsCustomThemeInstallButton'),
  webCustomThemeImportStatus: $('#settingsCustomThemeImportStatus'),
  webCustomThemeResetButton: $('#settingsCustomThemeResetButton'),
  settingsMarketplaceThemeSearchInput: $('#settingsMarketplaceThemeSearchInput'),
  settingsMarketplaceThemeSearchButton: $('#settingsMarketplaceThemeSearchButton'),
  settingsMarketplaceThemeStatus: $('#settingsMarketplaceThemeStatus'),
  settingsMarketplaceThemeResults: $('#settingsMarketplaceThemeResults'),
  settingsMarketplaceThemeMode: $('#settingsMarketplaceThemeMode'),
  settingsTextZoomPresetGrid: $('#settingsTextZoomPresetGrid'),
  settingsTextZoomInput: $('#settingsTextZoomInput'),
  settingsTextZoomDecreaseButton: $('#settingsTextZoomDecreaseButton'),
  settingsTextZoomIncreaseButton: $('#settingsTextZoomIncreaseButton'),
  settingsFontProfileSelect: $('#settingsFontProfileSelect'),
  settingsCustomFontFamilyField: $('#settingsCustomFontFamilyField'),
  settingsCustomFontFamilyInput: $('#settingsCustomFontFamilyInput'),
  settingsAppearanceSaveStatus: $('#settingsAppearanceSaveStatus'),
  inlineAssistEnabled: $('#inlineAssistEnabled'),
  inlineAssistDefaultRoute: $('#inlineAssistDefaultRoute'),
  inlineAssistModel: $('#inlineAssistModel'),
  inlineAssistModelButton: $('#inlineAssistModelButton'),
  inlineAssistModelLabel: $('#inlineAssistModelLabel'),
  assistModelCapabilityHint: $('#assistModelCapabilityHint'),
  inlineAssistSessionRetention: $('#inlineAssistSessionRetention'),
  contextMenuDefaultRoute: $('#contextMenuDefaultRoute'),
  contextMenuEditor: $('#contextMenuEditor'),
  settingsProfile: $('#settingsProfile'),
  settingsGatewayUrl: $('#settingsGatewayUrl'),
  settingsApiKey: $('#settingsApiKey'),
  browserContextConsentControl: $('#browserContextConsentControl'),
  browserContextConsentInput: $('#browserContextConsentInput'),
  browserContextConsentIdentity: $('#browserContextConsentIdentity'),
  settingsThemeGrid: $('#settingsThemeGrid'),
  settingsLanguageSelect: $('#settingsLanguageSelect'),
  imageLightbox: $('#imageLightbox'),
  imageLightboxCanvas: $('#imageLightboxCanvas'),
  imageLightboxImage: $('#imageLightboxImage'),
  imageZoomLabel: $('#imageZoomLabel'),
  zoomImageIn: $('[data-action="zoom-image-in"]'),
  zoomImageOut: $('[data-action="zoom-image-out"]'),
  resetImageZoom: $('[data-action="reset-image-zoom"]'),
  closeImageLightbox: $('[data-action="close-image-lightbox"]'),
  settingsColorModeButtons: Array.from(document.querySelectorAll('[data-color-mode]')),

  quickAttach: $('#quickAttach'),
  quickVoice: $('#quickVoice'),
  quickModel: $('#quickModel'),
  attachButton: $('#attachButton'),
  attachMenu: $('#attachMenu'),
  attachmentInput: $('#attachmentInput'),
  imageAttachmentInput: $('#imageAttachmentInput'),
  attachmentList: $('#attachmentList'),
  voiceButton: $('#voiceButton'),
  queueDraft: $('#queueDraft'),
  webRunControlRecovery: $('#webRunControlRecovery'),
  webRunControlRecoveryDetail: $('#webRunControlRecoveryDetail'),
  webRetryRunStatusButton: $('#webRetryRunStatusButton'),
  webDiscardHeldQueueButton: $('#webDiscardHeldQueueButton'),
  steerDraft: $('#steerDraft'),
};

let settings = {};
let contextConsentPrincipalBinding = { origin: '', transport: '', principal: '' };
let webAppearanceMutationId = 0;
let webAppearanceSaveStatus = '';
let webAppearanceWriteQueue = Promise.resolve();
let webCustomThemeStoreState = { ok: true, status: 'empty', themes: [] };
let webCustomThemePreviewState = null;
let webCustomThemeImportStatus = '';
let webCustomThemeDeleteArmedId = '';
let webCustomThemeResetArmed = false;
let webMarketplaceRevision = 0;
let webMarketplaceResults = [];
let webMarketplaceLoading = false;
let webMarketplaceError = '';
let webMarketplaceInstallingId = '';
let webMarketplaceLoaded = false;
let webMarketplaceDebounceTimer = null;
const directWebMarketplaceController = createThemeMarketplaceController({
  client: createVscodeMarketplaceClient(),
  storageArea: browserApi.storage.local,
});
const webMarketplaceTransport = createThemeMarketplaceTransport({
  runtime: browserApi.runtime,
  fallbackController: directWebMarketplaceController,
});
let appliedWebCustomThemeVariables = [];
let sessions = [];
let activeSessionId = handoff.sessionId;
let activeMessages = [];
let taskStackStore = {};
let taskStackExpanded = true;
let availableModels = [];
let selectedModelProvider = '';
let modelSelectionTarget = 'chat';
const modelPickerHome = { parent: els.modelPicker?.parentElement || null, next: els.modelPicker?.nextSibling || null };
let sending = false;
let activeAbortController = null;
let activeRunId = '';
let activeRunControl = null;
let runControlGeneration = 0;
let attachments = [];
let queuedTurn = null;
const approvedForeignSessionIds = new Set();
let pendingForeignTurn = null;
let availableSkills = [];
let modelsRefreshing = false;
let dragDepth = 0;
let latestRuntime = {};
let gatewayCapabilities = { ...DEFAULT_GATEWAY_CAPABILITIES };
let liveRun = null;
let imageViewerState = createImageViewerState();
let imagePanGesture = null;
let sessionHistoryLoading = true;
let webSessionLoadRequestId = 0;
let wakeTurnProcessingId = '';
let dashboardConnection = null;
let dashboardLiveSessionId = '';
let contextMenuEditor = null;
const HERMES_WEB_SESSION_SOURCE = 'hermes_web';
const openSessionGroups = new Set();
const closedSessionGroups = new Set();
const VOICE_DRAFT_STORAGE_KEY = 'hermesVoiceDraft';
const TASK_STACKS_STORAGE_KEY = 'hermesBrowserTaskStacks';

const client = createHermesClient({
  getConnection: () => settings,
});

function currentDelegationScopeKey() {
  return delegationScopeKey({
    mode: settings.connectionTransport || settings.connectionMode || settings.gatewayMode,
    gatewayUrl: settings.gatewayUrl,
    profile: settings.activeProfile,
  });
}

async function persistDelegationWatches(rows) {
  const stored = await browserApi.storage.local.get([DELEGATION_WATCH_STORAGE_KEY]);
  const merged = mergeDelegationWatchStores(stored?.[DELEGATION_WATCH_STORAGE_KEY] || [], rows);
  await browserApi.storage.local.set({ [DELEGATION_WATCH_STORAGE_KEY]: merged });
}

const delegationWatchManager = createDelegationWatchManager({
  isBusy: () => sending,
  isActive: (watch) => watch.scopeKey === currentDelegationScopeKey()
    && watch.durableSessionId === String(activeSessionId || '').trim(),
  loadHistory: async (watch) => {
    if (watch.transport === 'dashboard-ws') {
      const connection = await ensureDashboardConnection();
      if (!watch.liveSessionId) throw new Error('A live dashboard session id is required for history.');
      const history = await connection.client.request(WS_METHODS.sessionHistory, { session_id: watch.liveSessionId });
      return { messages: dashboardHistoryMessages(history) };
    }
    return { messages: await client.getSessionMessages(watch.durableSessionId) };
  },
  onComplete: async (watch, result) => {
    await commitFullTabSessionMessages(result?.messages || [], {
      sessionId: watch.durableSessionId,
      requestId: webSessionLoadRequestId,
    });
  },
  onState: (watch) => {
    if (watch.state === 'pending' && watch.attempts === 0) {
      els.composerStatus.textContent = translateUiText('Delegation in progress · result will appear automatically');
    } else if (watch.state === 'completed') {
      els.composerStatus.textContent = translateUiText('Delegation result loaded');
    } else if (watch.state === 'timed_out') {
      els.composerStatus.textContent = translateUiText('Delegation still pending · reopen this session to check again');
    }
  },
  persist: persistDelegationWatches,
});

async function startDelegationWatch(dispatch) {
  const durableSessionId = String(activeSessionId || '').trim();
  if (!dispatch?.delegationId || !durableSessionId) return null;
  return delegationWatchManager.start({
    scopeKey: currentDelegationScopeKey(),
    durableSessionId,
    liveSessionId: dashboardLiveSessionId || '',
    delegationId: dispatch.delegationId,
    transport: usesDashboardTicketTransport() ? 'dashboard-ws' : 'rest',
  });
}

async function captureDelegationToolEvent(event) {
  const dispatch = delegationDispatchFromToolEvent(event);
  if (dispatch) await startDelegationWatch(dispatch);
}

function captureDelegationRuntimePayload(runtime = {}) {
  for (const dispatch of delegationDispatchesFromMessages(runtime?.messages || [])) {
    startDelegationWatch(dispatch).catch((error) => console.warn('[Hermes Web] Could not persist delegation watch:', error));
  }
}

async function activateCurrentDelegationSession() {
  const durableSessionId = String(activeSessionId || '').trim();
  if (!durableSessionId) return;
  await delegationWatchManager.activate({
    scopeKey: currentDelegationScopeKey(),
    durableSessionId,
    liveSessionId: dashboardLiveSessionId || '',
  });
}

async function hydrateDelegationWatches(storedRows = null) {
  const rows = storedRows || (await browserApi.storage.local.get([DELEGATION_WATCH_STORAGE_KEY]))?.[DELEGATION_WATCH_STORAGE_KEY] || [];
  await delegationWatchManager.hydrate(rows);
  await activateCurrentDelegationSession();
}

function contextMenuEditorTranslate(key, fallback) {
  const translated = t(key);
  return translated === key ? fallback : translated;
}

async function ensureContextMenuEditor() {
  if (!els.contextMenuEditor) return null;
  if (contextMenuEditor) {
    contextMenuEditor.setTranslator(contextMenuEditorTranslate);
    return contextMenuEditor;
  }
  contextMenuEditor = await mountContextMenuEditor({
    chromeApi: browserApi,
    root: els.contextMenuEditor,
    translate: contextMenuEditorTranslate,
  });
  return contextMenuEditor;
}

function usesDashboardTicketTransport(source = settings) {
  const mode = normalizeConnectionMode(source.connectionMode);
  return mode === 'cloud' || source.connectionTransport === 'remote-dashboard' || source.gatewayMode === 'remote-dashboard';
}

function currentContextConsentController() {
  return String(browserApi.runtime.id || 'hermes-browser');
}

function contextConsentBindingMatches(source = settings) {
  return contextConsentPrincipalBinding.origin === normalizeContextConsentOrigin(source.gatewayUrl)
    && contextConsentPrincipalBinding.transport === String(source.connectionTransport || '');
}

async function refreshContextConsentPrincipal({ dashboardPrincipal, settingsOverride = settings } = {}) {
  const source = settingsOverride || settings;
  const origin = normalizeContextConsentOrigin(source.gatewayUrl);
  const transport = String(source.connectionTransport || '');
  if (!consentRequiredForConnection({ gatewayUrl: source.gatewayUrl })) {
    contextConsentPrincipalBinding = { origin, transport, principal: 'local' };
  } else if (usesDashboardTicketTransport(source)) {
    const supplied = dashboardPrincipal !== undefined;
    const principal = supplied
      ? dashboardPrincipalFromMe(dashboardPrincipal)
      : (contextConsentBindingMatches(source) ? contextConsentPrincipalBinding.principal : '');
    contextConsentPrincipalBinding = { origin, transport, principal };
  } else {
    const credential = source['api' + 'Key'] || '';
    const principal = credential ? `api:${await fingerprintContextCredential(credential)}` : '';
    contextConsentPrincipalBinding = { origin, transport, principal };
  }
  renderBrowserContextConsentControl();
  return contextConsentPrincipalBinding.principal;
}

function currentContextConsentIdentity(source = settings) {
  if (!consentRequiredForConnection({ gatewayUrl: source.gatewayUrl })) return null;
  if (!contextConsentBindingMatches(source) || !contextConsentPrincipalBinding.principal) return null;
  return contextConsentIdentity({
    gatewayUrl: source.gatewayUrl,
    principal: contextConsentPrincipalBinding.principal,
    profile: source.activeProfile || 'default',
    controller: currentContextConsentController(),
    transport: source.connectionTransport,
  });
}

function renderBrowserContextConsentControl() {
  if (!els.browserContextConsentControl || !els.browserContextConsentInput) return;
  const required = consentRequiredForConnection({ gatewayUrl: settings.gatewayUrl });
  els.browserContextConsentControl.hidden = !required;
  if (!required) {
    els.browserContextConsentInput.checked = true;
    els.browserContextConsentInput.disabled = true;
    return;
  }
  const identity = currentContextConsentIdentity();
  const granted = Boolean(identity) && consentGrantedForIdentity(settings.browserContextConsentLedger, identity);
  els.browserContextConsentInput.checked = granted;
  els.browserContextConsentInput.disabled = !identity;
  if (els.browserContextConsentIdentity) {
    els.browserContextConsentIdentity.textContent = identity
      ? `${identity.origin} · ${identity.profile} · verified ${usesDashboardTicketTransport(settings) ? 'dashboard account' : 'API credential'}`
      : 'Reconnect this connection to verify its account before sharing page context.';
  }
}

async function setBrowserContextConsent(granted) {
  await refreshContextConsentPrincipal();
  const identity = currentContextConsentIdentity();
  if (!identity) throw new Error('Reconnect this connection before sharing page context.');
  const ledger = await persistContextConsentDecision({
    storageArea: browserApi.storage.local,
    identity,
    granted: Boolean(granted),
  });
  settings = { ...settings, browserContextConsentLedger: ledger };
  renderBrowserContextConsentControl();
}

async function ensureDashboardConnection() {
  const desiredOrigin = originOf(settings.gatewayUrl || '');
  if (!isTrustedDashboardOrigin(settings.trustedDashboardOrigin, desiredOrigin)) {
    const error = new Error('Hermes Cloud origin is not trusted. Reconnect from the side panel before opening Hermes Web.');
    error.ticketReason = 'dashboard_origin_untrusted';
    throw error;
  }
  const tabId = Number(settings.trustedDashboardTabId);
  if (dashboardConnection?.client?.readyState === 1
    && dashboardConnection?.origin === desiredOrigin
    && Number(dashboardConnection?.tabId) === tabId) {
    return dashboardConnection;
  }
  dashboardConnection?.client?.close?.();
  dashboardConnection = null;
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error('Open the signed-in Hermes Cloud agent once from the side panel so Browser can remember its exact tab.');
  }
  const ticket = await mintWsTicket({
    tabsApi: browserApi.tabs,
    scriptingApi: browserApi.scripting,
    baseUrl: settings.gatewayUrl,
    tabId,
  });
  if (!ticket.ok) throw new Error(ticketFailureHelp(ticket.reason, ticket.origin || settings.gatewayUrl));
  await refreshContextConsentPrincipal({ dashboardPrincipal: ticket.principal });
  const gatewayClient = createGatewayClient({ WebSocketImpl: WebSocket, requestTimeoutMs: 180_000, readyTimeoutMs: 30_000 });
  gatewayClient.on('close', () => {
    if (dashboardConnection?.client === gatewayClient) dashboardConnection = null;
    dashboardLiveSessionId = '';
  });
  await gatewayClient.connect(buildDashboardWsUrl(settings.gatewayUrl, ticket.ticket));
  dashboardConnection = { client: gatewayClient, origin: desiredOrigin, tabId };
  return dashboardConnection;
}

async function establishDashboardSession(storedSessionId = '', { isCurrent = () => true } = {}) {
  const connection = await ensureDashboardConnection();
  const identity = await establishGatewaySession({
    client: connection.client,
    storedSessionId,
    createParams: { source: HERMES_WEB_SESSION_SOURCE },
  });
  if (!isCurrent()) {
    const error = new Error('A newer session selection replaced this dashboard request.');
    error.name = 'AbortError';
    throw error;
  }
  dashboardLiveSessionId = identity.liveId;
  activeSessionId = identity.storedId;
  const selectedModel = effectiveModel();
  if (selectedModel.model && selectedModel.provider) {
    try {
      const request = buildSessionModelSwitchRequest({
        sessionId: identity.liveId,
        model: selectedModel.model,
        provider: selectedModel.provider,
      });
      await connection.client.request(request.method, request.params);
    } catch (error) {
      console.warn('[Hermes Web] Cloud model selection was not applied:', error?.message || error);
    }
  }
  try {
    const status = await connection.client.request(WS_METHODS.sessionStatus, { session_id: identity.liveId });
    const binding = sessionModelBindingFromRuntime(runtimeModelFromSessionStatus(status), availableModels);
    if (binding) {
      settings = {
        ...settings,
        sessionModelBindings: {
          ...(settings.sessionModelBindings || {}),
          [identity.storedId]: binding,
        },
      };
      await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    }
  } catch (error) {
    console.warn('[Hermes Web] Cloud runtime metadata was not acknowledged:', error?.message || error);
  }
  await activateCurrentDelegationSession();
  return identity;
}

async function resumeDashboardRecoverySession(connection, storedSessionId = activeSessionId) {
  const durableSessionId = String(storedSessionId || '').trim();
  if (!durableSessionId) throw new Error('The durable Dashboard session is unavailable for recovery.');
  const identity = await establishGatewaySession({
    client: connection.client,
    storedSessionId: durableSessionId,
  });
  if (identity.storedId !== durableSessionId) {
    throw new Error('Dashboard resumed a different durable session during run recovery.');
  }
  dashboardLiveSessionId = identity.liveId;
  return identity;
}

function dashboardHistoryMessages(payload = {}) {
  return normalizeGatewayHistoryMessages(payload);
}

async function loadDashboardSessionMessages(storedSessionId, options = {}) {
  const connection = await ensureDashboardConnection();
  const identity = await establishDashboardSession(storedSessionId, options);
  const history = await connection.client.request(WS_METHODS.sessionHistory, { session_id: identity.liveId });
  return dashboardHistoryMessages(history);
}

async function listDashboardSessions() {
  const connection = await ensureDashboardConnection();
  const result = await connection.client.request(WS_METHODS.sessionList, { limit: 200, offset: 0 });
  return applySessionModelBindings(normalizeHermesSessions(result), settings.sessionModelBindings);
}

async function streamDashboardPrompt(prompt, { signal, onDelta, onTool, onRun } = {}) {
  const connection = await ensureDashboardConnection();
  if (!dashboardLiveSessionId) await establishDashboardSession(activeSessionId);
  const sessionId = dashboardLiveSessionId;
  onRun?.(sessionId);
  return new Promise((resolve, reject) => {
    let finalText = '';
    let settled = false;
    const offs = [];
    const timer = globalThis.setTimeout(() => finish(reject, new Error('Dashboard response timed out.')), 5 * 60 * 1000);
    const forThisSession = (event) => event.sessionId === sessionId;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      for (const off of offs) off();
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      connection.client.request(WS_METHODS.sessionInterrupt, { session_id: sessionId }).catch(() => {});
      finish(reject, new DOMException('Hermes turn stopped by user', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    offs.push(connection.client.on(WS_EVENTS.messageDelta, (event) => {
      if (!forThisSession(event)) return;
      finalText += event.payload?.text || '';
      onDelta?.(finalText);
    }));
    offs.push(connection.client.on(WS_EVENTS.messageComplete, (event) => {
      if (!forThisSession(event)) return;
      const completionError = hermesGatewayTurnError({ payload: event.payload });
      if (completionError) {
        finish(reject, completionError);
        return;
      }
      finalText = event.payload?.text || finalText;
      onDelta?.(finalText);
      finish(resolve, finalText);
    }));
    offs.push(connection.client.on('tool.start', (event) => {
      if (forThisSession(event)) onTool?.({ type: 'tool.start', tool_name: event.payload?.name });
    }));
    offs.push(connection.client.on('tool.complete', (event) => {
      if (forThisSession(event)) onTool?.({
        type: 'tool.complete',
        tool_name: event.payload?.name,
        result: event.payload?.result,
      });
    }));
    offs.push(connection.client.on(WS_EVENTS.error, (event) => {
      if (!forThisSession(event)) return;
      finish(reject, hermesGatewayTurnError({ payload: event.payload }) || new Error('Dashboard stream error'));
    }));
    offs.push(connection.client.on('close', () => finish(reject, new Error('Dashboard connection closed mid-turn.'))));
    connection.client.request(WS_METHODS.promptSubmit, { session_id: sessionId, text: prompt }).catch((error) => finish(reject, error));
  });
}

async function loadGatewayCapabilities() {
  try {
    const response = await client.fetch('/v1/capabilities', { method: 'GET', cache: 'no-store' });
    const payload = await client.readJson(response);
    gatewayCapabilities = normalizeGatewayCapabilities(response.ok ? payload : null, {
      healthOk: response.ok,
      warning: response.ok ? '' : `GET /v1/capabilities failed (${response.status})`,
    });
  } catch (error) {
    gatewayCapabilities = normalizeGatewayCapabilities(null, {
      healthOk: false,
      warning: error?.message || String(error),
    });
  }
  renderInlineAssistModelOptions();
  return gatewayCapabilities;
}

function currentTaskStack() {
  return Array.isArray(taskStackStore?.[activeSessionId]?.tasks) ? taskStackStore[activeSessionId].tasks : [];
}

function renderTaskStack() {
  if (!els.taskStack) return;
  const tasks = currentTaskStack();
  els.taskStack.hidden = !tasks.length;
  if (!tasks.length) {
    els.taskStackList.replaceChildren();
    return;
  }
  const progress = taskStackProgress(tasks);
  els.taskStack.dataset.expanded = String(taskStackExpanded);
  els.taskStackToggle.setAttribute('aria-expanded', String(taskStackExpanded));
  els.taskStackSummary.textContent = t('tasks.summary', {
    complete: `${progress.completed}/${progress.total}`,
    active: progress.active,
  });
  const progressFill = els.taskStackProgress.querySelector('i');
  if (progressFill) progressFill.style.width = `${progress.percent}%`;
  const rows = tasks.map((task, index) => {
    const item = document.createElement('li');
    item.className = `task-stack-item ${task.status}`;
    const taskIndex = document.createElement('span');
    taskIndex.className = 'task-stack-index';
    taskIndex.textContent = String(index + 1).padStart(2, '0');
    const content = document.createElement('strong');
    content.textContent = task.content;
    content.title = task.content;
    const status = document.createElement('span');
    status.className = 'task-stack-status';
    status.textContent = translateUiText(task.status === 'in_progress' ? 'working' : task.status);
    item.append(taskIndex, content, status);
    return item;
  });
  els.taskStackList.replaceChildren(...rows);
}

async function captureTaskToolEvent(event) {
  await captureDelegationToolEvent(event);
  const tasks = taskStackFromToolEvent(event);
  if (!tasks || !activeSessionId) return false;
  taskStackStore = updateTaskStackStore(taskStackStore, activeSessionId, tasks);
  renderTaskStack();
  await browserApi.storage.local.set({ [TASK_STACKS_STORAGE_KEY]: taskStackStore });
  return true;
}

function connectionModeLabel(mode) {
  if (mode === 'cloud') return 'Hermes Cloud';
  if (mode === 'remote') return translateUiText('Remote gateway');
  return translateUiText('Local gateway');
}


function gatewayOrigin(value = '') {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return translateUiText('not configured');
  }
}

function sessionTitle(session = {}) {
  return String(session.title || session.name || session.id || 'Untitled session');
}

function sessionTimestamp(session = {}) {
  const value = session.lastActive || session.updated_at || session.updatedAt || session.modified_at || session.created_at || session.createdAt;
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function isOwnedHermesWebSession(session = {}) {
  return String(session.source || '').toLowerCase() === 'api_server'
    && /^hermes-web-/i.test(String(session.id || ''));
}

async function migrateOwnedHermesWebSessionSources(rows = []) {
  const migrations = rows.filter(isOwnedHermesWebSession);
  if (!migrations.length) return rows;
  const migrated = await Promise.all(migrations.map(async (session) => {
    try {
      const response = await client.fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ source: HERMES_WEB_SESSION_SOURCE }),
      });
      const payload = await client.readJson(response);
      if (!response.ok) return session;
      return normalizeHermesSessions({ data: [payload.session || payload] })[0] || session;
    } catch {
      return session;
    }
  }));
  const byId = new Map(migrated.map((session) => [session.id, session]));
  return rows.map((session) => byId.get(session.id) || session);
}

function visibleHermesWebSessions(rows = []) {
  return rows.filter((session) => Number(session.messageCount || 0) > 0);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('');
  if (content && typeof content === 'object') return String(content.text || content.content || '');
  return '';
}

function requestedModelLabel() {
  const binding = settings.sessionModelBindings?.[activeSessionId] || {};
  const provider = binding.provider || settings.provider || '';
  const model = binding.rawModelId || binding.modelId || settings.model || translateUiText('Gateway default');
  return [provider, model].filter(Boolean).join(' · ');
}

function renderConnectionTruth({ status = 'idle' } = {}) {
  const mode = normalizeConnectionMode(settings.connectionMode);
  const label = connectionModeLabel(mode);
  const model = requestedModelLabel();
  const profile = settings.activeProfile || translateUiText('Default profile');
  els.connectionLabel.textContent = label;
  els.railAgentGlyph.dataset.connectionMode = mode;
  els.railAgentLabel.textContent = label;
  els.modelLabel.textContent = model;
  els.profileLabel.textContent = profile;
  els.connectionDot.className = `truth-dot ${status === 'online' ? 'online' : status === 'error' ? 'error' : ''}`.trim();
  els.contextMode.textContent = translateUiText(mode === 'cloud' || settings.connectionTransport === 'remote-dashboard' ? 'Chat only' : 'Inherited safely');
  els.contextSource.textContent = mode === 'cloud' || settings.connectionTransport === 'remote-dashboard'
    ? translateUiText('Cloud/dashboard context disabled')
    : handoff.sourceTabId ? t('context.browser_tab_handoff', { tabId: handoff.sourceTabId }) : translateUiText('No browser context attached');
  els.diagConnection.textContent = `${label} · ${settings.connectionTransport || settings.gatewayMode || translateUiText('unknown transport')}`;
  els.diagGateway.textContent = gatewayOrigin(settings.gatewayUrl);
  els.diagSession.textContent = activeSessionId || translateUiText('none');
  els.diagModel.textContent = model;
  els.diagProfile.textContent = profile;
}

function applySessionVisibility() {
  const visible = settings.webSessionsVisible !== false;
  els.shell.classList.toggle('sessions-hidden', !visible);
  els.railVisibilityToggle.setAttribute('aria-pressed', String(!visible));
  els.railVisibilityToggle.setAttribute('aria-label', translateUiText(visible ? 'Collapse sessions' : 'Show sessions'));
  els.railVisibilityToggle.title = translateUiText(visible ? 'Collapse sessions' : 'Show sessions');
  els.railVisibilityToggle.textContent = visible ? '◀' : '▶';
}

function persistSessionVisibility(partial) {
  settings = { ...settings, ...partial };
  applySessionVisibility();
  const active = sessions.find((session) => session.id === activeSessionId) || { title: settings.webSessionTitle || 'New Hermes Web chat' };
  els.sessionTitle.textContent = sessionTitle(active);
  els.composerSessionLabel.textContent = activeSessionId || translateUiText('Shared session');
  renderSessions(els.sessionSearch.value);
  browserApi.storage.local.set({ hermesBrowserSettings: settings }).catch((error) => {
    els.composerStatus.textContent = t('session.rail_save_failed', { error: error?.message || String(error) });
  });
}

function showRuntimeLoadingState({
  title = 'Loading Hermes runtime truth',
  detail = 'Reading connection settings, models, skills, and canonical session history.',
} = {}) {
  els.loadingTitle.textContent = translateUiText(title);
  els.loadingDetail.textContent = translateUiText(detail);
  els.loadingState.hidden = false;
  els.emptyState.hidden = true;
  els.messageList.hidden = true;
  els.errorState.hidden = true;
  els.prompt.disabled = true;
  els.send.disabled = true;
}

function hideRuntimeLoadingState() {
  els.loadingState.hidden = true;
  els.prompt.disabled = false;
  updateBusyControls();
}

function showSessionLoadingState(session = {}) {
  showRuntimeLoadingState({
    title: t('session.opening', { title: sessionTitle(session) }),
    detail: 'Loading canonical messages and restoring this session runtime.',
  });
}

function renderSessions(query = '') {
  const groups = groupSessionsForMenu(sessions, activeSessionId, query);
  const searching = Boolean(String(query || '').trim());
  els.sessionList.replaceChildren();
  els.sessionCount.textContent = String(groups.reduce((total, group) => total + group.sessions.length, 0));
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'session-list-empty';
    empty.textContent = translateUiText(sessions.length
      ? 'No sessions match this search.'
      : sessionHistoryLoading
        ? 'Loading canonical session history…'
        : 'Canonical session history is unavailable for this connection.');
    els.sessionList.append(empty);
    return;
  }
  for (const group of groups) {
    if (shouldAutoOpenSessionGroup(group, groups, closedSessionGroups)) openSessionGroups.add(group.label);
    const isOpen = searching || openSessionGroups.has(group.label);
    const heading = document.createElement('button');
    heading.type = 'button';
    heading.className = `session-group-toggle${isOpen ? ' open' : ''}`;
    heading.setAttribute('aria-expanded', String(isOpen));
    const label = document.createElement('span');
    label.textContent = `${isOpen ? '▾' : '▸'} ${group.label}`;
    const count = document.createElement('strong');
    count.textContent = String(group.sessions.length);
    heading.append(label, count);
    heading.addEventListener('click', () => {
      if (openSessionGroups.has(group.label)) {
        openSessionGroups.delete(group.label);
        closedSessionGroups.add(group.label);
      } else {
        openSessionGroups.add(group.label);
        closedSessionGroups.delete(group.label);
      }
      renderSessions(els.sessionSearch.value);
    });
    els.sessionList.append(heading);
    if (!isOpen) continue;
    for (const session of group.sessions) {
      const row = document.createElement('div');
      row.className = `session-row ${session.selected ? 'active' : ''}`.trim();
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'session-row-open';
      open.setAttribute('role', 'listitem');
      const title = document.createElement('strong');
      title.textContent = sessionTitle(session);
      const age = document.createElement('span');
      age.textContent = session.selected ? translateUiText('Current session') : sessionTimestamp(session);
      open.append(title, age);
      open.addEventListener('click', () => openSession(session.id));
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'session-row-rename';
      rename.title = translateUiText('Rename session');
      rename.setAttribute('aria-label', t('session.rename_named', { title: sessionTitle(session) }));
      rename.textContent = '✎';
      rename.addEventListener('click', (event) => {
        event.stopPropagation();
        promptRenameHermesWebSession(session);
      });
      row.append(open, rename);
      els.sessionList.append(row);
    }
  }
}

function localGatewayConnected() {
  return normalizeConnectionMode(settings.connectionMode) === 'local';
}

function runtimeTelemetryForSession(session = {}) {
  return {
    session_id: String(session.id || ''),
    model: String(session.model || ''),
    provider: String(session.provider || ''),
    last_prompt_tokens: Number(session.lastPromptTokens || 0),
    context_length: Number(session.contextLength || 0),
    threshold_tokens: Number(session.thresholdTokens || 0),
    usage_percent: Number(session.usagePercent || 0),
    compression_count: Number(session.compressionCount || 0),
    compression_count_known: Boolean(session.compressionCountKnown),
    source: 'persisted-session',
  };
}

function compactTokenLabel(value = 0) {
  const tokens = Math.max(0, Number(value || 0));
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}m`;
  if (tokens >= 1_000) return `${Math.round((tokens / 1_000) * 10) / 10}k`;
  return String(Math.round(tokens));
}

function renderContextWindow() {
  const session = sessions.find((item) => item.id === activeSessionId) || {};
  const model = effectiveModel();
  const transcript = activeMessages.map((message) => messageText(message.content)).join('\n');
  const pendingAttachmentText = attachments
    .map((item) => item.kind === 'image' ? `[image attachment: ${item.name}]` : item.text || item.name)
    .join('\n');
  const accounting = contextAccountingSnapshot({
    localPromptTokens: estimateTokens(transcript),
    draftTokens: estimateTokens(`${els.prompt?.value || ''}\n${pendingAttachmentText}`),
    runtime: latestRuntime,
    usage: latestRuntime?.usage || latestRuntime?.token_usage || {},
    session,
    modelContextTokens: model.contextTokens,
  });
  const display = contextMeterDisplay({ accounting, runtimeLabel: latestRuntime?.model || model.label, modelContextTokens: model.contextTokens });
  const compaction = contextCompactionState({ accounting, runtime: latestRuntime, session });
  const percent = Math.min(100, display.percent || 0);
  els.contextWindowMeter.textContent = display.compactLabel;
  els.contextWindowPercent.textContent = compaction.thresholdPercent
    ? `${display.percentLabel} · compacts ${compaction.thresholdPercent}%`
    : display.percentLabel;
  const compactionCount = compaction.compressionCount
    ? ` Compacted ${compaction.compressionCount}×.`
    : '';
  const threshold = compaction.thresholdTokens
    ? ` Trigger: ${compactTokenLabel(compaction.thresholdTokens)} tokens.`
    : '';
  els.contextWindowDetail.textContent = `${compaction.detail}${threshold}${compactionCount}`;
  els.contextWindowCard.title = display.title;
  els.contextWindowFill.style.width = `${percent}%`;
  els.contextWindowCard.dataset.contextState = compaction.state === 'over-limit'
    ? 'critical'
    : compaction.state === 'due' || percent >= 75
      ? 'warning'
      : 'normal';
}

function artifactActionButton(label, action, artifact) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => action(artifact).catch((error) => {
    els.composerStatus.textContent = `Artifact action failed: ${error?.message || String(error)}`;
  }));
  return button;
}

async function openArtifact(artifact) {
  const target = artifact.kind === 'local' ? toFileUrl(artifact.source) : artifact.source;
  if (!target) throw new Error('This artifact does not expose an openable URL.');
  await browserApi.tabs.create({ url: target, active: true });
}

async function downloadArtifact(artifact) {
  const target = artifact.kind === 'local' ? toFileUrl(artifact.source) : artifact.source;
  if (!target) throw new Error('This artifact does not expose a downloadable URL.');
  await browserApi.downloads.download({ url: target, filename: artifact.name, saveAs: true });
}

function renderArtifactCard(artifact) {
  const card = document.createElement('section');
  card.className = 'artifact-card';
  const head = document.createElement('div');
  head.className = 'artifact-card-head';
  const kind = document.createElement('span');
  kind.className = 'artifact-card-kind';
  kind.textContent = artifact.extension.toUpperCase();
  const copy = document.createElement('div');
  copy.className = 'artifact-card-copy';
  const name = document.createElement('strong');
  name.textContent = artifact.name;
  const source = document.createElement('small');
  source.textContent = artifact.kind === 'remote' ? 'Downloadable gateway artifact' : 'Local gateway artifact';
  copy.append(name, source);
  head.append(kind, copy);
  card.append(head);
  const state = artifactActionState(artifact, { localGateway: localGatewayConnected() });
  if (state.canOpen || state.canDownload) {
    const actions = document.createElement('div');
    actions.className = 'artifact-card-actions';
    if (state.canOpen) actions.append(artifactActionButton('Open', openArtifact, artifact));
    if (state.canDownload) actions.append(artifactActionButton('Download', downloadArtifact, artifact));
    card.append(actions);
  } else {
    const note = document.createElement('p');
    note.textContent = state.unavailableReason;
    card.append(note);
  }
  return card;
}

function clearLiveRun() {
  liveRun?.animation?.stop?.();
  liveRun = null;
}

function renderImageViewerState() {
  if (!els.imageLightboxImage) return;
  const { scale, x, y } = imageViewerState;
  els.imageLightboxImage.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  els.imageLightboxCanvas?.toggleAttribute('data-zoomed', scale > 1);
  if (els.imageZoomLabel) els.imageZoomLabel.textContent = `${Math.round(scale * 100)}%`;
  if (els.zoomImageOut) els.zoomImageOut.disabled = scale <= 1;
  if (els.resetImageZoom) els.resetImageZoom.disabled = scale <= 1 && x === 0 && y === 0;
}

function updateImageViewer(action) {
  imageViewerState = imageViewerReducer(imageViewerState, action);
  renderImageViewerState();
}

function resetImageViewer() {
  imagePanGesture = null;
  imageViewerState = createImageViewerState();
  renderImageViewerState();
}

function openImageLightbox(source = '', alt = 'Generated by Hermes') {
  if (!source || !els.imageLightbox || !els.imageLightboxImage) return;
  resetImageViewer();
  els.imageLightboxImage.src = source;
  els.imageLightboxImage.alt = alt;
  if (!els.imageLightbox.open) els.imageLightbox.showModal();
}

function loadGeneratedImage(source = '') {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Generated image could not be decoded for the final reveal.'));
    image.src = source;
  });
}

function beginFinalImageReveal(sources = []) {
  const run = liveRun;
  const imageSources = Array.isArray(sources) ? sources.filter(Boolean) : [sources].filter(Boolean);
  if (!run?.image || !imageSources.length || run.revealPromise) return run?.revealPromise || null;
  run.revealSources = imageSources;
  run.revealPending = true;
  run.revealPromise = Promise.all(imageSources.map((source) => loadGeneratedImage(source)))
    .then((images) => {
      if (liveRun !== run || !run.animation?.reveal) return undefined;
      return run.animation.reveal(images);
    })
    .catch((error) => {
      console.warn('[Hermes Web] final image reveal skipped:', error);
    })
    .finally(() => {
      if (liveRun === run) run.revealPending = false;
    });
  return run.revealPromise;
}

function renderLiveRun() {
  if (!sending || !liveRun) return;
  liveRun.animation?.stop?.();
  const card = document.createElement('article');
  const thinking = liveRun.phase === 'THINKING';
  card.className = `web-live-run${thinking ? ' thinking' : ''}`;
  const copy = document.createElement('div');
  copy.className = 'web-live-run-copy';
  const phase = document.createElement('small');
  phase.textContent = liveRun.phase || 'LIVE RUN';
  const detail = document.createElement('p');
  detail.textContent = liveRun.detail || 'Preparing a response';
  if (thinking) {
    const sequence = document.createElement('div');
    sequence.className = 'web-live-run-thinking';
    sequence.innerHTML = thinkingIndicatorMarkup();
    copy.append(phase, sequence, detail);
  } else {
    const indicator = document.createElement('span');
    indicator.className = 'web-live-run-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = liveRun.title || 'Hermes is thinking';
    copy.append(phase, title, detail);
    card.append(indicator);
  }
  card.append(copy);
  if (liveRun.image) {
    const preview = document.createElement('div');
    const imageCount = Math.max(1, Number(liveRun.revealSources?.length || liveRun.imageCount || 1));
    preview.className = `web-live-run-image${imageCount > 1 ? ' multi' : ''}`;
    const canvases = Array.from({ length: imageCount }, () => {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', 'Hermes image generation in progress');
      preview.append(canvas);
      return canvas;
    });
    card.append(preview);
    const animations = canvases.map((canvas, index) => createDiffusionCanvas(canvas, {
      aspectRatio: liveRun.aspectRatio || 'landscape',
      seed: `${liveRun.seed || activeRunId || Date.now()}:${index}`,
      maxFps: 36,
    }));
    liveRun.animation = {
      start: () => animations.forEach((animation) => animation.start()),
      stop: () => animations.forEach((animation) => animation.stop()),
      reveal: (images = []) => Promise.all(animations.map((animation, index) => animation.reveal(images[index] || images[0]))),
    };
    liveRun.animation.start();
  }
  els.messageList.append(card);
}

function renderMessages(messages = []) {
  activeMessages = messages;
  els.messageList.replaceChildren();
  const visible = browserDisplayMessages(messages)
    .filter((message) => !isDelegationCompletionMarkerMessage(message));
  const hasLiveRun = Boolean(sending && liveRun);
  els.emptyState.hidden = visible.length > 0 || hasLiveRun;
  els.messageList.hidden = visible.length === 0 && !hasLiveRun;
  for (const message of visible) {
    const role = String(message.role || 'system').toLowerCase();
    const article = document.createElement('article');
    article.className = `web-message ${role}`;
    const roleNode = document.createElement('div');
    roleNode.className = 'web-message-role';
    roleNode.textContent = role === 'assistant' ? 'Hermes' : role;
    const content = document.createElement('div');
    content.className = 'web-message-content';
    const rawText = messageText(message.content);
    const visibleText = messageDisplayText(role, rawText);
    const tagged = extractMediaTags(visibleText);
    const media = resolvedGeneratedImageSources(visibleText);
    const displayText = stripGeneratedImageEchoes(tagged.text, media);
    if (displayText) content.innerHTML = renderMarkdownSafe(displayText);
    if (role === 'user') {
      appendUserImageAttachments(content, message.attachments, {
        onOpen: (_image, preview) => openImageLightbox(preview.source, preview.name),
      });
    }
    const deferMediaGroup = role === 'assistant'
      && liveRun?.image
      && liveRun?.revealPending
      && media.some((source) => liveRun?.revealSources?.includes(source));
    if (media.length && !deferMediaGroup) {
      const group = document.createElement('section');
      group.className = `generated-media-group${media.length > 1 ? ' multiple' : ''}`;
      group.setAttribute('aria-label', `${media.length} generated image${media.length === 1 ? '' : 's'}`);
      for (const source of media) {
        const figure = document.createElement('figure');
        figure.className = 'generated-media';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'generated-media-open';
        open.setAttribute('aria-label', 'Open generated image');
        const image = document.createElement('img');
        image.src = source;
        image.alt = 'Generated by Hermes';
        image.loading = 'lazy';
        const inspect = document.createElement('span');
        inspect.className = 'generated-image-inspect';
        inspect.setAttribute('aria-hidden', 'true');
        inspect.textContent = '⌕';
        open.append(image, inspect);
        open.addEventListener('click', () => openImageLightbox(source, image.alt));
        figure.append(open);
        group.append(figure);
      }
      content.append(group);
    }
    for (const item of tagged.media.filter((entry) => !resolveImageSource(entry.source))) {
      content.append(renderArtifactCard(describeArtifact(item.source)));
    }
    article.append(roleNode, content);
    els.messageList.append(article);
  }
  renderLiveRun();
  renderContextWindow();
  requestAnimationFrame(() => { els.conversationScroll.scrollTop = els.conversationScroll.scrollHeight; });
}

function effectiveModel() {
  const binding = settings.sessionModelBindings?.[activeSessionId] || settings.extensionPreferredModel || {};
  if (binding.unconfirmed) {
    return {
      id: '',
      model: '',
      provider: '',
      label: 'Runtime model unconfirmed',
      contextTokens: 0,
      reasoning: undefined,
      fast: undefined,
    };
  }
  const selected = availableModels.find((model) => model.id === settings.model)
    || availableModels.find((model) => model.rawModelId === binding.rawModelId && (!binding.provider || model.provider === binding.provider));
  return {
    id: selected?.id || settings.model || binding.modelId || '',
    model: selected?.rawModelId || binding.rawModelId || binding.modelId || settings.model || '',
    provider: selected?.provider || binding.provider || settings.provider || '',
    label: selected?.label || selected?.rawModelId || binding.rawModelId || settings.model || 'Gateway default',
    contextTokens: Number(selected?.contextTokens || binding.contextTokens || settings.modelContextTokens || 0),
    reasoning: selected?.reasoning ?? binding.reasoning,
    fast: selected?.fast ?? binding.fast,
    gatewayAlias: selected?.gatewayAlias === true || binding.gatewayAlias === true,
    gatewayDefault: selected?.gatewayDefault === true || binding.gatewayDefault === true,
  };
}

function activeModelRuntimeOptions() {
  const scoped = activeSessionId ? settings.sessionModelOptionBindings?.[activeSessionId] : null;
  return normalizeModelRuntimeOptions(scoped || settings.extensionPreferredModelOptions || {
    thinkingEnabled: settings.thinkingEnabled,
    reasoningEffort: settings.reasoningEffort,
    fastMode: settings.fastMode,
  });
}

function modelOptionsPayload() {
  return buildModelRuntimeOptionsPayload(activeModelRuntimeOptions());
}

function renderComposerRuntimeControl() {
  if (!els.composerModelControl) return;
  const model = effectiveModel();
  const options = activeModelRuntimeOptions();
  const effort = MODEL_REASONING_EFFORTS.find((option) => option.value === options.reasoningEffort)?.label || options.reasoningEffort;
  els.composerModelName.textContent = model.label || translateUiText('Gateway default');
  els.composerRuntimeMeta.textContent = [
    options.thinkingEnabled ? t('runtime.reasoning', { effort: translateUiText(effort) }) : translateUiText('Thinking off'),
    options.fastMode ? translateUiText('Fast mode') : translateUiText('Standard'),
  ].join(' · ');
  els.composerModelControl.title = t('runtime.model_control_title', {
    model: model.label || translateUiText('Gateway default'),
    options: els.composerRuntimeMeta.textContent,
  });
}

function renderModelRuntimeOptions() {
  if (!els.modelOptionsList) return;
  const assistTarget = modelSelectionTarget === 'assist';
  const options = assistTarget ? inlineAssistRuntimeOptions() : activeModelRuntimeOptions();
  const selectedAssistModel = availableModels.find((model) => model.id === (settings.inlineAssistModel || settings.model));
  const capabilities = modelRuntimeCapabilities(assistTarget ? (selectedAssistModel || {}) : effectiveModel());
  els.modelOptionsList.replaceChildren();

  const heading = document.createElement('p');
  heading.className = 'model-options-heading';
  heading.textContent = assistTarget ? t('assist.options_heading') : t('runtime.options_heading');
  els.modelOptionsList.append(heading);

  if (capabilities.reasoning) {
    const effort = document.createElement('div');
    effort.className = 'model-effort-options';
    for (const option of MODEL_REASONING_EFFORTS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.runtimeEffort = option.value;
      button.className = `model-runtime-option${options.reasoningEffort === option.value ? ' selected' : ''}`;
      button.setAttribute('aria-pressed', String(options.reasoningEffort === option.value));
      button.textContent = option.label;
      effort.append(button);
    }
    els.modelOptionsList.append(effort);
  }

  const toggles = document.createElement('div');
  toggles.className = 'model-runtime-toggles';
  if (capabilities.thinking) {
    const thinking = document.createElement('button');
    thinking.type = 'button';
    thinking.dataset.runtimeToggle = 'thinking';
    thinking.className = `model-runtime-toggle${options.thinkingEnabled ? ' selected' : ''}`;
    thinking.setAttribute('aria-pressed', String(options.thinkingEnabled));
    thinking.textContent = t('runtime.thinking_toggle', { state: translateUiText(options.thinkingEnabled ? 'On' : 'Off') });
    toggles.append(thinking);
  }
  if (capabilities.fast) {
    const fast = document.createElement('button');
    fast.type = 'button';
    fast.dataset.runtimeToggle = 'fast';
    fast.className = `model-runtime-toggle${options.fastMode ? ' selected' : ''}`;
    fast.setAttribute('aria-pressed', String(options.fastMode));
    fast.textContent = t('runtime.fast_mode_toggle', { state: translateUiText(options.fastMode ? 'On' : 'Off') });
    toggles.append(fast);
  }
  if (toggles.childElementCount) els.modelOptionsList.append(toggles);

  if (!capabilities.reasoning || !capabilities.fast) {
    const unavailable = document.createElement('p');
    unavailable.className = 'model-options-note';
    unavailable.textContent = translateUiText('Only controls supported by the selected model are shown.');
    els.modelOptionsList.append(unavailable);
  }
  renderComposerRuntimeControl();
}

async function setModelRuntimeOptions(partial = {}) {
  const options = normalizeModelRuntimeOptions({ ...activeModelRuntimeOptions(), ...partial });
  const sessionBindings = { ...(settings.sessionModelOptionBindings || {}) };
  if (activeSessionId) sessionBindings[activeSessionId] = options;
  settings = {
    ...settings,
    thinkingEnabled: options.thinkingEnabled,
    reasoningEffort: options.reasoningEffort,
    fastMode: options.fastMode,
    extensionPreferredModelOptions: options,
    sessionModelOptionBindings: sessionBindings,
  };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  renderModelRuntimeOptions();
  renderComposerRuntimeControl();
  const effortLabel = MODEL_REASONING_EFFORTS.find((option) => option.value === options.reasoningEffort)?.label || options.reasoningEffort;
  const runtimeSummary = [
    options.thinkingEnabled ? t('runtime.reasoning', { effort: translateUiText(effortLabel) }) : translateUiText('Thinking off'),
    options.fastMode ? translateUiText('Fast mode') : '',
  ].filter(Boolean).join(' · ');
  els.composerStatus.textContent = t('runtime.options_saved', { summary: runtimeSummary });
}

function modelProviderName(model = {}) {
  return String(model.providerLabel || model.provider || 'Hermes').trim() || 'Hermes';
}

function groupModelsForPicker(query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const groups = new Map();
  for (const model of availableModels) {
    const haystack = `${modelProviderName(model)} ${model.label || ''} ${model.rawModelId || ''}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    const provider = modelProviderName(model);
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(model);
  }
  return [...groups.entries()].map(([provider, models]) => ({ provider, models }));
}

function inlineAssistRuntimeOptions() {
  return normalizeModelRuntimeOptions({
    thinkingEnabled: settings.inlineAssistThinkingEnabled,
    reasoningEffort: settings.inlineAssistReasoningEffort || 'low',
    fastMode: settings.inlineAssistFastMode,
  });
}

function renderInlineAssistRuntimeOptions() {
  if (!els.inlineAssistRuntimeOptions) return;
  const options = inlineAssistRuntimeOptions();
  els.inlineAssistRuntimeOptions.replaceChildren();
  const heading = document.createElement('p');
  heading.className = 'model-options-heading';
  heading.textContent = translateUiText('Assist options');
  const effort = document.createElement('div');
  effort.className = 'model-effort-options';
  for (const option of MODEL_REASONING_EFFORTS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.assistEffort = option.value;
    button.className = `model-runtime-option${options.reasoningEffort === option.value ? ' selected' : ''}`;
    button.textContent = translateUiText(option.label);
    effort.append(button);
  }
  const toggles = document.createElement('div');
  toggles.className = 'model-runtime-toggles';
  for (const [key, label, enabled] of [
    ['thinking', 'Thinking', options.thinkingEnabled],
    ['fast', 'Fast mode', options.fastMode],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.assistToggle = key;
    button.className = `model-runtime-toggle${enabled ? ' selected' : ''}`;
    button.textContent = `${translateUiText(label)} ${translateUiText(enabled ? 'On' : 'Off')}`;
    toggles.append(button);
  }
  els.inlineAssistRuntimeOptions.append(heading, effort, toggles);
}

function renderInlineAssistModelOptions() {
  if (!els.inlineAssistModel) return;
  const selectedId = String(settings.inlineAssistModel || settings.model || '');
  const routingSupported = assistModelRoutingSupported(gatewayCapabilities);
  const selected = availableModels.find((model) => (model.id === selectedId || model.rawModelId === selectedId) && isModelRuntimeSelectable(model))
    || (!selectedId ? availableModels.find(isModelRuntimeSelectable) : null)
    || null;
  els.inlineAssistModel.value = selected?.id || selectedId;
  if (els.inlineAssistModelLabel) els.inlineAssistModelLabel.textContent = selected?.label || selected?.rawModelId || selected?.id || selectedId || translateUiText('Choose model');
  if (els.inlineAssistModelButton) {
    els.inlineAssistModelButton.disabled = false;
    els.inlineAssistModelButton.title = selected
      ? `${modelProviderName(selected)} · ${selected.rawModelId || selected.id} · ${t(routingSupported ? 'assist.routing.exact_short' : 'assist.routing.fallback_short')}`
      : translateUiText('Choose the model used by Hermes Assist');
  }
  if (els.assistModelCapabilityHint) {
    const key = routingSupported ? 'assist.routing.exact' : 'assist.routing.fallback';
    const localized = t(key);
    els.assistModelCapabilityHint.textContent = localized === key && !routingSupported ? ASSIST_ROUTING_FALLBACK_ENGLISH : localized;
  }
  renderInlineAssistRuntimeOptions();
}

async function reconcileInlineAssistModelBinding() {
  const binding = resolveAssistModelBindingFromCatalog({ settings, models: availableModels });
  if (!binding) return false;
  const changed = Object.entries(binding).some(([key, value]) => settings[key] !== value);
  if (!changed) return false;
  settings = { ...settings, ...binding };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  return true;
}

function modelForSelectionTarget(target = modelSelectionTarget) {
  if (target === 'assist') {
    const modelId = settings.inlineAssistModel || settings.model;
    return availableModels.find((model) => model.id === modelId || model.rawModelId === modelId)
      || availableModels.find(isModelRuntimeSelectable)
      || availableModels[0]
      || null;
  }
  return effectiveModel();
}

function setModelSelectionTarget(target = 'chat') {
  modelSelectionTarget = target === 'assist' ? 'assist' : 'chat';
  if (modelPickerHome.parent && els.modelPicker.parentElement !== modelPickerHome.parent) {
    modelPickerHome.parent.insertBefore(els.modelPicker, modelPickerHome.next);
  }
  if (modelSelectionTarget === 'assist') {
    els.modelPicker.dataset.selectionTarget = 'assist';
    if (els.modelPickerTitle) els.modelPickerTitle.textContent = translateUiText('Choose Assist model');
  } else {
    delete els.modelPicker.dataset.selectionTarget;
    if (els.modelPickerTitle) els.modelPickerTitle.textContent = translateUiText('Choose model');
  }
  const selected = modelForSelectionTarget(modelSelectionTarget);
  selectedModelProvider = selected ? modelProviderName(selected) : '';
  els.modelSearch.value = '';
  els.modelProviderList.scrollTop = 0;
  els.modelList.scrollTop = 0;
  renderModelPicker('');
  globalThis.queueMicrotask(() => {
    els.modelProviderList.querySelector('.model-provider-option.selected')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
}

function renderModelPicker(query = '') {
  const needle = String(query).trim();
  const current = modelSelectionTarget === 'assist'
    ? (availableModels.find((model) => model.id === (settings.inlineAssistModel || settings.model)) || effectiveModel())
    : effectiveModel();
  const allGroups = groupModelsForPicker();
  const matchingGroups = groupModelsForPicker(needle);
  const selectedProvider = modelProviderName(availableModels.find((model) => model.id === current.id) || {});
  if (!selectedModelProvider || !allGroups.some((group) => group.provider === selectedModelProvider)) {
    selectedModelProvider = selectedProvider && allGroups.some((group) => group.provider === selectedProvider)
      ? selectedProvider
      : allGroups[0]?.provider || '';
  }

  els.modelProviderList.replaceChildren();
  for (const group of needle ? matchingGroups : allGroups) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-provider-option ${group.provider === selectedModelProvider ? 'selected' : ''}`.trim();
    button.setAttribute('aria-pressed', String(group.provider === selectedModelProvider));
    const label = document.createElement('span');
    label.textContent = group.provider;
    const count = document.createElement('small');
    count.textContent = String(group.models.length);
    button.append(label, count);
    button.addEventListener('click', () => {
      selectedModelProvider = group.provider;
      els.modelSearch.value = '';
      renderModelPicker();
      els.modelSearch.focus();
    });
    els.modelProviderList.append(button);
  }

  els.modelList.replaceChildren();
  const groupsToRender = needle
    ? matchingGroups
    : matchingGroups.filter((group) => group.provider === selectedModelProvider);
  for (const group of groupsToRender) {
    const heading = document.createElement('p');
    heading.className = 'model-group-heading';
    heading.textContent = `${group.provider} · ${group.models.length} models`;
    els.modelList.append(heading);
    for (const model of group.models) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `model-choice ${model.id === current.id ? 'selected' : ''}`.trim();
      const selectable = isModelRuntimeSelectable(model);
      button.disabled = !selectable;
      if (!selectable) button.title = translateUiText('Observed from session history; not advertised as a requestable Hermes model.');
      const copy = document.createElement('span');
      const provider = document.createElement('small');
      const label = document.createElement('strong');
      const selected = document.createElement('em');
      provider.textContent = modelProviderName(model);
      label.textContent = model.label || model.rawModelId;
      selected.textContent = model.id === current.id ? '✓' : '';
      copy.append(provider, label);
      button.append(copy, selected);
      if (selectable) button.addEventListener('click', async () => {
        if (modelSelectionTarget === 'assist') {
          settings = { ...settings, inlineAssistModel: model.id, inlineAssistRawModel: model.rawModelId || model.id, inlineAssistProvider: model.provider || '' };
          renderInlineAssistModelOptions();
          await browserApi.storage.local.set({ hermesBrowserSettings: settings });
          toggleModelPicker(false);
          els.inlineAssistModelButton?.setAttribute('aria-expanded', 'false');
        } else {
          selectModel(model);
        }
      });
      els.modelList.append(button);
    }
  }
  if (!els.modelList.childElementCount) els.modelList.textContent = translateUiText('No models found.');
  renderInlineAssistModelOptions();
  renderModelRuntimeOptions();
}

async function readCachedModelCatalog() {
  try {
    const stored = await browserApi.storage.local.get([MODEL_CATALOG_CACHE_STORAGE_KEY]);
    const key = modelCatalogCacheKey({
      gatewayMode: settings.gatewayMode,
      gatewayUrl: settings.gatewayUrl,
      profile: settings.activeProfile,
    });
    return normalizeCachedModelCatalog(stored?.[MODEL_CATALOG_CACHE_STORAGE_KEY]?.[key]?.models);
  } catch {
    return [];
  }
}

async function writeCachedModelCatalog(models = []) {
  const canonicalModels = normalizeCachedModelCatalog(models);
  if (!canonicalModels.length) return;
  try {
    const stored = await browserApi.storage.local.get([MODEL_CATALOG_CACHE_STORAGE_KEY]);
    const cache = stored?.[MODEL_CATALOG_CACHE_STORAGE_KEY] && typeof stored[MODEL_CATALOG_CACHE_STORAGE_KEY] === 'object'
      ? stored[MODEL_CATALOG_CACHE_STORAGE_KEY]
      : {};
    const key = modelCatalogCacheKey({
      gatewayMode: settings.gatewayMode,
      gatewayUrl: settings.gatewayUrl,
      profile: settings.activeProfile,
    });
    cache[key] = { savedAt: Date.now(), models: canonicalModels };
    await browserApi.storage.local.set({ [MODEL_CATALOG_CACHE_STORAGE_KEY]: cache });
  } catch {
    // Catalog caching is resilience-only; storage failures must not block sync.
  }
}

async function loadModels({ refresh = false } = {}) {
  const previousSelectedModel = settings.model;
  let registryModels = [];
  let registrySource = '';

  const registryResult = await discoverModelsFromRegistry({ apiFetch: client.fetch, readJsonResponse: client.readJson, refresh });
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
      const cachedCatalogModels = await readCachedModelCatalog();
      const cachedFallback = selectModelCatalogFallback({ cachedModels: cachedCatalogModels });
      if (cachedFallback.models.length) {
        registryModels = normalizeHermesModels(cachedFallback.models, settings.model);
        registrySource = cachedFallback.source;
      } else {
        const virtualResult = await discoverGatewayVirtualModels({ apiFetch: client.fetch, readJsonResponse: client.readJson });
        if (!virtualResult.ok || !virtualResult.models.length) {
          throw new Error(virtualResult.error || 'Hermes did not advertise a gateway model alias.');
        }
        registryModels = normalizeHermesModels(virtualResult.models, settings.model);
        registrySource = 'gateway';
      }
    }
  }

  if (registrySource !== 'gateway') {
    const virtualResult = await discoverGatewayVirtualModels({ apiFetch: client.fetch, readJsonResponse: client.readJson });
    if (virtualResult.ok && virtualResult.models.length) {
      registryModels = normalizeHermesModels(mergeVirtualModelRows({
        registryModels,
        virtualModels: virtualResult.models,
      }), settings.model);
    }
  }

  if (registryModels.length && shouldEnrichCanonicalProviderCatalog(registrySource)) {
    const canonicalResult = await discoverCanonicalProviderCatalog({
      registryModels,
      fetchFn: globalThis.fetch?.bind(globalThis),
    });
    registryModels = normalizeHermesModels(canonicalResult.models, settings.model);
    await writeCachedModelCatalog(registryModels);
  }

  if (shouldTrySessionModelFallback({
    registryModels,
    registrySource,
    defaultModelId: 'hermes-agent',
  })) {
    const sessionResult = await discoverModelsFromSessions({ apiFetch: client.fetch, readJsonResponse: client.readJson });
    if (sessionResult.ok && sessionResult.models.length) {
      registryModels = normalizeHermesModels(
        mergeModelsWithRegistry({ registryModels, sessionModels: sessionResult.models }),
        settings.model,
      );
      registrySource = 'sessions';
    }
  }

  const refreshDecision = modelCatalogRefreshDecision({
    previousSelectedModel,
    discoveredModels: registryModels,
    refresh,
  });
  if (refreshDecision.keepPreviousSelection) {
    registryModels = normalizeHermesModels(registryModels, refreshDecision.selectedModel);
  }

  availableModels = registryModels;
  await reconcileInlineAssistModelBinding();
  const current = effectiveModel();
  els.modelLabel.textContent = current.label;
  renderModelPicker(els.modelSearch.value);
  renderComposerRuntimeControl();
  renderContextWindow();
  return availableModels;
}

function setModelRefreshState(refreshing) {
  modelsRefreshing = Boolean(refreshing);
  els.refreshModels.disabled = modelsRefreshing;
  els.refreshModels.classList.toggle('model-refreshing', modelsRefreshing);
  els.refreshModels.setAttribute('aria-busy', String(modelsRefreshing));
}

async function refreshModelsFromPicker() {
  setModelRefreshState(true);
  try {
    const models = await loadModels({ refresh: true });
    els.composerStatus.textContent = `${models.length} models loaded and synced`;
  } finally {
    setModelRefreshState(false);
  }
}

async function loadSkills({ quiet = false } = {}) {
  try {
    const response = await client.fetch('/v1/skills', { method: 'GET' });
    const payload = await client.readJson(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Skills list failed (${response.status}).`);
    availableSkills = normalizeHermesSkills(payload);
    renderComposerSuggestions();
    if (!quiet) els.composerStatus.textContent = `${availableSkills.length} skills synced`;
  } catch (error) {
    availableSkills = [];
    renderComposerSuggestions();
    if (!quiet) els.composerStatus.textContent = `Skill sync failed: ${error?.message || String(error)}`;
  }
}

function applySkillSuggestion(command = '') {
  const clean = String(command || '').trim();
  if (!clean) return;
  const value = els.prompt.value;
  const next = value.replace(/(^|\s)[/@][a-z0-9_-]*$/i, (_match, prefix) => `${prefix}${clean} `);
  els.prompt.value = next === value ? `${value}${value && !value.endsWith(' ') ? ' ' : ''}${clean} ` : next;
  els.skillMenu.hidden = true;
  els.commandMenuButton.setAttribute('aria-expanded', 'false');
  renderContextWindow();
  updateBusyControls();
  els.prompt.focus();
}

function toggleModelPicker(forceOpen = null) {
  const nextVisible = typeof forceOpen === 'boolean' ? forceOpen : els.modelPicker.hidden;
  els.modelPicker.hidden = !nextVisible;
  els.modelPickerButton.setAttribute('aria-expanded', String(nextVisible && modelSelectionTarget === 'chat'));
  els.inlineAssistModelButton?.setAttribute('aria-expanded', String(nextVisible && modelSelectionTarget === 'assist'));
  if (nextVisible) {
    renderModelPicker(els.modelSearch.value);
    els.modelSearch.focus();
  }
}

function browserCommandsForSurface(surface = 'fulltab') {
  return WEB_COMMANDS.filter((command) => !command.surfaces || command.surfaces.includes(surface));
}

function nativeCommandCatalogText() {
  return browserCommandsForSurface()
    .map((command) => `/${command.name}${command.requiresInput ? ' …' : ''} — ${command.description}`)
    .join('\n');
}

async function executeNativeBrowserCommand(parsedCommand) {
  if (!parsedCommand || parsedCommand.kind !== 'native') return false;
  const { command, userInput = '' } = parsedCommand;
  const action = command.action;
  els.skillMenu.hidden = true;
  els.commandMenuButton.setAttribute('aria-expanded', 'false');

  if (action === 'steer-run') {
    if (!userInput) {
      els.composerStatus.textContent = translateUiText('Add guidance after /steer');
      return true;
    }
    els.prompt.value = userInput;
    await steerCurrentDraft();
    return true;
  }
  if (action === 'stop-run') {
    await stopActiveRun();
    return true;
  }
  if (action === 'queue-message') {
    if (!sending) els.composerStatus.textContent = translateUiText('Hermes is not running · send the message normally');
    else if (!userInput) els.composerStatus.textContent = translateUiText('Add a message after /queue');
    else {
      queuedTurn = { text: userInput, attachments: [...attachments] };
      els.prompt.value = '';
      attachments = [];
      renderAttachments();
      updateBusyControls();
      els.composerStatus.textContent = translateUiText('Message queued');
    }
    return true;
  }
  if (action === 'command-help') {
    activeMessages = [...activeMessages, { role: 'system', content: `Hermes Browser commands\n\n${nativeCommandCatalogText()}` }];
    renderMessages(activeMessages);
    return true;
  }
  if (action === 'session-list') {
    setNavigationOpen(true);
    updateScrim();
    els.sessionSearch.focus();
    return true;
  }
  if (action === 'new-session' || action === 'reset-session') {
    if (sending) els.composerStatus.textContent = translateUiText('Stop the active run before starting a clean session');
    else await beginHermesWebDraft();
    return true;
  }
  if (action === 'retry-last') {
    if (sending) {
      els.composerStatus.textContent = translateUiText('Stop or wait for the active run before retrying');
      return true;
    }
    const lastUser = [...activeMessages].reverse().find((message) => message?.role === 'user' && String(message?.content || '').trim());
    if (!lastUser) els.composerStatus.textContent = translateUiText('Nothing to retry');
    else await sendPrompt(String(lastUser.content).trim());
    return true;
  }
  if (action === 'model-picker') {
    toggleModelPicker(true);
    return true;
  }
  if (action === 'provider-settings' || action === 'settings') {
    openSettings();
    return true;
  }
  if (action === 'skill-list') {
    await loadSkills({ quiet: true });
    els.prompt.value = '/';
    renderComposerSuggestions({ force: true });
    els.prompt.focus();
    return true;
  }
  if (action === 'refresh-sessions') {
    await loadApp();
    return true;
  }
  if (action === 'context-window' || action === 'activity') {
    setInspectorTab(action === 'activity' ? 'activity' : 'context');
    els.shell.classList.remove('inspector-closed');
    els.inspectorToggle.setAttribute('aria-expanded', 'true');
    updateScrim();
    return true;
  }
  if (action === 'attach-files') {
    els.attachmentInput.click();
    return true;
  }
  if (action === 'unsupported') {
    els.composerStatus.textContent = command.unsupportedReason || `/${command.name} is unavailable in Hermes Browser.`;
    return true;
  }
  return false;
}

async function runWebCommand(name = '') {
  const command = WEB_COMMANDS.find((item) => item.name === name && item.kind === 'native');
  if (!command) return false;
  return executeNativeBrowserCommand({ kind: 'native', command, userInput: '' });
}

function renderComposerSuggestions({ force = false } = {}) {
  const value = els.prompt.value || '';
  const mode = webComposerSuggestionMode(value, { force });
  const commandToken = /(?:^|\s)\/([a-z0-9_-]*)$/i.exec(value);
  const skillToken = /(?:^|\s)([/@])([a-z0-9_-]*)$/i.exec(value);
  if (mode === 'none') {
    els.skillMenu.hidden = true;
    els.commandMenuButton.setAttribute('aria-expanded', 'false');
    return;
  }
  const skillPrefix = skillToken?.[1] || '/';
  const skillNeedle = String(skillToken?.[2] || '').toLowerCase();
  const webCommands = mode === 'commands' ? WEB_COMMANDS : commandToken ? webCommandSuggestions(value) : [];
  const skills = mode === 'typed'
    ? skillNeedle ? skillSuggestionsForInput(value, availableSkills, 8) : availableSkills.slice(0, 8)
    : [];
  const visibleWebCommands = webCommands;
  const visibleSkills = skills;
  const seen = new Set();
  const suggestions = [
    ...visibleWebCommands.map((command) => ({
      command: `/${command.name}`,
      name: command.name,
      description: command.description,
      type: command.kind === 'native' ? 'NATIVE' : 'HELPER',
      webCommand: command.kind === 'native',
      requiresInput: Boolean(command.requiresInput),
    })),
    ...visibleSkills.map((skill) => ({ command: skill.command.replace(/^[/@]/, skillPrefix), name: skill.name, description: skill.description, type: skill.category || 'SKILL' })),
  ].filter((item) => {
    if (seen.has(item.command)) return false;
    seen.add(item.command);
    return true;
  }).slice(0, 12);
  els.skillMenu.replaceChildren();
  if (!suggestions.length) {
    els.skillMenu.hidden = true;
    return;
  }
  for (const suggestion of suggestions) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'skill-option';
    option.setAttribute('role', 'option');
    const command = document.createElement('strong');
    command.textContent = suggestion.command;
    const copy = document.createElement('span');
    copy.textContent = suggestion.description || suggestion.name;
    const type = document.createElement('small');
    type.textContent = suggestion.type;
    option.append(command, copy, type);
    option.addEventListener('click', () => {
      if (suggestion.webCommand && !suggestion.requiresInput) {
        runWebCommand(suggestion.name).catch((error) => { els.composerStatus.textContent = error?.message || String(error); });
      } else {
        applySkillSuggestion(suggestion.command);
      }
    });
    els.skillMenu.append(option);
  }
  els.skillMenu.hidden = false;
  els.commandMenuButton.setAttribute('aria-expanded', 'true');
}


async function selectModel(model) {
  const previousSettings = settings;
  const previousSelectedModelProvider = selectedModelProvider;
  let cloudSwitchAccepted = false;
  let cloudSwitchConnection = null;
  let cloudSwitchSessionId = '';
  selectedModelProvider = modelProviderName(model);
  const binding = {
    modelId: model.id,
    rawModelId: model.rawModelId,
    provider: model.provider,
    contextTokens: model.contextTokens || 0,
    reasoning: model.reasoning,
    fast: model.fast,
    gatewayAlias: model.gatewayAlias === true,
    gatewayDefault: model.gatewayDefault === true,
  };
  settings = {
    ...settings,
    model: model.id,
    extensionPreferredModel: binding,
    sessionModelBindings: { ...(settings.sessionModelBindings || {}), ...(activeSessionId ? { [activeSessionId]: binding } : {}) },
  };
  try {
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    if (activeSessionId) {
      if (usesDashboardTicketTransport()) {
        const connection = await ensureDashboardConnection();
        if (!dashboardLiveSessionId) await establishDashboardSession(activeSessionId);
        cloudSwitchConnection = connection;
        cloudSwitchSessionId = dashboardLiveSessionId;
        const request = buildSessionModelSwitchRequest({
          sessionId: dashboardLiveSessionId,
          model: model.rawModelId,
          provider: model.provider,
        });
        await connection.client.request(request.method, request.params);
        cloudSwitchAccepted = true;
        const status = await connection.client.request(WS_METHODS.sessionStatus, { session_id: dashboardLiveSessionId });
        const acknowledged = sessionModelBindingFromRuntime(runtimeModelFromSessionStatus(status), availableModels);
        if (!acknowledged) throw new Error('Hermes Cloud did not acknowledge the active session model.');
        settings = {
          ...settings,
          model: acknowledged.modelId,
          sessionModelBindings: { ...(settings.sessionModelBindings || {}), [activeSessionId]: acknowledged },
        };
        await browserApi.storage.local.set({ hermesBrowserSettings: settings });
        const exact = acknowledged.provider === model.provider && acknowledged.rawModelId === model.rawModelId;
        els.composerStatus.textContent = exact
          ? 'Cloud session model confirmed'
          : `Cloud fallback · ${acknowledged.provider} · ${acknowledged.rawModelId}`;
      } else {
        const requireModelLock = shouldRequireModelLock({
          provider: model.provider,
          model: model.rawModelId,
          defaultModel: 'hermes-agent',
          gatewayDefault: model.gatewayDefault === true,
        });
        if (!requireModelLock) {
          els.composerStatus.textContent = 'Gateway default requested · Hermes will confirm the runtime on the next turn';
        } else {
          const response = await client.fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/model`, {
            method: 'POST',
            body: JSON.stringify({ provider: model.provider || undefined, model: model.rawModelId, model_options: modelOptionsPayload(), require_model_lock: true }),
          });
          const payload = await client.readJson(response);
          const outcome = modelLockRequestOutcome({
            responseOk: response.ok,
            status: response.status,
            payload,
            requested: {
              provider: model.provider,
              model: model.rawModelId,
              gatewayAlias: model.gatewayAlias === true,
              gatewayDefault: model.gatewayDefault === true,
            },
          });
          if (!outcome.ok && outcome.rollback) throw new Error(outcome.detail);
          els.composerStatus.textContent = outcome.state === 'legacy'
            ? 'Model requested · Hermes will confirm on the next turn'
            : outcome.state === 'pending'
              ? 'Model lock pending · waiting for runtime confirmation'
              : `Model lock accepted${outcome.detail ? ` · ${outcome.detail}` : ''}`;
        }
      }
    }
  } catch (error) {
    if (cloudSwitchAccepted) {
      const previousBinding = previousSettings.sessionModelBindings?.[activeSessionId]
        || previousSettings.extensionPreferredModel
        || {};
      const previousModel = availableModels.find((candidate) => candidate.id === previousSettings.model)
        || availableModels.find((candidate) => candidate.rawModelId === previousBinding.rawModelId && (!previousBinding.provider || candidate.provider === previousBinding.provider));
      const rollbackModel = previousModel?.rawModelId || previousBinding.rawModelId || '';
      const rollbackProvider = previousModel?.provider || previousBinding.provider || '';
      try {
        if (!rollbackModel || !rollbackProvider || !cloudSwitchConnection || !cloudSwitchSessionId) {
          throw new Error('The previous provider-qualified model was unavailable.');
        }
        const rollbackRequest = buildSessionModelSwitchRequest({
          sessionId: cloudSwitchSessionId,
          model: rollbackModel,
          provider: rollbackProvider,
        });
        await cloudSwitchConnection.client.request(rollbackRequest.method, rollbackRequest.params);
        const rollbackStatus = await cloudSwitchConnection.client.request(WS_METHODS.sessionStatus, { session_id: cloudSwitchSessionId });
        const rollbackAck = sessionModelBindingFromRuntime(runtimeModelFromSessionStatus(rollbackStatus), availableModels);
        if (!rollbackAck || rollbackAck.rawModelId !== rollbackModel || rollbackAck.provider !== rollbackProvider) {
          throw new Error('Hermes did not confirm the previous runtime model.');
        }
      } catch (rollbackError) {
        settings = {
          ...settings,
          model: '',
          sessionModelBindings: {
            ...(settings.sessionModelBindings || {}),
            [activeSessionId]: { unconfirmed: true },
          },
        };
        selectedModelProvider = '';
        await browserApi.storage.local.set({ hermesBrowserSettings: settings }).catch(() => {});
        renderModelPicker();
        renderComposerRuntimeControl();
        renderContextWindow();
        const truthError = new Error(`Cloud model changed, but runtime confirmation and Cloud model rollback both failed: ${rollbackError?.message || String(rollbackError)}`);
        els.composerStatus.textContent = translateUiText('Cloud runtime model unconfirmed');
        throw truthError;
      }
    }
    settings = previousSettings;
    selectedModelProvider = previousSelectedModelProvider;
    await browserApi.storage.local.set({ hermesBrowserSettings: settings }).catch(() => {});
    renderModelPicker();
    renderComposerRuntimeControl();
    renderContextWindow();
    throw error;
  }
  const acknowledgedModel = effectiveModel();
  els.modelLabel.textContent = acknowledgedModel.label || acknowledgedModel.model || model.label || model.rawModelId;
  renderModelPicker();
  els.modelPicker.hidden = true;
  els.modelPickerButton.setAttribute('aria-expanded', 'false');
  renderContextWindow();
}

function webAppearancePreferences() {
  return appearancePreferencesForSurface(settings, 'web');
}

function webMarketplaceText(key, fallback, params) {
  const translated = t(key, params);
  return translated && translated !== key ? translated : fallback;
}

function webMarketplaceErrorText(code) {
  const map = { 'request-timeout':['marketplace.timeout','Request timed out'], 'archive-too-large':['marketplace.package_too_large','Package is too large'], 'no-color-themes':['marketplace.not_supported','Package is not a supported theme'], 'package-corrupt':['marketplace.package_corrupt','Package is corrupt'], 'unsupported-compression':['marketplace.unsupported_archive','Unsupported archive format'], 'network-failed':['marketplace.unavailable','Marketplace unavailable'] };
  const [key, fallback] = map[code] || ['marketplace.unavailable','Marketplace unavailable'];
  return webMarketplaceText(key, fallback);
}

function renderWebMarketplace(status = '') {
  const host = els.settingsMarketplaceThemeResults;
  if (!host || !els.settingsMarketplaceThemeStatus) return;
  els.settingsMarketplaceThemeStatus.textContent = status || (webMarketplaceLoading ? webMarketplaceText('marketplace.loading','Loading themes…') : webMarketplaceError);
  els.settingsMarketplaceThemeMode.textContent = els.settingsMarketplaceThemeSearchInput?.value.trim() ? webMarketplaceText('marketplace.search_results','Search results') : webMarketplaceText('marketplace.most_installed','Most installed');
  host.replaceChildren();
  if (webMarketplaceError) return;
  if (webMarketplaceLoading) {
    const loading=document.createElement('div'); loading.className='marketplace-theme-loading'; loading.setAttribute('aria-hidden','true');
    for(let index=0;index<5;index+=1)loading.append(document.createElement('i'));
    host.append(loading); return;
  }
  if (!webMarketplaceResults.length) { const empty=document.createElement('p'); empty.className='marketplace-theme-empty'; empty.textContent=webMarketplaceText('marketplace.empty','No themes found'); host.append(empty); return; }
  for (const item of webMarketplaceResults) {
    const card=document.createElement('article'); card.className='marketplace-theme-card';
    const copy=document.createElement('div'); copy.className='marketplace-theme-card-copy';
    const title=document.createElement('strong'); title.textContent=item.displayName;
    const meta=document.createElement('span'); meta.textContent=`${item.publisher}${item.installs ? ` · ${new Intl.NumberFormat(undefined,{notation:'compact'}).format(item.installs)}` : ''}`;
    const description=document.createElement('p'); description.textContent=item.description; copy.append(title,meta,description);
    const button=document.createElement('button'); button.type='button'; button.dataset.marketplaceInstall=item.extensionId; button.disabled=Boolean(webMarketplaceInstallingId);
    button.textContent=webMarketplaceInstallingId===item.extensionId ? webMarketplaceText('marketplace.installing','Installing…') : item.installedThemeId ? webMarketplaceText('marketplace.select_installed','Select installed theme') : webMarketplaceText('marketplace.install','Install');
    card.append(copy,button); host.append(card);
  }
}

async function loadWebMarketplace() {
  const revision=++webMarketplaceRevision; webMarketplaceLoading=true; webMarketplaceError=''; renderWebMarketplace();
  const query=els.settingsMarketplaceThemeSearchInput?.value.trim() || '';
  const response=await webMarketplaceTransport.send({type:'HERMES_THEME_MARKETPLACE_SEARCH',query,limit:20});
  if (revision!==webMarketplaceRevision) return;
  webMarketplaceLoading=false; webMarketplaceLoaded=true;
  if (!response?.ok) { webMarketplaceError=webMarketplaceErrorText(response?.error?.code); renderWebMarketplace(); return; }
  webMarketplaceError='';
  webMarketplaceResults=Array.isArray(response.data?.results)?response.data.results:[]; renderWebMarketplace();
}

async function installWebMarketplaceTheme(extensionId) {
  if (webMarketplaceInstallingId) return;
  const existing=webMarketplaceResults.find((item)=>item.extensionId===extensionId)?.installedThemeId;
  if (existing) { els.settingsTheme.value=existing; await applyAndPersistAppearance(); return; }
  webMarketplaceInstallingId=extensionId; renderWebMarketplace();
  const response=await webMarketplaceTransport.send({type:'HERMES_THEME_MARKETPLACE_INSTALL',extensionId});
  webMarketplaceInstallingId='';
  if (!response?.ok) { webMarketplaceError=webMarketplaceErrorText(response?.error?.code); renderWebMarketplace(); return; }
  await refreshWebCustomThemeStore(); els.settingsTheme.value=response.data.themeId; await applyAndPersistAppearance();
  const details=[]; if(response.data.adjusted?.length)details.push(webMarketplaceText('marketplace.adjusted','Theme was adjusted for readability')); if(response.data.derived?.length)details.push(webMarketplaceText('marketplace.derived','Some source colors were derived'));
  await loadWebMarketplace(); renderWebMarketplace(details.join(' · ') || webMarketplaceText('marketplace.installed','Installed'));
}

function webCustomThemeText(key, fallback, params) {
  const translated = t(key, params);
  return translated && translated !== key ? translated : fallback;
}

function normalizedWebThemeId(value) {
  const selection = customThemeSelection(value, webCustomThemeStoreState.themes);
  if (selection.kind === 'builtin' || selection.kind === 'custom') return selection.id;
  return normalizeAppearanceTheme(value);
}

function webCustomThemeInputBytes(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

function buildWebThemePreview(palette) {
  const preview = document.createElement('span');
  preview.className = 'theme-preview';
  preview.setAttribute('aria-hidden', 'true');
  preview.style.setProperty('--preview-bg', palette.canvas);
  preview.style.setProperty('--preview-panel', palette.paper);
  preview.style.setProperty('--preview-text', palette.ink);
  preview.style.setProperty('--preview-muted', palette.muted);
  preview.style.setProperty('--preview-accent', palette.accent);
  preview.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  return preview;
}

function renderWebCustomThemePreview() {
  const preview = els.webCustomThemePreview;
  if (!preview || !els.webCustomThemeInstallButton) return;
  preview.replaceChildren();
  preview.hidden = !webCustomThemePreviewState;
  els.webCustomThemeInstallButton.disabled = !webCustomThemePreviewState?.valid;
  if (!webCustomThemePreviewState) return;
  if (!webCustomThemePreviewState.valid) {
    const list = document.createElement('ul');
    list.className = 'custom-theme-validation-list';
    for (const error of webCustomThemePreviewState.errors) {
      const item = document.createElement('li');
      const path = document.createElement('strong');
      path.textContent = error.path || '$';
      item.append(path, document.createTextNode(` — ${error.message || error.code}`));
      list.append(item);
    }
    preview.append(list);
    return;
  }
  const themeDocument = webCustomThemePreviewState.document;
  const head = document.createElement('div');
  head.className = 'custom-theme-preview-head';
  const name = document.createElement('strong');
  name.textContent = themeDocument.name;
  const coverage = document.createElement('span');
  coverage.className = 'custom-theme-preview-mode';
  coverage.textContent = themeDocument.darkColors
    ? webCustomThemeText('custom_theme.light_and_dark', 'Light and dark palettes')
    : webCustomThemeText('custom_theme.light_only', 'Light palette only');
  head.append(name, coverage);
  const swatches = document.createElement('div');
  swatches.className = 'custom-theme-swatches';
  swatches.setAttribute('role', 'list');
  for (const key of ['canvas', 'paper', 'ink', 'muted', 'primary', 'accent', 'danger']) {
    const swatch = document.createElement('span');
    swatch.className = 'custom-theme-swatch';
    swatch.style.setProperty('--swatch', themeDocument.colors[key]);
    swatch.title = `${key}: ${themeDocument.colors[key]}`;
    swatch.setAttribute('aria-label', swatch.title);
    swatches.append(swatch);
  }
  preview.append(head, swatches);
}

function renderWebCustomThemeManager() {
  renderWebCustomThemePreview();
  if (els.webCustomThemeImportStatus) {
    const corrupt = webCustomThemeStoreState.status === 'corrupt'
      ? webCustomThemeText('custom_theme.storage_corrupt', 'Custom theme storage is corrupt. Reset it explicitly to continue.')
      : '';
    els.webCustomThemeImportStatus.textContent = webCustomThemeImportStatus || corrupt;
  }
  if (els.webCustomThemeResetButton) {
    els.webCustomThemeResetButton.hidden = webCustomThemeStoreState.status !== 'corrupt';
    els.webCustomThemeResetButton.textContent = webCustomThemeResetArmed
      ? webCustomThemeText('custom_theme.confirm_reset', 'Confirm reset')
      : webCustomThemeText('custom_theme.reset_storage', 'Reset custom theme storage');
  }
}

function appendWebCustomThemeCards(activeTheme) {
  for (const record of webCustomThemeStoreState.themes) {
    const selected = record.id === activeTheme;
    const shell = document.createElement('div');
    shell.className = `custom-theme-card-shell${selected ? ' selected' : ''}`;
    shell.dataset.customThemeId = record.id;

    const select = document.createElement('button');
    select.className = 'custom-theme-card-select';
    select.type = 'button';
    select.dataset.theme = record.id;
    select.setAttribute('role', 'radio');
    select.setAttribute('aria-checked', String(selected));
    select.setAttribute('aria-label', `${record.document.name}: ${webCustomThemeText('custom_theme.user_installed', 'User-installed')}`);
    const copy = document.createElement('span');
    copy.className = 'custom-theme-card-copy';
    const name = document.createElement('strong');
    name.textContent = record.document.name;
    const meta = document.createElement('small');
    meta.textContent = webCustomThemeText('custom_theme.user_installed', 'User-installed');
    copy.append(name, meta);
    select.append(buildWebThemePreview(record.document.colors), copy);

    const actions = document.createElement('span');
    actions.className = 'custom-theme-card-actions';
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.dataset.customThemeExport = record.id;
    exportButton.textContent = webCustomThemeText('custom_theme.export_theme', 'Export');
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger-action';
    deleteButton.dataset.customThemeDelete = record.id;
    deleteButton.textContent = webCustomThemeDeleteArmedId === record.id
      ? webCustomThemeText('custom_theme.confirm_delete', 'Confirm delete')
      : webCustomThemeText('custom_theme.delete_theme', 'Delete');
    actions.append(exportButton, deleteButton);
    shell.append(select, actions);
    els.settingsThemeGrid.append(shell);
  }
}

async function refreshWebCustomThemeStore({ render = true } = {}) {
  const previousStatus = webCustomThemeStoreState.status;
  webCustomThemeStoreState = await readCustomThemeStore(browserApi.storage.local);
  if (webCustomThemeStoreState.status === 'corrupt') {
    webCustomThemeImportStatus = '';
    webCustomThemePreviewState = null;
  } else if (previousStatus === 'corrupt') {
    webCustomThemeImportStatus = '';
    webCustomThemeResetArmed = false;
  } else if (!webCustomThemeStoreState.ok) {
    webCustomThemeImportStatus = `${webCustomThemeText('custom_theme.storage_unavailable', 'Custom themes are unavailable.')} ${webCustomThemeStoreState.error?.message || ''}`.trim();
  }
  if (render) renderAppearanceSettings();
  return webCustomThemeStoreState;
}

async function previewWebCustomThemeImport(inputText = els.webCustomThemeImportTextarea?.value || '') {
  webCustomThemePreviewState = null;
  const inputBytes = webCustomThemeInputBytes(inputText);
  if (inputBytes > CUSTOM_THEME_MAX_INPUT_BYTES) {
    webCustomThemePreviewState = { valid: false, inputBytes, errors: [{ code: 'input-too-large', path: '$', message: webCustomThemeText('custom_theme.input_too_large', 'Theme input is too large.') }] };
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.input_too_large', 'Theme input is too large.');
    renderWebCustomThemeManager();
    return webCustomThemePreviewState;
  }
  let candidate;
  try {
    candidate = JSON.parse(inputText);
  } catch (error) {
    webCustomThemePreviewState = { valid: false, inputBytes, errors: [{ code: 'invalid-json', path: '$', message: error?.message || 'Invalid JSON' }] };
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.validation_errors', 'Theme has validation errors.');
    renderWebCustomThemeManager();
    return webCustomThemePreviewState;
  }
  const result = validateThemeDocument(candidate);
  webCustomThemePreviewState = { ...result, inputBytes };
  webCustomThemeImportStatus = result.valid
    ? webCustomThemeText('custom_theme.valid', 'Theme is valid. Install it to add it to your themes.')
    : result.errors.some((error) => error.code === 'contrast')
      ? webCustomThemeText('custom_theme.contrast_failed', 'Theme failed contrast requirements.')
    : webCustomThemeText('custom_theme.validation_errors', 'Theme has validation errors.');
  renderWebCustomThemeManager();
  return webCustomThemePreviewState;
}

async function installPreviewedWebCustomTheme() {
  if (!webCustomThemePreviewState?.valid) {
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.validation_errors', 'Theme has validation errors.');
    renderWebCustomThemeManager();
    return;
  }
  els.webCustomThemeInstallButton?.setAttribute('aria-busy', 'true');
  let result;
  try {
    result = await installCustomTheme(browserApi.storage.local, webCustomThemePreviewState.document, { inputBytes: webCustomThemePreviewState.inputBytes });
  } finally {
    els.webCustomThemeInstallButton?.setAttribute('aria-busy', 'false');
  }
  if (!result.ok) {
    webCustomThemeImportStatus = result.error?.code === 'theme-limit-reached'
      ? webCustomThemeText('custom_theme.limit_reached', 'Theme limit reached.')
      : `${webCustomThemeText('custom_theme.save_failed', 'Theme could not be saved.')} ${result.error?.message || ''}`.trim();
    renderWebCustomThemeManager();
    return;
  }
  webCustomThemeStoreState = { ok: true, status: 'ready', themes: result.store.themes };
  webCustomThemeImportStatus = webCustomThemeText('custom_theme.installed', 'Theme installed.');
  els.settingsTheme.value = result.record.id;
  renderAppearanceSettings();
  await applyAndPersistAppearance();
}

function webCustomThemeExportFilename(name) {
  const safe = String(name || 'hermes-theme').normalize('NFKD').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return `${safe || 'hermes-theme'}.json`;
}

function exportWebCustomTheme(id) {
  const record = webCustomThemeStoreState.themes.find((candidate) => candidate.id === id);
  if (!record) return;
  const blob = new Blob([serializeThemeDocument(record.document)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = webCustomThemeExportFilename(record.document.name);
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

async function fallbackWebDeletedThemeSelections(id, { allCustom = false } = {}) {
  const stored = await browserApi.storage.local.get('hermesBrowserSettings');
  const fresh = stored.hermesBrowserSettings || {};
  const shouldFallback = (value) => allCustom ? String(value || '').startsWith('custom:') : value === id;
  const panelFallback = shouldFallback(fresh.appearanceTheme);
  const webFallback = shouldFallback(fresh.webAppearanceTheme);
  if (!panelFallback && !webFallback) return fresh;
  const hermesBrowserSettings = {
    ...fresh,
    ...(panelFallback ? { appearanceTheme: 'nous' } : {}),
    ...(webFallback ? { webAppearanceTheme: 'nous' } : {}),
  };
  await browserApi.storage.local.set({ hermesBrowserSettings });
  return hermesBrowserSettings;
}

async function deleteWebCustomTheme(id) {
  const record = webCustomThemeStoreState.themes.find((candidate) => candidate.id === id);
  if (!record) return;
  if (webCustomThemeDeleteArmedId !== id) {
    webCustomThemeDeleteArmedId = id;
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.confirm_delete', 'Click Confirm delete to remove this theme.');
    renderAppearanceSettings();
    return;
  }
  webCustomThemeDeleteArmedId = '';
  try {
    const saved = await fallbackWebDeletedThemeSelections(id);
    const result = await deleteCustomTheme(browserApi.storage.local, id);
    if (!result.ok) throw new Error(result.error?.message || 'Could not delete custom theme');
    webCustomThemeStoreState = { ok: true, status: result.store.themes.length ? 'ready' : 'empty', themes: result.store.themes };
    settings = { ...settings, ...saved, webAppearanceTheme: normalizedWebThemeId(saved.webAppearanceTheme) };
    els.settingsTheme.value = settings.webAppearanceTheme || 'nous';
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.deleted', 'Theme deleted.');
    applyAppearance();
    renderAppearanceSettings();
  } catch (error) {
    webCustomThemeImportStatus = `${webCustomThemeText('custom_theme.delete_failed', 'Theme could not be deleted.')} ${error?.message || ''}`.trim();
    renderWebCustomThemeManager();
  }
}

async function resetWebCustomThemeStore() {
  if (webCustomThemeStoreState.status !== 'corrupt') return;
  if (!webCustomThemeResetArmed) {
    webCustomThemeResetArmed = true;
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.confirm_reset', 'Click Confirm reset to clear corrupt custom theme storage.');
    renderWebCustomThemeManager();
    return;
  }
  webCustomThemeResetArmed = false;
  try {
    const saved = await fallbackWebDeletedThemeSelections('', { allCustom: true });
    const result = await resetCustomThemeStore(browserApi.storage.local);
    if (!result.ok) throw new Error(result.error?.message || 'Could not reset custom theme storage');
    webCustomThemeStoreState = { ok: true, status: 'empty', themes: [] };
    settings = { ...settings, ...saved, webAppearanceTheme: normalizedWebThemeId(saved.webAppearanceTheme) };
    els.settingsTheme.value = settings.webAppearanceTheme || 'nous';
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.reset_complete', 'Custom theme storage reset.');
    applyAppearance();
    renderAppearanceSettings();
  } catch (error) {
    webCustomThemeImportStatus = `${webCustomThemeText('custom_theme.reset_failed', 'Custom theme storage could not be reset.')} ${error?.message || ''}`.trim();
    renderWebCustomThemeManager();
  }
}

async function handleWebCustomThemeFileSelection() {
  const file = els.webCustomThemeFileInput?.files?.[0];
  if (!file) return;
  if (file.size > CUSTOM_THEME_MAX_INPUT_BYTES) {
    webCustomThemePreviewState = { valid: false, inputBytes: file.size, errors: [{ code: 'input-too-large', path: '$', message: webCustomThemeText('custom_theme.input_too_large', 'Theme input is too large.') }] };
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.input_too_large', 'Theme input is too large.');
    renderWebCustomThemeManager();
    return;
  }
  const isJsonFile = file.type === 'application/json' || String(file.name || '').toLowerCase().endsWith('.json');
  if (!isJsonFile) {
    webCustomThemePreviewState = { valid: false, inputBytes: file.size, errors: [{ code: 'invalid-file-type', path: '$', message: webCustomThemeText('custom_theme.invalid_file_type', 'Choose a JSON theme file.') }] };
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.invalid_file_type', 'Choose a JSON theme file.');
    renderWebCustomThemeManager();
    return;
  }
  try {
    const text = await file.text();
    if (els.webCustomThemeImportTextarea) els.webCustomThemeImportTextarea.value = text;
    await previewWebCustomThemeImport(text);
  } catch (error) {
    webCustomThemePreviewState = { valid: false, inputBytes: file.size, errors: [{ code: 'file-read-failed', path: '$', message: error?.message || 'Theme file could not be read' }] };
    webCustomThemeImportStatus = webCustomThemeText('custom_theme.file_read_failed', 'Theme file could not be read.');
    renderWebCustomThemeManager();
  }
}

async function handleWebCustomThemeStoreChange() {
  const previous = settings.webAppearanceTheme;
  await refreshWebCustomThemeStore({ render: false });
  const stored = await browserApi.storage.local.get('hermesBrowserSettings');
  const requested = stored.hermesBrowserSettings?.webAppearanceTheme ?? previous;
  const next = normalizedWebThemeId(requested);
  if (String(previous || '').startsWith('custom:') && next === 'nous' && previous !== 'nous') {
    webAppearanceSaveStatus = webCustomThemeText('custom_theme.active_unavailable', 'Active theme is unavailable. Using Nous.');
  }
  settings = { ...settings, webAppearanceTheme: next };
  if (els.settingsTheme) els.settingsTheme.value = next;
  applyAppearance();
  renderAppearanceSettings();
}

function applyAppearance() {
  const mode = normalizeColorMode(settings.webColorMode || 'light');
  const resolved = resolveColorMode(mode, globalThis.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  for (const property of appliedWebCustomThemeVariables) root.style.removeProperty(property);
  appliedWebCustomThemeVariables = [];
  const selection = customThemeSelection(settings.webAppearanceTheme, webCustomThemeStoreState.themes);
  const theme = selection.kind === 'custom' ? selection.id : normalizeAppearanceTheme(settings.webAppearanceTheme || 'nous');
  if (selection.kind === 'custom') {
    const variables = themeCssVariables(customThemePaletteForMode(selection.document, resolved));
    for (const [property, value] of Object.entries(variables)) root.style.setProperty(property, value);
    appliedWebCustomThemeVariables = Object.keys(variables);
  }
  root.dataset.hermesMode = resolved;
  root.dataset.hermesColorMode = mode;
  root.dataset.hermesTheme = theme;
  root.style.colorScheme = selection.kind === 'custom' && resolved === 'dark' && !selection.document.darkColors ? 'light' : resolved;
  applyAppearancePreferences(root, webAppearancePreferences());
}

function renderAppearanceSettings() {
  if (els.settingsLanguageSelect) {
    populateLanguageSelect(els.settingsLanguageSelect);
    els.settingsLanguageSelect.value = getLocale();
  }
  const mode = normalizeColorMode(settings.webColorMode || 'light');
  const theme = normalizedWebThemeId(settings.webAppearanceTheme || 'nous');
  const preferences = webAppearancePreferences();
  els.settingsColorMode.value = mode;
  els.settingsTheme.value = theme;
  for (const button of els.settingsColorModeButtons) {
    const selected = button.dataset.colorMode === mode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  }
  for (const button of els.settingsTextZoomPresetGrid?.querySelectorAll('[data-web-text-zoom-percent]') || []) {
    const selected = Number(button.dataset.webTextZoomPercent) === preferences.textZoomPercent;
    const percentLabel = t('appearance.percent_value', { percent: button.dataset.webTextZoomPercent });
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
    button.setAttribute('aria-label', selected ? t('appearance.current_selection', { value: percentLabel }) : percentLabel);
  }
  if (els.settingsTextZoomInput) {
    els.settingsTextZoomInput.value = String(preferences.textZoomPercent);
    els.settingsTextZoomInput.setAttribute('aria-valuetext', t('appearance.percent_value', { percent: preferences.textZoomPercent }));
  }
  if (els.settingsFontProfileSelect) els.settingsFontProfileSelect.value = preferences.fontProfile;
  if (els.settingsCustomFontFamilyField) els.settingsCustomFontFamilyField.hidden = preferences.fontProfile !== 'custom-local';
  if (els.settingsCustomFontFamilyInput && document.activeElement !== els.settingsCustomFontFamilyInput) {
    els.settingsCustomFontFamilyInput.value = preferences.customFontFamily;
  }
  if (els.settingsAppearanceSaveStatus) els.settingsAppearanceSaveStatus.textContent = webAppearanceSaveStatus;
  renderWebCustomThemeManager();
  els.settingsThemeGrid.replaceChildren();
  for (const item of APPEARANCE_THEMES) {
    const selected = item.value === theme;
    const button = document.createElement('button');
    button.className = `theme-card${selected ? ' selected' : ''}`;
    button.type = 'button';
    button.dataset.theme = item.value;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(selected));
    button.setAttribute('aria-label', `${item.name}: ${item.description}`);
    const p = item.preview;
    button.style.cssText = `--preview-bg:${p.bg};--preview-panel:${p.panel};--preview-text:${p.text};--preview-muted:${p.muted};--preview-accent:${p.accent};`;
    const preview = document.createElement('span');
    preview.className = 'theme-preview';
    preview.setAttribute('aria-hidden', 'true');
    preview.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    const copy = document.createElement('span');
    copy.className = 'theme-card-copy';
    const name = document.createElement('strong');
    name.textContent = item.name;
    copy.append(name);
    const check = document.createElement('span');
    check.className = 'theme-check';
    check.textContent = selected ? '✓' : '';
    button.append(preview, copy, check);
    els.settingsThemeGrid.append(button);
  }
  appendWebCustomThemeCards(theme);
}

async function persistWebAppearanceSettings(preferences) {
  const write = async () => {
    const stored = await browserApi.storage.local.get('hermesBrowserSettings');
    const freshSettings = stored?.hermesBrowserSettings && typeof stored.hermesBrowserSettings === 'object'
      ? stored.hermesBrowserSettings
      : {};
    const hermesBrowserSettings = {
      ...withAppearancePreferenceUpdate(freshSettings, 'web', preferences),
      webColorMode: normalizeColorMode(preferences.colorMode),
      webAppearanceTheme: normalizedWebThemeId(preferences.appearanceTheme),
      appearanceSchemaVersion: 2,
    };
    await browserApi.storage.local.set({ hermesBrowserSettings });
    return hermesBrowserSettings;
  };
  const pending = webAppearanceWriteQueue.then(write, write);
  webAppearanceWriteQueue = pending.catch(() => {});
  return pending;
}

async function applyAndPersistAppearance(patch = {}) {
  const mutationId = ++webAppearanceMutationId;
  const previousSettings = settings;

  const previousPreferences = webAppearancePreferences();
  const nextPreferences = {
    ...previousPreferences,
    ...patch,
    textZoomPercent: normalizeTextZoomPercent(patch.textZoomPercent ?? previousPreferences.textZoomPercent),
    customFontFamily: sanitizeLocalFontFamily(patch.customFontFamily ?? previousPreferences.customFontFamily),
  };
  settings = {
    ...withAppearancePreferenceUpdate(settings, 'web', nextPreferences),
    webColorMode: normalizeColorMode(els.settingsColorMode.value || settings.webColorMode || 'light'),
    webAppearanceTheme: normalizedWebThemeId(els.settingsTheme.value || settings.webAppearanceTheme || 'nous'),
    appearanceSchemaVersion: 2,
  };
  const snapshot = {
    ...webAppearancePreferences(),
    colorMode: settings.webColorMode,
    appearanceTheme: settings.webAppearanceTheme,
  };
  webAppearanceSaveStatus = t('appearance.saving');
  applyAppearance();
  renderAppearanceSettings();
  try {
    const savedSettings = await persistWebAppearanceSettings(snapshot);
    if (mutationId !== webAppearanceMutationId) return;
    settings = savedSettings;
    webAppearanceSaveStatus = t('appearance.saved');
    applyAppearance();
    renderAppearanceSettings();
  } catch (error) {
    if (mutationId !== webAppearanceMutationId) return;
    settings = {
      ...withAppearancePreferenceUpdate(previousSettings, 'web', previousPreferences),
      webColorMode: previousSettings.webColorMode,
      webAppearanceTheme: previousSettings.webAppearanceTheme,
    };
    webAppearanceSaveStatus = `${t('appearance.change_not_saved')} ${error?.message || String(error)}`;
    applyAppearance();
    renderAppearanceSettings();
  }
}

function openSettings() {
  els.settingsColorMode.value = settings.webColorMode || 'light';
  els.settingsTheme.value = settings.webAppearanceTheme || 'nous';
  if (els.inlineAssistEnabled) els.inlineAssistEnabled.checked = settings.inlineAssistEnabled !== false;
  if (els.inlineAssistDefaultRoute) els.inlineAssistDefaultRoute.value = normalizeInlineDraftRoutePreference(settings.inlineAssistDefaultRoute);
  renderInlineAssistModelOptions();
  if (els.inlineAssistSessionRetention) els.inlineAssistSessionRetention.value = settings.inlineAssistSessionRetention === 'delete' ? 'delete' : 'keep';
  if (els.contextMenuDefaultRoute) els.contextMenuDefaultRoute.value = settings.contextMenuDefaultRoute || 'ask';
  els.settingsProfile.value = settings.activeProfile || '';
  els.settingsGatewayUrl.value = settings.gatewayUrl || '';
  els.settingsApiKey.value = '';
  renderBrowserContextConsentControl();
  renderAppearanceSettings();
  els.settingsDialog.showModal();
}

async function saveSettings() {
  await webAppearanceWriteQueue;
  const assistModelId = els.inlineAssistModel?.value || settings.inlineAssistModel || '';
  const assistBinding = resolveAssistModelBindingFromCatalog({
    settings: { ...settings, inlineAssistModel: assistModelId },
    models: availableModels,
  }) || {
    inlineAssistModel: String(settings.inlineAssistModel || ''),
    inlineAssistRawModel: String(settings.inlineAssistRawModel || ''),
    inlineAssistProvider: String(settings.inlineAssistProvider || ''),
  };
  let nextSettings = migrateConnectionSettings({
    ...settings,
    webColorMode: normalizeColorMode(els.settingsColorMode.value),
    webAppearanceTheme: normalizedWebThemeId(els.settingsTheme.value),
    inlineAssistEnabled: els.inlineAssistEnabled ? els.inlineAssistEnabled.checked : settings.inlineAssistEnabled !== false,
    inlineAssistDefaultRoute: normalizeInlineDraftRoutePreference(els.inlineAssistDefaultRoute?.value || settings.inlineAssistDefaultRoute),
    ...assistBinding,
    inlineAssistSessionRetention: els.inlineAssistSessionRetention ? (els.inlineAssistSessionRetention.value === 'delete' ? 'delete' : 'keep') : (settings.inlineAssistSessionRetention === 'delete' ? 'delete' : 'keep'),
    inlineAssistThinkingEnabled: settings.inlineAssistThinkingEnabled !== false,
    inlineAssistReasoningEffort: normalizeModelRuntimeOptions({ reasoningEffort: settings.inlineAssistReasoningEffort || 'low' }).reasoningEffort,
    inlineAssistFastMode: settings.inlineAssistFastMode !== false,
    contextMenuDefaultRoute: els.contextMenuDefaultRoute ? (['current', 'new', 'background'].includes(els.contextMenuDefaultRoute.value) ? els.contextMenuDefaultRoute.value : 'ask') : (settings.contextMenuDefaultRoute || 'ask'),
    activeProfile: els.settingsProfile.value.trim() || settings.activeProfile,
    gatewayUrl: els.settingsGatewayUrl.value.trim() || settings.gatewayUrl,
    ...(els['settingsApi' + 'Key'].value ? { apiKey: els['settingsApi' + 'Key'].value } : {}),
  });
  await refreshContextConsentPrincipal({ settingsOverride: nextSettings });
  const consentIdentity = currentContextConsentIdentity(nextSettings);
  if (consentIdentity && els.browserContextConsentInput && !els.browserContextConsentInput.disabled) {
    const ledger = await persistContextConsentDecision({
      storageArea: browserApi.storage.local,
      identity: consentIdentity,
      granted: els.browserContextConsentInput.checked,
    });
    nextSettings = { ...nextSettings, browserContextConsentLedger: ledger };
  }
  settings = withAppearancePreferenceUpdate(nextSettings, 'web', webAppearancePreferences());
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  applyAppearance();
  renderConnectionTruth({ status: 'idle' });
  els.settingsDialog.close();
  await loadApp();
}

function formatBytes(value = 0) {
  const bytes = Number(value || 0);
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function readFile(file, method) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read attachment.'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader[method](file);
  });
}

function renderAttachments() {
  els.attachmentList.replaceChildren();
  els.attachmentList.hidden = attachments.length === 0;
  for (const attachment of attachments) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const label = document.createElement('span');
    label.textContent = `${attachment.kind === 'image' ? 'IMAGE' : 'FILE'} · ${attachment.name} · ${formatBytes(attachment.size)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.addEventListener('click', () => {
      attachments = attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
    });
    chip.append(label, remove);
    els.attachmentList.append(chip);
  }
  renderContextWindow();
}

async function attachFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    const image = String(file.type || '').startsWith('image/');
    const text = image ? '' : await readFile(file, 'readAsText').catch(() => '');
    const dataUrl = image ? await readFile(file, 'readAsDataURL') : '';
    attachments.push({ id: `${Date.now()}:${Math.random()}`, kind: image ? 'image' : 'file', name: file.name || 'attachment', size: file.size, type: file.type, text: text.slice(0, 120_000), dataUrl });
  }
  renderAttachments();
  els.prompt.focus();
}

function toggleAttachMenu(force) {
  const visible = typeof force === 'boolean' ? force : els.attachMenu.hidden;
  els.attachMenu.hidden = !visible;
  els.attachButton.setAttribute('aria-expanded', String(visible));
}

async function pasteImageAttachment() {
  if (!navigator.clipboard?.read) throw new Error('This browser does not allow image paste from the clipboard.');
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((candidate) => candidate.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const extension = type.split('/')[1] || 'png';
    await attachFiles([new File([blob], `pasted-image.${extension}`, { type })]);
    return;
  }
  throw new Error('No image was found in the clipboard.');
}

function filesFromPasteEvent(event) {
  const data = event?.clipboardData;
  if (!data) return [];
  const files = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (file) files.push(file);
  }
  for (const file of Array.from(data.files || [])) {
    if (!files.some((candidate) => candidate.name === file.name && candidate.size === file.size && candidate.type === file.type)) files.push(file);
  }
  return files;
}

async function handleComposerPaste(event) {
  const files = filesFromPasteEvent(event);
  if (!files.length) return false;
  event.preventDefault();
  await attachFiles(files);
  els.composerStatus.textContent = `${files.length} pasted attachment${files.length === 1 ? '' : 's'} ready`;
  return true;
}

function dragEventHasFiles(event) {
  return Array.from(event?.dataTransfer?.types || []).includes('Files');
}

function setComposerDropActive(active) {
  els.composer.classList.toggle('drop-active', Boolean(active));
  els.composerDropOverlay.hidden = !active;
}

async function handleComposerDrop(event) {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  dragDepth = 0;
  setComposerDropActive(false);
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  await attachFiles(files);
  els.composerStatus.textContent = `${files.length} dropped attachment${files.length === 1 ? '' : 's'} ready`;
}

function addUrlAttachment() {
  const url = globalThis.prompt('Paste a URL to attach to this prompt:');
  if (!url?.trim()) return;
  attachments.push({ id: `${Date.now()}:${Math.random()}`, kind: 'url', name: 'URL context', size: 0, type: 'text/uri-list', text: url.trim(), dataUrl: '' });
  renderAttachments();
  els.prompt.focus();
}

function insertPromptSnippet() {
  const snippet = 'Summarize the attached context and call out the important takeaways.';
  els.prompt.value = [els.prompt.value.trim(), snippet].filter(Boolean).join(els.prompt.value.trim() ? '\n\n' : '');
  els.prompt.focus();
  updateBusyControls();
}

async function handleAttachAction(action) {
  toggleAttachMenu(false);
  if (action === 'files') els.attachmentInput.click();
  else if (action === 'images') els.imageAttachmentInput.click();
  else if (action === 'paste-image') await pasteImageAttachment();
  else if (action === 'url') addUrlAttachment();
  else if (action === 'snippet') insertPromptSnippet();
}

function attachmentPrompt() {
  if (!attachments.length) return '';
  return `\n\n[ATTACHMENTS]\n${attachments.map((item, index) => item.kind === 'image'
    ? `Image ${index + 1}: ${item.name}\nInline image data: ${item.dataUrl}`
    : `File ${index + 1}: ${item.name}\n${item.text || '[binary file metadata only]'}`).join('\n\n')}\n[/ATTACHMENTS]`;
}

function voicePagePath() {
  return fullTabEntryPathForPage(globalThis.location.href).replace(/app\.html$/, 'voice-dictation.html');
}

async function openVoiceDictation() {
  await browserApi.tabs.create({ url: browserApi.runtime.getURL(voicePagePath()), active: true });
  els.composerStatus.textContent = translateUiText('Voice tab opened');
}

async function consumeVoiceDraft(draft) {
  const transcript = String(draft?.transcript || draft?.text || draft?.payload?.transcript || '').trim();
  if (!transcript) return false;
  els.prompt.value = [els.prompt.value.trim(), transcript].filter(Boolean).join(' ');
  await browserApi.storage.local.remove(VOICE_DRAFT_STORAGE_KEY);
  els.composerStatus.textContent = translateUiText('Voice transcript ready');
  updateBusyControls();
  els.prompt.focus();
  return true;
}

async function consumePendingVoiceDraft() {
  const stored = await browserApi.storage.local.get([VOICE_DRAFT_STORAGE_KEY]);
  return consumeVoiceDraft(stored?.[VOICE_DRAFT_STORAGE_KEY]);
}

function renderWakeState(state = {}) {
  if (!els.wakeButton) return;
  const active = Boolean(state.enabled) && !['off', 'unavailable'].includes(String(state.state || ''));
  els.wakeButton.setAttribute('aria-pressed', String(active));
  els.wakeButton.classList.toggle('active', active);
  els.wakeButton.title = state.detail || translateUiText(active ? 'Hey Hermes is listening' : 'Enable Hey Hermes');
}

async function toggleWakeWord() {
  const desired = !normalizeWakeWordSettings(settings).enabled;
  settings = { ...settings, wakeWordEnabled: desired };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  try {
    let state = await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.setEnabled, enabled: desired, settings });
    if (desired && state?.mode === 'browser-local') {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in Hermes Web.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream?.getTracks?.() || []) track.stop();
      state = await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.setEnabled, enabled: true, settings });
    }
    renderWakeState(state || { enabled: desired, state: desired ? 'arming' : 'off' });
  } catch (error) {
    if (desired) {
      settings = { ...settings, wakeWordEnabled: false };
      await browserApi.storage.local.set({ hermesBrowserSettings: settings });
      await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.setEnabled, enabled: false, settings }).catch(() => null);
      renderWakeState({ enabled: false, state: 'off', detail: 'Wake word is off.' });
    }
    throw error;
  }
}

async function consumeWakeTurn(turn = null) {
  if (!wakeTurnIsFresh(turn)) {
    await browserApi.storage.local.remove(WAKE_STORAGE_KEYS.turn);
    return false;
  }
  if (!turn?.id || wakeTurnProcessingId === turn.id) return false;
  wakeTurnProcessingId = turn.id;
  const claim = await browserApi.runtime.sendMessage({
    type: WAKE_MESSAGES.claimTurn,
    turnId: turn.id,
    surface: SURFACE_KINDS.FULL_TAB,
  }).catch(() => null);
  if (claim?.claimed === false) {
    wakeTurnProcessingId = '';
    return false;
  }
  if (!claim) await browserApi.storage.local.remove(WAKE_STORAGE_KEYS.turn);
  let reply = '';
  try {
    const text = String(turn.text || '').trim();
    await sendPrompt(text);
    reply = String([...activeMessages].reverse().find((message) => message?.role === 'assistant')?.content || '').trim();
    return true;
  } finally {
    await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.turnReply, turnId: turn.id, text: reply }).catch(() => null);
    if (wakeTurnProcessingId === turn.id) wakeTurnProcessingId = '';
  }
}

async function consumePendingWakeTurn() {
  const stored = await browserApi.storage.local.get(WAKE_STORAGE_KEYS.turn);
  return consumeWakeTurn(stored?.[WAKE_STORAGE_KEYS.turn]);
}

function updateBusyControls() {
  renderWebRunControlRecovery();
  const hasDraft = Boolean(els.prompt.value.trim() || attachments.length);
  els.queueDraft.hidden = !(sending && hasDraft);
  els.steerDraft.hidden = !(sending && hasDraft && activeRunId);
}

function queueCurrentDraft() {
  const text = els.prompt.value.trim();
  if (!text && !attachments.length) return;
  queuedTurn = { text, attachments: [...attachments] };
  els.prompt.value = '';
  attachments = [];
  renderAttachments();
  els.composerStatus.textContent = translateUiText('Message queued');
  updateBusyControls();
}

async function sendWebSteerText(text) {
  const steerText = String(text || '').trim();
  if (!steerText) return false;
  if (!sending) throw new Error('Hermes is not currently running. Send or queue the message instead.');
  if (usesDashboardTicketTransport()) {
    const connection = await ensureDashboardConnection();
    const sessionId = String(dashboardLiveSessionId || '').trim()
      || (await resumeDashboardRecoverySession(connection)).liveId;
    if (!sessionId) throw new Error('The active Dashboard session is not available yet.');
    await connection.client.request(WS_METHODS.sessionSteer, { session_id: sessionId, text: steerText });
    return true;
  }
  if (!gatewayCapabilities.runSteer) {
    throw new Error('Connected Hermes runtime does not advertise active-run steering yet. Queue the draft instead, or update Hermes Gateway when /v1/runs/{run_id}/steer is available.');
  }
  if (!activeRunId) throw new Error('The active run id is not available yet. Wait for Hermes to start streaming, then steer again.');
  const response = await client.fetch(`/v1/runs/${encodeURIComponent(activeRunId)}/steer`, {
    method: 'POST',
    body: JSON.stringify({ input: steerText, message: steerText, text: steerText }),
  });
  const payload = await client.readJson(response);
  if (!response.ok) {
    const failure = runSteerFailureState({ status: response.status, payload });
    if (failure.staleRun) {
      activeRunId = '';
      updateBusyControls();
    }
    throw new Error(failure.detail);
  }
  return true;
}

async function steerCurrentDraft() {
  const text = els.prompt.value.trim();
  if (!text) return false;
  try {
    await sendWebSteerText(text);
    els.prompt.value = '';
    els.composerStatus.textContent = translateUiText('Steer sent');
    updateBusyControls();
    return true;
  } catch (error) {
    els.composerStatus.textContent = `Steer failed: ${error?.message || String(error)}`;
    updateBusyControls();
    return false;
  }
}

async function reconcileWebRunTerminal({ stopRequested = false, dashboardSessionId = '', expectedGeneration = runControlGeneration } = {}) {
  const reconciliationRunId = String(activeRunId || '');
  let dashboardStatusClient = dashboardConnection?.client || null;
  let dashboardStatusSessionId = String(dashboardSessionId || dashboardLiveSessionId || '').trim();
  if (!usesDashboardTicketTransport() && !gatewayCapabilities.runStatus) {
    throw new Error('Connected Hermes runtime does not explicitly advertise run status reconciliation.');
  }
  const readStatus = usesDashboardTicketTransport()
    ? async () => {
      const connection = await ensureDashboardConnection();
      if (!dashboardStatusSessionId || dashboardStatusClient !== connection.client) {
        const identity = await resumeDashboardRecoverySession(connection);
        dashboardStatusClient = connection.client;
        dashboardStatusSessionId = identity.liveId;
      }
      return runControlRequestWithTimeout(
        () => connection.client.request(WS_METHODS.sessionStatus, { session_id: dashboardStatusSessionId }),
        { timeoutMs: RUN_CONTROL_REQUEST_TIMEOUT_MS },
      );
    }
    : async () => {
      if (!reconciliationRunId) throw new Error('The active run id is unavailable for terminal reconciliation.');
      const response = await runControlRequestWithTimeout(
        (signal) => client.fetch(`/v1/runs/${encodeURIComponent(reconciliationRunId)}`, { method: 'GET', signal }),
        { timeoutMs: RUN_CONTROL_REQUEST_TIMEOUT_MS },
      );
      const payload = await client.readJson(response);
      if (!response.ok) {
        const staleTerminal = runStopFailureTerminalStatus({ httpStatus: response.status, payload });
        if (staleTerminal) return { status: staleTerminal };
        throw new Error(payload?.error?.message || payload?.error || payload?.message || `Hermes run status failed (${response.status})`);
      }
      return payload;
    };
  const terminalStatus = usesDashboardTicketTransport()
    ? (payload) => dashboardTerminalStatus(payload, { stopRequested })
    : restTerminalStatus;
  const result = await waitForTerminalStatus({
    readStatus,
    terminalStatus,
    timeoutMs: RUN_TERMINAL_CONFIRM_TIMEOUT_MS,
    pollMs: RUN_STATUS_POLL_MS,
  });
  if (!runControlGenerationMatches(expectedGeneration, runControlGeneration)) return { ...result, stale: true };
  activeRunControl = markRunTerminal(activeRunControl, result.status);
  return result;
}

function renderWebRunControlRecovery() {
  if (!els.webRunControlRecovery) return;
  const unconfirmed = activeRunControl?.phase === RUN_CONTROL_PHASES.UNCONFIRMED;
  els.webRunControlRecovery.hidden = !unconfirmed;
  if (!unconfirmed) return;
  els.webRunControlRecoveryDetail.textContent = activeRunControl?.detail
    ? `Hermes has not confirmed a terminal run state. ${activeRunControl.detail}`
    : 'Hermes has not confirmed a terminal run state. Retry status before starting another turn.';
  els.webRetryRunStatusButton.disabled = false;
  els.webDiscardHeldQueueButton.disabled = !queuedTurn;
}

async function retryWebRunTerminalStatus() {
  if (activeRunControl?.phase !== RUN_CONTROL_PHASES.UNCONFIRMED) return false;
  const expectedGeneration = runControlGeneration;
  els.webRetryRunStatusButton.disabled = true;
  try {
    await reconcileWebRunTerminal({
      stopRequested: activeRunControl.controlStatus === 'accepted',
      expectedGeneration,
    });
    if (!runControlGenerationMatches(expectedGeneration, runControlGeneration)) return false;
    if (activeRunControl?.phase === RUN_CONTROL_PHASES.TERMINAL) {
      els.composerStatus.textContent = translateUiText('Runtime state confirmed');
      await settleWebRunTerminal();
      return true;
    }
  } catch (error) {
    els.composerStatus.textContent = `Runtime state unconfirmed: Status retry failed. The writer and queued turns remain held: ${error?.message || String(error)}`;
  } finally {
    renderWebRunControlRecovery();
  }
  return false;
}

function discardWebHeldQueuedTurn() {
  queuedTurn = null;
  updateBusyControls();
  renderWebRunControlRecovery();
  els.composerStatus.textContent = translateUiText('Queued message deleted');
}

async function settleWebRunTerminal() {
  if (activeRunControl?.phase !== RUN_CONTROL_PHASES.TERMINAL || activeRunControl.writerLease !== 'released') return false;
  const settledRunControl = activeRunControl;
  activeAbortController?.abort();
  activeAbortController = null;
  activeRunId = '';
  clearLiveRun();
  setSending(false);
  renderMessages(activeMessages);
  if (!shouldAutoFlushQueuedTurn(queuedTurn, settledRunControl)) return true;
  const next = queuedTurn;
  queuedTurn = null;
  attachments = next.attachments || [];
  await sendPrompt(next.text || 'Please review the attached files.');
  return true;
}

async function stopActiveRun() {
  if (!sending) {
    els.composerStatus.textContent = translateUiText('Hermes is not currently running');
    return false;
  }
  if (!activeRunControl) {
    activeRunControl = beginRunControl({ runId: activeRunId, transport: usesDashboardTicketTransport() ? 'dashboard-ws' : 'rest' });
  }
  activeRunControl = requestRunStop(activeRunControl);
  const stopGeneration = runControlGeneration;
  const stopRunId = String(activeRunId || '');
  els.composerStatus.textContent = translateUiText('Stopping Hermes…');
  let dashboardSessionId = '';
  try {
    if (usesDashboardTicketTransport()) {
      const connection = await ensureDashboardConnection();
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
      dashboardSessionId = String(dashboardLiveSessionId || '').trim();
      if (!dashboardSessionId) {
        dashboardSessionId = (await resumeDashboardRecoverySession(connection)).liveId;
      }
      if (!dashboardSessionId) throw new Error('The active Dashboard session is not available yet.');
      await runControlRequestWithTimeout(
        () => connection.client.request(WS_METHODS.sessionInterrupt, { session_id: dashboardSessionId }),
        { timeoutMs: RUN_CONTROL_REQUEST_TIMEOUT_MS },
      );
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
    } else {
      if (!stopRunId) {
        activeAbortController?.abort();
        activeRunControl = markRunTerminal(activeRunControl, 'cancelled');
        els.composerStatus.textContent = translateUiText('Hermes stopped before server run identity');
        return true;
      }
      if (!gatewayCapabilities.runStop || !gatewayCapabilities.runStatus) {
        throw new Error('Connected Hermes runtime does not explicitly advertise both run Stop and run status.');
      }
      const response = await runControlRequestWithTimeout(
        (signal) => client.fetch(`/v1/runs/${encodeURIComponent(stopRunId)}/stop`, { method: 'POST', signal }),
        { timeoutMs: RUN_CONTROL_REQUEST_TIMEOUT_MS },
      );
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
      const payload = await client.readJson(response);
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
      if (!response.ok) {
        const staleTerminal = runStopFailureTerminalStatus({ httpStatus: response.status, payload });
        if (staleTerminal) {
          activeRunControl = markRunTerminal(activeRunControl, staleTerminal);
          els.composerStatus.textContent = translateUiText('Hermes stopped · writer released');
          await settleWebRunTerminal();
          return true;
        }
        throw new Error(payload?.error?.message || payload?.error || payload?.message || `Hermes stop failed (${response.status})`);
      }
    }
    if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
    activeRunControl = acknowledgeStopRequest(activeRunControl, { status: 'stopping' });
  } catch (error) {
    if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
    activeRunControl = markStopRequestFailed(activeRunControl, error?.message || String(error));
    els.composerStatus.textContent = `Runtime stop unconfirmed: Hermes did not acknowledge Stop. Browser kept the run identity and queued turns remain held: ${error?.message || String(error)}`;
    return false;
  }

  els.composerStatus.textContent = translateUiText('Stop accepted · waiting for terminal state');
  try {
    await reconcileWebRunTerminal({ stopRequested: true, dashboardSessionId, expectedGeneration: stopGeneration });
    if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
  } catch (error) {
    if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
    activeRunControl = markTerminalTimeout(activeRunControl, error?.message || 'Runtime terminal confirmation timed out.');
    els.composerStatus.textContent = `Runtime stop unconfirmed: Hermes accepted Stop, but terminal confirmation timed out. Browser kept the run identity and queued turns remain held: ${error?.message || String(error)}`;
    return false;
  }
  els.composerStatus.textContent = translateUiText('Hermes stopped · writer released');
  await settleWebRunTerminal();
  return true;
}

function renderToolEvent(event) {
  captureTaskToolEvent(event).catch((error) => console.warn('[Hermes Web] Task event persistence failed:', error));
  const activity = normalizeToolActivity(event);
  if (shouldPreserveImageGenerationRun(liveRun, activity)) return;
  els.toolActivityList.querySelector('.activity-empty')?.remove();
  const row = document.createElement('article');
  row.className = `tool-event ${activity.status || 'progress'}`;
  const type = document.createElement('small');
  const name = document.createElement('strong');
  const detail = document.createElement('p');
  type.textContent = activity.category;
  name.textContent = activity.label;
  detail.textContent = activity.preview || activity.status || 'Running';
  row.append(type, name, detail);
  els.toolActivityList.prepend(row);
  const imageGeneration = Boolean(activity.aspectRatio);
  liveRun = {
    phase: imageGeneration ? 'IMAGE GENERATION' : 'TOOL ACTIVITY',
    title: imageGeneration ? 'Hermes is generating an image' : activity.label,
    detail: activity.preview || activity.rawName,
    image: imageGeneration,
    aspectRatio: activity.aspectRatio,
    seed: activity.activityId || activeRunId || Date.now(),
  };
  renderMessages(activeMessages);
  setInspectorTab('activity');
}

function setSending(value) {
  sending = Boolean(value);
  els.send.disabled = sending;
  els.stopRun.hidden = !sending;
  if (sending) els.composerStatus.textContent = translateUiText('Hermes is working…');
  else if (els.composerStatus.textContent === translateUiText('Hermes is working…')) els.composerStatus.textContent = '';
  updateBusyControls();
}

function toggleSessionActionsMenu(force) {
  if (!activeSessionId) return;
  const visible = typeof force === 'boolean' ? force : els.sessionActionsMenu.hidden;
  els.sessionActionsMenu.hidden = !visible;
  els.copySessionId.setAttribute('aria-expanded', String(visible));
}

async function renameHermesWebSessionTitle(sessionId, title) {
  const cleanSessionId = String(sessionId || '').trim();
  const cleanTitle = String(title || '').trim();
  if (!cleanSessionId || !cleanTitle) return false;
  const response = await client.fetch(`/api/sessions/${encodeURIComponent(cleanSessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: cleanTitle }),
  });
  const payload = await client.readJson(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session rename failed (${response.status}).`);
  const updated = normalizeHermesSessions({ data: [payload.session || payload] })[0]
    || { id: cleanSessionId, title: cleanTitle, source: sessions.find((session) => session.id === cleanSessionId)?.source || 'hermes_web' };
  sessions = normalizeHermesSessions({ data: [updated, ...sessions.filter((session) => session.id !== cleanSessionId)] });
  if (cleanSessionId === activeSessionId) {
    settings = { ...settings, webSessionTitle: updated.title || cleanTitle };
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    els.sessionTitle.textContent = settings.webSessionTitle;
  }
  renderSessions(els.sessionSearch.value);
  els.composerStatus.textContent = translateUiText('Session renamed and synced');
  return true;
}

function promptRenameHermesWebSession(session = {}) {
  const currentTitle = sessionTitle(session);
  const nextTitle = window.prompt('Rename session', currentTitle);
  if (nextTitle == null) return;
  const cleanTitle = String(nextTitle).trim();
  if (!cleanTitle || cleanTitle === currentTitle) return;
  renameHermesWebSessionTitle(session.id, cleanTitle).catch((error) => {
    els.composerStatus.textContent = `Could not rename session: ${error?.message || String(error)}`;
  });
}

async function beginHermesWebDraft({ focus = true, keepLoading = false } = {}) {
  if (!canSwitchActiveSession({ sending, runControl: activeRunControl })) {
    els.composerStatus.textContent = translateUiText('Stop the active run before switching sessions.');
    return false;
  }
  webSessionLoadRequestId += 1;
  dismissWebSessionOwnershipNotice();
  clearLiveRun();
  activeSessionId = '';
  activeMessages = [];
  renderTaskStack();
  attachments = [];
  settings = { ...settings, webSessionId: '', webSessionTitle: 'New Hermes Web chat' };
  const persistDraft = browserApi.storage.local.set({ hermesBrowserSettings: settings });
  els.sessionTitle.textContent = settings.webSessionTitle;
  els.composerSessionLabel.textContent = translateUiText('Draft · saved when sent');
  els.errorState.hidden = true;
  renderAttachments();
  renderMessages([]);
  if (!keepLoading) hideRuntimeLoadingState();
  else showRuntimeLoadingState();
  renderSessions(els.sessionSearch.value);
  renderConnectionTruth({ status: 'online' });
  if (focus) els.prompt.focus();
  await persistDraft;
}

async function createSession() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const id = `hermes-web-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const model = effectiveModel();
  const title = `Hermes Web · ${new Date().toLocaleString()}`;
  if (usesDashboardTicketTransport()) {
    const identity = await establishDashboardSession('');
    activeSessionId = identity.storedId;
    renderTaskStack();
    settings = { ...settings, webSessionId: activeSessionId, webSessionTitle: title };
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    activeMessages = [];
    renderMessages([]);
    renderSessions();
    els.sessionTitle.textContent = title;
    els.composerSessionLabel.textContent = activeSessionId;
    return activeSessionId;
  }
  const response = await client.fetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id,
      title,
      source: HERMES_WEB_SESSION_SOURCE,
      model: model.model,
      provider: model.provider || undefined,
      model_options: modelOptionsPayload(),
      require_model_lock: shouldRequireModelLock({
        provider: model.provider,
        model: model.model,
        defaultModel: 'hermes-agent',
        gatewayDefault: model.gatewayDefault === true,
      }),
    }),
  });
  const payload = await client.readJson(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Session creation failed (${response.status}).`);
  const session = payload.session || payload;
  activeSessionId = session.id || id;
  renderTaskStack();
  settings = { ...settings, webSessionId: activeSessionId, webSessionTitle: session.title || title };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  activeMessages = [];
  renderMessages([]);
  renderSessions();
  els.sessionTitle.textContent = settings.webSessionTitle;
  els.composerSessionLabel.textContent = activeSessionId;
  return activeSessionId;
}

async function compactActiveSessionContext({ automaticRecovery = false } = {}) {
  if (!activeSessionId) return { ok: false, reason: 'no-session' };
  if (!gatewayCapabilities.sessionCompress) return { ok: false, reason: 'route-unavailable' };
  try {
    const response = await client.fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/compress`, {
      method: 'POST',
      body: JSON.stringify({ source: automaticRecovery ? 'hermes_web_recovery' : 'hermes_web' }),
    });
    const payload = await client.readJson(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || payload?.message || `Context compaction failed (${response.status})`);
    const compactedSessionId = String(payload?.rotated_session_id || payload?.session_id || '').trim();
    if (compactedSessionId && compactedSessionId !== activeSessionId) {
      activeSessionId = compactedSessionId;
      settings = { ...settings, webSessionId: activeSessionId };
      await browserApi.storage.local.set({ hermesBrowserSettings: settings });
      els.composerSessionLabel.textContent = activeSessionId;
      renderTaskStack();
    }
    if (payload?.runtime && typeof payload.runtime === 'object') latestRuntime = payload.runtime;
    renderContextWindow();
    return { ok: true, sessionId: activeSessionId, payload };
  } catch (error) {
    return { ok: false, reason: 'request-failed', error };
  }
}

function activeWebSessionForSend() {
  const sessionId = String(activeSessionId || '').trim();
  if (!sessionId) return null;
  return sessions.find((session) => String(session.id || '') === sessionId) || { id: sessionId, source: '' };
}

function dismissWebSessionOwnershipNotice() {
  pendingForeignTurn = null;
  if (els.webSessionOwnershipNotice) els.webSessionOwnershipNotice.hidden = true;
}

function showWebSessionOwnershipNotice(session = {}, text = '', turnAttachments = []) {
  if (!els.webSessionOwnershipNotice) return;
  const notice = sessionOwnershipNotice({
    session,
    expectedSource: SESSION_SURFACE_SOURCES.FULL_TAB,
  });
  pendingForeignTurn = {
    sessionId: String(session.id || ''),
    userText: String(text || ''),
    attachments: [...turnAttachments],
    fromComposer: String(text || '').trim() === els.prompt.value.trim(),
  };
  els.webSessionOwnershipTitle.textContent = notice.title;
  els.webSessionOwnershipDetail.textContent = notice.detail;
  const newButton = els.webSessionOwnershipNotice.querySelector('[data-web-session-ownership-action="new-web"]');
  const continueButton = els.webSessionOwnershipNotice.querySelector('[data-web-session-ownership-action="continue"]');
  if (newButton) newButton.textContent = notice.newChatLabel;
  if (continueButton) continueButton.textContent = notice.continueLabel;
  els.webSessionOwnershipNotice.hidden = false;
  newButton?.focus();
}

function guardForeignSessionSend(text, turnAttachments) {
  const session = activeWebSessionForSend();
  if (!requiresSessionOwnershipConfirmation({
    session,
    expectedSource: SESSION_SURFACE_SOURCES.FULL_TAB,
    approvedSessionIds: approvedForeignSessionIds,
  })) {
    dismissWebSessionOwnershipNotice();
    return true;
  }
  showWebSessionOwnershipNotice(session, text, turnAttachments);
  return false;
}

async function handleWebSessionOwnershipDecision(event) {
  const button = event.target.closest('[data-web-session-ownership-action]');
  if (!button) return;
  const session = activeWebSessionForSend();
  const pendingTurn = pendingForeignTurn;
  if (!session || !pendingTurn || String(session.id) !== pendingTurn.sessionId) {
    dismissWebSessionOwnershipNotice();
    return;
  }
  const buttons = Array.from(els.webSessionOwnershipNotice.querySelectorAll('button'));
  for (const actionButton of buttons) actionButton.disabled = true;
  try {
    if (button.dataset.webSessionOwnershipAction === 'continue') {
      approvedForeignSessionIds.add(session.id);
    } else {
      await beginHermesWebDraft({ focus: false });
    }
    attachments = [...pendingTurn.attachments];
    renderAttachments();
    dismissWebSessionOwnershipNotice();
    await sendPrompt(pendingTurn.userText);
  } finally {
    for (const actionButton of buttons) actionButton.disabled = false;
  }
}

async function sendPrompt(text) {
  if (sending || !canSwitchActiveSession({ sending, runControl: activeRunControl })) {
    els.composer.dataset.submitState = 'busy';
    return false;
  }
  if (!guardForeignSessionSend(text, [...attachments])) {
    els.composer.dataset.submitState = 'ownership-blocked';
    return false;
  }
  els.composer.dataset.submitState = 'accepted';
  els.prompt.value = '';
  renderContextWindow();
  const turnRunControlGeneration = ++runControlGeneration;
  activeRunControl = beginRunControl({
    runId: usesDashboardTicketTransport() ? String(dashboardLiveSessionId || '') : '',
    transport: usesDashboardTicketTransport() ? 'dashboard-ws' : 'rest',
  });
  try {
    if (!activeSessionId) await createSession();
  } catch (error) {
    activeRunControl = markRunTerminal(activeRunControl, 'failed');
    await settleWebRunTerminal();
    throw error;
  }
  setSending(true);
  const turnAttachments = [...attachments];
  const browserCommand = parseBrowserCommand(text);
  const helperCommand = browserCommand?.kind === 'helper'
    ? resolveCommandPrompt(browserCommand.command.name, browserCommand.userInput, {
      activeTab: null,
      tabs: [],
      pageContext: {},
    })
    : null;
  const commandText = helperCommand?.prompt || text;
  const skillSelection = extractSelectedWebSkills(commandText, availableSkills);
  const requestText = skillSelection.message || (skillSelection.selectedSkills.length ? 'Use the selected Hermes skill guidance for this request.' : commandText);
  const prompt = `${requestText}${attachmentPrompt()}`;
  attachments = [];
  renderAttachments();
  const user = { role: 'user', content: text, attachments: turnAttachments };
  const assistant = { role: 'assistant', content: '' };
  activeMessages = [...activeMessages, user];
  liveRun = { phase: 'THINKING', title: 'Hermes is thinking', detail: 'Preparing a response', image: false, seed: Date.now() };
  renderMessages(activeMessages);
  activeAbortController = new AbortController();
  const model = effectiveModel();
  let contextRecoveryHandled = false;
  let streamTerminalStatus = '';
  let dashboardTurnSessionId = '';
  try {
    if (usesDashboardTicketTransport()) {
      const streamedAnswer = await streamDashboardPrompt(prompt, {
        signal: activeAbortController.signal,
        onDelta: (content) => {
          assistant.content = content;
          if (isRenderableAssistantMessage(assistant) && !activeMessages.includes(assistant)) activeMessages = [...activeMessages, assistant];
          clearLiveRun();
          renderMessages(activeMessages);
        },
        onTool: renderToolEvent,
        onRun: (runId) => {
          dashboardTurnSessionId = String(runId || '');
          activeRunId = String(runId || '');
          activeRunControl = withRunControlId(activeRunControl, activeRunId);
          updateBusyControls();
        },
      });
      if (sessionContextFailureRecovery(streamedAnswer, gatewayCapabilities)) {
        const contextError = new Error(streamedAnswer);
        contextError.requestAccepted = true;
        throw contextError;
      }
      const connection = await ensureDashboardConnection();
      const history = await connection.client.request(WS_METHODS.sessionHistory, { session_id: dashboardTurnSessionId }).catch(() => null);
      const refreshed = dashboardHistoryMessages(history);
      if (refreshed.length) {
        activeMessages = preserveUserImageAttachments(refreshed, activeMessages);
        renderMessages(activeMessages);
      }
      sessions = visibleHermesWebSessions(await listDashboardSessions().catch(() => []));
      renderSessions(els.sessionSearch.value);
      if (
        runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)
        && [RUN_CONTROL_PHASES.RUNNING, RUN_CONTROL_PHASES.STOPPING, RUN_CONTROL_PHASES.UNCONFIRMED].includes(activeRunControl?.phase)
      ) {
        activeRunControl = markRunTerminal(activeRunControl, 'completed');
      }
      return;
    }
    const response = await client.fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}/chat/stream`, {
      method: 'POST',
      signal: activeAbortController.signal,
      body: JSON.stringify({
        model: model.model,
        provider: model.provider || undefined,
        model_options: modelOptionsPayload(),
        require_model_lock: shouldRequireModelLock({
          provider: model.provider,
          model: model.model,
          defaultModel: 'hermes-agent',
          gatewayDefault: model.gatewayDefault === true,
        }),
        message: prompt,
        selected_skills: skillSelection.selectedSkills,
      }),
    });
    if (!response.ok || !response.body) throw hermesRequestError({
      status: response.status,
      body: await response.text(),
      operation: 'Hermes stream',
    });
    const streamedAnswer = await readHermesSse(response, {
      signal: activeAbortController.signal,
      onAssistant: (content) => {
        if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
        assistant.content = content;
        if (isRenderableAssistantMessage(assistant)) {
          if (!activeMessages.includes(assistant)) activeMessages = [...activeMessages, assistant];
          const imageSources = resolvedGeneratedImageSources(content);
          if (liveRun?.image) {
            if (imageSources.length && !liveRun.revealPromise) {
              liveRun.revealSources = imageSources;
              liveRun.revealPending = true;
              renderMessages(activeMessages);
              beginFinalImageReveal(imageSources);
            }
            return;
          }
          clearLiveRun();
        }
        renderMessages(activeMessages);
      },
      onTool: (tool) => {
        if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
        renderToolEvent(tool);
      },
      onRun: (runId) => {
        if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
        activeRunId = String(runId || '');
        activeRunControl = withRunControlId(activeRunControl, activeRunId);
        if (liveRun) liveRun.seed = activeRunId || liveRun.seed;
        updateBusyControls();
      },
      onRuntime: (runtime) => {
        if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
        captureDelegationRuntimePayload(runtime);
        const actual = runtime?.runtime || runtime;
        const status = String(actual?.status || runtime?.status || '').trim().toLowerCase();
        if (['completed', 'failed', 'cancelled'].includes(status)) streamTerminalStatus = status;
        latestRuntime = actual || {};
        if (actual?.model) els.modelLabel.textContent = actual.model;
        activeRunId = String(actual?.run_id || actual?.runId || activeRunId || '');
        activeRunControl = withRunControlId(activeRunControl, activeRunId);
        updateBusyControls();
        renderContextWindow();
      },
    });
    if (sessionContextFailureRecovery(streamedAnswer, gatewayCapabilities)) {
      const contextError = new Error(streamedAnswer);
      contextError.requestAccepted = true;
      throw contextError;
    }
    const refreshed = await client.getSessionMessages(activeSessionId).catch(() => null);
    if (refreshed?.length) {
      activeMessages = preserveUserImageAttachments(refreshed, activeMessages);
      if (!liveRun?.revealPending) renderMessages(activeMessages);
    }
    const listedSessions = normalizeHermesSessions(await client.listSessions({ limit: 200, maxPages: 5 }).catch(() => []));
    sessions = visibleHermesWebSessions(await migrateOwnedHermesWebSessionSources(listedSessions));
    renderSessions(els.sessionSearch.value);
    if (
      runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)
      && [RUN_CONTROL_PHASES.RUNNING, RUN_CONTROL_PHASES.STOPPING, RUN_CONTROL_PHASES.UNCONFIRMED].includes(activeRunControl?.phase)
    ) {
      activeRunControl = markRunTerminal(activeRunControl, streamTerminalStatus || 'completed');
    }
  } catch (error) {
    const requestFailure = turnRequestFailureState(error);
    if (requestFailure?.gatewayStatus === 'connected') {
      activeMessages = activeMessages.filter((message) => message !== assistant);
      if (!els.prompt.value.trim()) els.prompt.value = text;
      attachments = [...turnAttachments];
      renderAttachments();
      activeMessages = [...activeMessages, {
        role: 'system',
        content: `${requestFailure.title}: ${requestFailure.detail} Gateway remains connected; adjust the model option and resend the preserved draft.`,
      }];
      els.composerStatus.textContent = `${requestFailure.title}: ${requestFailure.detail}`;
      renderConnectionTruth({ status: 'online' });
      renderMessages(activeMessages);
      return false;
    }
    const contextRecovery = sessionContextFailureRecovery(error, gatewayCapabilities);
    if (!contextRecovery) throw error;
    contextRecoveryHandled = true;
    activeMessages = activeMessages.filter((message) => message !== assistant);
    if (!els.prompt.value.trim()) els.prompt.value = text;
    attachments = [...turnAttachments];
    renderAttachments();
    const compactResult = contextRecovery.action === 'compact'
      ? await compactActiveSessionContext({ automaticRecovery: true })
      : { ok: false, reason: 'new-session-required' };
    const replayDetail = contextRecovery.retryTurn
      ? 'Hermes may retry the accepted turn.'
      : 'Browser did not replay the accepted turn, preventing a duplicate message.';
    const recoveryDetail = compactResult.ok
      ? 'Hermes compacted the session and Browser adopted the acknowledged successor when provided.'
      : 'This runtime could not recover the session automatically. Start a new session, then resend the preserved draft.';
    activeMessages = [...activeMessages, { role: 'system', content: `Session context reached its compression ceiling. ${recoveryDetail} ${replayDetail}` }];
    els.composerStatus.textContent = translateUiText(compactResult.ok ? 'Context recovered · draft preserved' : 'New session required · draft preserved');
  } finally {
    if (liveRun?.revealPromise) await liveRun.revealPromise;
    if (turnRunControlGeneration === runControlGeneration) {
      activeRunControl = markRunStreamClosed(activeRunControl);
      if ([RUN_CONTROL_PHASES.RUNNING, RUN_CONTROL_PHASES.UNCONFIRMED].includes(activeRunControl?.phase)) {
        if (!activeRunId && !dashboardLiveSessionId) {
          if (activeRunControl.phase === RUN_CONTROL_PHASES.RUNNING) activeRunControl = markRunTerminal(activeRunControl, 'failed');
        } else if (usesDashboardTicketTransport() || gatewayCapabilities.runStatus) {
          try {
            await reconcileWebRunTerminal({ stopRequested: false, expectedGeneration: turnRunControlGeneration });
          } catch (error) {
            if (runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) {
              activeRunControl = markTerminalTimeout(activeRunControl, error?.message || 'Runtime terminal confirmation timed out.');
              els.composerStatus.textContent = `Runtime state unconfirmed: The Browser stream closed before a terminal runtime state. Retry status from the recovery controls; the run identity and queued turns remain held: ${error?.message || String(error)}`;
            }
          }
        } else {
          activeRunControl = markTerminalTimeout(activeRunControl, 'Connected Hermes runtime does not advertise terminal run status.');
          els.composerStatus.textContent = 'Runtime state unconfirmed: This runtime does not advertise run status. Update Hermes Agent or reconnect to a compatible runtime before starting another turn.';
        }
      }
      if (contextRecoveryHandled && queuedTurn) queuedTurn = { ...queuedTurn, autoSend: false };
      if (activeRunControl?.phase === RUN_CONTROL_PHASES.TERMINAL && activeRunControl.writerLease === 'released') {
        await settleWebRunTerminal();
      } else {
        updateBusyControls();
        renderMessages(activeMessages);
      }
    }
  }
}

function showError(title, detail, { translateTitle = true, translateDetail = true } = {}) {
  els.loadingState.hidden = true;
  els.errorState.hidden = false;
  els.errorTitle.textContent = translateTitle ? translateUiText(title) : String(title || '');
  els.errorDetail.textContent = translateDetail ? translateUiText(detail) : String(detail || '');
}

async function commitFullTabSessionMessages(messages = [], { sessionId, requestId = null } = {}) {
  if (requestId != null && requestId !== webSessionLoadRequestId) return false;
  if (String(activeSessionId || '').trim() !== String(sessionId || '').trim()) return false;
  const preserved = preserveUserImageAttachments(messages, activeMessages);
  renderMessages(preserved);
  if (requestId != null && requestId !== webSessionLoadRequestId) return false;
  if (String(activeSessionId || '').trim() !== String(sessionId || '').trim()) return false;
  return true;
}

async function openSession(sessionId, { keepLoading = false } = {}) {
  if (!canSwitchActiveSession({ sending, runControl: activeRunControl })) {
    els.composerStatus.textContent = translateUiText('Stop the active run before switching sessions.');
    return false;
  }
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) return;
  dismissWebSessionOwnershipNotice();
  const requestId = ++webSessionLoadRequestId;
  activeSessionId = cleanSessionId;
  renderTaskStack();
  const session = sessions.find((row) => row.id === cleanSessionId) || { id: cleanSessionId, title: settings.webSessionTitle };
  showSessionLoadingState(session);
  latestRuntime = runtimeTelemetryForSession(session);
  settings = { ...settings, webSessionId: cleanSessionId, webSessionTitle: sessionTitle(session) };
  els.sessionTitle.textContent = sessionTitle(session);
  els.composerSessionLabel.textContent = cleanSessionId;
  renderSessions(els.sessionSearch.value);
  renderContextWindow();
  renderConnectionTruth({ status: 'online' });
  try {
    const messages = usesDashboardTicketTransport()
      ? await loadDashboardSessionMessages(cleanSessionId, { isCurrent: () => requestId === webSessionLoadRequestId })
      : await client.getSessionMessages(cleanSessionId);
    if (requestId !== webSessionLoadRequestId) return;
    const durableSessionId = String(activeSessionId || cleanSessionId).trim();
    settings = { ...settings, webSessionId: durableSessionId, webSessionTitle: sessionTitle(session) };
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    if (requestId !== webSessionLoadRequestId) return;
    await activateCurrentDelegationSession();
    await commitFullTabSessionMessages(messages, { sessionId: durableSessionId, requestId });
    if (!keepLoading) hideRuntimeLoadingState();
  } catch (error) {
    if (requestId !== webSessionLoadRequestId) return;
    showError('Could not load this session', error?.message || String(error), { translateDetail: false });
  }
}

async function loadApp() {
  webSessionLoadRequestId += 1;
  sessionHistoryLoading = true;
  showRuntimeLoadingState();
  renderSessions();
  await refreshWebCustomThemeStore({ render: false });
  const stored = await browserApi.storage.local.get(['hermesBrowserSettings', CONTEXT_CONSENT_STORAGE_KEY, TASK_STACKS_STORAGE_KEY, DELEGATION_WATCH_STORAGE_KEY]);
  taskStackStore = stored[TASK_STACKS_STORAGE_KEY] && typeof stored[TASK_STACKS_STORAGE_KEY] === 'object'
    ? stored[TASK_STACKS_STORAGE_KEY]
    : {};
  settings = {
    ...migrateConnectionSettings(stored.hermesBrowserSettings || {}),
    inlineAssistEnabled: stored.hermesBrowserSettings?.inlineAssistEnabled !== false,
    inlineAssistDefaultRoute: normalizeInlineDraftRoutePreference(stored.hermesBrowserSettings?.inlineAssistDefaultRoute),
    inlineAssistModel: String(stored.hermesBrowserSettings?.inlineAssistModel || ''),
    inlineAssistRawModel: String(stored.hermesBrowserSettings?.inlineAssistRawModel || ''),
    inlineAssistProvider: String(stored.hermesBrowserSettings?.inlineAssistProvider || ''),
    inlineAssistSessionRetention: stored.hermesBrowserSettings?.inlineAssistSessionRetention === 'delete' ? 'delete' : 'keep',
    inlineAssistThinkingEnabled: stored.hermesBrowserSettings?.inlineAssistThinkingEnabled !== false,
    inlineAssistReasoningEffort: normalizeModelRuntimeOptions({ reasoningEffort: stored.hermesBrowserSettings?.inlineAssistReasoningEffort || 'low' }).reasoningEffort,
    inlineAssistFastMode: Boolean(stored.hermesBrowserSettings?.inlineAssistFastMode),
    contextMenuDefaultRoute: ['current', 'new', 'background'].includes(stored.hermesBrowserSettings?.contextMenuDefaultRoute) ? stored.hermesBrowserSettings.contextMenuDefaultRoute : 'ask',
    webAppearanceTheme: normalizedWebThemeId(stored.hermesBrowserSettings?.webAppearanceTheme || 'nous'),
    browserContextConsentLedger: normalizeContextConsentLedger(stored[CONTEXT_CONSENT_STORAGE_KEY] || stored.hermesBrowserSettings?.browserContextConsentLedger),
  };
  await refreshContextConsentPrincipal({ settingsOverride: settings });
  await ensureContextMenuEditor();
  applyAppearance();
  renderAppearanceSettings();
  applySessionVisibility();
  activeSessionId = handoff.newChat ? '' : (activeSessionId || settings.webSessionId || '');
  await hydrateDelegationWatches(stored[DELEGATION_WATCH_STORAGE_KEY] || []);
  renderTaskStack();
  const mode = normalizeConnectionMode(settings.connectionMode);
  renderConnectionTruth({ status: 'idle' });
  els.handoffDetail.textContent = handoff.sourceSurfaceId
    ? handoff.sourceTabId
      ? t('fulltab.handoff.opened_from_tab', { source: handoff.sourceSurfaceId, tabId: handoff.sourceTabId })
      : t('fulltab.handoff.opened_from', { source: handoff.sourceSurfaceId })
    : translateUiText('Opened directly in full view.');
  els.returnToPageButton.hidden = !handoff.sourceTabId;

  if (!settings.gatewayUrl) {
    showError('Connection not configured', 'Open the side panel, configure a Hermes connection, then open full view again.');
    return;
  }
  if (mode === 'cloud' || settings.connectionTransport === 'remote-dashboard' || settings.gatewayMode === 'remote-dashboard') {
    try {
      const connection = await ensureDashboardConnection();
      renderConnectionTruth({ status: 'online' });
      const metadataPromise = Promise.all([
        connection.client.request(WS_METHODS.modelOptions, {}).then((modelOptions) => {
          const discoveredModels = modelRowsFromGatewayOptions(modelOptions || {});
          if (!discoveredModels.length) return;
          availableModels = normalizeHermesModels(discoveredModels, settings.model);
          renderModelPicker();
          renderConnectionTruth({ status: 'online' });
        }).catch(() => null),
        listDashboardSessions().then((rows) => {
          sessions = visibleHermesWebSessions(rows);
          sessionHistoryLoading = false;
          renderSessions();
        }),
      ]);
      const initialSessionId = handoff.newChat ? '' : activeSessionId;
      const activeSessionPromise = initialSessionId
        ? openSession(initialSessionId, { keepLoading: true })
        : Promise.resolve();
      if (handoff.newChat) await beginHermesWebDraft({ keepLoading: true });
      await Promise.all([metadataPromise, activeSessionPromise]);
      hideRuntimeLoadingState();
      if (!activeSessionId) els.emptyState.hidden = false;
    } catch (error) {
      renderConnectionTruth({ status: 'error' });
      showError('Hermes Cloud unavailable', error?.message || String(error), { translateDetail: false });
    }
    return;
  }
  if (!settings.apiKey) {
    showError('API token required', 'Open side-panel Settings and connect the Local or Remote API before loading canonical session history.');
    return;
  }

  try {
    const health = await client.fetch('/health', { method: 'GET', cache: 'no-store' });
    if (!health.ok) throw new Error(`Gateway health returned ${health.status}.`);
    renderConnectionTruth({ status: 'online' });
    const metadataPromise = Promise.all([
      loadGatewayCapabilities(),
      loadModels().catch((error) => { els.modelLabel.textContent = requestedModelLabel(); console.warn('[Hermes Web] model discovery:', error); }),
      loadSkills({ quiet: true }),
      client.listSessions({ limit: 200, maxPages: 5 }).then(async (rows) => {
        const listedSessions = normalizeHermesSessions(rows);
        sessions = visibleHermesWebSessions(await migrateOwnedHermesWebSessionSources(listedSessions));
        if (activeSessionId && !sessions.some((session) => session.id === activeSessionId) && !handoff.sessionId) activeSessionId = '';
        sessionHistoryLoading = false;
        renderSessions();
      }),
    ]);
    const initialSessionId = handoff.newChat ? '' : activeSessionId;
    const activeSessionPromise = initialSessionId
      ? openSession(initialSessionId, { keepLoading: true })
      : Promise.resolve();
    if (handoff.newChat) await beginHermesWebDraft({ keepLoading: true });
    await Promise.all([metadataPromise, activeSessionPromise]);
    hideRuntimeLoadingState();
    if (handoff.newChat) {
      renderMessages([]);
      return;
    }
    if (!activeSessionId) {
      els.emptyState.hidden = false;
    }
  } catch (error) {
    renderConnectionTruth({ status: 'error' });
    showError('Hermes gateway unavailable', error?.message || String(error), { translateDetail: false });
  }
}

function setInspectorTab(name) {
  for (const tab of document.querySelectorAll('[data-inspector-tab]')) {
    const selected = tab.dataset.inspectorTab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  for (const panel of document.querySelectorAll('[data-inspector-panel]')) {
    const selected = panel.dataset.inspectorPanel === name;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  }
}

function initializeResponsiveShell() {
  const inspectorStartsOpen = globalThis.innerWidth >= 1440;
  els.shell.classList.toggle('inspector-closed', !inspectorStartsOpen);
  els.inspectorToggle.setAttribute('aria-expanded', String(inspectorStartsOpen));
  setNavigationOpen(false);
}

function setNavigationOpen(open) {
  const drawerMode = globalThis.innerWidth <= 1023;
  const visible = drawerMode && Boolean(open);
  els.shell.classList.toggle('nav-open', visible);
  els.navToggle.setAttribute('aria-expanded', String(visible));
  els.sessionRail.inert = drawerMode && !visible;
  els.sessionRail.setAttribute('aria-hidden', String(drawerMode && !visible));
}

function updateScrim() {
  const visible = (globalThis.innerWidth <= 1023 && els.shell.classList.contains('nav-open'))
    || (globalThis.innerWidth <= 1439 && !els.shell.classList.contains('inspector-closed'));
  els.drawerScrim.hidden = !visible;
}

els.messageList?.addEventListener('copy', (event) => {
  writeAssistantClipboardEvent(event, {
    selection: globalThis.getSelection?.(),
    messagesRoot: els.messageList,
    document,
    assistantSelector: '.web-message.assistant',
  });
});
els.navToggle.addEventListener('click', () => {
  setNavigationOpen(!els.shell.classList.contains('nav-open'));
  updateScrim();
});
els.inspectorToggle.addEventListener('click', () => {
  const closed = els.shell.classList.toggle('inspector-closed');
  els.inspectorToggle.setAttribute('aria-expanded', String(!closed));
  updateScrim();
});
els.drawerScrim.addEventListener('click', () => {
  setNavigationOpen(false);
  if (globalThis.innerWidth <= 1439) els.shell.classList.add('inspector-closed');
  els.inspectorToggle.setAttribute('aria-expanded', 'false');
  updateScrim();
});
els.sessionSearch.addEventListener('input', () => renderSessions(els.sessionSearch.value));
els.railVisibilityToggle.addEventListener('click', () => persistSessionVisibility({ webSessionsVisible: settings.webSessionsVisible === false }));
els.webSessionOwnershipNotice?.addEventListener('click', handleWebSessionOwnershipDecision);
els.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.composer.dataset.submitState = 'received';
  try {
    const text = els.prompt.value.trim();
    if (!text && !attachments.length) {
      els.composer.dataset.submitState = 'empty';
      return;
    }
    const browserCommand = parseBrowserCommand(text);
    if (browserCommand?.kind === 'native') {
      els.prompt.value = '';
      await executeNativeBrowserCommand(browserCommand);
      renderContextWindow();
      return;
    }
    if (sending) {
      els.composer.dataset.submitState = 'queued';
      queueCurrentDraft();
      return;
    }
    await sendPrompt(text);
  } catch (error) {
    const completedAfterReconcile = activeRunControl?.phase === RUN_CONTROL_PHASES.TERMINAL
      && activeRunControl?.terminalStatus === 'completed';
    const cancelledAfterStop = activeRunControl?.phase === RUN_CONTROL_PHASES.TERMINAL
      && activeRunControl?.terminalStatus === 'cancelled';
    if (completedAfterReconcile || cancelledAfterStop) {
      els.composer.dataset.submitState = `terminal:${activeRunControl.terminalStatus}`;
      renderMessages(activeMessages);
      return;
    }
    els.composer.dataset.submitState = `error:${String(error?.message || error).slice(0, 180)}`;
    activeMessages = [...activeMessages, { role: 'system', content: `Send failed: ${error?.message || String(error)}` }];
    renderMessages(activeMessages);
  }
});
els.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});
els.prompt.addEventListener('input', () => {
  if (pendingForeignTurn?.fromComposer) dismissWebSessionOwnershipNotice();
  updateBusyControls();
  renderComposerSuggestions();
  renderContextWindow();
});
els.prompt.addEventListener('paste', (event) => {
  handleComposerPaste(event).catch((error) => { els.composerStatus.textContent = `Paste failed: ${error?.message || String(error)}`; });
});
['dragenter', 'dragover'].forEach((type) => {
  els.composer.addEventListener(type, (event) => {
    if (!dragEventHasFiles(event)) return;
    event.preventDefault();
    if (type === 'dragenter') dragDepth += 1;
    setComposerDropActive(true);
  });
});
els.composer.addEventListener('dragleave', (event) => {
  if (!dragEventHasFiles(event)) return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setComposerDropActive(false);
});
els.composer.addEventListener('drop', (event) => {
  handleComposerDrop(event).catch((error) => { els.composerStatus.textContent = `Drop failed: ${error?.message || String(error)}`; });
});
els.stopRun.addEventListener('click', () => stopActiveRun().catch((error) => { els.composerStatus.textContent = error?.message || String(error); }));
els.webRetryRunStatusButton?.addEventListener('click', () => { void retryWebRunTerminalStatus(); });
els.webDiscardHeldQueueButton?.addEventListener('click', discardWebHeldQueuedTurn);
els.attachButton.addEventListener('click', () => toggleAttachMenu());
els.quickAttach.addEventListener('click', () => toggleAttachMenu(true));
els.attachMenu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-attach]')?.dataset.attach;
  if (action) handleAttachAction(action).catch((error) => { els.composerStatus.textContent = error?.message || String(error); });
});
els.attachmentInput.addEventListener('change', () => attachFiles(els.attachmentInput.files).finally(() => { els.attachmentInput.value = ''; }));
els.imageAttachmentInput.addEventListener('change', () => attachFiles(els.imageAttachmentInput.files).finally(() => { els.imageAttachmentInput.value = ''; }));
els.voiceButton.addEventListener('click', () => openVoiceDictation().catch((error) => { els.composerStatus.textContent = error?.message || String(error); }));
els.wakeButton?.addEventListener('click', () => toggleWakeWord().catch((error) => { els.composerStatus.textContent = error?.message || String(error); }));
els.quickVoice.addEventListener('click', () => els.voiceButton.click());
els.quickModel.addEventListener('click', () => toggleModelPicker(true));
els.composerModelControl?.addEventListener('click', () => toggleModelPicker());
els.queueDraft.addEventListener('click', queueCurrentDraft);
els.steerDraft.addEventListener('click', () => steerCurrentDraft().catch((error) => { els.composerStatus.textContent = error?.message || String(error); }));
els.commandMenuButton.addEventListener('click', () => renderComposerSuggestions({ force: els.skillMenu.hidden }));
els.settingsButton.addEventListener('click', openSettings);
els.settingsLanguageSelect?.addEventListener('change', () => {
  setLocale(els.settingsLanguageSelect.value).catch((error) => {
    els.composerStatus.textContent = `Language change failed: ${error?.message || String(error)}`;
  });
});
els.taskStackToggle?.addEventListener('click', () => {
  taskStackExpanded = !taskStackExpanded;
  renderTaskStack();
});
els.closeSettings.addEventListener('click', () => els.settingsDialog.close());
els.settingsDialog.addEventListener('click', (event) => {
  if (event.target === els.settingsDialog) els.settingsDialog.close();
});
els.closeImageLightbox?.addEventListener('click', () => els.imageLightbox?.close());
els.zoomImageIn?.addEventListener('click', () => updateImageViewer({ type: 'zoom-in' }));
els.zoomImageOut?.addEventListener('click', () => updateImageViewer({ type: 'zoom-out' }));
els.resetImageZoom?.addEventListener('click', resetImageViewer);
els.imageLightbox?.addEventListener('close', resetImageViewer);
els.imageLightbox?.addEventListener('click', (event) => {
  if (event.target === els.imageLightbox) els.imageLightbox.close();
});
els.imageLightboxCanvas?.addEventListener('wheel', (event) => {
  event.preventDefault();
  updateImageViewer({ type: event.deltaY < 0 ? 'zoom-in' : 'zoom-out' });
}, { passive: false });
els.imageLightboxCanvas?.addEventListener('pointerdown', (event) => {
  if (imageViewerState.scale <= 1) return;
  imagePanGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    imageX: imageViewerState.x,
    imageY: imageViewerState.y,
  };
  els.imageLightboxCanvas.setPointerCapture?.(event.pointerId);
  els.imageLightboxCanvas.toggleAttribute('data-dragging', true);
});
els.imageLightboxCanvas?.addEventListener('pointermove', (event) => {
  if (!imagePanGesture || imagePanGesture.pointerId !== event.pointerId) return;
  updateImageViewer({
    type: 'pan',
    x: imagePanGesture.imageX + event.clientX - imagePanGesture.startX,
    y: imagePanGesture.imageY + event.clientY - imagePanGesture.startY,
  });
});
const endImagePan = (event) => {
  if (!imagePanGesture || (event?.pointerId != null && imagePanGesture.pointerId !== event.pointerId)) return;
  imagePanGesture = null;
  els.imageLightboxCanvas?.removeAttribute('data-dragging');
};
els.imageLightboxCanvas?.addEventListener('pointerup', endImagePan);
els.imageLightboxCanvas?.addEventListener('pointercancel', endImagePan);
for (const button of els.settingsColorModeButtons) {
  button.addEventListener('click', () => {
    els.settingsColorMode.value = button.dataset.colorMode;
    applyAndPersistAppearance();
  });
}
els.settingsTextZoomPresetGrid?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-web-text-zoom-percent]');
  if (!button) return;
  void applyAndPersistAppearance({ textZoomPercent: button.dataset.webTextZoomPercent });
});
els.settingsTextZoomInput?.addEventListener('change', () => {
  void applyAndPersistAppearance({ textZoomPercent: els.settingsTextZoomInput.value });
});
els.settingsTextZoomDecreaseButton?.addEventListener('click', () => {
  void applyAndPersistAppearance({ textZoomPercent: stepTextZoomPercent(webAppearancePreferences().textZoomPercent, 'down') });
});
els.settingsTextZoomIncreaseButton?.addEventListener('click', () => {
  void applyAndPersistAppearance({ textZoomPercent: stepTextZoomPercent(webAppearancePreferences().textZoomPercent, 'up') });
});
els.settingsFontProfileSelect?.addEventListener('change', () => {
  const fontProfile = els.settingsFontProfileSelect.value;
  const customFontFamily = sanitizeLocalFontFamily(els.settingsCustomFontFamilyInput?.value || webAppearancePreferences().customFontFamily);
  if (fontProfile === 'custom-local' && !customFontFamily) {
    webAppearanceMutationId += 1;
    webAppearanceSaveStatus = t('appearance.invalid_local_font_family');
    if (els.settingsCustomFontFamilyField) els.settingsCustomFontFamilyField.hidden = false;
    if (els.settingsAppearanceSaveStatus) els.settingsAppearanceSaveStatus.textContent = webAppearanceSaveStatus;
    els.settingsCustomFontFamilyInput?.focus();
    return;
  }
  void applyAndPersistAppearance({ fontProfile, customFontFamily });
});
els.settingsCustomFontFamilyInput?.addEventListener('change', () => {
  const customFontFamily = sanitizeLocalFontFamily(els.settingsCustomFontFamilyInput.value);
  if (!customFontFamily) {
    webAppearanceMutationId += 1;
    webAppearanceSaveStatus = t('appearance.invalid_local_font_family');
    if (els.settingsAppearanceSaveStatus) els.settingsAppearanceSaveStatus.textContent = webAppearanceSaveStatus;
    return;
  }
  void applyAndPersistAppearance({ fontProfile: 'custom-local', customFontFamily });
});
els.settingsThemeGrid.addEventListener('click', (event) => {
  const exportButton = event.target.closest('[data-custom-theme-export]');
  if (exportButton) {
    exportWebCustomTheme(exportButton.dataset.customThemeExport);
    return;
  }
  const deleteButton = event.target.closest('[data-custom-theme-delete]');
  if (deleteButton) {
    void deleteWebCustomTheme(deleteButton.dataset.customThemeDelete);
    return;
  }
  const card = event.target.closest('[data-theme]');
  if (!card) return;
  webCustomThemeDeleteArmedId = '';
  els.settingsTheme.value = card.dataset.theme;
  applyAndPersistAppearance();
});
els.webCustomThemeImportTextarea?.addEventListener('input', () => {
  webCustomThemePreviewState = null;
  webCustomThemeImportStatus = '';
  renderWebCustomThemeManager();
});
els.webCustomThemeFileInput?.addEventListener('change', () => void handleWebCustomThemeFileSelection());
els.webCustomThemePreviewButton?.addEventListener('click', () => void previewWebCustomThemeImport());
els.webCustomThemeInstallButton?.addEventListener('click', () => void installPreviewedWebCustomTheme());
els.webCustomThemeResetButton?.addEventListener('click', () => void resetWebCustomThemeStore());
els.webCustomThemeManager?.addEventListener('toggle', () => { if (els.webCustomThemeManager.open && !webMarketplaceLoaded) void loadWebMarketplace(); });
els.settingsMarketplaceThemeSearchInput?.addEventListener('input', () => { clearTimeout(webMarketplaceDebounceTimer); webMarketplaceRevision+=1; webMarketplaceLoading=true; webMarketplaceError=''; renderWebMarketplace(); webMarketplaceDebounceTimer=setTimeout(()=>void loadWebMarketplace(),300); });
els.settingsMarketplaceThemeSearchButton?.addEventListener('click', () => void loadWebMarketplace());
els.settingsMarketplaceThemeResults?.addEventListener('click', (event) => { const button=event.target.closest('[data-marketplace-install]'); if(button)void installWebMarketplaceTheme(button.dataset.marketplaceInstall); });
els.browserContextConsentInput?.addEventListener('change', () => {
  setBrowserContextConsent(els.browserContextConsentInput.checked).catch((error) => {
    renderBrowserContextConsentControl();
    els.composerStatus.textContent = `Context sharing unchanged: ${error?.message || String(error)}`;
  });
});
els.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveSettings().catch((error) => { els.composerStatus.textContent = `Settings failed: ${error?.message || String(error)}`; });
});
els.newChatButton.addEventListener('click', () => beginHermesWebDraft().catch((error) => showError('Could not start draft', error?.message || String(error), { translateDetail: false })));
els.modelPickerButton.addEventListener('click', () => {
  const nextOpen = els.modelPicker.hidden || modelSelectionTarget !== 'chat';
  if (!nextOpen) return toggleModelPicker(false);
  setModelSelectionTarget('chat');
  toggleModelPicker(true);
});
els.inlineAssistModelButton?.addEventListener('click', () => {
  const nextOpen = els.modelPicker.hidden || modelSelectionTarget !== 'assist';
  if (!nextOpen) return toggleModelPicker(false);
  setModelSelectionTarget('assist');
  toggleModelPicker(true);
});
els.closeModelPicker?.addEventListener('click', () => {
  const focusTarget = modelSelectionTarget === 'assist' ? els.inlineAssistModelButton : els.modelPickerButton;
  toggleModelPicker(false);
  focusTarget?.focus();
});
els.modelSearch.addEventListener('input', () => renderModelPicker(els.modelSearch.value));
els.modelOptionsList?.addEventListener('click', (event) => {
  const effort = event.target.closest('[data-runtime-effort]')?.dataset.runtimeEffort;
  const toggle = event.target.closest('[data-runtime-toggle]')?.dataset.runtimeToggle;
  if (modelSelectionTarget === 'assist') {
    const options = inlineAssistRuntimeOptions();
    if (effort) settings.inlineAssistReasoningEffort = normalizeModelRuntimeOptions({ ...options, reasoningEffort: effort }).reasoningEffort;
    if (toggle === 'thinking') settings.inlineAssistThinkingEnabled = !options.thinkingEnabled;
    if (toggle === 'fast') settings.inlineAssistFastMode = !options.fastMode;
    if (!effort && !toggle) return;
    browserApi.storage.local.set({ hermesBrowserSettings: settings });
    renderModelRuntimeOptions();
    return;
  }
  if (effort) {
    setModelRuntimeOptions({ reasoningEffort: effort }).catch((error) => { els.composerStatus.textContent = `Runtime option save failed: ${error?.message || String(error)}`; });
    return;
  }
  const options = activeModelRuntimeOptions();
  if (toggle === 'thinking') {
    setModelRuntimeOptions({ thinkingEnabled: !options.thinkingEnabled }).catch((error) => { els.composerStatus.textContent = `Runtime option save failed: ${error?.message || String(error)}`; });
  } else if (toggle === 'fast') {
    setModelRuntimeOptions({ fastMode: !options.fastMode }).catch((error) => { els.composerStatus.textContent = `Runtime option save failed: ${error?.message || String(error)}`; });
  }
});
els.refreshModels.addEventListener('click', () => refreshModelsFromPicker().catch((error) => { els.modelList.textContent = error?.message || String(error); }));
els.copySessionId.addEventListener('click', () => toggleSessionActionsMenu());
els.sessionActionsMenu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-session-action]')?.dataset.sessionAction;
  if (!action || !activeSessionId) return;
  toggleSessionActionsMenu(false);
  if (action === 'rename') {
    promptRenameHermesWebSession(sessions.find((session) => session.id === activeSessionId) || { id: activeSessionId, title: settings.sessionTitle });
    return;
  }
  navigator.clipboard.writeText(activeSessionId)
    .then(() => { els.composerStatus.textContent = translateUiText('Session ID copied'); })
    .catch((error) => { els.composerStatus.textContent = `Copy failed: ${error?.message || String(error)}`; });
});
els.returnToPageButton.addEventListener('click', async () => {
  if (handoff.sourceTabId) await browserApi.tabs.update(handoff.sourceTabId, { active: true });
});
els.connectionTruth.addEventListener('click', () => {
  setInspectorTab('diagnostics');
  els.shell.classList.remove('inspector-closed');
  els.inspectorToggle.setAttribute('aria-expanded', 'true');
  updateScrim();
});
els.copyDiagnostics.addEventListener('click', async () => {
  const report = [
    'Hermes Web diagnostics',
    `Surface: fulltab`,
    `Connection: ${els.diagConnection.textContent}`,
    `Gateway origin: ${els.diagGateway.textContent}`,
    `Session: ${activeSessionId || 'none'}`,
    `Model: ${els.diagModel.textContent}`,
    `Profile: ${els.diagProfile.textContent}`,
  ].join('\n');
  await navigator.clipboard.writeText(report);
  els.copyDiagnostics.textContent = translateUiText('Diagnostics copied');
  setTimeout(() => { els.copyDiagnostics.textContent = translateUiText('Copy redacted diagnostics'); }, 1400);
});
for (const tab of document.querySelectorAll('[data-inspector-tab]')) {
  tab.addEventListener('click', () => setInspectorTab(tab.dataset.inspectorTab));
}
globalThis.addEventListener('resize', () => {
  if (globalThis.innerWidth <= 1439) {
    els.shell.classList.add('inspector-closed');
    els.inspectorToggle.setAttribute('aria-expanded', 'false');
  }
  setNavigationOpen(els.shell.classList.contains('nav-open'));
  updateScrim();
});
browserApi.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.hasOwn(changes, CUSTOM_THEME_STORAGE_KEY)) {
    void handleWebCustomThemeStoreChange();
  }
  if (area === 'local' && changes[TASK_STACKS_STORAGE_KEY]) {
    taskStackStore = changes[TASK_STACKS_STORAGE_KEY].newValue && typeof changes[TASK_STACKS_STORAGE_KEY].newValue === 'object'
      ? changes[TASK_STACKS_STORAGE_KEY].newValue
      : {};
    renderTaskStack();
  }
  if (area === 'local' && Object.hasOwn(changes, CONTEXT_CONSENT_STORAGE_KEY)) {
    settings = {
      ...settings,
      browserContextConsentLedger: normalizeContextConsentLedger(changes[CONTEXT_CONSENT_STORAGE_KEY]?.newValue),
    };
    renderBrowserContextConsentControl();
  }
  if (area === 'local' && changes[VOICE_DRAFT_STORAGE_KEY]?.newValue) consumeVoiceDraft(changes[VOICE_DRAFT_STORAGE_KEY].newValue).catch(() => {});
  if (area === 'local' && changes[WAKE_STORAGE_KEYS.state]?.newValue) renderWakeState(changes[WAKE_STORAGE_KEYS.state].newValue);
  if (area === 'local' && changes[WAKE_STORAGE_KEYS.turn]?.newValue) consumeWakeTurn(changes[WAKE_STORAGE_KEYS.turn].newValue).catch(() => {});
});
browserApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === WAKE_MESSAGES.turnReady) {
    consumeWakeTurn(message.turn).catch(() => {});
    sendResponse?.({ ok: true, accepted: true, surface: SURFACE_KINDS.FULL_TAB });
  }
  if (message?.type === WAKE_MESSAGES.localState) renderWakeState(message);
  return false;
});
document.addEventListener('click', (event) => {
  if (!els.attachMenu.hidden && !els.attachMenu.contains(event.target) && !els.attachButton.contains(event.target)) toggleAttachMenu(false);
  if (!els.skillMenu.hidden && !els.skillMenu.contains(event.target) && event.target !== els.prompt && event.target !== els.commandMenuButton) {
    els.skillMenu.hidden = true;
    els.commandMenuButton.setAttribute('aria-expanded', 'false');
  }
  if (!els.sessionActionsMenu.hidden && !els.sessionActionsMenu.contains(event.target) && event.target !== els.copySessionId) toggleSessionActionsMenu(false);
});
globalThis.addEventListener('focus', () => {
  consumePendingVoiceDraft().catch(() => {});
  consumePendingWakeTurn().catch(() => {});
});
globalThis.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    consumePendingVoiceDraft().catch(() => {});
    consumePendingWakeTurn().catch(() => {});
  }
});

document.documentElement.dataset.hermesWebListenersReady = 'true';
subscribeLocale(() => {
  contextMenuEditor?.setTranslator(contextMenuEditorTranslate);
  renderAppearanceSettings();
  renderInlineAssistModelOptions();
  renderTaskStack();
});
await initI18n();
initializeResponsiveShell();
updateScrim();
loadApp()
  .then(async () => {
    renderWakeState(await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.getState }).catch(() => ({})));
    await consumePendingVoiceDraft();
    await consumePendingWakeTurn();
  })
  .catch((error) => showError('Hermes Web could not start', error?.message || String(error), { translateDetail: false }));
