import {
  AUDIO_TRANSCRIBE_ENDPOINT,
  DEFAULT_SETTINGS,
  HERMES_BROWSER_SYSTEM_PROMPT,
  MODEL_EFFORTS,
  appendOpenAiChunkText,
  autoSessionTitleFromText,
  buildAudioTranscriptionBody,
  buildHermesModelOptions,
  buildHermesRuntimeSelectionNote,

  browserContextPayloadHash,
  busyComposerSubmitAction,
  clampText,
  classifyGatewayError,
  classifyRemoteGatewaySetup,
  composerControlState,
  composerKeyAction,
  connectionStateForGateway,
  contextAccountingSnapshot,
  contextCompactionState,
  contextChipSummary,
  contextControlState,
  contextMeterDisplay,
  encodeSessionId,
  estimateContextWindow,
  estimateLocalSessionContextTokens,
  estimateTokens,
  escapeHtml,
  extractAssistantText,
  formatUpdateStatus,
  gatewayConnectionTroubleshooting,
  gatewayConnectionSummary,
  groupModelsForMenu,
  groupSessionsForMenu,
  isDefaultBrowserSessionTitle,
  isUnsavedBrowserDraftSession,
  isMicrophonePermissionError,
  isModelRuntimeSelectable,
  isRestrictedUrl,
  isLocalDocumentUrl,
  isUsableRemoteGatewayUrl,
  messageDisplayText,
  messagesForLocalCache,
  microphonePermissionHelp,
  modelDisplayName,
  modelRefreshControlState,
  modelRuntimeStatus,
  modelRuntimeAckState,
  modelOptionsRuntimeAckState,
  normalizeGitCommit,
  normalizeHermesModels,
  normalizeHermesProfiles,
  normalizeHermesSessions,
  applySessionModelBindings,
  normalizeHermesSkills,
  normalizeExtensionVersion,
  normalizeFastMode,
  normalizeGatewayMode,
  normalizeGatewayUrl,
  normalizeBrowserModelBinding,
  normalizeRuntimeModelPayload,
  normalizeSessionStartupMode,

  normalizeToolActivity,
  normalizeReasoningEffort,
  pairingFailureMessage,
  prepareOnDeviceSpeechRecognition,
  queuedMessageControlState,
  reasoningEffortShortLabel,
  runtimeValueMatches,
  safeTab,
  shouldRequireModelLock,
  shouldReuseImageGenerationActivity,
  shouldStopSessionPaging,
  shouldFallbackToWebSpeechForTranscription,
  shouldUseLocalDashboardAudioTranscription,
  shouldAutoOpenSessionGroup,
  shouldAutoFlushQueuedTurn,
  shouldCreateFreshSessionOnOpen,
  shouldShowBrowserIntro,
  sourceBlobMapsMatch,
  sessionModelBindingFromRuntime,
  resolveAcknowledgedSessionModelBinding,
  resolveAcknowledgedSessionModelOptions,
  resolveBrowserEffectiveModel,
  resolveBrowserEffectiveModelOptions,
  resolveCatalogModelIdForBinding,
  skillSuggestionsForInput,
  updateBrowserModelScope,
  updateBrowserModelOptionScope,
  updateReviewState,
  sessionBindingIdentity,
  isSessionBindingValid,
  withSessionBindingIdentity,
  agentDiscoveryAppliesToMode,
  agentDiscoveryModeNote,
} from './lib/common.mjs';
import { renderMarkdownSafe, sanitizeHtml } from './lib/sanitizer.mjs';
import { getLocale, initI18n, populateLanguageSelect, setLocale, subscribeLocale, t, translateUiText } from './lib/i18n.mjs';
import {
  buildContextMenuTurn,
  contextMenuRequestMatchesTab,
  normalizeContextMenuRequest,
} from './lib/context-menu-request.mjs';
import { mountContextMenuEditor } from './lib/context-menu-editor-client.mjs';
import { CONTEXT_MENU_REQUEST_CLAIM } from './lib/context-menu-controller.mjs';
import {
  assertAssistModelSelectionAcknowledged,
  assistModelFallbackNotice,
  assistModelRoutingSupported,
  buildAssistModelRouteRequest,
  resolveAssistModelBindingFromCatalog,
} from './lib/assist-model-contract.mjs';
import { serializeBrowserTurnEnvelope } from './lib/browser-context-protocol.mjs';
import {
  APPEARANCE_THEMES,
  normalizeAppearanceTheme,
  normalizeColorMode,
} from './lib/appearance-themes.mjs';
import {
  ZOOM_PRESETS,
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
import { buildAgentThemePrompt, extractAgentThemeDocument } from './lib/agent-theme-authoring.mjs';
import { createImageViewerState, imageViewerReducer } from './lib/image-viewer.mjs';
import { appendUserImageAttachments } from './lib/image-render.mjs';
import { extractYouTubeVideoId } from './lib/transcript.mjs';
import {
  buildDashboardWsUrl,
  buildSessionModelSwitchRequest,
  createGatewayClient,
  establishGatewaySession,
  normalizeGatewayHistoryMessages,
  remoteStoredSessionIdForGateway,
  runtimeModelFromSessionStatus,
  WS_EVENTS,
  WS_METHODS,
} from './lib/gateway-ws.mjs';
import { browserDisplayMessages } from './lib/web-run-state.mjs';
import {
  dashboardTrustPrompt,
  discoverProfilesViaTab,
  findDashboardTab,
  isTrustedDashboardOrigin,
  mintWsTicket,
  originOf,
  ticketFailureHelp,
} from './lib/dashboard-bridge.mjs';
import {
  deriveStartupView,
  initialStartupReadiness,
  reduceStartupReadiness,
  selectedModelReadiness,
} from './lib/readiness.mjs';
import {
  runCanonicalConnectionReadiness,
  ticketTransportClosedReadiness,
} from './lib/connection-readiness-orchestrator.mjs';
import {
  DEFAULT_GATEWAY_CAPABILITIES,
  buildContextReceipt,
  capabilityStatusRows,
  connectionSecuritySummary,
  normalizeGatewayCapabilities,
} from './lib/capabilities.mjs';
import { filterKnownAssistantReconcileParts, normalizeBrowserRuntimeEvent, reduceAssistantStreamText } from './lib/runtime-events.mjs';
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
import {
  classifyTurnRecovery,
  hermesGatewayTurnError,
  hermesRequestError,
  latestAssistantAfterUser,
  sessionContextFailureRecovery,
  turnRequestFailureState,
} from './lib/turn-recovery.mjs';
import { createDiffusionCanvas, diffusionVariantForSeed } from './lib/diffusion-canvas.mjs';
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
  transcribeAudioViaDashboard,
  dashboardModelDiscoveryBaseUrl,
  discoverCanonicalProviderCatalog,
  discoverGatewayVirtualModels,
  discoverModelsFromDashboard,
  discoverModelsFromExternalSources,
  discoverModelsFromRegistry,
  discoverModelsFromSessions,
  mergeModelsByRawId,
  mergeModelsWithRegistry,
  mergeVirtualModelRows,
  MODEL_CATALOG_CACHE_STORAGE_KEY,
  modelCatalogCacheKey,
  modelRowsFromGatewayOptions,
  modelCatalogRefreshDecision,
  normalizeCachedModelCatalog,
  normalizeExternalModelSourceList,
  selectModelCatalogFallback,
  shouldEnrichCanonicalProviderCatalog,
  shouldTrySessionModelFallback,
} from './lib/model-discovery.mjs';
import {
  WAKE_MESSAGES,
  WAKE_STORAGE_KEYS,
  normalizeWakeWordSettings,
  wakeTurnIsFresh,
} from './lib/wake-word.mjs';

import {
  BUILTIN_COMMANDS,
  parseBrowserCommand,
  resolveCommandPrompt,
} from './lib/commands.mjs';
import {
  ELEMENT_PICK_MESSAGES,
  pickedElementForTab,
  storedPickedElementRecord,
} from './lib/element-picker.mjs';
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
  CONTEXT_CONSENT_STORAGE_KEY,
  consentGrantedForIdentity,
  consentRequiredForConnection,
  contextConsentIdentity,
  contextScopeWithConsent,
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
import {
  PANEL_RESIDENCY_MODES,
  normalizePanelResidencyMode,
  parseSidePanelParams,
} from './lib/panel-residency.mjs';
import {
  INLINE_DRAFT_ROUTES,
  buildInlineDraftPrompt,
  normalizeInlineDraftRequest,
  normalizeInlineDraftRoutePreference,
  sanitizeInlineDraftResult,
} from './lib/inline-draft-policy.mjs';
import {
  CONTEXT_DELIVERY_MODES,
  contextDeliveryDecision,
  recordContextDelivery,
} from './lib/context-delivery.mjs';
import {
  DELIVERY_STATE_STORAGE_KEY,
  clearDeliveryState,
  deliveryIdentityForTurn,
  deliveryStateEntryForIdentity,
  deliveryStateToMap,
  normalizeDeliveryState,
  serializeDeliveryState,
} from './lib/session-delivery-state.mjs';
import {
  CONNECTION_TRANSPORTS,
  apiCredentialSatisfied,
  automaticApiPairingAllowed,
  connectionModePreviewUrl,
  connectionSettingsAfterTokenClear,
  legacyGatewayModeForConnection,
  migrateConnectionSettings,
  normalizeConnectionMode,
  resolvePhaseATransport,
  sanitizeGatewayUrlForConnectionMode,
  transportUsesDashboardTicket,
} from './lib/connection-modes.mjs';
import { CONNECTION_ACTIONS, connectionActionForSettings } from './lib/connection-dispatch.mjs';
import { assertCloudAgentTabStillMatches, resolveActiveCloudAgentTab } from './lib/cloud-agent-tab.mjs';
import {
  CONNECTION_STATES,
  createConnectionController,
} from './lib/connection-controller.mjs';
import { createHermesClient } from './lib/hermes-client.mjs';
import { openHermesFullView } from './lib/fulltab-opener.mjs';
import { writeAssistantClipboardEvent } from './lib/assistant-clipboard.mjs';
import { explicitSiteCaptureAction } from './lib/site-adapters.mjs';
import {
  SURFACE_KINDS,
  buildFullTabHandoffUrl,
  createSurfaceId,
  fullTabEntryPathForPage,
} from './lib/surface-protocol.mjs';
import { resolveBrowserApi } from './lib/browser-api.mjs';
import { detectBrowserProduct, probeBrowserCapabilities } from './lib/browser-runtime.mjs';
import { controllerAdapterContractFor } from './lib/browser-controller-adapter.mjs';
import {
  browserControlView,
  controlLeaseRequest,
  currentTabLeaseReplacement,
  followTargetTabId,
} from './lib/browser-control-ui.mjs';

// -- Train 1 Phase 0 startup instrumentation (observer-only) ---------------
// Marks/measure hooks for scripts/bench-startup.mjs (window.__HBE_BOOT_MARKS).
// Every call below is guarded and one-shot so a repeated render or a missing
// performance API can never gate, reorder, or otherwise change boot behavior;
// hooks are appended after the existing behavior that completes each phase.
const HBE_BOOT_TARGET = globalThis;
if (!Array.isArray(HBE_BOOT_TARGET.__HBE_BOOT_MARKS)) {
  HBE_BOOT_TARGET.__HBE_BOOT_MARKS = [];
}
const HBE_BOOT_MARKS = HBE_BOOT_TARGET.__HBE_BOOT_MARKS;
const HBE_BOOT_EMITTED = new Set();
function hbeBootClock() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
function hbeBootFindTime(markName) {
  for (let index = HBE_BOOT_MARKS.length - 1; index >= 0; index -= 1) {
    const entry = HBE_BOOT_MARKS[index];
    if (entry?.mark === markName && Number.isFinite(entry?.t)) return entry.t;
  }
  return null;
}
function hbeBootEmit(name, { startMark = null } = {}) {
  try {
    const t = hbeBootClock();
    if (!HBE_BOOT_EMITTED.has(name)) {
      HBE_BOOT_EMITTED.add(name);
      HBE_BOOT_MARKS.push({ mark: name, t });
      if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
        try { performance.mark(name); } catch { /* mark is best-effort */ }
      }
    }
    if (startMark) {
      const start = hbeBootFindTime(startMark);
      if (start !== null) {
        HBE_BOOT_MARKS.push({ measure: name, dur: Math.max(0, t - start) });
        if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
          try { performance.measure(name, { start, end: t }); } catch { /* measure is best-effort */ }
        }
      }
    }
  } catch { /* instrumentation must never block boot */ }
}

hbeBootEmit('panel:body-start');

const $ = (selector) => document.querySelector(selector);
const browserApiResolution = resolveBrowserApi();
const browserApi = browserApiResolution.api;
const ASSIST_ROUTING_FALLBACK_ENGLISH = 'Your Assist model choice stays saved. This gateway cannot enforce an exact model, so Assist uses the gateway default and labels every fallback result.';
const sidePanelParams = parseSidePanelParams(globalThis.location?.search || '');
const INLINE_DRAFT_STORAGE_KEY = 'hermesBrowserInlineDraftRequest';
const INLINE_SESSION_STATE_KEY = 'hermesBrowserInlineSessionState';
const CONTEXT_MENU_STORAGE_KEY = 'hermesBrowserContextMenuRequest';
const OPEN_SESSION_STORAGE_KEY = 'hermesBrowserOpenSessionRequest';
const TASK_STACKS_STORAGE_KEY = 'hermesBrowserTaskStacks';

const els = {
  shell: $('.shell'),
  bottomDock: $('.bottom-dock'),
  appScroll: $('#appScroll'),
  startupScreen: $('#startupScreen'),
  startupTitle: $('#startupTitle'),
  startupDetail: $('#startupDetail'),
  startupProgress: $('#startupProgress'),
  startupStepList: $('#startupStepList'),
  startupConnectButton: $('#startupConnectButton'),
  connectPanel: $('#connectPanel'),
  connectButton: $('#connectButton'),
  manualSettingsButton: $('#manualSettingsButton'),
  connectStatus: $('#connectStatus'),
  connectionPill: $('#connectionPill'),
  browserIntroHero: $('#browserIntroHero'),
  browserIntroDismissButton: $('#browserIntroDismissButton'),
  sessionMenuButton: $('#sessionMenuButton'),
  currentSessionName: $('#currentSessionName'),
  newSessionButton: $('#newSessionButton'),
  sessionMenu: $('#sessionMenu'),
  sessionSearchInput: $('#sessionSearchInput'),
  sessionMenuList: $('#sessionMenuList'),
  createSessionButton: $('#createSessionButton'),
  refreshSessionsButton: $('#refreshSessionsButton'),
  sessionRefreshIcon: $('#sessionRefreshIcon'),
  refreshSessionsLabel: $('#refreshSessionsLabel'),
  messages: $('#messages'),
  taskStack: $('#taskStack'),
  taskStackToggle: $('#taskStackToggle'),
  taskStackSummary: $('#taskStackSummary'),
  taskStackProgress: $('#taskStackProgress'),
  taskStackList: $('#taskStackList'),
  composer: $('#composer'),
  input: $('#promptInput'),
  contextChip: $('#contextChip'),
  contextChipLabel: $('#contextChipLabel'),
  contextPreview: $('#contextPreview'),
  explicitSiteCaptureButton: $('#explicitSiteCaptureButton'),
  contextScopeButton: $('#contextScopeButton'),
  contextScopeLabel: $('#contextScopeLabel'),
  contextScopeMenu: $('#contextScopeMenu'),
  localDocumentApprovalNotice: $('#localDocumentApprovalNotice'),
  localDocumentApprovalTitle: $('#localDocumentApprovalTitle'),
  localDocumentApprovalDetail: $('#localDocumentApprovalDetail'),
  localDocumentApproveButton: $('#localDocumentApproveButton'),
  localDocumentDismissButton: $('#localDocumentDismissButton'),
  sessionOwnershipNotice: $('#sessionOwnershipNotice'),
  contextMenuRouteNotice: $('#contextMenuRouteNotice'),
  contextMenuRememberRoute: $('#contextMenuRememberRoute'),
  sessionOwnershipTitle: $('#sessionOwnershipTitle'),
  sessionOwnershipDetail: $('#sessionOwnershipDetail'),
  composerDropZone: $('#composerDropZone'),
  dropOverlay: $('#dropOverlay'),
  skillMenu: $('#skillMenu'),
  queueNotice: $('#queueNotice'),
  runControlRecovery: $('#runControlRecovery'),
  runControlRecoveryDetail: $('#runControlRecoveryDetail'),
  retryRunStatusButton: $('#retryRunStatusButton'),
  discardHeldQueueButton: $('#discardHeldQueueButton'),
  sendButton: $('#sendButton'),
  inlineSendButton: $('#inlineSendButton'),
  queueButton: $('#queueButton'),
  steerButton: $('#steerButton'),
  stopButton: $('#stopButton'),
  wakeButton: $('#wakeButton'),
  voiceButton: $('#voiceButton'),
  refreshButton: $('#refreshButton'),
  settingsButton: $('#settingsButton'),
  startupTestConnectionButton: $('#startupTestConnectionButton'),
  openFullViewButton: $('#openFullViewButton'),
  closeSettingsButton: $('#closeSettingsButton'),
  settingsDialog: $('#settingsDialog'),
  settingsForm: $('#settingsForm'),
  testConnectionButton: $('#testConnectionButton'),
  versionLabel: $('#versionLabel'),
  checkUpdatesButton: $('#checkUpdatesButton'),
  reviewUpdateButton: $('#reviewUpdateButton'),
  updateStatus: $('#updateStatus'),
  updateDialog: $('#updateDialog'),
  updateDialogTitle: $('#updateDialogTitle'),
  updateDialogSummary: $('#updateDialogSummary'),
  updateChangeGroups: $('#updateChangeGroups'),
  updateNowButton: $('#updateNowButton'),
  maybeLaterButton: $('#maybeLaterButton'),
  closeUpdateDialogButton: $('#closeUpdateDialogButton'),
  updateInstallNote: $('#updateInstallNote'),
  operationToast: $('#operationToast'),
  operationToastTitle: $('#operationToastTitle'),
  operationToastDetail: $('#operationToastDetail'),
  closeOperationToastButton: $('#closeOperationToastButton'),
  activeTitle: $('#activeTitle'),
  activeUrl: $('#activeUrl'),
  statusDot: $('#statusDot'),
  statusActions: $('#statusActions'),
  statusCopyDiagnosticsButton: $('#statusCopyDiagnosticsButton'),
  browserControlCard: $('#browserControlCard'),
  browserControlCardDetail: $('#browserControlCardDetail'),
  browserControlState: $('#browserControlState'),
  browserControlScopeInput: $('#browserControlScopeInput'),
  browserControlStayButton: $('#browserControlStayButton'),
  browserControlFollowButton: $('#browserControlFollowButton'),
  browserControlEnableButton: $('#browserControlEnableButton'),
  browserControlDetachButton: $('#browserControlDetachButton'),
  browserControlStrip: $('#browserControlStrip'),
  browserControlStripSignal: $('#browserControlStripSignal'),
  browserControlStripTitle: $('#browserControlStripTitle'),
  browserControlStripDetail: $('#browserControlStripDetail'),
  browserControlAttachButton: $('#browserControlAttachButton'),
  browserControlDismissButton: $('#browserControlDismissButton'),
  browserControlPauseButton: $('#browserControlPauseButton'),
  browserControlStopButton: $('#browserControlStopButton'),
  browserControlApproveButton: $('#browserControlApproveButton'),
  browserControlRejectButton: $('#browserControlRejectButton'),
  modelMenuButton: $('#modelMenuButton'),
  currentModelName: $('#currentModelName'),
  currentModelEffort: $('#currentModelEffort'),
  modelMenu: $('#modelMenu'),
  modelMenuTitle: $('#modelMenuTitle'),
  modelMenuCloseButton: $('#modelMenuCloseButton'),
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
  contextRuntimeBreakdown: $('#contextRuntimeBreakdown'),
  contextBreakdown: $('#contextBreakdown'),
  contextControlStatus: $('#contextControlStatus'),
  contextCompactButton: $('#contextCompactButton'),
  connectionModeInput: $('#connectionModeInput'),
  gatewayModeInput: $('#gatewayModeInput'),
  remoteTransportRow: $('#remoteTransportRow'),
  gatewayUrlInput: $('#gatewayUrlInput'),
  gatewayUrlField: $('#gatewayUrlField'),
  cloudPreviewHelp: $('#cloudPreviewHelp'),
  gatewayHelp: $('#gatewayHelp'),
  apiKeyField: $('#apiKeyField'),
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
  browserContextConsentControl: $('#browserContextConsentControl'),
  browserContextConsentInput: $('#browserContextConsentInput'),
  browserContextConsentIdentity: $('#browserContextConsentIdentity'),
  inlineAssistEnabled: $('#inlineAssistEnabled'),
  inlineAssistDefaultRoute: $('#inlineAssistDefaultRoute'),
  inlineAssistModel: $('#inlineAssistModel'),
  inlineAssistModelButton: $('#inlineAssistModelButton'),
  inlineAssistModelLabel: $('#inlineAssistModelLabel'),
  assistModelCapabilityHint: $('#assistModelCapabilityHint'),
  inlineAssistSessionRetention: $('#inlineAssistSessionRetention'),
  contextMenuDefaultRoute: $('#contextMenuDefaultRoute'),
  contextMenuEditor: $('#contextMenuEditor'),
  panelResidencyInputs: Array.from(document.querySelectorAll('input[name="panelResidencyMode"]')),
  autoNameSessionsInput: $('#autoNameSessionsInput'),
  transcriptProviderInput: $('#transcriptProviderInput'),
  wakeWordEnabledInput: $('#wakeWordEnabledInput'),
  wakeWordPhraseInput: $('#wakeWordPhraseInput'),
  wakeWordBrowserFallbackInput: $('#wakeWordBrowserFallbackInput'),
  wakeWordSpeakRepliesInput: $('#wakeWordSpeakRepliesInput'),
  wakeWordStatus: $('#wakeWordStatus'),
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
  customThemeManager: $('#customThemeManager'),
  customThemeImportTextarea: $('#customThemeImportTextarea'),
  customThemeFileInput: $('#customThemeFileInput'),
  customThemePreviewButton: $('#customThemePreviewButton'),
  customThemePreview: $('#customThemePreview'),
  customThemeInstallButton: $('#customThemeInstallButton'),
  customThemeImportStatus: $('#customThemeImportStatus'),
  customThemeResetButton: $('#customThemeResetButton'),
  marketplaceThemeSearchInput: $('#marketplaceThemeSearchInput'),
  marketplaceThemeSearchButton: $('#marketplaceThemeSearchButton'),
  marketplaceThemeStatus: $('#marketplaceThemeStatus'),
  marketplaceThemeResults: $('#marketplaceThemeResults'),
  marketplaceThemeMode: $('#marketplaceThemeMode'),
  agentThemeDescription: $('#agentThemeDescription'),
  agentThemeCreateButton: $('#agentThemeCreateButton'),
  agentThemeStatus: $('#agentThemeStatus'),
  languageSelect: $('#languageSelect'),
  colorModeButtons: Array.from(document.querySelectorAll('[data-color-mode]')),
  textZoomPresetGrid: $('#textZoomPresetGrid'),
  textZoomInput: $('#textZoomInput'),
  textZoomDecreaseButton: $('#textZoomDecreaseButton'),
  textZoomIncreaseButton: $('#textZoomIncreaseButton'),
  fontProfileSelect: $('#fontProfileSelect'),
  customFontFamilyField: $('#customFontFamilyField'),
  customFontFamilyInput: $('#customFontFamilyInput'),
  appearanceSaveStatus: $('#appearanceSaveStatus'),
  quickMoreMenu: $('#quickMoreMenu'),
  commandMenuButton: $('#commandMenuButton'),
  template: $('#messageTemplate'),
};

let settings = { ...DEFAULT_SETTINGS };
let appearanceMutationId = 0;
let appearanceSaveStatus = '';
let appearanceWriteQueue = Promise.resolve();
let customThemeStoreState = { ok: true, status: 'empty', themes: [] };
let customThemePreviewState = null;
let customThemeImportStatus = '';
let customThemeDeleteArmedId = '';
let customThemeResetArmed = false;
let marketplaceThemeRevision = 0;
let marketplaceThemeResults = [];
let marketplaceThemeLoading = false;
let marketplaceThemeError = '';
let marketplaceThemeInstallingId = '';
let marketplaceThemeLoaded = false;
let marketplaceThemeDebounceTimer = null;
let agentThemeCreating = false;
let agentThemeStatus = '';
const directMarketplaceController = createThemeMarketplaceController({
  client: createVscodeMarketplaceClient(),
  storageArea: browserApi.storage.local,
});
const marketplaceTransport = createThemeMarketplaceTransport({
  runtime: browserApi.runtime,
  fallbackController: directMarketplaceController,
});
let appliedCustomThemeVariables = [];
let wakeState = { enabled: false, state: 'off', mode: 'off', phrase: DEFAULT_SETTINGS.wakeWordPhrase, provider: '', detail: 'Wake word is off.' };
let wakeTurnProcessingId = '';
const hermesClient = createHermesClient({
  getConnection: () => settings,
});
let startupReadiness = initialStartupReadiness(settings);
let contextScope = normalizeContextScope(DEFAULT_CONTEXT_SCOPE);
let previousConversationScope = normalizeContextScope(DEFAULT_CONTEXT_SCOPE);
let currentContext = { activeTab: null, tabs: [], pageContext: null, contextScope };
let contextConsentPrincipalBinding = { origin: '', transport: '', principal: '' };
const pickedElementsByTabId = new Map();
let elementPickInProgress = false;
let elementPickState = null;
const PICK_STATE_STORAGE_NAME = 'hermes:elementPickInProgress';
let selectedTabs = []; // null = all tabs; array of SafeTab = user-filtered set
let messages = [];
let taskStackStore = {};
let taskStackExpanded = true;
let loadedSessionContextEstimate = { sessionId: '', contextTokens: 0, visibleTokens: 0 };
let availableModels = [];
let availableSessions = [];
let availableSkills = [];
let availableProfiles = [];
let attachments = [];
let selectedModelProvider = '';
let modelSelectionTarget = 'chat';
const modelMenuHome = { parent: els.modelMenu?.parentElement || null, next: els.modelMenu?.nextSibling || null };
let modelSelectionVersion = 0;
let modelOptionSelectionVersion = 0;
let pendingModelRuntimeAck = null;
let lastRemoteDiagnostic = null;
let lastVisibleStatus = null;
const openSessionGroups = new Set();
const closedSessionGroups = new Set();
const approvedForeignSessionIds = new Set();
let pendingForeignTurn = null;
let pendingContextMenuRequest = null;
let sending = false;
let queuedTurn = null;
let activeAbortController = null;
let activeRunId = '';
let activeRunControl = null;
let runControlGeneration = 0;
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
let sessionLoadRequestId = 0;
let bottomDockResizeObserver = null;
const HERMES_BROWSER_INTRO_SEEN_STORAGE_KEY = 'hermesBrowserIntroSeen';
let browserIntroSeen = false;
let browserIntroDismissedForPanel = false;
let operationToastTimer = null;
let browserControlStatus = null;
let browserControlActiveTab = null;
let browserControlCurrentTarget = null;
let browserControlPollTimer = null;
let latestUpdateReview = null;
let sessionsRefreshing = false;
let contextMenuEditor = null;

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

function currentTaskStack() {
  const sessionId = String(settings.sessionId || '').trim();
  return Array.isArray(taskStackStore?.[sessionId]?.tasks) ? taskStackStore[sessionId].tasks : [];
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
  if (!tasks) return false;
  const sessionId = String(settings.sessionId || '').trim();
  if (!sessionId) return false;
  taskStackStore = updateTaskStackStore(taskStackStore, sessionId, tasks);
  renderTaskStack();
  await browserApi.storage.local.set({ [TASK_STACKS_STORAGE_KEY]: taskStackStore });
  return true;
}

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
    && watch.durableSessionId === String(settings.sessionId || '').trim(),
  loadHistory: async (watch) => fetchSessionMessagesQuietly(
    watch.transport === 'dashboard-ws' ? watch.liveSessionId : watch.durableSessionId,
    { transport: watch.transport },
  ),
  onComplete: async (watch, result) => {
    await commitFetchedSessionMessages(result, {
      sessionId: watch.durableSessionId,
      requestId: sessionLoadRequestId,
    });
  },
  onState: (watch) => {
    if (watch.state === 'pending' && watch.attempts === 0) {
      setStatus('warn', 'Delegation in progress', 'Waiting for the exact subagent result. It will appear here automatically.');
    } else if (watch.state === 'completed') {
      setStatus('ok', 'Delegation result loaded', 'The durable subagent completion turn is now in this session.');
    } else if (watch.state === 'timed_out') {
      setStatus('warn', 'Delegation still pending', 'Automatic waiting paused. Reopen this session to check durable history again.');
    }
  },
  persist: persistDelegationWatches,
});

async function startDelegationWatch(dispatch) {
  const durableSessionId = String(settings.sessionId || '').trim();
  if (!dispatch?.delegationId || !durableSessionId) return null;
  return delegationWatchManager.start({
    scopeKey: currentDelegationScopeKey(),
    durableSessionId,
    liveSessionId: remoteWsConnection?.wsSessionId || '',
    delegationId: dispatch.delegationId,
    transport: isRemoteWsMode() ? 'dashboard-ws' : 'rest',
  });
}

async function captureDelegationToolEvent(event) {
  const dispatch = delegationDispatchFromToolEvent(event);
  if (dispatch) await startDelegationWatch(dispatch);
}

function captureDelegationRuntimePayload(payload = {}) {
  for (const dispatch of delegationDispatchesFromMessages(payload?.messages || [])) {
    startDelegationWatch(dispatch).catch((error) => console.warn('[Hermes Browser] Could not persist delegation watch:', error));
  }
}

async function captureDelegationDispatchesFromCurrentRestHistory() {
  const sessionId = String(settings.sessionId || '').trim();
  if (!sessionId || isRemoteWsMode() || !settings.apiKey) return false;
  try {
    const result = await fetchSessionMessagesQuietly(sessionId, { transport: 'rest' });
    captureDelegationRuntimePayload({ messages: result?.messages || [] });
    return true;
  } catch {
    // Older/stateless gateways may not expose durable history. Dispatch is
    // inline there, so absence of this recovery route must remain non-fatal.
    return false;
  }
}

async function activateCurrentDelegationSession() {
  const durableSessionId = String(settings.sessionId || '').trim();
  if (!durableSessionId) return;
  await delegationWatchManager.activate({
    scopeKey: currentDelegationScopeKey(),
    durableSessionId,
    liveSessionId: remoteWsConnection?.wsSessionId || '',
  });
}

async function hydrateDelegationWatches() {
  const stored = await browserApi.storage.local.get([DELEGATION_WATCH_STORAGE_KEY]);
  await delegationWatchManager.hydrate(stored?.[DELEGATION_WATCH_STORAGE_KEY] || []);
  await activateCurrentDelegationSession();
}

const contextDeliveryBySession = new Map();
let forceFullContextNextTurn = false;

// Issue #71 pre-gate: bounded minimal delivery metadata survives panel reloads
// for durable identities only. Persistence stores exactly
// { gatewayUrl, storedSessionId, contextHash, referenceCount, lastFullAt,
// lastSentAt } — never page text, URL, title, or transcript — and fails closed
// on corrupt, wrong-version, or identity-mismatched state.
async function persistContextDeliveryState() {
  try {
    await browserApi.storage.local.set({
      [DELIVERY_STATE_STORAGE_KEY]: serializeDeliveryState(contextDeliveryBySession),
    });
  } catch (error) {
    console.warn('[Hermes Browser] Delivery state persistence failed:', error?.message || error);
  }
}

async function hydrateContextDeliveryState() {
  try {
    const stored = await browserApi.storage.local.get([DELIVERY_STATE_STORAGE_KEY]);
    const persisted = deliveryStateToMap(normalizeDeliveryState(stored?.[DELIVERY_STATE_STORAGE_KEY]));
    for (const [key, record] of persisted) {
      if (!contextDeliveryBySession.has(key)) contextDeliveryBySession.set(key, record);
    }
  } catch (error) {
    console.warn('[Hermes Browser] Delivery state hydration failed:', error?.message || error);
  }
}

async function clearContextDeliveryState() {
  contextDeliveryBySession.clear();
  forceFullContextNextTurn = true;
  try {
    await browserApi.storage.local.set({
      [DELIVERY_STATE_STORAGE_KEY]: clearDeliveryState(),
    });
  } catch (error) {
    console.warn('[Hermes Browser] Delivery state clear failed:', error?.message || error);
  }
}

let trustedDashboardTabId = null;
let connectionProbeStatus = 'connecting';
let connectionProbeDetail = '';
let connectionProbeTimer = null;
let connectionProbeInFlight = false;
const connectionController = createConnectionController();
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

function minimumConnectionReady() {
  return isConnected() && apiCredentialSatisfied(settings);
}

function positionStartupSettings(active = document.body?.classList.contains('startup-active')) {
  const topbar = els.settingsButton?.closest('.topbar');
  if (!topbar) return;
  if (!active) {
    topbar.style.removeProperty('--startup-settings-top');
    return;
  }
  const listRect = els.startupStepList?.getBoundingClientRect();
  const buttonHeight = Math.max(34, els.settingsButton?.getBoundingClientRect().height || 0);
  if (!listRect || !Number.isFinite(listRect.bottom)) return;
  const viewportHeight = Math.max(buttonHeight + 24, Number(globalThis.innerHeight) || 0);
  const maxTop = Math.max(12, viewportHeight - buttonHeight - 12);
  const top = Math.min(maxTop, Math.round(listRect.bottom + 12));
  topbar.style.setProperty('--startup-settings-top', `${top}px`);
}

function renderStartupReadiness() {
  const view = deriveStartupView(startupReadiness);
  if (els.startupScreen) els.startupScreen.hidden = !view.visible;
  if (els.startupTitle) els.startupTitle.textContent = translateUiText(view.title);
  if (els.startupDetail) els.startupDetail.textContent = translateUiText(view.detail);
  if (els.startupProgress) els.startupProgress.style.width = `${Math.max(0, Math.min(100, view.progress))}%`;
  if (els.startupStepList) {
    els.startupStepList.textContent = '';
    for (const step of view.steps) {
      const item = document.createElement('li');
      item.className = `startup-step startup-step-${step.status}`;
      item.dataset.status = step.status;
      const label = document.createElement('strong');
      label.textContent = translateUiText(step.label);
      const detail = document.createElement('span');
      detail.textContent = translateUiText(step.detail || step.status);
      item.append(label, detail);
      els.startupStepList.appendChild(item);
    }
  }
  if (els.startupConnectButton) {
    els.startupConnectButton.hidden = view.phase !== 'setup-needed';
  }
  if (els.startupTestConnectionButton) {
    els.startupTestConnectionButton.hidden = view.phase === 'setup-needed';
  }
  document.body?.classList.toggle('startup-active', view.visible);
  positionStartupSettings(view.visible);
  els.composer?.classList.toggle('startup-blocked', view.visible);
  if (els.input) els.input.disabled = view.visible;
  if (els.sendButton) els.sendButton.disabled = view.visible || els.sendButton.disabled;
  if (els.inlineSendButton) els.inlineSendButton.disabled = view.visible || els.inlineSendButton.disabled;
  if (els.modelMenuButton) els.modelMenuButton.disabled = view.visible;
  if (els.newSessionButton) els.newSessionButton.disabled = view.visible;
  if (!view.visible) {
    updateComposerBusyState();
    hbeBootEmit('panel:interactive', { startMark: 'panel:body-start' });
  }
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

function setStatus(kind, title, detail, { translateTitle = true, translateDetail = true } = {}) {
  lastVisibleStatus = { kind: kind || '', title: title || '', detail: detail || '', translateTitle, translateDetail, ts: Date.now() };
  els.statusDot.className = `status-dot ${kind || ''}`.trim();
  const safeTitle = title || 'Hermes Browser Extension';
  const safeDetail = detail || '';
  els.activeTitle.textContent = translateTitle ? translateUiText(safeTitle) : safeTitle;
  els.activeTitle.title = translateTitle ? translateUiText(safeTitle) : safeTitle;
  els.activeUrl.textContent = translateDetail ? translateUiText(safeDetail) : safeDetail;
  els.activeUrl.title = translateDetail ? translateUiText(safeDetail) : safeDetail;
  renderStatusActions();
}

function renderStatusActions() {
  if (!els.statusActions || !els.statusCopyDiagnosticsButton) return;
  const shouldShow = lastVisibleStatus?.kind === 'error'
    && isRemoteMode()
    && lastRemoteDiagnostic
    && lastRemoteDiagnostic.kind !== 'unknown';
  els.statusActions.hidden = !shouldShow;
}

function applyRemoteDiagnostic(diagnostic, { statusKind = 'error' } = {}) {
  if (!diagnostic || diagnostic.kind === 'unknown') return false;
  lastRemoteDiagnostic = diagnostic;
  renderRemoteDiagnostics(diagnostic);
  markConnectionProbe('unreachable', diagnostic.detail);
  scheduleConnectionProbe();
  setStatus(
    statusKind,
    diagnostic.title,
    diagnostic.kind === 'unknown' ? diagnostic.detail : translateUiText(diagnostic.detail),
    { translateDetail: false },
  );
  return true;
}

function openSettingsDialog() {
  renderVersionInfo();
  syncSettingsForm();
  renderCompatibilityPanel();
  renderConnectionSecurity();
  renderBrowserContextConsentControl();
  renderRemoteDiagnostics(lastRemoteDiagnostic);
  els.settingsDialog.hidden = false;
  els.settingsDialog.setAttribute('aria-hidden', 'false');
  els.settingsDialog.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  const mode = normalizeConnectionMode(settings.connectionMode);
  (mode === 'cloud' ? els.connectButton : els.gatewayUrlInput)?.focus({ preventScroll: true });
}

function closeSettingsDialog() {
  els.settingsDialog.hidden = true;
  els.settingsDialog.setAttribute('aria-hidden', 'true');
  els.settingsButton.focus();
}

function browserControlMessage(type, payload = {}) {
  return browserApi.runtime.sendMessage({ type, ...payload });
}

const CONTROL_TARGET_READY_RETRY = Object.freeze({ attempts: 6, delayMs: 100 });

async function resolveBrowserControlCandidate(candidate) {
  let resolved = null;
  for (let attempt = 0; attempt < CONTROL_TARGET_READY_RETRY.attempts; attempt += 1) {
    try {
      resolved = await browserControlMessage('HERMES_CONTROLLER_TARGET_RESOLVE', candidate);
    } catch {
      return null;
    }
    if (resolved?.reason !== 'document_not_ready') return resolved;
    if (attempt + 1 < CONTROL_TARGET_READY_RETRY.attempts) {
      await new Promise((resolve) => setTimeout(resolve, CONTROL_TARGET_READY_RETRY.delayMs));
    }
  }
  return resolved;
}

function browserControlCandidate({ context = {}, scope = {} } = {}) {
  if (scope?.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return null;
  const pinned = scope?.mode === CONTEXT_SCOPE_MODES.PINNED_TAB;
  const tabId = Number(pinned ? scope?.pinnedTabId : context?.activeTab?.id);
  const url = String(pinned
    ? (scope?.pinnedUrl || context?.activeTab?.url || '')
    : (context?.activeTab?.url || '')).trim();
  if (!Number.isInteger(tabId) || tabId <= 0 || !url) return null;
  return { tabId, frameId: 0, expectedUrl: url };
}

async function resolveBrowserControlForTurn({ context = {}, scope = {} } = {}) {
  const candidate = browserControlCandidate({ context, scope });
  if (!candidate) {
    return {
      route: 'extension-controller',
      availability: 'unavailable',
      isolatedFallback: 'forbidden',
      reason: 'target_unavailable',
      message: 'Tab not found in your browser.',
    };
  }
  try {
    const resolved = await resolveBrowserControlCandidate(candidate);
    if (resolved?.route === 'extension-controller' && resolved?.isolatedFallback === 'forbidden') return resolved;
  } catch {
    // Fall through to a fail-closed unavailable target.
  }
  return {
    route: 'extension-controller',
    availability: 'unavailable',
    isolatedFallback: 'forbidden',
    reason: 'controller_unavailable',
    message: 'Tab not found in your browser.',
  };
}

function browserControlTaskSetId() {
  const ids = Array.isArray(selectedTabs) ? selectedTabs.map((tab) => Number(tab.id)).filter(Number.isInteger) : [];
  return ids.length ? `task-set-${ids.sort((a, b) => a - b).join('-')}`.slice(0, 120) : '';
}

async function persistBrowserControlPreferences(patch = {}) {
  settings = { ...settings, ...patch };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
}

function renderBrowserControl() {
  if (!els.browserControlCard || !els.browserControlStrip) return;
  const view = browserControlView({
    settings,
    status: browserControlStatus || {},
    activeTab: browserControlActiveTab,
    currentTarget: browserControlCurrentTarget,
  });
  const enabled = settings.browserControlEnabled === true;
  const viewBehavior = settings.browserControlViewBehavior === 'follow' ? 'follow' : 'stay';
  const paused = browserControlStatus?.paused === true;
  const pendingApproval = browserControlStatus?.pendingApproval || null;

  const stateKey = {
    off: 'browser_control.state_off',
    reconnecting: 'ui.reconnecting',
    unavailable: 'ui.unavailable',
    unattached: 'ui.attach',
    preparing: 'ui.reconnecting',
    ready: 'browser_control.state_ready',
    active: 'browser_control.state_active',
    paused: 'browser_control.state_paused',
  }[view.state] || 'browser_control.state_off';
  els.browserControlState.textContent = t(stateKey).toUpperCase();
  els.browserControlState.dataset.state = view.state;
  els.browserControlCardDetail.textContent = translateUiText(view.detail);
  els.browserControlScopeInput.value = ['this-tab', 'selected-tabs', 'task-set'].includes(settings.browserControlScope)
    ? settings.browserControlScope
    : 'this-tab';
  els.browserControlScopeInput.disabled = enabled;
  els.browserControlStayButton.setAttribute('aria-pressed', String(viewBehavior === 'stay'));
  els.browserControlFollowButton.setAttribute('aria-pressed', String(viewBehavior === 'follow'));
  els.browserControlEnableButton.hidden = enabled && !view.canAttach;
  els.browserControlEnableButton.textContent = t(view.canAttach
    ? 'ui.attach.to.current.tab'
    : 'browser_control.enable');
  els.browserControlDetachButton.hidden = !enabled;

  els.browserControlStrip.hidden = !enabled;
  els.browserControlStrip.dataset.tone = view.tone;
  els.browserControlStripTitle.textContent = translateUiText(view.title);
  els.browserControlStripDetail.textContent = translateUiText(view.detail);
  const activeTabIdForStrip = Number(browserControlActiveTab?.id);
  const stripTabAttached = Number.isInteger(activeTabIdForStrip)
    && Array.isArray(browserControlStatus?.leasedTabIds)
    && browserControlStatus.leasedTabIds.some((tabId) => Number(tabId) === activeTabIdForStrip);
  const stripToggleMode = stripTabAttached ? 'detach' : 'attach';
  els.browserControlAttachButton.hidden = !(view.canAttach || stripTabAttached);
  els.browserControlAttachButton.dataset.mode = stripToggleMode;
  els.browserControlAttachButton.textContent = t(stripToggleMode === 'detach' ? 'browser_control.detach' : 'ui.attach');
  els.browserControlAttachButton.title = t(stripToggleMode === 'detach' ? 'browser_control.detach' : 'ui.attach.to.current.tab');
  els.browserControlAttachButton.setAttribute('aria-label', t(stripToggleMode === 'detach' ? 'browser_control.detach' : 'ui.attach.to.current.tab'));
  els.browserControlPauseButton.dataset.paused = String(paused);
  // Toggle glyphs via attributes: SVGElement does not reliably reflect the hidden property.
  const pauseGlyph = els.browserControlPauseButton.querySelector('.glyph-pause');
  const playGlyph = els.browserControlPauseButton.querySelector('.glyph-play');
  if (pauseGlyph) { if (paused) pauseGlyph.setAttribute('hidden', ''); else pauseGlyph.removeAttribute('hidden'); }
  if (playGlyph) { if (paused) playGlyph.removeAttribute('hidden'); else playGlyph.setAttribute('hidden', ''); }
  const pauseLabelKey = paused ? 'browser_control.resume' : 'browser_control.pause';
  els.browserControlPauseButton.title = t(pauseLabelKey);
  els.browserControlPauseButton.setAttribute('aria-label', t(pauseLabelKey));
  els.browserControlPauseButton.disabled = !view.canPause;
  els.browserControlStopButton.hidden = !view.canStop;
  els.browserControlApproveButton.hidden = !pendingApproval;
  els.browserControlRejectButton.hidden = !pendingApproval;
}

async function refreshBrowserControlStatus({ follow = true } = {}) {
  if (document.visibilityState === 'hidden') return browserControlStatus;
  try {
    browserControlStatus = await browserControlMessage('HERMES_CONTROLLER_STATUS');
    browserControlActiveTab = await activeTab();
    browserControlCurrentTarget = null;
    const activeTabId = Number(browserControlActiveTab?.id);
    if (browserControlStatus?.leasedTabIds?.some((tabId) => Number(tabId) === activeTabId)) {
      const candidate = browserControlCandidate({
        context: { activeTab: browserControlActiveTab },
        scope: { mode: CONTEXT_SCOPE_MODES.ACTIVE_TAB },
      });
      if (candidate) {
        browserControlCurrentTarget = await browserControlMessage('HERMES_CONTROLLER_TARGET_RESOLVE', candidate)
          .catch(() => null);
      }
    }
    renderBrowserControl();
    if (follow && settings.browserControlViewBehavior === 'follow') {
      const tab = await activeTab();
      const targetTabId = followTargetTabId({
        viewBehavior: 'follow',
        status: browserControlStatus,
        activeTabId: tab?.id,
      });
      if (targetTabId) await browserApi.tabs.update(targetTabId, { active: true });
    }
    return browserControlStatus;
  } catch {
    browserControlStatus = null;
    browserControlCurrentTarget = null;
    renderBrowserControl();
    return null;
  }
}

function scheduleBrowserControlPoll() {
  if (browserControlPollTimer) clearTimeout(browserControlPollTimer);
  browserControlPollTimer = null;
  if (settings.browserControlEnabled !== true || document.visibilityState === 'hidden') return;
  browserControlPollTimer = setTimeout(async () => {
    await refreshBrowserControlStatus();
    scheduleBrowserControlPoll();
  }, 750);
}

async function attachBrowserControlToCurrentTab() {
  await refreshBrowserControlStatus({ follow: false });
  const tab = browserControlActiveTab || await activeTab();
  if (browserControlStatus?.lastConnectFailure?.reason === 'missing_session') {
    throw new Error('Start or select a Hermes session, then attach this tab.');
  }
  const replacement = currentTabLeaseReplacement({ status: browserControlStatus || {}, activeTab: tab, allowLocalFiles: true });
  if (!replacement.ok) {
    const messages = {
      controller_busy: 'Wait for the current browser action to finish before attaching another tab.',
      controller_unavailable: 'Hermes Control is still reconnecting. Try Attach this tab again in a moment.',
      restricted_url: 'Open a normal HTTP or HTTPS page before attaching Hermes Control.',
    };
    throw new Error(messages[replacement.error] || 'This tab cannot be attached right now.');
  }
  if (replacement.releaseTabIds.length) {
    const released = await browserControlMessage('HERMES_CONTROLLER_LEASE_RELEASE', {
      ownerId: replacement.ownerId,
      tabIds: replacement.releaseTabIds,
    });
    if (!released?.ok) throw new Error(released?.error || 'Could not release the previous tab lease.');
  }
  const acquired = await browserControlMessage('HERMES_CONTROLLER_LEASE_ACQUIRE', replacement.acquire);
  if (!acquired?.ok) throw new Error(acquired?.error || 'Could not lease this tab.');
  const candidate = browserControlCandidate({
    context: { activeTab: tab },
    scope: { mode: CONTEXT_SCOPE_MODES.ACTIVE_TAB },
  });
  const resolved = candidate ? await resolveBrowserControlCandidate(candidate) : null;
  if (resolved?.availability !== 'available' || resolved?.leaseOwned !== true) {
    await refreshBrowserControlStatus({ follow: false });
    throw new Error('This tab is leased but its page is not ready yet. Wait for the page to finish loading, then attach it again.');
  }
  await persistBrowserControlPreferences({
    browserControlScope: 'this-tab',
    browserControlPaused: false,
  });
  browserControlActiveTab = tab;
  browserControlCurrentTarget = resolved;
  await refreshBrowserControlStatus({ follow: false });
  scheduleBrowserControlPoll();
  showOperationToast({ title: 'This tab is attached', detail: 'Hermes Control is ready for the first browser action.' });
  return resolved;
}

async function enableBrowserControl() {
  if (settings.browserControlEnabled === true) {
    return attachBrowserControlToCurrentTab();
  }
  if (!String(settings.sessionId || '').trim()) {
    throw new Error('Start or select a Hermes session before enabling control.');
  }
  const tab = await activeTab();
  const scope = els.browserControlScopeInput.value;
  const leaseRequest = controlLeaseRequest({
    scope,
    activeTab: tab,
    selectedTabs,
    taskSetId: browserControlTaskSetId(),
  });
  if (!leaseRequest.ok) {
    throw new Error(leaseRequest.error === 'explicit_selection_required'
      ? 'Select one or more tabs in the Browser context scope before enabling this control scope.'
      : 'A supported active tab is required.');
  }

  try {
    await persistBrowserControlPreferences({
      browserControlEnabled: true,
      browserControlPaused: false,
      browserControlScope: scope,
    });
    const rebound = await browserControlMessage('HERMES_CONTROLLER_SETTINGS_REFRESH');
    if (!rebound?.ok) throw new Error(rebound?.error || 'Controller capability refresh failed.');
    const acquired = await browserControlMessage('HERMES_CONTROLLER_LEASE_ACQUIRE', {
      ...leaseRequest,
      ownership: 'owned',
      ownerId: rebound.controllerId,
    });
    if (!acquired?.ok) throw new Error(acquired?.error || 'Could not lease the selected tabs.');
    await refreshBrowserControlStatus({ follow: false });
    scheduleBrowserControlPoll();
    showOperationToast({ title: t('browser_control.enabled_toast'), detail: t('browser_control.enabled_detail') });
  } catch (error) {
    await persistBrowserControlPreferences({ browserControlEnabled: false, browserControlPaused: false });
    await browserControlMessage('HERMES_CONTROLLER_SETTINGS_REFRESH').catch(() => null);
    throw error;
  }
}

async function detachBrowserControl() {
  await browserControlMessage('HERMES_CONTROLLER_DETACH');
  settings = { ...settings, browserControlEnabled: false, browserControlPaused: false };
  browserControlStatus = null;
  renderBrowserControl();
  scheduleBrowserControlPoll();
  showOperationToast({ title: t('browser_control.detached_toast'), detail: t('browser_control.detached_detail') });
}

async function setBrowserControlViewBehavior(value) {
  const viewBehavior = value === 'follow' ? 'follow' : 'stay';
  await persistBrowserControlPreferences({ browserControlViewBehavior: viewBehavior });
  renderBrowserControl();
  if (viewBehavior === 'follow') await refreshBrowserControlStatus();
}

async function toggleBrowserControlPause() {
  const type = browserControlStatus?.paused ? 'HERMES_CONTROLLER_RESUME' : 'HERMES_CONTROLLER_PAUSE';
  browserControlStatus = await browserControlMessage(type);
  settings = { ...settings, browserControlPaused: browserControlStatus?.paused === true };
  renderBrowserControl();
}

async function decideBrowserControlApproval(approved) {
  const pendingApproval = browserControlStatus?.pendingApproval;
  if (!pendingApproval) return;
  const type = approved ? 'HERMES_CONTROLLER_APPROVAL_GRANT' : 'HERMES_CONTROLLER_APPROVAL_REJECT';
  const result = await browserControlMessage(type, {
    approvalId: pendingApproval.approvalId,
    approvalNonce: pendingApproval.approvalNonce,
    commandId: pendingApproval.commandId,
    controllerId: pendingApproval.controllerId,
    leaseId: pendingApproval.leaseId,
    leaseGeneration: pendingApproval.leaseGeneration,
    action: pendingApproval.action,
    tabId: pendingApproval.tabId,
    frameId: 0,
    documentGeneration: pendingApproval.documentGeneration,
    state: pendingApproval.state,
  });
  if (!result?.ok) throw new Error(result?.error || 'Approval decision was not accepted.');
  await refreshBrowserControlStatus();
}

function hideOperationToast() {
  if (operationToastTimer) clearTimeout(operationToastTimer);
  operationToastTimer = null;
  if (els.operationToast) els.operationToast.hidden = true;
}

function positionOperationToast() {
  if (!els.operationToast || els.operationToast.hidden) return;
  // If settings dialog is open, place toast neatly docked at the bottom of the viewport
  if (els.settingsDialog && !els.settingsDialog.hidden) {
    els.operationToast.style.top = 'auto';
    els.operationToast.style.bottom = '16px';
    return;
  }
  const composerTop = els.composer?.getBoundingClientRect().top;
  if (!Number.isFinite(composerTop) || composerTop <= 0) {
    els.operationToast.style.top = 'auto';
    els.operationToast.style.bottom = '16px';
    return;
  }
  els.operationToast.style.bottom = 'auto';
  els.operationToast.style.top = `${Math.max(58, Math.round(composerTop - els.operationToast.offsetHeight - 10))}px`;
}

function showOperationToast({ kind = 'ok', title = 'Hermes Browser', detail = '', duration = 5200 } = {}) {
  if (!els.operationToast) return;
  hideOperationToast();
  els.operationToast.className = `operation-toast ${kind}`.trim();
  els.operationToastTitle.textContent = translateUiText(title);
  els.operationToastDetail.textContent = translateUiText(detail);
  els.operationToast.hidden = false;
  positionOperationToast();
  if (duration > 0) operationToastTimer = setTimeout(hideOperationToast, duration);
}

function renderVersionInfo(statusText = '') {
  if (els.versionLabel) els.versionLabel.textContent = `v${CURRENT_EXTENSION_VERSION}`;
  if (els.updateStatus) {
    els.updateStatus.textContent = translateUiText(statusText || 'Updates are checked against the public GitHub repo.');
  }
}

function currentExtensionOrigin() {
  try {
    const url = browserApi?.runtime?.getURL?.('') || '';
    return url.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function currentBrowserPlatformSnapshot() {
  const product = detectBrowserProduct({
    userAgent: navigator.userAgent,
    brands: navigator.userAgentData?.brands || [],
    braveApi: navigator.brave,
    extensionUrl: browserApi?.runtime?.getURL?.('') || '',
  });
  const capabilities = probeBrowserCapabilities({
    product,
    api: browserApi,
    sidebarAction: globalThis.opr?.sidebarAction || browserApi?.sidebarAction || null,
  });
  return {
    product,
    capabilities,
    controllerAdapter: controllerAdapterContractFor({ product, capabilities }),
  };
}

function currentGatewaySummary(overrides = {}) {
  return gatewayConnectionSummary({
    gatewayMode: overrides.gatewayMode ?? settings.gatewayMode,
    gatewayUrl: overrides.gatewayUrl ?? settings.gatewayUrl,
    extensionOrigin: currentExtensionOrigin(),
  });
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
  } else if (transportUsesDashboardTicket(transport)) {
    const supplied = dashboardPrincipal !== undefined;
    const principal = supplied
      ? dashboardPrincipalFromMe(dashboardPrincipal)
      : (contextConsentBindingMatches(source) ? contextConsentPrincipalBinding.principal : '');
    contextConsentPrincipalBinding = { origin, transport, principal };
  } else {
    const principal = source.apiKey
      ? `api:${await fingerprintContextCredential(source.apiKey)}`
      : '';
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
    profile: source.activeProfile || DEFAULT_SETTINGS.activeProfile,
    controller: currentContextConsentController(),
    transport: source.connectionTransport,
  });
}

function effectiveContextGate(scope = contextScope, source = settings) {
  return contextScopeWithConsent(scope, {
    gatewayUrl: source.gatewayUrl,
    connectionTransport: source.connectionTransport,
    identity: currentContextConsentIdentity(source),
    ledger: source.browserContextConsentLedger,
  });
}

async function refreshContextConsentLedger(settingsOverride = settings) {
  const stored = await browserApi.storage.local.get([CONTEXT_CONSENT_STORAGE_KEY]);
  const sendTimeSettings = {
    ...settingsOverride,
    browserContextConsentLedger: normalizeContextConsentLedger(stored?.[CONTEXT_CONSENT_STORAGE_KEY]),
  };
  await refreshContextConsentPrincipal({ settingsOverride: sendTimeSettings });
  return sendTimeSettings;
}

function renderBrowserContextConsentControl() {
  if (!els.browserContextConsentControl || !els.browserContextConsentInput) return;
  const required = consentRequiredForConnection({ gatewayUrl: settings.gatewayUrl });
  els.browserContextConsentControl.hidden = !required;
  if (!required) {
    els.browserContextConsentInput.checked = true;
    els.browserContextConsentInput.disabled = true;
    for (const contextInput of [els.includeTabsInput, els.includePageTextInput, els.includeSelectedTextInput]) {
      if (contextInput) contextInput.disabled = false;
    }
    return;
  }
  const identity = currentContextConsentIdentity();
  const granted = Boolean(identity) && consentGrantedForIdentity(settings.browserContextConsentLedger, identity);
  els.browserContextConsentInput.checked = granted;
  els.browserContextConsentInput.disabled = !identity;
  if (els.browserContextConsentIdentity) {
    els.browserContextConsentIdentity.textContent = identity
      ? `${identity.origin} · ${identity.profile} · verified ${transportUsesDashboardTicket(identity.transport) ? 'dashboard account' : 'API credential'}`
      : 'Reconnect or test this connection to verify its account before sharing page context.';
  }
  for (const contextInput of [els.includeTabsInput, els.includePageTextInput, els.includeSelectedTextInput]) {
    if (!contextInput) continue;
    contextInput.disabled = !granted;
    contextInput.title = granted ? '' : 'Chat only until this exact connection is approved.';
  }
}

async function setBrowserContextConsent(granted) {
  await refreshContextConsentPrincipal();
  const identity = currentContextConsentIdentity();
  if (!identity) throw new Error('Reconnect or test this connection before sharing page context.');
  const ledger = await persistContextConsentDecision({
    storageArea: browserApi.storage.local,
    identity,
    granted: Boolean(granted),
  });
  settings = { ...settings, browserContextConsentLedger: ledger };
  renderBrowserContextConsentControl();
  await refreshContext();
}

function renderGatewayHelp() {
  const connectionMode = normalizeConnectionMode(els.connectionModeInput?.value || settings.connectionMode);
  const summary = currentGatewaySummary({
    gatewayMode: els.gatewayModeInput?.value || settings.gatewayMode,
    gatewayUrl: els.gatewayUrlInput?.value || settings.gatewayUrl,
  });
  if (els.gatewayHelp) {
    els.gatewayHelp.textContent = translateUiText(connectionMode === 'cloud'
      ? 'Hermes Cloud uses Trusted Dashboard Attach. Open the signed-in agent dashboard in the active tab, then choose Test connection. Cloud connections are Chat-only.'
      : summary.setupHint);
  }
  if (els.gatewayUrlInput) els.gatewayUrlInput.placeholder = summary.mode.defaultUrl || DEFAULT_SETTINGS.gatewayUrl;
  renderBrowserContextConsentControl();
}

// The "Connected agent" port scanner is meaningless in remote-dashboard mode
// (transport is the dashboard WebSocket on 443, not a local sidecar on
// 8642-8646). Disable the scanner controls there so they can't imply
// Dashboard Attach is offline, and surface a clear non-blocking note.
function renderAgentDiscoveryAvailability() {
  const applicable = agentDiscoveryAppliesToMode(els.gatewayModeInput?.value || settings.gatewayMode);
  for (const control of [els.refreshAgentsButton, els.addCustomAgentButton, els.agentHostInput, els.agentSchemeInput, els.agentPortsInput]) {
    if (control && 'disabled' in control) control.disabled = !applicable;
  }
  if (els.agentPickerStatus) {
    els.agentPickerStatus.textContent = applicable
      ? 'Agent discovery has not run yet.'
      : agentDiscoveryModeNote(els.gatewayModeInput?.value || settings.gatewayMode);
  }
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
  if (!shouldShow) {
    renderStatusActions();
    return;
  }
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
  renderStatusActions();
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
  els.copyDiagnosticsButton.textContent = translateUiText('Copying...');
  if (els.diagnosticsCopyStatus) els.diagnosticsCopyStatus.textContent = translateUiText('Building redacted diagnostics...');
  try {
    const buildInfo = await loadExtensionBuildInfo().catch(() => ({}));
    const state = currentConnectionState();
    const browserPlatform = currentBrowserPlatformSnapshot();
    const diagnostics = buildSupportDiagnostics({
      extensionVersion: CURRENT_EXTENSION_VERSION,
      extensionOrigin: currentExtensionOrigin(),
      buildInfo,
      userAgent: navigator.userAgent,
      browserProduct: browserPlatform.product,
      browserCapabilities: browserPlatform.capabilities,
      controllerAdapter: browserPlatform.controllerAdapter,
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
    if (els.diagnosticsCopyStatus) els.diagnosticsCopyStatus.textContent = translateUiText('Copied redacted diagnostics. Paste them into the GitHub issue or support thread.');
    setStatus('ok', 'Diagnostics copied', 'Redacted support diagnostics are on your clipboard.');
  } catch (error) {
    if (els.diagnosticsCopyStatus) els.diagnosticsCopyStatus.textContent = translateUiText('Could not copy diagnostics. Check browser clipboard permissions.');
    setStatus('warn', 'Diagnostics copy failed', error?.message || String(error), { translateDetail: false });
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

function fullViewHandoffUrl() {
  const sourceSurfaceId = createSurfaceId({
    kind: SURFACE_KINDS.SIDE_PANEL,
    instanceId: ensureSidepanelInstanceId(),
  });
  const url = buildFullTabHandoffUrl({
    runtimeUrl: (path) => browserApi.runtime.getURL(path),
    entryPath: fullTabEntryPathForPage(globalThis.location?.href || ''),
    newChat: true,
    sourceTabId: sidePanelParams.tabId,
    sourceSurfaceId,
  });
  return url;
}

async function openFullView() {
  const url = fullViewHandoffUrl();
  return openHermesFullView({
    url,
    tabsApi: browserApi.tabs,
    runtimeApi: browserApi.runtime,
    windowOpen: globalThis.open?.bind(globalThis),
  });
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
  const stored = await browserApi.storage.local.get([key]);
  messages = Array.isArray(stored[key]) ? stored[key] : [];
  const visibleTokens = estimateLocalSessionContextTokens({ messages: browserDisplayMessages(messages) });
  loadedSessionContextEstimate = {
    sessionId: settings.sessionId,
    contextTokens: visibleTokens,
    visibleTokens,
  };
  renderMessagesFromStorage();
}

async function saveMessagesForActiveScope() {
  const key = activeMessagesStorageKey(previousConversationScope);
  const cachedMessages = messagesForLocalCache(messages, settings.maxLocalMessages);
  await browserApi.storage.local.set({ [key]: cachedMessages });
}

async function loadSessionBindingForActiveScope() {
  if (previousConversationScope.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB) return null;
  const key = sessionBindingKeyForScope(contextScope, previousConversationScope);
  const stored = await browserApi.storage.local.get([key]);
  return stored[key] || null;
}

async function saveSessionBindingForActiveScope(session) {
  if (previousConversationScope.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB || !session?.id) return;
  const key = sessionBindingKeyForScope(contextScope, previousConversationScope);
  // Bind the stored session to the gateway + profile that created it so resume
  // cannot silently cross profile boundaries if the user switches profiles.
  const identity = sessionBindingIdentity({
    gatewayUrl: normalizeGatewayUrl(settings.gatewayUrl),
    gatewayMode: settings.gatewayMode,
    profile: safeActiveProfile(),
  });
  await browserApi.storage.local.set({
    [key]: withSessionBindingIdentity({
      sessionId: session.id,
      sessionTitle: session.title || session.id,
      pinnedTabId: previousConversationScope.pinnedTabId,
      pinnedTitle: previousConversationScope.pinnedTitle || '',
      pinnedUrl: previousConversationScope.pinnedUrl || '',
      updatedAt: Date.now(),
    }, identity),
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

function contextScopeLabel(scope = contextScope) {
  if (scope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) return 'Chat only';
  if (scope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB) {
    if (isAttachedPanelResidency() && Number(scope.pinnedTabId) === Number(sidePanelParams.tabId)) {
      return scope.pinnedTitle ? `Attached: ${scope.pinnedTitle}` : 'Attached tab';
    }
    return scope.pinnedTitle ? `Pinned: ${scope.pinnedTitle}` : 'Pinned tab';
  }
  return isGlobalPanelResidency() ? 'Follow active tab' : 'Attached tab';
}

function renderContextScopeControls() {
  if (!els.contextScopeButton || !els.contextScopeLabel) return;
  const visibleScope = effectiveContextGate(contextScope).scope;
  const pinned = visibleScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB;
  const chatOnly = visibleScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY;
  els.contextScopeLabel.textContent = translateUiText(contextScopeLabel(visibleScope));
  els.contextScopeButton.classList.toggle('active', pinned || chatOnly);
  els.contextScopeButton.setAttribute('aria-expanded', String(!els.contextScopeMenu?.hidden));
  els.contextScopeButton.title = chatOnly
    ? 'Hermes is in Chat only mode and will not read browser context'
    : pinned
      ? (isAttachedPanelResidency() && Number(visibleScope.pinnedTabId) === Number(sidePanelParams.tabId)
        ? `Hermes is attached to ${visibleScope.pinnedUrl || visibleScope.pinnedTitle || 'this browser tab'}`
        : `Hermes is pinned to ${visibleScope.pinnedUrl || visibleScope.pinnedTitle || 'this tab'}`)
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
      label: t('context.pin_tab', { title: compactPinnedTitle(tab.title || tab.url || translateUiText('Untitled tab'), 88) }),
      detail: translateUiText(isPinned ? 'current' : isActive ? 'active' : ''),
      selected: isPinned,
      parent: row,
    }).classList.add('context-scope-pin-action');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'context-scope-include-toggle';
    toggle.dataset.promptTabToggle = String(tab.id);
    toggle.setAttribute('aria-pressed', String(isIncluded));
    toggle.title = translateUiText(isIncluded ? 'Remove this tab from the prompt tab list' : 'Include this tab in the prompt tab list');
    toggle.textContent = translateUiText(isIncluded ? 'IN' : 'OUT');
    if (isIncluded) toggle.classList.add('selected');
    row.appendChild(toggle);
    list.appendChild(row);
  }
  if (!filteredTabs.length) {
    const empty = document.createElement('p');
    empty.className = 'context-scope-empty';
    empty.textContent = translateUiText('No matching tabs');
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
  title.textContent = translateUiText('Tabs in prompt');
  const count = document.createElement('small');
  count.textContent = `${promptTabsCount(tabs)}/${tabs.length}`;
  header.append(title, count);

  const actions = document.createElement('div');
  actions.className = 'context-scope-prompt-actions';
  appendContextScopeMenuButton({
    action: 'prompt-tabs-all',
    label: translateUiText('Include all tabs'),
    detail: `${tabs.length}`,
    selected: selectedTabs === null,
    parent: actions,
  });
  appendContextScopeMenuButton({
    action: 'prompt-tabs-none',
    label: translateUiText('Page only'),
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
    label: translateUiText('Chat only'),
    detail: translateUiText('no page'),
    selected: contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY,
    parent: actions,
  });
  if (isGlobalPanelResidency()) {
    appendContextScopeMenuButton({
      action: 'follow-active',
      label: translateUiText('Follow active tab'),
      detail: translateUiText('live'),
      selected: contextScope.mode === CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE,
      parent: actions,
    });
  } else if (contextScope.mode === CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE) {
    syncAttachedPanelContextScope();
  }
  appendContextScopeMenuButton({ action: 'pin-active', label: translateUiText('Pin current tab'), detail: translateUiText('lock'), parent: actions });
  if (isGlobalPanelResidency() && contextScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB) {
    appendContextScopeMenuButton({ action: 'unlock', label: translateUiText('Unlock pinned tab'), detail: translateUiText('follow'), parent: actions });
  }
  els.contextScopeMenu.appendChild(actions);

  const tabs = currentContext.tabs || [];
  if (tabs.length) {
    els.contextScopeMenu.appendChild(renderContextScopePromptControls(tabs));

    const search = document.createElement('input');
    search.className = 'context-scope-search';
    search.type = 'search';
    search.placeholder = translateUiText('Search tabs');
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
  if (!minimumConnectionReady()) return;
  const binding = await loadSessionBindingForActiveScope();
  // Never resume a stored session under a different gateway + profile than the
  // one that created it. A mismatched binding is stale; drop it and start fresh
  // so the user's Chat-only history never silently crosses into another profile.
  if (binding?.sessionId) {
    const currentIdentity = sessionBindingIdentity({
      gatewayUrl: normalizeGatewayUrl(settings.gatewayUrl),
      gatewayMode: settings.gatewayMode,
      profile: safeActiveProfile(),
    });
    if (isSessionBindingValid(binding, currentIdentity)) {
      const session = availableSessions.find((item) => item.id === binding.sessionId) || {
        id: binding.sessionId,
        title: binding.sessionTitle || binding.sessionId,
        source: DEFAULT_SETTINGS.sessionSource,
      };
      await openHermesSession(session);
      return;
    }
    // Mismatched profile/gateway: forget the binding so we don't resume the
    // wrong profile's chat. The stored messages for this scope stay until the
    // new session overwrites them.
    const key = sessionBindingKeyForScope(contextScope, previousConversationScope);
    await browserApi.storage.local.remove([key]);
  }
  await beginHermesBrowserDraft({ title: makePinnedTabSessionTitle(currentContext.activeTab || previousConversationScope), focus });
}

async function initializeSessionForPanelOpen({ focus = false } = {}) {
  if (!minimumConnectionReady()) return;
  if (shouldCreateFreshSessionOnOpen(settings)) {
    await beginHermesBrowserDraft({ title: makeBrowserSessionTitle(), focus });
    setStatus('ok', 'New Hermes Browser Extension draft', 'Saved when you send the first message.');
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
    const freshTab = await browserApi.tabs.get(id);
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
  const nextDeveloperMode = gatewayCapabilities.browserControlDeveloperMode === true;
  const nextArtifactTransport = gatewayCapabilities.browserControlArtifactTransport === true;
  if (settings.browserControlDeveloperMode !== nextDeveloperMode
    || settings.browserControlArtifactTransport !== nextArtifactTransport) {
    settings = {
      ...settings,
      browserControlDeveloperMode: nextDeveloperMode,
      browserControlArtifactTransport: nextArtifactTransport,
    };
    void browserApi.storage.local.get('hermesBrowserSettings')
      .then((stored) => browserApi.storage.local.set({
        hermesBrowserSettings: {
          ...(stored?.hermesBrowserSettings || {}),
          browserControlDeveloperMode: nextDeveloperMode,
          browserControlArtifactTransport: nextArtifactTransport,
        },
      }))
      .then(() => browserControlMessage('HERMES_CONTROLLER_SETTINGS_REFRESH'))
      .catch(() => undefined);
  }
  renderCompatibilityPanel();
  renderInlineAssistModelOptions();
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

// Product mode (Local / Cloud / Remote) is separate from the compatibility
// transport (local-api / remote-api / remote-dashboard). Existing transport
// predicates remain authoritative until the later broker phases replace them.
function renderConnectionModeCards() {
  const mode = normalizeConnectionMode(els.connectionModeInput?.value || settings.connectionMode);
  for (const card of document.querySelectorAll('[data-connection-mode]')) {
    const selected = card.dataset.connectionMode === mode;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-checked', String(selected));
  }
}

function renderConnectionModePanel() {
  const mode = normalizeConnectionMode(els.connectionModeInput?.value || settings.connectionMode);
  if (els.apiKeyField) els.apiKeyField.hidden = mode === 'cloud';
  if (els.gatewayUrlField) els.gatewayUrlField.hidden = mode === 'cloud';
  if (els.cloudPreviewHelp) els.cloudPreviewHelp.hidden = mode !== 'cloud';
  renderGatewayHelp();
}

function applyConnectionMode(value) {
  if (!els.connectionModeInput || !els.gatewayModeInput) return;
  const previousMode = normalizeConnectionMode(els.connectionModeInput.value || settings.connectionMode);
  const connectionMode = normalizeConnectionMode(value);
  const connectionTransport = resolvePhaseATransport({
    connectionMode,
    currentTransport: connectionMode === 'remote'
      ? (String(els.apiKeyInput?.value || '').trim() ? CONNECTION_TRANSPORTS.REMOTE_API : CONNECTION_TRANSPORTS.REMOTE_DASHBOARD)
      : settings.connectionTransport,
    apiKey: els.apiKeyInput?.value || settings.apiKey,
  });
  const gatewayMode = legacyGatewayModeForConnection({ connectionMode, connectionTransport });

  els.connectionModeInput.value = connectionMode;
  els.gatewayModeInput.value = gatewayMode;
  if (previousMode !== connectionMode) {
    connectionController.cancel('connection settings changed');
    try {
      remoteWsConnection?.client?.close();
    } catch {
      /* ignore */
    }
    remoteWsConnection = null;
    trustedDashboardTabId = null;
    if (els.connectButton) {
      els.connectButton.disabled = false;
      els.connectButton.textContent = translateUiText('Connect to Hermes');
    }
    if (els.testConnectionButton) {
      setTestConnectionBusy(false);
      setTestConnectionButtonLabel('TEST');
      els.testConnectionButton.classList.remove('success', 'error');
    }
  }

  const summary = currentGatewaySummary({ gatewayMode, gatewayUrl: els.gatewayUrlInput?.value });
  els.gatewayUrlInput.value = connectionModePreviewUrl({
    connectionMode,
    currentUrl: els.gatewayUrlInput.value,
    localDefaultUrl: DEFAULT_SETTINGS.gatewayUrl,
    transportDefaultUrl: summary.mode.defaultUrl,
  });
  renderConnectionModeCards();
  renderConnectionModePanel();
}

async function fetchJsonNoStore(url) {
  const response = await fetch(`${url}${String(url).includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error(`Fetch failed (${response.status})`);
  return response.json();
}

async function loadExtensionBuildInfo() {
  const runtime = browserApi?.runtime;
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

async function fetchMainSourceBlobs(latestCommit = '') {
  const commit = normalizeGitCommit(latestCommit);
  if (!commit) return null;
  const payload = await fetchJsonNoStore(`${UPDATE_MAIN_TREE_URL}/${encodeURIComponent(commit)}?recursive=1`);
  if (payload?.truncated || !Array.isArray(payload?.tree)) return null;
  const rows = payload.tree
    .filter((entry) => entry?.type === 'blob' && String(entry?.path || '').startsWith('extension/'))
    .map((entry) => [
      String(entry.path).slice('extension/'.length),
      normalizeGitCommit(entry.sha),
    ])
    .filter(([filePath, sha]) => filePath && filePath !== 'build-info.json' && sha)
    .sort(([left], [right]) => left.localeCompare(right));
  return rows.length ? Object.fromEntries(rows) : null;
}

async function commitsBehindMainForBuild(currentCommit = '', latestCommit = '') {
  const currentSha = normalizeGitCommit(currentCommit);
  const latestSha = normalizeGitCommit(latestCommit);
  if (!currentSha) return { commitsBehind: null, commitsAhead: 0, alignment: 'unverified', commits: [] };
  if (latestSha && currentSha === latestSha) return { commitsBehind: 0, commitsAhead: 0, alignment: 'identical', commits: [] };
  const head = latestSha || 'main';
  const response = await fetch(`${UPDATE_COMPARE_URL}/${encodeURIComponent(currentSha)}...${encodeURIComponent(head)}?t=${Date.now()}`, { cache: 'no-store', redirect: 'error' });
  if (!response.ok) return { commitsBehind: null, commitsAhead: 0, alignment: 'unverified', commits: [] };
  const payload = await response.json().catch(() => ({}));
  const commitsBehind = Math.max(0, Number.parseInt(payload.ahead_by, 10) || 0);
  const commitsAhead = Math.max(0, Number.parseInt(payload.behind_by, 10) || 0);
  const alignment = commitsBehind > 0 && commitsAhead > 0
    ? 'diverged'
    : commitsBehind > 0
      ? 'main-ahead'
      : commitsAhead > 0
        ? 'build-ahead'
        : 'identical';
  return {
    commitsBehind,
    commitsAhead,
    alignment,
    commits: (Array.isArray(payload.commits) ? payload.commits : [])
      .slice(-12)
      .reverse()
      .map((commit) => ({ sha: commit?.sha || '', message: commit?.commit?.message || '' })),
  };
}

function closeUpdateDialog({ restoreFocus = true } = {}) {
  if (!els.updateDialog) return;
  els.updateDialog.hidden = true;
  els.updateDialog.setAttribute('aria-hidden', 'true');
  if (restoreFocus) els.reviewUpdateButton?.focus();
}

function renderUpdateDialog(review = { loading: true }) {
  if (!els.updateDialog) return;
  els.updateDialog.hidden = false;
  els.updateDialog.setAttribute('aria-hidden', 'false');
  els.updateDialogTitle.textContent = review.loading ? translateUiText('Checking Browser main…') : (review.title || translateUiText('Browser update review'));
  els.updateDialogSummary.textContent = review.loading
    ? translateUiText('Comparing this loaded build with the public GitHub repository.')
    : (review.summary || translateUiText('Update details are unavailable.'));
  els.updateChangeGroups.innerHTML = '';
  if (review.error || review.loading || !review.groups?.length) {
    const empty = document.createElement('p');
    empty.className = 'update-change-empty';
    empty.textContent = review.error || (review.loading
      ? translateUiText('Reading version and commit metadata…')
      : (review.emptyMessage || translateUiText('No newer public commits were found for this build.')));
    els.updateChangeGroups.appendChild(empty);
  } else {
    for (const group of review.groups) {
      const section = document.createElement('section');
      section.className = 'update-change-group';
      const title = document.createElement('h3');
      title.textContent = group.label;
      const list = document.createElement('ul');
      for (const item of group.items) {
        const row = document.createElement('li');
        row.textContent = item.title;
        if (item.sha) {
          const sha = document.createElement('code');
          sha.textContent = ` ${item.sha}`;
          row.appendChild(sha);
        }
        list.appendChild(row);
      }
      section.append(title, list);
      els.updateChangeGroups.appendChild(section);
    }
  }
  els.updateNowButton.hidden = !review.available;
  els.maybeLaterButton.textContent = translateUiText(review.available ? 'MAYBE LATER' : 'CLOSE');
  els.updateInstallNote.textContent = review.available
    ? translateUiText('Update now starts a guarded Hermes agent turn. It will stop on local changes, build dist/, and reload through computer-use when available.')
    : translateUiText('This check compares the loaded build metadata with the public Hermes Browser repository.');
  (review.available ? els.updateNowButton : els.maybeLaterButton)?.focus({ preventScroll: true });
}

function launchBrowserUpdateWithHermes() {
  const review = latestUpdateReview || {};
  const updatePrompt = [
    'Update my Hermes Browser Extension from the official repository: https://github.com/abundantbeing/hermes-browser-extension',
    `The Browser update review reports ${review.commitCount || 'new'} public commit${review.commitCount === 1 ? '' : 's'} available.`,
    'First locate the existing Hermes Browser Extension checkout that this user intends to update.',
    'If the checkout has uncommitted changes, stop and report them. Do not discard, overwrite, commit, or push any local work.',
    'If it is clean, fetch and fast-forward the current branch from the official remote, install dependencies only if required, and run npm run build.',
    'After a successful build, use computer-use to reload the unpacked dist/ extension from chrome://extensions when available. Otherwise tell me exactly how to reload it manually.',
    'Verify the extension build before reporting success.',
  ].join('\n\n');
  closeUpdateDialog({ restoreFocus: false });
  closeSettingsDialog();
  els.input.value = updatePrompt;
  els.input.dispatchEvent(new Event('input', { bubbles: true }));
  if (!isConnected() || sending) {
    showOperationToast({ kind: 'warn', title: 'Update prompt ready', detail: sending ? 'Send it when the current Hermes run finishes.' : 'Connect to Hermes, then send the prepared update request.' });
    els.input.focus();
    return;
  }
  showOperationToast({ title: 'Handing update to Hermes', detail: 'Hermes will stop before changing a dirty checkout.' });
  requestAnimationFrame(() => els.composer.requestSubmit());
}

async function checkForUpdates({ openReview = false } = {}) {
  if (!els.checkUpdatesButton) return;
  els.checkUpdatesButton.disabled = true;
  if (els.reviewUpdateButton) els.reviewUpdateButton.disabled = true;
  els.checkUpdatesButton.textContent = translateUiText('Checking...');
  renderVersionInfo('Checking GitHub main and this loaded build commit...');
  if (openReview) renderUpdateDialog({ loading: true });
  try {
    const [buildInfo, latestInfo] = await Promise.all([
      loadExtensionBuildInfo(),
      fetchLatestUpdateInfo(),
    ]);
    const currentCommit = normalizeGitCommit(buildInfo?.commit);
    const buildDirty = Boolean(buildInfo?.dirty);
    const commitMatchesMain = Boolean(currentCommit && latestInfo.latestCommit && currentCommit === latestInfo.latestCommit);
    let sourceMatchesMain = false;
    let comparison;
    if (!buildDirty) {
      comparison = await commitsBehindMainForBuild(currentCommit, latestInfo.latestCommit);
    } else {
      const mainSourceBlobs = await fetchMainSourceBlobs(latestInfo.latestCommit).catch(() => null);
      sourceMatchesMain = sourceBlobMapsMatch(buildInfo?.sourceBlobs, mainSourceBlobs);
      comparison = sourceMatchesMain
        ? { commitsBehind: 0, commitsAhead: 0, alignment: 'source-current', commits: [] }
        : commitMatchesMain
          ? { commitsBehind: 0, commitsAhead: 0, alignment: 'custom-current', commits: [] }
          : { commitsBehind: null, commitsAhead: 0, alignment: 'custom', commits: [] };
    }
    const status = formatUpdateStatus({
      latestVersion: latestInfo.latestVersion,
      currentVersion: CURRENT_EXTENSION_VERSION,
      currentCommit,
      latestCommit: latestInfo.latestCommit,
      commitsBehind: comparison.commitsBehind,
      commitsAhead: comparison.commitsAhead,
      alignment: comparison.alignment,
      buildDirty,
      sourceMatchesMain,
    });
    latestUpdateReview = {
      ...updateReviewState({
        latestVersion: latestInfo.latestVersion,
        currentVersion: CURRENT_EXTENSION_VERSION,
        commitsBehind: comparison.commitsBehind,
        commitsAhead: comparison.commitsAhead,
        alignment: comparison.alignment,
        commits: comparison.commits,
      }),
      currentCommit,
      latestCommit: latestInfo.latestCommit,
      sourceMatchesMain,
    };
    renderVersionInfo(status);
    if (openReview) renderUpdateDialog(latestUpdateReview);
    return latestUpdateReview;
  } catch (error) {
    const detail = `${error?.message || String(error)} Open ${REPO_URL} for manual update instructions.`;
    renderVersionInfo(detail);
    if (openReview) renderUpdateDialog({ title: 'Update check unavailable', summary: 'Hermes Browser could not read public update metadata.', error: detail });
    return null;
  } finally {
    els.checkUpdatesButton.disabled = false;
    if (els.reviewUpdateButton) els.reviewUpdateButton.disabled = false;
    els.checkUpdatesButton.textContent = translateUiText('Check');
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
      els.sendButton.textContent = translateUiText('Checking...');
      els.connectStatus.textContent = `Checking ${summary.title} at ${summary.normalizedUrl}...`;
      setStatus('warn', 'Checking Hermes', `${summary.title}: ${summary.normalizedUrl}`);
    } else if (state.state === 'unreachable') {
      els.sendButton.textContent = translateUiText('Reconnect');
      els.connectStatus.textContent = currentConnectionTroubleshooting(state);
      setStatus(
        'error',
        'Hermes API unavailable',
        currentConnectionTroubleshooting(state) || t('status.connection_not_responding', { summary: summary.title }),
        { translateDetail: false },
      );
    } else {
      els.sendButton.textContent = translateUiText('Connect first');
      if (isRemoteWsMode()) {
        els.connectStatus.textContent = translateUiText('Enter your dashboard https URL in Settings and sign in to it in a browser tab.');
        setStatus('warn', 'Set a remote dashboard', 'Enter your dashboard https URL in Settings and sign in to it in a browser tab.');
      } else {
        els.connectStatus.textContent = `${summary.title}. Click Connect to Hermes or use Manual setup.`;
        setStatus('warn', 'Connect Hermes', `${summary.title}. Click Connect to Hermes or use Manual setup.`);
      }
    }
  } else {
    els.sendButton.textContent = translateUiText(sending ? 'Hermes running' : 'Ask Hermes');
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
    button.title = translateUiText(state.label);
    button.setAttribute('aria-label', translateUiText(state.label));
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
  renderRunControlRecovery();
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
    if (isConnected()) els.sendButton.textContent = translateUiText(state.mainButton.label);
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
    setStatus('warn', 'Steer failed', error?.message || String(error), { translateDetail: false });
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
    setStatus('warn', 'Steer failed', error?.message || String(error), { translateDetail: false });
    els.input.focus();
    return false;
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || error || ''));
}

async function reconcileActiveRunTerminal({ stopRequested = false, dashboardSessionId = '', expectedGeneration = runControlGeneration } = {}) {
  const reconciliationRunId = String(activeRunId || '');
  if (!isRemoteWsMode() && !gatewayCapabilities.runStatus) {
    throw new Error('Connected Hermes runtime does not explicitly advertise run status reconciliation.');
  }
  const readStatus = isRemoteWsMode()
    ? async () => {
      const sessionId = String(dashboardSessionId || reconciliationRunId).trim();
      if (!sessionId) throw new Error('The active Dashboard session is unavailable for terminal reconciliation.');
      const connection = await ensureRemoteWsClient();
      return runControlRequestWithTimeout(
        () => connection.client.request(WS_METHODS.sessionStatus, { session_id: sessionId }),
        { timeoutMs: RUN_CONTROL_REQUEST_TIMEOUT_MS },
      );
    }
    : async () => {
      if (!reconciliationRunId) throw new Error('The active run id is unavailable for terminal reconciliation.');
      const response = await runControlRequestWithTimeout(
        (signal) => apiFetch(`/v1/runs/${encodeURIComponent(reconciliationRunId)}`, { method: 'GET', signal }),
        { timeoutMs: RUN_CONTROL_REQUEST_TIMEOUT_MS },
      );
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        const staleTerminal = runStopFailureTerminalStatus({ httpStatus: response.status, payload });
        if (staleTerminal) return { status: staleTerminal };
        throw new Error(payload?.error?.message || payload?.error || payload?.message || `Hermes run status failed (${response.status})`);
      }
      return payload;
    };
  const terminalStatus = isRemoteWsMode()
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

function renderRunControlRecovery() {
  if (!els.runControlRecovery) return;
  const unconfirmed = activeRunControl?.phase === RUN_CONTROL_PHASES.UNCONFIRMED;
  els.runControlRecovery.hidden = !unconfirmed;
  if (!unconfirmed) return;
  els.runControlRecoveryDetail.textContent = activeRunControl?.detail
    ? `Hermes has not confirmed a terminal run state. ${activeRunControl.detail}`
    : 'Hermes has not confirmed a terminal run state. Retry status before starting another turn.';
  els.retryRunStatusButton.disabled = false;
  els.discardHeldQueueButton.disabled = !queuedTurn;
}

async function retryActiveRunTerminalStatus() {
  if (activeRunControl?.phase !== RUN_CONTROL_PHASES.UNCONFIRMED) return false;
  const expectedGeneration = runControlGeneration;
  els.retryRunStatusButton.disabled = true;
  try {
    await reconcileActiveRunTerminal({
      stopRequested: activeRunControl.controlStatus === 'accepted',
      expectedGeneration,
    });
    if (!runControlGenerationMatches(expectedGeneration, runControlGeneration)) return false;
    if (activeRunControl?.phase === RUN_CONTROL_PHASES.TERMINAL) {
      setStatus('ok', 'Runtime state confirmed', 'Hermes reached a terminal state and Browser released the held writer.');
      await settleActiveRunTerminal();
      return true;
    }
  } catch (error) {
    setStatus('warn', 'Runtime state unconfirmed', `Status retry failed. The writer and queued turns remain held: ${error?.message || String(error)}`, { translateDetail: false });
  } finally {
    renderRunControlRecovery();
  }
  return false;
}

function discardHeldQueuedTurn() {
  queuedTurn = null;
  renderQueueNotice();
  renderRunControlRecovery();
  setStatus('warn', 'Queued message deleted', 'The active runtime state is still unconfirmed; Browser did not release the writer.');
}

async function settleActiveRunTerminal() {
  if (activeRunControl?.phase !== RUN_CONTROL_PHASES.TERMINAL || activeRunControl.writerLease !== 'released') return false;
  const settledRunControl = activeRunControl;
  activeAbortController?.abort();
  activeAbortController = null;
  activeRunId = '';
  pendingSteerText = '';
  sending = false;
  updateComposerBusyState();
  renderContextWindow();
  const shouldFlushQueue = shouldAutoFlushQueuedTurn(queuedTurn, settledRunControl);
  if (!shouldFlushQueue) return true;
  const next = queuedTurn;
  queuedTurn = null;
  renderQueueNotice();
  await askHermes(next.text, next.attachments || []);
  return true;
}

async function stopCurrentTurn() {
  if (!sending) return false;
  if (!activeRunControl) {
    activeRunControl = beginRunControl({ runId: activeRunId, transport: isRemoteWsMode() ? 'dashboard-ws' : 'rest' });
  }
  activeRunControl = requestRunStop(activeRunControl);
  const stopGeneration = runControlGeneration;
  const stopRunId = String(activeRunId || '');
  setStatus('warn', 'Stopping Hermes', stopRunId ? `Interrupt requested for ${stopRunId}` : 'Interrupting the active Hermes session');
  let dashboardSessionId = '';
  try {
    if (isRemoteWsMode()) {
      const connection = await ensureRemoteWsClient();
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
      dashboardSessionId = await ensureRemoteWsSession(connection);
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
      await runControlRequestWithTimeout(
        () => connection.client.request(WS_METHODS.sessionInterrupt, { session_id: dashboardSessionId }),
        { timeoutMs: RUN_CONTROL_REQUEST_TIMEOUT_MS },
      );
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
    } else {
      if (!stopRunId) {
        activeAbortController?.abort();
        activeRunControl = markRunTerminal(activeRunControl, 'cancelled');
        setStatus('ok', 'Hermes stopped', 'Browser cancelled the turn before Hermes published a server run identity.');
        return true;
      }
      if (!gatewayCapabilities.runStop || !gatewayCapabilities.runStatus) {
        throw new Error('Connected Hermes runtime does not explicitly advertise both run Stop and run status.');
      }
      const response = await runControlRequestWithTimeout(
        (signal) => apiFetch(`/v1/runs/${encodeURIComponent(stopRunId)}/stop`, { method: 'POST', signal }),
        { timeoutMs: RUN_CONTROL_REQUEST_TIMEOUT_MS },
      );
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
      const payload = await readJsonResponse(response);
      if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
      if (!response.ok) {
        const staleTerminal = runStopFailureTerminalStatus({ httpStatus: response.status, payload });
        if (staleTerminal) {
          activeRunControl = markRunTerminal(activeRunControl, staleTerminal);
          setStatus('ok', 'Hermes stopped', 'The runtime no longer reports this run as active, so Browser released the held writer.');
          await settleActiveRunTerminal();
          return true;
        }
        throw new Error(payload?.error?.message || payload?.error || payload?.message || `Hermes stop failed (${response.status})`);
      }
    }
    if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
    activeRunControl = acknowledgeStopRequest(activeRunControl, { status: 'stopping' });
  } catch (error) {
    if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
    const stopDetail = error?.message || String(error);
    activeRunControl = markStopRequestFailed(activeRunControl, stopDetail);
    setStatus('warn', 'Runtime stop unconfirmed', `Hermes did not acknowledge the stop. Browser kept the run identity and queued turns remain held: ${stopDetail}`, { translateDetail: false });
    return false;
  }

  setStatus('warn', 'Stop accepted', 'Hermes is stopping. Browser is waiting for terminal runtime confirmation before releasing the session writer or queued turns.');
  try {
    await reconcileActiveRunTerminal({ stopRequested: true, dashboardSessionId, expectedGeneration: stopGeneration });
    if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
  } catch (error) {
    if (!runControlGenerationMatches(stopGeneration, runControlGeneration)) return false;
    activeRunControl = markTerminalTimeout(activeRunControl, error?.message || 'Runtime terminal confirmation timed out.');
    setStatus('warn', 'Runtime stop unconfirmed', `Hermes accepted Stop, but terminal confirmation timed out. Browser kept the run identity and queued turns remain held: ${error?.message || String(error)}`, { translateDetail: false });
    return false;
  }
  setStatus('ok', 'Hermes stopped', 'Terminal cancellation confirmed and the session writer was released.');
  await settleActiveRunTerminal();
  return true;
}

function browserCommandsForSurface(surface = 'sidepanel') {
  return BUILTIN_COMMANDS.filter((command) => !command.surfaces || command.surfaces.includes(surface));
}

function nativeCommandCatalogText(surface = 'sidepanel') {
  return browserCommandsForSurface(surface)
    .map((command) => `/${command.name}${command.requiresInput ? ' …' : ''} — ${command.description}`)
    .join('\n');
}

async function executeNativeBrowserCommand(parsedCommand) {
  if (!parsedCommand || parsedCommand.kind !== 'native') return false;
  const { command, userInput = '' } = parsedCommand;
  const action = command.action;

  if (action === 'steer-run') {
    if (!userInput) {
      setStatus('warn', 'Steer needs guidance', 'Add text after /steer.');
      return true;
    }
    try {
      await sendSteerText(userInput);
      els.input.value = '';
      renderSkillSuggestions();
      updateComposerBusyState();
      setStatus('ok', 'Steer sent to active run', 'Hermes accepted the guidance for the active run.');
    } catch (error) {
      setStatus('warn', 'Steer failed', error?.message || String(error), { translateDetail: false });
    }
    return true;
  }

  if (action === 'stop-run') {
    if (!sending) setStatus('warn', 'Nothing to stop', 'Hermes is not currently running.');
    else await stopCurrentTurn();
    return true;
  }

  if (action === 'queue-message') {
    if (!sending) {
      setStatus('warn', 'Nothing to queue behind', 'Hermes is not currently running. Send the message normally.');
    } else if (!userInput) {
      setStatus('warn', 'Queue needs a message', 'Add text after /queue.');
    } else {
      queuedTurn = { text: userInput, attachments: [...attachments], kind: 'queued', autoSend: true };
      els.input.value = '';
      clearAttachments();
      renderSkillSuggestions();
      updateComposerBusyState();
      setStatus('ok', 'Message queued', 'Hermes will send it after the current turn finishes or stops.');
    }
    return true;
  }

  if (action === 'command-help') {
    addMessage('system', `Hermes Browser commands\n\n${nativeCommandCatalogText('sidepanel')}`);
    return true;
  }
  if (action === 'session-list') {
    closeFloatingPanels();
    els.sessionMenu.hidden = false;
    els.sessionMenuButton.setAttribute('aria-expanded', 'true');
    await loadSessions({ quiet: true });
    els.sessionSearchInput.focus();
    return true;
  }
  if (action === 'new-session' || action === 'reset-session') {
    if (sending) {
      setStatus('warn', 'Current run is still active', 'Use /stop before starting a clean session.');
    } else {
      await persistBrowserIntroSeen();
      await beginHermesBrowserDraft();
      await loadSessions({ quiet: true });
      setStatus('ok', 'New Hermes Browser Extension draft', 'Saved when you send the first message.');
    }
    return true;
  }
  if (action === 'retry-last') {
    if (sending) {
      setStatus('warn', 'Current run is still active', 'Stop or wait for the current run before retrying.');
      return true;
    }
    const lastUser = [...messages].reverse().find((message) => message?.role === 'user' && String(message?.content || '').trim());
    if (!lastUser) setStatus('warn', 'Nothing to retry', 'This session has no previous user turn.');
    else await askHermes(String(lastUser.content).trim(), [], { disableAutoTitle: true });
    return true;
  }
  if (action === 'model-picker') {
    els.modelMenuButton.click();
    return true;
  }
  if (action === 'provider-settings') {
    openSettingsDialog();
    setStatus('ok', 'Provider settings opened', 'Connection and model provider controls are available in Settings.');
    return true;
  }
  if (action === 'skill-list') {
    await loadSkills({ quiet: true });
    els.input.value = '/';
    renderSkillSuggestions();
    els.input.focus();
    return true;
  }
  if (action === 'unsupported') {
    setStatus('warn', `/${command.name} is unavailable here`, command.unsupportedReason || 'This command is unavailable in Hermes Browser.', { translateDetail: false });
    return true;
  }
  return false;
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

function canUseLocalDashboardVoiceTranscription() {
  return shouldUseLocalDashboardAudioTranscription({
    gatewayMode: settings.gatewayMode,
    recordingAvailable: canRecordVoiceAudio(),
  });
}

function browserSpeechAvailable() {
  return Boolean(speechRecognitionConstructor());
}

function preferredVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return VOICE_AUDIO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
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
  const url = browserApi?.runtime?.getURL?.(MICROPHONE_PERMISSION_PAGE) || MICROPHONE_PERMISSION_PAGE;
  if (browserApi?.tabs?.create) {
    await browserApi.tabs.create({ url, active: true });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function openVoiceDictationPage(detail = 'Opening a Hermes Voice Dictation tab. Record there; the transcript will return to this composer automatically.') {
  setStatus('warn', 'Opening voice dictation tab', detail);
  const url = browserApi?.runtime?.getURL?.(VOICE_DICTATION_PAGE) || VOICE_DICTATION_PAGE;
  if (browserApi?.tabs?.create) {
    await browserApi.tabs.create({ url, active: true });
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
    await browserApi?.storage?.local?.remove?.(VOICE_DRAFT_STORAGE_KEY);
    return false;
  }
  const inserted = insertExternalVoiceTranscript(draft.transcript, draft.source || 'voice dictation tab');
  if (inserted) await browserApi?.storage?.local?.remove?.(VOICE_DRAFT_STORAGE_KEY);
  return inserted;
}

async function consumePendingVoiceDraft() {
  const storage = browserApi?.storage?.local;
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

async function requestMicrophoneOriginPermissionViaPage(detail = 'Opening a temporary Hermes permission tab because some browsers suppress mic prompts inside extension sidebars.') {
  setStatus('warn', 'Microphone permission needed', detail);
  await openMicrophonePermissionPage();
  const granted = await waitForMicrophonePermission();
  if (granted) {
    setStatus('ok', 'Microphone permission enabled', 'Starting Hermes voice recording now.');
    return true;
  }
  throw microphonePermissionError('Microphone access was not granted. Use the Hermes permission tab or your browser’s extension settings to enable Microphone, then click the mic again.');
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

function renderWakeState(nextState = wakeState) {
  wakeState = { ...wakeState, ...(nextState || {}) };
  const enabled = Boolean(wakeState.enabled || settings.wakeWordEnabled);
  const currentState = String(wakeState.state || (enabled ? 'arming' : 'off'));
  const listening = ['listening', 'awaiting-command'].includes(currentState);
  const paused = ['arming', 'capturing', 'paused', 'processing'].includes(currentState);
  const unavailable = ['degraded', 'unavailable'].includes(currentState);
  const phrase = String(wakeState.phrase || settings.wakeWordPhrase || DEFAULT_SETTINGS.wakeWordPhrase);
  const provider = wakeState.mode === 'native'
    ? `Hermes ${wakeState.provider || 'native'}`
    : (wakeState.mode === 'browser-local' ? 'Browser on-device speech' : 'Wake word');
  const detail = String(wakeState.detail || (enabled ? `Preparing “${phrase}”…` : 'Wake word is off.'));
  if (els.wakeButton) {
    els.wakeButton.classList.toggle('active', enabled);
    els.wakeButton.classList.toggle('listening', listening);
    els.wakeButton.classList.toggle('paused', paused);
    els.wakeButton.classList.toggle('unavailable', unavailable);
    els.wakeButton.setAttribute('aria-pressed', String(enabled));
    els.wakeButton.setAttribute('aria-label', translateUiText(enabled ? 'Turn off wake word' : 'Turn on wake word'));
    els.wakeButton.title = `${translateUiText(provider)}: ${translateUiText(detail)}`;
  }
  if (els.wakeWordStatus) els.wakeWordStatus.textContent = `${translateUiText(provider)}: ${translateUiText(detail)}`;
  if (els.wakeWordEnabledInput) els.wakeWordEnabledInput.checked = enabled;
}

async function refreshWakeState() {
  try {
    const next = await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.getState });
    if (next) renderWakeState(next);
  } catch {
    renderWakeState({
      enabled: Boolean(settings.wakeWordEnabled),
      state: settings.wakeWordEnabled ? 'unavailable' : 'off',
      detail: settings.wakeWordEnabled ? 'Wake controller is unavailable in this browser runtime.' : 'Wake word is off.',
    });
  }
}

async function grantWakeMicrophoneAccess() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot capture microphone audio.');
  const stream = await getMicrophoneStreamWithPermissionRetry();
  stream?.getTracks?.().forEach((track) => track.stop());
}

async function setWakeWordEnabled(enabled) {
  const desired = Boolean(enabled);
  settings = { ...settings, wakeWordEnabled: desired };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  renderWakeState({ enabled: desired, state: desired ? 'arming' : 'off', detail: desired ? 'Selecting the safest wake listener…' : 'Wake word is off.' });
  let next = await browserApi.runtime.sendMessage({
    type: WAKE_MESSAGES.setEnabled,
    enabled: desired,
    settings,
  });
  if (desired && next?.mode === 'browser-local') {
    try {
      await grantWakeMicrophoneAccess();
      next = await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.setEnabled, enabled: true, settings });
    } catch (error) {
      settings = { ...settings, wakeWordEnabled: false };
      await browserApi.storage.local.set({ hermesBrowserSettings: settings });
      await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.setEnabled, enabled: false, settings }).catch(() => null);
      if (isMicrophonePermissionError(error)) {
        await openMicrophonePermissionPage();
        throw microphonePermissionError('Microphone access is required for Browser-local wake listening. Grant it in the Hermes permission tab, then click the ear again.');
      }
      throw error;
    }
  }
  if (next) renderWakeState(next);
  return next;
}

async function consumeWakeTurn(turn = null) {
  if (!wakeTurnIsFresh(turn) || !turn?.id) {
    if (turn) await browserApi.storage.local.remove(WAKE_STORAGE_KEYS.turn);
    return false;
  }
  if (wakeTurnProcessingId === turn.id) return false;
  wakeTurnProcessingId = turn.id;
  const claim = await browserApi.runtime.sendMessage({
    type: WAKE_MESSAGES.claimTurn,
    turnId: turn.id,
    surface: SURFACE_KINDS.SIDE_PANEL,
  }).catch(() => null);
  if (claim?.claimed === false) {
    wakeTurnProcessingId = '';
    return false;
  }
  if (!claim) await browserApi.storage.local.remove(WAKE_STORAGE_KEYS.turn);
  let completed = false;
  try {
    const sent = await askHermes(String(turn.text || '').trim(), [], {
      forceChatOnly: true,
      displayUserText: String(turn.text || '').trim(),
      onComplete: async (finalAnswer) => {
        completed = true;
        await browserApi.runtime.sendMessage({
          type: WAKE_MESSAGES.turnReply,
          turnId: turn.id,
          text: finalAnswer,
        });
      },
    });
    return Boolean(sent);
  } finally {
    if (!completed) {
      await browserApi.runtime.sendMessage({ type: WAKE_MESSAGES.turnReply, turnId: turn.id, text: '' }).catch(() => null);
    }
    if (wakeTurnProcessingId === turn.id) wakeTurnProcessingId = '';
  }
}

async function consumePendingWakeTurn() {
  const stored = await browserApi.storage.local.get(WAKE_STORAGE_KEYS.turn);
  return consumeWakeTurn(stored?.[WAKE_STORAGE_KEYS.turn]);
}

function updateVoiceButtonState() {
  if (!els.voiceButton) return;
  const supported = canUseHermesVoiceTranscription()
    || canUseLocalDashboardVoiceTranscription()
    || browserSpeechAvailable();
  els.voiceButton.disabled = !supported;
  els.voiceButton.classList.toggle('recording', dictating);
  els.voiceButton.classList.toggle('active', dictating);
  const mode = canUseHermesVoiceTranscription()
    ? 'Hermes API STT'
    : (canUseLocalDashboardVoiceTranscription() ? 'Hermes Dashboard STT' : 'browser speech fallback');
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
  const canUseApiTranscription = canUseHermesVoiceTranscription();
  const canUseDashboardTranscription = canUseLocalDashboardVoiceTranscription();
  if (!canUseApiTranscription && !canUseDashboardTranscription) {
    const error = new Error('Hermes audio transcription is unavailable on this gateway.');
    error.fallbackToWebSpeech = true;
    throw error;
  }
  const dataUrl = await blobToDataUrl(blob);
  if (canUseDashboardTranscription && !canUseApiTranscription) {
    const result = await transcribeAudioViaDashboard({
      baseUrl: dashboardModelDiscoveryBaseUrl({
        gatewayMode: normalizeGatewayMode(settings.gatewayMode),
        gatewayUrl: settings.gatewayUrl,
      }),
      profile: settings.activeProfile,
      dataUrl,
      mimeType: blob.type || 'audio/webm',
    });
    if (!result.ok) {
      const error = new Error(result.error || 'Hermes Dashboard voice transcription failed.');
      error.status = result.status;
      error.fallbackToWebSpeech = shouldFallbackToWebSpeechForTranscription(result.status);
      throw error;
    }
    return result.transcript;
  }
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
    setStatus('warn', 'Voice dictation stopped', event.error || t('voice.speech_recognition_error'), { translateDetail: false });
  };
  recognition.onend = () => {
    dictating = false;
    updateVoiceButtonState();
  };
  speechRecognition = recognition;
  return speechRecognition;
}

async function startWebSpeechDictation(detail = 'Speak to dictate into the Hermes composer.') {
  const recognition = ensureSpeechRecognition();
  if (!recognition) return false;
  dictationFinalText = '';
  try {
    const preparation = await prepareOnDeviceSpeechRecognition({
      Recognition: speechRecognitionConstructor(),
      recognition,
      language: recognition.lang,
      onStatus: () => setStatus('ok', 'Preparing on-device dictation', 'Downloading the browser language pack once so voice dictation can run locally.'),
    });
    recognition.start();
    dictating = true;
    updateVoiceButtonState();
    setStatus(
      'ok',
      preparation.mode === 'local' ? 'Listening on device' : 'Listening',
      preparation.mode === 'local' ? 'Speech recognition is running locally in the browser.' : detail,
    );
    return true;
  } catch (error) {
    dictating = false;
    updateVoiceButtonState();
    setStatus('warn', 'Voice dictation unavailable', error?.message || String(error), { translateDetail: false });
    return false;
  }
}

async function startRecorderDictation() {
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
    setStatus('warn', 'Voice recording failed', event?.error?.message || t('voice.capture_error'), { translateDetail: false });
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
      if (error?.fallbackToWebSpeech && await startWebSpeechDictation('Hermes transcription route is unavailable. Using browser speech fallback; speak again.')) {
        return;
      }
      setStatus('warn', 'Voice transcription failed', error?.message || String(error), { translateDetail: false });
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
    setStatus('warn', 'Voice recording failed', error?.message || String(error), { translateDetail: false });
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
  const canUseRecorderTranscription = canUseHermesVoiceTranscription()
    || canUseLocalDashboardVoiceTranscription();
  if (!canUseRecorderTranscription && await startWebSpeechDictation('Hermes transcription route is unavailable. Using browser speech fallback.')) return;
  if (canUseRecorderTranscription) {
    try {
      await startRecorderDictation();
      return;
    } catch (error) {
      console.warn('Hermes voice recorder unavailable', error);
      cleanupVoiceRecorder();
      dictating = false;
      updateVoiceButtonState();
      if (isMicrophonePermissionError(error)) {
        await openVoiceDictationPage('The current browser blocked microphone capture inside the side panel. Use this visible Hermes Voice tab once; it will transcribe locally through Hermes and send the text back here.');
        return;
      }
      if (await startWebSpeechDictation('Hermes microphone capture failed. Using browser speech fallback.')) return;
      setStatus('warn', 'Voice dictation unavailable', error?.message || String(error), { translateDetail: false });
      return;
    }
  }
  if (await startWebSpeechDictation()) return;
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
  if (!session) return;
  const previousModel = settings.model;
  const previousBinding = JSON.stringify(settings.sessionModelBindings?.[session.id] || null);
  const previousOptionsBinding = JSON.stringify(settings.sessionModelOptionBindings?.[session.id] || null);
  applyModelBindingForSession(session);
  applyModelOptionsForSession(session);
  applySessionRuntimeSnapshot({ session, sessionId: session.id, source: 'Hermes session' });
  const nextBinding = JSON.stringify(settings.sessionModelBindings?.[session.id] || null);
  const nextOptionsBinding = JSON.stringify(settings.sessionModelOptionBindings?.[session.id] || null);
  if (settings.model !== previousModel || nextBinding !== previousBinding || nextOptionsBinding !== previousOptionsBinding) {
    void browserApi.storage.local.set({ hermesBrowserSettings: settings });
    renderModelOptions(availableModels);
  }
}

const TEXT_ATTACHMENT_LIMIT = 12_000;
const IMAGE_ATTACHMENT_TOKEN_ESTIMATE = 1_200;
const BROWSER_IMAGE_UPLOAD_ENDPOINT = '/api/browser-extension/uploads/images';
const UPDATE_PACKAGE_URL = 'https://raw.githubusercontent.com/abundantbeing/hermes-browser-extension/main/package.json';
const UPDATE_MAIN_COMMIT_URL = 'https://api.github.com/repos/abundantbeing/hermes-browser-extension/commits/main';
const UPDATE_MAIN_TREE_URL = 'https://api.github.com/repos/abundantbeing/hermes-browser-extension/git/trees';
const UPDATE_COMPARE_URL = 'https://api.github.com/repos/abundantbeing/hermes-browser-extension/compare';
const REPO_URL = 'https://github.com/abundantbeing/hermes-browser-extension';
const runtimeManifest = browserApi?.runtime?.getManifest?.() || {};
const CURRENT_EXTENSION_VERSION = normalizeExtensionVersion(runtimeManifest, els.versionLabel?.textContent);

const systemColorQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;


function marketplaceText(key, fallback, params) {
  const translated = t(key, params);
  return translated && translated !== key ? translated : fallback;
}

function marketplaceErrorText(code) {
  const map = {
    'request-timeout': ['marketplace.timeout', 'Request timed out'],
    'archive-too-large': ['marketplace.package_too_large', 'Package is too large'],
    'no-color-themes': ['marketplace.not_supported', 'Package is not a supported theme'],
    'package-corrupt': ['marketplace.package_corrupt', 'Package is corrupt'],
    'unsupported-compression': ['marketplace.unsupported_archive', 'Unsupported archive format'],
    'network-failed': ['marketplace.unavailable', 'Marketplace unavailable'],
  };
  const [key, fallback] = map[code] || ['marketplace.unavailable', 'Marketplace unavailable'];
  return marketplaceText(key, fallback);
}

function renderMarketplaceThemes(status = '') {
  if (!els.marketplaceThemeResults || !els.marketplaceThemeStatus) return;
  els.marketplaceThemeStatus.textContent = status
    || (marketplaceThemeLoading ? marketplaceText('marketplace.loading', 'Loading themes…') : marketplaceThemeError);
  els.marketplaceThemeMode.textContent = els.marketplaceThemeSearchInput?.value.trim()
    ? marketplaceText('marketplace.search_results', 'Search results')
    : marketplaceText('marketplace.most_installed', 'Most installed');
  els.marketplaceThemeResults.replaceChildren();
  if (marketplaceThemeError) return;
  if (marketplaceThemeLoading) {
    const loading = document.createElement('div');
    loading.className = 'marketplace-theme-loading';
    loading.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 5; index += 1) loading.append(document.createElement('i'));
    els.marketplaceThemeResults.append(loading);
    return;
  }
  if (!marketplaceThemeResults.length) {
    const empty = document.createElement('p'); empty.className = 'marketplace-theme-empty';
    empty.textContent = marketplaceText('marketplace.empty', 'No themes found');
    els.marketplaceThemeResults.append(empty);
    return;
  }
  for (const item of marketplaceThemeResults) {
    const card = document.createElement('article'); card.className = 'marketplace-theme-card';
    const copy = document.createElement('div'); copy.className = 'marketplace-theme-card-copy';
    const title = document.createElement('strong'); title.textContent = item.displayName;
    const meta = document.createElement('span'); meta.textContent = `${item.publisher}${item.installs ? ` · ${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(item.installs)}` : ''}`;
    const description = document.createElement('p'); description.textContent = item.description;
    copy.append(title, meta, description);
    const button = document.createElement('button'); button.type = 'button'; button.dataset.marketplaceInstall = item.extensionId;
    button.disabled = Boolean(marketplaceThemeInstallingId);
    button.textContent = marketplaceThemeInstallingId === item.extensionId
      ? marketplaceText('marketplace.installing', 'Installing…')
      : item.installedThemeId ? marketplaceText('marketplace.select_installed', 'Select installed theme') : marketplaceText('marketplace.install', 'Install');
    card.append(copy, button); els.marketplaceThemeResults.append(card);
  }
}

async function loadMarketplaceThemes() {
  const revision = ++marketplaceThemeRevision;
  marketplaceThemeLoading = true;
  marketplaceThemeError = '';
  renderMarketplaceThemes();
  const query = els.marketplaceThemeSearchInput?.value.trim() || '';
  const response = await marketplaceTransport.send({ type: 'HERMES_THEME_MARKETPLACE_SEARCH', query, limit: 20 });
  if (revision !== marketplaceThemeRevision) return;
  marketplaceThemeLoading = false;
  marketplaceThemeLoaded = true;
  if (!response?.ok) {
    marketplaceThemeError = marketplaceErrorText(response?.error?.code);
    renderMarketplaceThemes();
    return;
  }
  marketplaceThemeError = '';
  marketplaceThemeResults = Array.isArray(response.data?.results) ? response.data.results : [];
  renderMarketplaceThemes();
}

async function installMarketplaceTheme(extensionId) {
  if (marketplaceThemeInstallingId) return;
  const existing = marketplaceThemeResults.find((item) => item.extensionId === extensionId)?.installedThemeId;
  if (existing) { await setAppearanceOption('appearanceTheme', existing); return; }
  marketplaceThemeInstallingId = extensionId; renderMarketplaceThemes();
  const response = await marketplaceTransport.send({ type: 'HERMES_THEME_MARKETPLACE_INSTALL', extensionId });
  marketplaceThemeInstallingId = '';
  if (!response?.ok) {
    marketplaceThemeError = marketplaceErrorText(response?.error?.code);
    renderMarketplaceThemes();
    return;
  }
  await refreshCustomThemeStore();
  await setAppearanceOption('appearanceTheme', response.data.themeId);
  const details = [];
  if (response.data.adjusted?.length) details.push(marketplaceText('marketplace.adjusted', 'Theme was adjusted for readability'));
  if (response.data.derived?.length) details.push(marketplaceText('marketplace.derived', 'Some source colors were derived'));
  await loadMarketplaceThemes();
  renderMarketplaceThemes(details.join(' · ') || marketplaceText('marketplace.installed', 'Installed'));
}

async function createAgentTheme() {
  if (agentThemeCreating) return;
  const description = String(els.agentThemeDescription?.value || '').trim();
  let prompt;
  try {
    prompt = buildAgentThemePrompt(description);
  } catch (error) {
    agentThemeStatus = error?.message || marketplaceText('agent_theme.invalid_description', 'Describe the theme you want Hermes to create');
    renderAgentThemeStudio();
    els.agentThemeDescription?.focus();
    return;
  }
  if (!isConnected()) {
    agentThemeStatus = marketplaceText('agent_theme.connect_first', 'Connect to Hermes before creating a theme');
    renderAgentThemeStudio();
    els.connectButton?.focus();
    return;
  }
  agentThemeCreating = true;
  agentThemeStatus = marketplaceText('agent_theme.designing', 'Hermes is designing and validating your theme…');
  renderAgentThemeStudio();
  const sent = await askHermes(prompt, [], {
    forceChatOnly: true,
    disableAutoTitle: true,
    disableCommandParsing: true,
    displayUserText: `${marketplaceText('agent_theme.create_with_hermes', 'Create with Hermes')}: ${description}`,
    onComplete: async (finalAnswer) => {
      try {
        const document = extractAgentThemeDocument(finalAnswer);
        const installed = await installCustomTheme(browserApi.storage.local, document);
        if (!installed.ok) throw new Error(installed.error?.message || 'Theme installation failed');
        await refreshCustomThemeStore();
        await setAppearanceOption('appearanceTheme', installed.record.id);
        if (els.customThemeImportTextarea) els.customThemeImportTextarea.value = serializeThemeDocument(document);
        customThemePreviewState = { valid: true, document, errors: [] };
        customThemeImportStatus = '';
        agentThemeStatus = marketplaceText('agent_theme.applied', 'Theme created, validated, and applied');
        renderCustomThemeManagement();
      } catch (error) {
        agentThemeStatus = error?.validationErrors?.[0]?.message
          || error?.message
          || marketplaceText('agent_theme.failed', 'Hermes did not return a valid theme');
        renderAgentThemeStudio();
      }
    },
  });
  agentThemeCreating = false;
  if (!sent) agentThemeStatus = marketplaceText('agent_theme.failed', 'Hermes could not create the theme');
  renderAgentThemeStudio();
}

function renderAgentThemeStudio() {
  if (els.agentThemeCreateButton) els.agentThemeCreateButton.disabled = agentThemeCreating || sending;
  if (els.agentThemeStatus) els.agentThemeStatus.textContent = agentThemeStatus;
}

function customThemeText(key, fallback, params) {
  const translated = t(key, params);
  return translated && translated !== key ? translated : fallback;
}

function customThemeInputBytes(value) {
  return new TextEncoder().encode(String(value || '')).byteLength;
}

function normalizedPanelThemeId(value) {
  const selection = customThemeSelection(value, customThemeStoreState.themes);
  if (selection.kind === 'builtin' || selection.kind === 'custom') return selection.id;
  return normalizeAppearanceTheme(value);
}

function customThemePreviewMarkup(palette) {
  const style = [
    `--preview-bg:${palette.canvas}`,
    `--preview-panel:${palette.paper}`,
    `--preview-text:${palette.ink}`,
    `--preview-muted:${palette.muted}`,
    `--preview-accent:${palette.accent}`,
  ].join(';');
  return `<span class="theme-preview" aria-hidden="true" style="${style}"><span></span><span></span><span></span></span>`;
}

function renderCustomThemePreview() {
  if (!els.customThemePreview || !els.customThemeInstallButton) return;
  const state = customThemePreviewState;
  els.customThemePreview.hidden = !state;
  els.customThemeInstallButton.disabled = !state?.valid;
  if (!state) {
    els.customThemePreview.innerHTML = '';
    return;
  }
  if (!state.valid) {
    const errors = state.errors.map((error) => `<li><strong>${escapeHtml(error.path || '$')}</strong> — ${escapeHtml(error.message || error.code)}</li>`).join('');
    els.customThemePreview.innerHTML = sanitizeHtml(`<ul class="custom-theme-validation-list">${errors}</ul>`);
    return;
  }
  const document = state.document;
  const palette = document.colors;
  const swatches = ['canvas', 'paper', 'ink', 'muted', 'primary', 'accent', 'danger']
    .map((key) => `<span class="custom-theme-swatch" style="--swatch:${palette[key]}" title="${key}: ${palette[key]}" aria-label="${key}: ${palette[key]}"></span>`)
    .join('');
  const coverage = document.darkColors
    ? customThemeText('custom_theme.light_and_dark', 'Light and dark palettes')
    : customThemeText('custom_theme.light_only', 'Light palette only');
  els.customThemePreview.innerHTML = sanitizeHtml(`
    <div class="custom-theme-preview-head">
      <strong>${escapeHtml(document.name)}</strong>
      <span class="custom-theme-preview-mode">${escapeHtml(coverage)}</span>
    </div>
    <div class="custom-theme-swatches" role="list" aria-label="Palette colors">${swatches}</div>
  `);
}

function renderCustomThemeManagement() {
  renderCustomThemePreview();
  renderAgentThemeStudio();
  if (els.customThemeImportStatus) {
    const corrupt = customThemeStoreState.status === 'corrupt'
      ? customThemeText('custom_theme.storage_corrupt', 'Custom theme storage is corrupt. Reset it explicitly to continue.')
      : '';
    els.customThemeImportStatus.textContent = customThemeImportStatus || corrupt;
  }
  if (els.customThemeResetButton) {
    els.customThemeResetButton.hidden = customThemeStoreState.status !== 'corrupt';
    els.customThemeResetButton.textContent = customThemeResetArmed
      ? customThemeText('custom_theme.confirm_reset', 'Confirm reset')
      : customThemeText('custom_theme.reset_storage', 'Reset custom theme storage');
  }
}

function renderCustomThemeCards(activeTheme) {
  return customThemeStoreState.themes.map((record) => {
    const selected = record.id === activeTheme;
    const armed = customThemeDeleteArmedId === record.id;
    const userInstalled = customThemeText('custom_theme.user_installed', 'User-installed');
    const exportLabel = customThemeText('custom_theme.export_theme', 'Export');
    const deleteLabel = armed
      ? customThemeText('custom_theme.confirm_delete', 'Confirm delete')
      : customThemeText('custom_theme.delete_theme', 'Delete');
    return `
      <div class="custom-theme-card-shell ${selected ? 'selected' : ''}" data-custom-theme-id="${record.id}">
        <button class="custom-theme-card-select" type="button" data-theme="${record.id}" role="radio" aria-checked="${selected}" aria-label="${escapeHtml(record.document.name)}: ${escapeHtml(userInstalled)}">
          ${customThemePreviewMarkup(record.document.colors)}
          <span class="custom-theme-card-copy"><strong>${escapeHtml(record.document.name)}</strong><small>${escapeHtml(userInstalled)}</small></span>
        </button>
        <span class="custom-theme-card-actions">
          <button type="button" data-custom-theme-export="${record.id}" aria-label="${escapeHtml(exportLabel)} ${escapeHtml(record.document.name)}">${escapeHtml(exportLabel)}</button>
          <button class="danger-action" type="button" data-custom-theme-delete="${record.id}" aria-label="${escapeHtml(deleteLabel)} ${escapeHtml(record.document.name)}">${escapeHtml(deleteLabel)}</button>
        </span>
      </div>
    `;
  }).join('');
}

async function refreshCustomThemeStore({ render = true } = {}) {
  const previousStatus = customThemeStoreState.status;
  customThemeStoreState = await readCustomThemeStore(browserApi.storage.local);
  if (customThemeStoreState.status === 'corrupt') {
    customThemeImportStatus = '';
    customThemePreviewState = null;
  } else if (previousStatus === 'corrupt') {
    customThemeImportStatus = '';
    customThemeResetArmed = false;
  } else if (!customThemeStoreState.ok) {
    customThemeImportStatus = `${customThemeText('custom_theme.storage_unavailable', 'Custom themes are unavailable.')} ${customThemeStoreState.error?.message || ''}`.trim();
  }
  if (render) renderAppearanceControls();
  return customThemeStoreState;
}

async function previewCustomThemeImport(inputText = els.customThemeImportTextarea?.value || '') {
  customThemePreviewState = null;
  const inputBytes = customThemeInputBytes(inputText);
  if (inputBytes > CUSTOM_THEME_MAX_INPUT_BYTES) {
    customThemePreviewState = {
      valid: false,
      inputBytes,
      errors: [{ code: 'input-too-large', path: '$', message: customThemeText('custom_theme.input_too_large', 'Theme input is too large.') }],
    };
    customThemeImportStatus = customThemeText('custom_theme.input_too_large', 'Theme input is too large.');
    renderCustomThemeManagement();
    return customThemePreviewState;
  }
  let candidate;
  try {
    candidate = JSON.parse(inputText);
  } catch (error) {
    customThemePreviewState = {
      valid: false,
      inputBytes,
      errors: [{ code: 'invalid-json', path: '$', message: error?.message || 'Invalid JSON' }],
    };
    customThemeImportStatus = customThemeText('custom_theme.validation_errors', 'Theme has validation errors.');
    renderCustomThemeManagement();
    return customThemePreviewState;
  }
  const result = validateThemeDocument(candidate);
  customThemePreviewState = { ...result, inputBytes };
  customThemeImportStatus = result.valid
    ? customThemeText('custom_theme.valid', 'Theme is valid. Install it to add it to your themes.')
    : result.errors.some((error) => error.code === 'contrast')
      ? customThemeText('custom_theme.contrast_failed', 'Theme failed contrast requirements.')
    : customThemeText('custom_theme.validation_errors', 'Theme has validation errors.');
  renderCustomThemeManagement();
  return customThemePreviewState;
}

async function installPreviewedCustomTheme() {
  if (!customThemePreviewState?.valid) {
    customThemeImportStatus = customThemeText('custom_theme.validation_errors', 'Theme has validation errors.');
    renderCustomThemeManagement();
    return;
  }
  els.customThemeInstallButton?.setAttribute('aria-busy', 'true');
  let result;
  try {
    result = await installCustomTheme(browserApi.storage.local, customThemePreviewState.document, {
      inputBytes: customThemePreviewState.inputBytes,
    });
  } finally {
    els.customThemeInstallButton?.setAttribute('aria-busy', 'false');
  }
  if (!result.ok) {
    customThemeImportStatus = result.error?.code === 'theme-limit-reached'
      ? customThemeText('custom_theme.limit_reached', 'Theme limit reached.')
      : `${customThemeText('custom_theme.save_failed', 'Theme could not be saved.')} ${result.error?.message || ''}`.trim();
    renderCustomThemeManagement();
    return;
  }
  customThemeStoreState = { ok: true, status: 'ready', themes: result.store.themes };
  customThemeImportStatus = customThemeText('custom_theme.installed', 'Theme installed.');
  renderAppearanceControls();
  await setAppearanceOption('appearanceTheme', result.record.id);
}

function customThemeExportFilename(name) {
  const safe = String(name || 'hermes-theme').normalize('NFKD').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return `${safe || 'hermes-theme'}.json`;
}

function exportCustomTheme(id) {
  const record = customThemeStoreState.themes.find((candidate) => candidate.id === id);
  if (!record) return;
  const blob = new Blob([serializeThemeDocument(record.document)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = customThemeExportFilename(record.document.name);
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

async function fallbackDeletedCustomThemeSelections(id, { allCustom = false } = {}) {
  const stored = await browserApi.storage.local.get('hermesBrowserSettings');
  const freshSettings = stored.hermesBrowserSettings || {};
  const shouldFallback = (value) => allCustom ? String(value || '').startsWith('custom:') : value === id;
  const panelFallback = shouldFallback(freshSettings.appearanceTheme);
  const webFallback = shouldFallback(freshSettings.webAppearanceTheme);
  if (!panelFallback && !webFallback) return freshSettings;
  const hermesBrowserSettings = {
    ...freshSettings,
    ...(panelFallback ? { appearanceTheme: 'nous' } : {}),
    ...(webFallback ? { webAppearanceTheme: 'nous' } : {}),
  };
  await browserApi.storage.local.set({ hermesBrowserSettings });
  return hermesBrowserSettings;
}

async function handleCustomThemeDelete(id) {
  const record = customThemeStoreState.themes.find((candidate) => candidate.id === id);
  if (!record) return;
  if (customThemeDeleteArmedId !== id) {
    customThemeDeleteArmedId = id;
    customThemeImportStatus = customThemeText('custom_theme.confirm_delete', 'Click Confirm delete to remove this theme.');
    renderAppearanceControls();
    return;
  }
  customThemeDeleteArmedId = '';
  try {
    const savedSettings = await fallbackDeletedCustomThemeSelections(id);
    const result = await deleteCustomTheme(browserApi.storage.local, id);
    if (!result.ok) throw new Error(result.error?.message || 'Could not delete custom theme');
    customThemeStoreState = { ok: true, status: result.store.themes.length ? 'ready' : 'empty', themes: result.store.themes };
    if (settings.appearanceTheme === id) settings = { ...settings, ...savedSettings, appearanceTheme: 'nous' };
    customThemeImportStatus = customThemeText('custom_theme.deleted', 'Theme deleted.');
    renderAppearanceControls();
  } catch (error) {
    customThemeImportStatus = `${customThemeText('custom_theme.delete_failed', 'Theme could not be deleted.')} ${error?.message || ''}`.trim();
    renderCustomThemeManagement();
  }
}

async function handleCustomThemeReset() {
  if (customThemeStoreState.status !== 'corrupt') return;
  if (!customThemeResetArmed) {
    customThemeResetArmed = true;
    customThemeImportStatus = customThemeText('custom_theme.confirm_reset', 'Click Confirm reset to clear corrupt custom theme storage.');
    renderCustomThemeManagement();
    return;
  }
  customThemeResetArmed = false;
  try {
    const savedSettings = await fallbackDeletedCustomThemeSelections('', { allCustom: true });
    const result = await resetCustomThemeStore(browserApi.storage.local);
    if (!result.ok) throw new Error(result.error?.message || 'Could not reset custom theme storage');
    customThemeStoreState = { ok: true, status: 'empty', themes: [] };
    settings = { ...settings, ...savedSettings, appearanceTheme: normalizedPanelThemeId(savedSettings.appearanceTheme) };
    customThemeImportStatus = customThemeText('custom_theme.reset_complete', 'Custom theme storage reset.');
    renderAppearanceControls();
  } catch (error) {
    customThemeImportStatus = `${customThemeText('custom_theme.reset_failed', 'Custom theme storage could not be reset.')} ${error?.message || ''}`.trim();
    renderCustomThemeManagement();
  }
}

async function handleCustomThemeFileSelection() {
  const file = els.customThemeFileInput?.files?.[0];
  if (!file) return;
  if (file.size > CUSTOM_THEME_MAX_INPUT_BYTES) {
    customThemePreviewState = {
      valid: false,
      inputBytes: file.size,
      errors: [{ code: 'input-too-large', path: '$', message: customThemeText('custom_theme.input_too_large', 'Theme input is too large.') }],
    };
    customThemeImportStatus = customThemeText('custom_theme.input_too_large', 'Theme input is too large.');
    renderCustomThemeManagement();
    return;
  }
  const isJsonFile = file.type === 'application/json' || String(file.name || '').toLowerCase().endsWith('.json');
  if (!isJsonFile) {
    customThemePreviewState = {
      valid: false,
      inputBytes: file.size,
      errors: [{ code: 'invalid-file-type', path: '$', message: customThemeText('custom_theme.invalid_file_type', 'Choose a JSON theme file.') }],
    };
    customThemeImportStatus = customThemeText('custom_theme.invalid_file_type', 'Choose a JSON theme file.');
    renderCustomThemeManagement();
    return;
  }
  try {
    const text = await file.text();
    if (els.customThemeImportTextarea) els.customThemeImportTextarea.value = text;
    await previewCustomThemeImport(text);
  } catch (error) {
    customThemePreviewState = {
      valid: false,
      inputBytes: file.size,
      errors: [{ code: 'file-read-failed', path: '$', message: error?.message || 'Theme file could not be read' }],
    };
    customThemeImportStatus = customThemeText('custom_theme.file_read_failed', 'Theme file could not be read.');
    renderCustomThemeManagement();
  }
}

async function handleCustomThemeStoreChange() {
  const previousTheme = settings.appearanceTheme;
  await refreshCustomThemeStore({ render: false });
  const stored = await browserApi.storage.local.get('hermesBrowserSettings');
  const freshAppearanceTheme = stored.hermesBrowserSettings?.appearanceTheme ?? previousTheme;
  const nextTheme = normalizedPanelThemeId(freshAppearanceTheme);
  if (String(previousTheme || '').startsWith('custom:') && nextTheme === 'nous' && previousTheme !== 'nous') {
    appearanceSaveStatus = customThemeText('custom_theme.active_unavailable', 'Active theme is unavailable. Using Nous.');
  }
  settings = { ...settings, appearanceTheme: nextTheme };
  renderAppearanceControls();
}

function resolvedColorMode(value = settings.colorMode) {
  const mode = normalizeColorMode(value);
  if (mode === 'system') return systemColorQuery?.matches ? 'dark' : 'light';
  return mode;
}

function panelAppearancePreferences() {
  return {
    textZoomPercent: normalizeTextZoomPercent(settings.textZoomPercent),
    fontProfile: settings.fontProfile || 'signature',
    customFontFamily: sanitizeLocalFontFamily(settings.customFontFamily),
  };
}

function panelAppearanceSnapshot() {
  return {
    ...panelAppearancePreferences(),
    colorMode: normalizeColorMode(settings.colorMode),
    appearanceTheme: normalizedPanelThemeId(settings.appearanceTheme),
  };
}

function applyAppearanceSettings() {
  const colorMode = normalizeColorMode(settings.colorMode);
  const resolvedMode = resolvedColorMode(colorMode);
  const root = document.documentElement;
  for (const property of appliedCustomThemeVariables) root.style.removeProperty(property);
  appliedCustomThemeVariables = [];
  const selection = customThemeSelection(settings.appearanceTheme, customThemeStoreState.themes);
  const theme = selection.kind === 'custom' ? selection.id : normalizeAppearanceTheme(settings.appearanceTheme);
  if (selection.kind === 'custom') {
    const palette = customThemePaletteForMode(selection.document, resolvedMode);
    const variables = themeCssVariables(palette);
    for (const [property, value] of Object.entries(variables)) root.style.setProperty(property, value);
    appliedCustomThemeVariables = Object.keys(variables);
  }
  root.dataset.hermesTheme = theme;
  root.dataset.hermesColorMode = colorMode;
  root.dataset.hermesMode = resolvedMode;
  const effectiveColorScheme = selection.kind === 'custom' && resolvedMode === 'dark' && !selection.document.darkColors
    ? 'light'
    : resolvedMode;
  root.style.colorScheme = effectiveColorScheme;
  applyAppearancePreferences(root, appearancePreferencesForSurface(settings, 'panel'));
}

function renderAppearanceControls() {
  applyAppearanceSettings();
  if (els.languageSelect) {
    populateLanguageSelect(els.languageSelect);
    els.languageSelect.value = getLocale();
  }
  const colorMode = normalizeColorMode(settings.colorMode);
  const activeTheme = normalizedPanelThemeId(settings.appearanceTheme);
  const preferences = appearancePreferencesForSurface(settings, 'panel');
  const requestedProfile = settings.fontProfile === 'custom-local' ? 'custom-local' : preferences.fontProfile;
  for (const button of els.colorModeButtons || []) {
    const selected = button.dataset.colorMode === colorMode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  }
  for (const button of els.textZoomPresetGrid?.querySelectorAll('[data-text-zoom-percent]') || []) {
    const selected = Number(button.dataset.textZoomPercent) === preferences.textZoomPercent;
    const percentLabel = t('appearance.percent_value', { percent: button.dataset.textZoomPercent });
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
    button.setAttribute('aria-label', selected ? t('appearance.current_selection', { value: percentLabel }) : percentLabel);
  }
  if (els.textZoomInput) {
    els.textZoomInput.value = String(preferences.textZoomPercent);
    els.textZoomInput.setAttribute('aria-valuetext', t('appearance.percent_value', { percent: preferences.textZoomPercent }));
  }
  if (els.fontProfileSelect) els.fontProfileSelect.value = requestedProfile;
  if (els.customFontFamilyField) els.customFontFamilyField.hidden = requestedProfile !== 'custom-local';
  if (els.customFontFamilyInput && document.activeElement !== els.customFontFamilyInput) {
    els.customFontFamilyInput.value = settings.customFontFamily || preferences.customFontFamily;
  }
  if (els.appearanceSaveStatus) els.appearanceSaveStatus.textContent = appearanceSaveStatus;
  renderCustomThemeManagement();
  if (!els.themeGrid) return;
  const builtInCards = APPEARANCE_THEMES.map((theme) => {
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
  els.themeGrid.innerHTML = sanitizeHtml(`${builtInCards}${renderCustomThemeCards(activeTheme)}`);
}

async function persistAppearanceSettings(preferences) {
  const writeAppearance = async () => {
    const stored = await browserApi.storage.local.get('hermesBrowserSettings');
    const freshSettings = stored.hermesBrowserSettings || {};
    const mergedPreferences = withAppearancePreferenceUpdate(freshSettings, 'panel', preferences);
    const hermesBrowserSettings = {
      ...mergedPreferences,
      appearanceSchemaVersion: 2,
      colorMode: normalizeColorMode(preferences.colorMode),
      appearanceTheme: normalizedPanelThemeId(preferences.appearanceTheme),
    };
    await browserApi.storage.local.set({ hermesBrowserSettings: hermesBrowserSettings });
    return hermesBrowserSettings;
  };
  const pendingWrite = appearanceWriteQueue.then(writeAppearance, writeAppearance);
  appearanceWriteQueue = pendingWrite.catch(() => undefined);
  return pendingWrite;
}

async function setAppearanceOption(key, value, { persist = true } = {}) {
  const previousAppearance = panelAppearanceSnapshot();
  appearanceMutationId += 1;
  const mutationId = appearanceMutationId;
  if (key === 'colorMode') settings = { ...settings, colorMode: normalizeColorMode(value) };
  if (key === 'appearanceTheme') settings = { ...settings, appearanceTheme: normalizedPanelThemeId(value) };
  if (key === 'textZoomPercent') settings = { ...settings, textZoomPercent: normalizeTextZoomPercent(value) };
  if (key === 'fontProfile') settings = { ...settings, fontProfile: String(value || 'signature') };
  if (key === 'customFontFamily') settings = { ...settings, customFontFamily: sanitizeLocalFontFamily(value) };

  if (settings.fontProfile === 'custom-local' && !sanitizeLocalFontFamily(settings.customFontFamily)) {
    appearanceSaveStatus = t('appearance.invalid_local_font_family');
    renderAppearanceControls();
    return;
  }

  appearanceSaveStatus = persist ? t('appearance.saving') : '';
  renderAppearanceControls();
  if (!persist) return;

  try {
    const savedSettings = await persistAppearanceSettings(panelAppearanceSnapshot());
    if (mutationId === appearanceMutationId) {
      settings = savedSettings;
      appearanceSaveStatus = t('appearance.saved');
      renderAppearanceControls();
    }
  } catch (error) {
    if (mutationId === appearanceMutationId) {
      settings = {
        ...settings,
        textZoomPercent: previousAppearance.textZoomPercent,
        fontProfile: previousAppearance.fontProfile,
        customFontFamily: previousAppearance.customFontFamily,
        colorMode: previousAppearance.colorMode,
        appearanceTheme: previousAppearance.appearanceTheme,
      };
      appearanceSaveStatus = `${t('appearance.change_not_saved')} ${error?.message || ''}`.trim();
      renderAppearanceControls();
    }
  }
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
    throw new Error('Use Ctrl+V inside the Ask Hermes box to paste images. This extension surface does not expose global clipboard image read.');
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
  // Attachment labels, paths, and extracted text are untrusted attachment data,
  // never composer instruction. They travel only in BCP v2 attachment_context.
  void items;
  return text || 'Attachment-only turn.';
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

function modelBindingFromModel(model = {}) {
  if (!model || typeof model !== 'object') return null;
  return normalizeBrowserModelBinding({
    modelId: model.id || model.model || model.rawModelId,
    rawModelId: model.rawModelId || model.raw_model_id || model.model || model.id,
    provider: model.provider || model.providerId || model.owner || '',
    contextTokens: model.contextTokens || model.context_tokens || 0,
    gatewayAlias: model.gatewayAlias === true,
    gatewayDefault: model.gatewayDefault === true,
  });
}

function modelForBinding(binding = null) {
  const normalized = normalizeBrowserModelBinding(binding);
  if (!normalized) return null;
  return availableModels.find((model) => model.id === normalized.modelId)
    || availableModels.find((model) => model.rawModelId === normalized.rawModelId && (!normalized.provider || model.provider === normalized.provider || model.owner === normalized.provider))
    || null;
}

function browserGlobalDefaultModelBinding() {
  return modelBindingFromModel(availableModels.find((model) => model.id === settings.model))
    || normalizeBrowserModelBinding({ modelId: settings.model || DEFAULT_SETTINGS.model, rawModelId: settings.model || DEFAULT_SETTINGS.model, contextTokens: settings.modelContextTokens || 0 });
}

function currentEffectiveModelBinding(sessionId = settings.sessionId) {
  return resolveBrowserEffectiveModel({
    sessionId,
    sessionModelBindings: settings.sessionModelBindings || {},
    extensionPreferredModel: settings.extensionPreferredModel,
    globalDefaultModel: browserGlobalDefaultModelBinding(),
  });
}

function modelBindingFromSession(session = {}) {
  return normalizeBrowserModelBinding({
    modelId: session.model || session.rawModelId,
    rawModelId: session.rawModelId || session.model,
    provider: session.provider || '',
    contextTokens: session.contextTokens || 0,
  });
}

function applyModelBindingForSession(session = {}) {
  const sessionId = session?.id || settings.sessionId;
  const storedBinding = normalizeBrowserModelBinding(settings.sessionModelBindings?.[sessionId]);
  const sessionBinding = modelBindingFromSession(session);
  const binding = resolveAcknowledgedSessionModelBinding({
    sessionProvider: session?.provider,
    sessionBinding,
    storedBinding,
  });
  if (!binding) return settings;
  const selected = modelForBinding(binding);
  const modelId = selected?.id || binding.modelId || binding.rawModelId || DEFAULT_SETTINGS.model;
  const nextBindings = {
    ...(settings.sessionModelBindings && typeof settings.sessionModelBindings === 'object' ? settings.sessionModelBindings : {}),
    [sessionId]: binding,
  };
  settings = {
    ...settings,
    model: modelId,
    modelContextTokens: selected?.contextTokens || binding.contextTokens || settings.modelContextTokens || 0,
    sessionModelBindings: nextBindings,
    modelScopeVersion: DEFAULT_SETTINGS.modelScopeVersion,
  };
  return settings;
}

function applyModelOptionsForSession(session = {}) {
  const sessionId = session?.id || settings.sessionId;
  const options = resolveAcknowledgedSessionModelOptions({
    sessionOptions: session?.modelOptions,
    storedOptions: settings.sessionModelOptionBindings?.[sessionId],
  });
  if (!options) return settings;
  settings = {
    ...settings,
    thinkingEnabled: options.thinkingEnabled,
    reasoningEffort: options.reasoningEffort,
    fastMode: options.fastMode,
    sessionModelOptionBindings: {
      ...(settings.sessionModelOptionBindings && typeof settings.sessionModelOptionBindings === 'object'
        ? settings.sessionModelOptionBindings
        : {}),
      [sessionId]: options,
    },
  };
  return settings;
}

function preferredModelBindingForNewSession() {
  return normalizeBrowserModelBinding(settings.extensionPreferredModel)
    || modelBindingFromModel(availableModels.find((model) => model.id === settings.model))
    || normalizeBrowserModelBinding({ modelId: settings.model || DEFAULT_SETTINGS.model, rawModelId: settings.model || DEFAULT_SETTINGS.model, contextTokens: settings.modelContextTokens || 0 });
}

function updateModelButtonMeta() {
  const effort = reasoningEffortShortLabel(settings.reasoningEffort);
  const fastMode = normalizeFastMode(settings.fastMode);
  const fast = fastMode ? ' Fast' : '';
  els.currentModelEffort.textContent = `${fast}${effort}`.trim();
  els.currentModelEffort.title = `Reasoning effort: ${effort}${fastMode ? ' · Fast' : ''}`;
}

function inlineAssistRuntimeOptions() {
  return {
    thinkingEnabled: settings.inlineAssistThinkingEnabled !== false,
    reasoningEffort: normalizeReasoningEffort(settings.inlineAssistReasoningEffort || 'low'),
    fastMode: normalizeFastMode(settings.inlineAssistFastMode),
  };
}

function renderInlineAssistRuntimeOptions() {
  if (!els.inlineAssistRuntimeOptions) return;
  const options = inlineAssistRuntimeOptions();
  const effortRows = MODEL_EFFORTS.map((item) => `
    <button class="model-effort-option ${item.value === options.reasoningEffort ? 'selected' : ''}" type="button" data-assist-effort="${item.value}">
      <span>${item.label}</span><strong>${item.value === options.reasoningEffort ? '✓' : ''}</strong>
    </button>
  `).join('');
  els.inlineAssistRuntimeOptions.innerHTML = `
    <div class="model-options-heading">Assist options</div>
    <button class="model-toggle-option" type="button" data-assist-toggle="thinking" aria-pressed="${String(options.thinkingEnabled)}">
      <span>Thinking</span><strong class="toggle-switch ${options.thinkingEnabled ? 'on' : ''}" aria-hidden="true"></strong>
    </button>
    <button class="model-toggle-option" type="button" data-assist-toggle="fast" aria-pressed="${String(options.fastMode)}">
      <span>Fast</span><strong class="toggle-switch ${options.fastMode ? 'on' : ''}" aria-hidden="true"></strong>
    </button>
    <div class="model-options-heading effort-heading">Effort</div>
    <div class="model-effort-list">${effortRows}</div>
  `;
}

function renderInlineAssistModelOptions(models = availableModels) {
  if (!els.inlineAssistModel) return;
  const selectedId = String(settings.inlineAssistModel || settings.model || '');
  const routingSupported = assistModelRoutingSupported(gatewayCapabilities);
  const selected = models.find((model) => (model.id === selectedId || model.rawModelId === selectedId) && isModelRuntimeSelectable(model))
    || (!selectedId ? models.find(isModelRuntimeSelectable) : null)
    || null;
  els.inlineAssistModel.value = selected?.id || selectedId;
  if (els.inlineAssistModelLabel) els.inlineAssistModelLabel.textContent = selected ? modelDisplayName(selected) : (selectedId || translateUiText('Choose model'));
  if (els.inlineAssistModelButton) {
    els.inlineAssistModelButton.disabled = false;
    els.inlineAssistModelButton.title = selected
      ? `${modelProviderLabel(selected)} · ${selected.rawModelId || selected.id} · ${t(routingSupported ? 'assist.routing.exact_short' : 'assist.routing.fallback_short')}`
      : translateUiText('Choose the model used by Hermes Assist');
  }
  if (els.assistModelCapabilityHint) {
    const key = routingSupported ? 'assist.routing.exact' : 'assist.routing.fallback';
    const localized = t(key);
    els.assistModelCapabilityHint.textContent = localized === key && !routingSupported ? ASSIST_ROUTING_FALLBACK_ENGLISH : localized;
  }
  renderInlineAssistRuntimeOptions();
}

async function reconcileInlineAssistModelBinding(models = availableModels) {
  const binding = resolveAssistModelBindingFromCatalog({ settings, models });
  if (!binding) return false;
  const changed = Object.entries(binding).some(([key, value]) => settings[key] !== value);
  if (!changed) return false;
  settings = { ...settings, ...binding };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  return true;
}

function renderModelOptions(models = availableModels) {
  const effectiveBinding = currentEffectiveModelBinding();
  const effectiveModelId = resolveCatalogModelIdForBinding({ binding: effectiveBinding, models });
  if (effectiveModelId && settings.model !== effectiveModelId) {
    settings = {
      ...settings,
      model: effectiveModelId,
      modelContextTokens: effectiveBinding.contextTokens || settings.modelContextTokens || 0,
    };
  }
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
  renderInlineAssistModelOptions(normalized);
  renderModelRuntimeOptions();
  renderContextWindow();
}

async function applyAssistSelectedModel(model) {
  if (!model || !isModelRuntimeSelectable(model)) return;
  settings = {
    ...settings,
    inlineAssistModel: model.id,
    inlineAssistRawModel: model.rawModelId || model.id,
    inlineAssistProvider: model.provider || '',
  };
  renderInlineAssistModelOptions();
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  els.modelMenu.hidden = true;
  els.modelMenuButton.setAttribute('aria-expanded', 'false');
  els.inlineAssistModelButton?.setAttribute('aria-expanded', 'false');
}

function modelForSelectionTarget(target = modelSelectionTarget) {
  const modelId = target === 'assist' ? (settings.inlineAssistModel || settings.model) : settings.model;
  return availableModels.find((model) => model.id === modelId || model.rawModelId === modelId)
    || (target === 'chat' ? availableModels.find((model) => model.id === settings.model) : null)
    || availableModels.find(isModelRuntimeSelectable)
    || availableModels[0]
    || null;
}

function positionAssistModelMenu() {
  if (modelSelectionTarget !== 'assist' || !els.modelMenu || !els.inlineAssistModelButton) return;
  const rect = els.inlineAssistModelButton.getBoundingClientRect();
  const viewportHeight = globalThis.innerHeight || document.documentElement.clientHeight || 800;
  const below = Math.max(0, viewportHeight - rect.bottom - 12);
  const above = Math.max(0, rect.top - 12);
  const desiredHeight = Math.min(560, Math.max(300, Math.floor(viewportHeight * 0.66)));
  const openBelow = below >= Math.min(360, desiredHeight) || below >= above;
  const availableHeight = Math.max(260, openBelow ? below : above);
  els.modelMenu.style.maxHeight = `${Math.min(desiredHeight, availableHeight)}px`;
  if (openBelow) {
    els.modelMenu.style.top = `${Math.round(rect.bottom + 6)}px`;
    els.modelMenu.style.bottom = 'auto';
  } else {
    els.modelMenu.style.top = 'auto';
    els.modelMenu.style.bottom = `${Math.round(viewportHeight - rect.top + 6)}px`;
  }
  if (!els.modelMenu.hidden) {
    const menuRect = els.modelMenu.getBoundingClientRect();
    if (menuRect.bottom > viewportHeight - 12) {
      els.modelMenu.style.top = `${Math.max(12, Math.round(viewportHeight - menuRect.height - 12))}px`;
      els.modelMenu.style.bottom = 'auto';
    } else if (menuRect.top < 12) {
      els.modelMenu.style.top = '12px';
      els.modelMenu.style.bottom = 'auto';
    }
  }
}

function setModelSelectionTarget(target = 'chat') {
  modelSelectionTarget = target === 'assist' ? 'assist' : 'chat';
  if (modelSelectionTarget === 'assist') {
    if (els.modelMenu.parentElement !== document.body) document.body.append(els.modelMenu);
    els.modelMenu.dataset.selectionTarget = 'assist';
    if (els.modelMenuTitle) els.modelMenuTitle.textContent = translateUiText('Choose Assist model');
  } else {
    if (modelMenuHome.parent && els.modelMenu.parentElement !== modelMenuHome.parent) {
      modelMenuHome.parent.insertBefore(els.modelMenu, modelMenuHome.next);
    }
    delete els.modelMenu.dataset.selectionTarget;
    els.modelMenu.style.removeProperty('top');
    els.modelMenu.style.removeProperty('bottom');
    els.modelMenu.style.removeProperty('max-height');
  }
  const selected = modelForSelectionTarget(modelSelectionTarget);
  selectedModelProvider = selected ? modelProviderLabel(selected) : '';
  els.modelSearchInput.value = '';
  els.modelProviderList.scrollLeft = 0;
  els.modelMenuList.scrollTop = 0;
  renderModelMenu('');
  renderModelRuntimeOptions();
  if (modelSelectionTarget === 'assist') positionAssistModelMenu();
  globalThis.queueMicrotask(() => {
    els.modelProviderList.querySelector('.model-provider-option.selected')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
}

function renderModelMenu(query = els.modelSearchInput?.value || '') {
  const menuModelId = modelSelectionTarget === 'assist' ? (settings.inlineAssistModel || settings.model) : settings.model;
  const allGroups = groupModelsForMenu(availableModels, menuModelId, '');
  const needle = String(query || '').trim().toLowerCase();
  const matchingGroups = needle ? groupModelsForMenu(availableModels, menuModelId, needle) : allGroups;
  els.modelProviderList.innerHTML = '';
  els.modelMenuList.innerHTML = '';

  if (!allGroups.length) {
    const empty = document.createElement('div');
    empty.className = 'model-group-title';
    empty.textContent = translateUiText('No providers found');
    els.modelMenuList.appendChild(empty);
    return;
  }

  const selectedModel = availableModels.find((model) => model.id === menuModelId);
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
    empty.textContent = translateUiText('No models match');
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
      button.className = `model-option ${model.id === menuModelId ? 'selected' : ''} ${requestable ? '' : 'observed'}`.trim();
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
      meta.textContent = model.id === menuModelId ? '✓' : (!requestable ? 'observed' : (model.contextTokens ? formatTokens(model.contextTokens).replace(' tokens', '') : runtimeStatus.label));

      button.append(name, meta);
      button.addEventListener('click', async () => {
        if (modelSelectionTarget === 'assist') await applyAssistSelectedModel(model);
        else applySelectedModel(model.id, { keepOpen: true });
      });
      els.modelMenuList.appendChild(button);
    }
  }
}

function renderModelRuntimeOptions() {
  if (!els.modelOptionsList) return;
  const assistTarget = modelSelectionTarget === 'assist';
  const assistOptions = inlineAssistRuntimeOptions();
  const thinkingEnabled = assistTarget ? assistOptions.thinkingEnabled : settings.thinkingEnabled !== false;
  const fastMode = assistTarget ? assistOptions.fastMode : normalizeFastMode(settings.fastMode);
  const effort = assistTarget ? assistOptions.reasoningEffort : normalizeReasoningEffort(settings.reasoningEffort);
  const effortRows = MODEL_EFFORTS.map((item) => `
    <button class="model-effort-option ${item.value === effort ? 'selected' : ''}" type="button" data-effort="${item.value}">
      <span>${item.label}</span><strong>${item.value === effort ? '✓' : ''}</strong>
    </button>
  `).join('');
  els.modelOptionsList.innerHTML = `
    <div class="model-options-heading">${assistTarget ? 'Hermes Assist options' : 'Options'}</div>
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
  browserApi.storage.local.set({ hermesBrowserSettings: settings });
}

function setModelRuntimeOption(key, value) {
  const previousOptions = resolveBrowserEffectiveModelOptions({
    sessionId: settings.sessionId,
    sessionModelOptionBindings: settings.sessionModelOptionBindings,
    extensionPreferredModelOptions: settings.extensionPreferredModelOptions,
  });
  const previousPreferredModelOptions = settings.extensionPreferredModelOptions;
  const previousSessionModelOptionBindings = { ...(settings.sessionModelOptionBindings || {}) };
  const nextSettings = { ...settings, [key]: value };
  const fastMode = normalizeFastMode(nextSettings.fastMode);
  const scope = updateBrowserModelOptionScope({
    options: {
      thinkingEnabled: nextSettings.thinkingEnabled !== false,
      reasoningEffort: normalizeReasoningEffort(nextSettings.reasoningEffort),
      fastMode,
      serviceTier: fastMode ? 'priority' : null,
    },
    sessionId: settings.sessionId,
    sessionModelOptionBindings: settings.sessionModelOptionBindings || {},
  });
  settings = {
    ...nextSettings,
    fastMode,
    extensionPreferredModelOptions: scope.extensionPreferredModelOptions,
    sessionModelOptionBindings: scope.sessionModelOptionBindings,
  };
  renderModelRuntimeOptions();
  updateModelButtonMeta();
  persistModelRuntimeOptions();
  modelOptionSelectionVersion += 1;
  void syncSessionModelOptions({
    sessionId: settings.sessionId,
    optionVersion: modelOptionSelectionVersion,
    requestedOptions: scope.extensionPreferredModelOptions,
    previousOptions,
    previousPreferredModelOptions,
    previousSessionModelOptionBindings,
  });
}

async function fetchAcknowledgedSessionModelOptions(sessionId) {
  if (!sessionId || isRemoteWsMode()) return null;
  const response = await apiFetch(`/api/sessions/${encodeSessionId(sessionId)}`);
  const payload = await readJsonResponse(response);
  if (!response.ok) return null;
  return normalizeHermesSessions({ data: [payload?.session || payload] })[0]?.modelOptions || null;
}

async function syncSessionModelOptions({
  sessionId,
  optionVersion,
  requestedOptions,
  previousOptions,
  previousPreferredModelOptions,
  previousSessionModelOptionBindings,
} = {}) {
  if (!sessionId) return { state: 'pending' };
  if (sessionId !== settings.sessionId) return { state: 'stale' };
  if (isRemoteWsMode()) {
    setStatus('warn', 'Hermes model options pending', 'Dashboard WebSocket does not expose an existing-session model-options update yet. These options will apply to the next new session.');
    return { state: 'pending' };
  }
  if (isUnsavedBrowserDraftSession({ sessionId, sessions: availableSessions })) {
    setStatus('warn', 'Hermes model options pending', 'Selected for this draft; Hermes will confirm these options when the first message saves the session.');
    return { state: 'pending' };
  }
  const supportsLock = Boolean(gatewayCapabilities?.sessionModelLock || gatewayCapabilities?.endpoints?.session_model_lock);
  if (!supportsLock) {
    setStatus('warn', 'Hermes model options pending', 'The connected runtime will receive these options on the next turn, but does not expose an acknowledgement endpoint.');
    return { state: 'pending' };
  }
  setStatus('warn', 'Hermes model options pending', 'Waiting for the session resource to confirm Thinking, effort, and Fast mode.');
  try {
    const payload = await requestSessionModelLock(currentSelectedModel(), { sessionId });
    if (optionVersion !== modelOptionSelectionVersion) return { state: 'stale' };
    if (sessionId !== settings.sessionId) return { state: 'stale' };
    const acknowledgedSessionOptions = await fetchAcknowledgedSessionModelOptions(sessionId);
    if (optionVersion !== modelOptionSelectionVersion) return { state: 'stale' };
    if (sessionId !== settings.sessionId) return { state: 'stale' };
    const acknowledged = acknowledgedSessionOptions
      || payload?.runtime?.model_options
      || payload?.model_options
      || null;
    const ack = modelOptionsRuntimeAckState({
      requested: requestedOptions,
      runtime: acknowledged ? { model_options: acknowledged } : payload?.runtime || {},
    });
    if (ack.state === 'confirmed') {
      setStatus('ok', 'Hermes model options confirmed', ack.detail);
    } else if (ack.state === 'mismatch') {
      setStatus('warn', 'Hermes model options mismatch', ack.detail);
    } else {
      setStatus('warn', 'Hermes model options pending', ack.detail);
    }
    return ack;
  } catch (error) {
    if (optionVersion !== modelOptionSelectionVersion) return { state: 'stale' };
    if (sessionId !== settings.sessionId) return { state: 'stale' };
    const rollback = previousOptions || DEFAULT_SETTINGS.extensionPreferredModelOptions;
    settings = {
      ...settings,
      thinkingEnabled: rollback.thinkingEnabled,
      reasoningEffort: rollback.reasoningEffort,
      fastMode: rollback.fastMode,
      extensionPreferredModelOptions: previousPreferredModelOptions,
      sessionModelOptionBindings: previousSessionModelOptionBindings,
    };
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    renderModelOptions(availableModels);
    setStatus('error', 'Hermes model options failed', error?.message || String(error), { translateDetail: false });
    return { state: 'failed', error };
  }
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
  const session = availableSessions.find((item) => item.id === settings.sessionId) || {};
  const runtime = activeSessionRuntime.sessionId === settings.sessionId ? activeSessionRuntime : {};
  const loadedContextEstimate = loadedSessionContextEstimate.sessionId === settings.sessionId
    ? loadedSessionContextEstimate
    : { contextTokens: 0, visibleTokens: 0 };
  const localSessionContextTokens = estimateLocalSessionContextTokens({
    messages,
    nextPromptTokens: stats.estimatedTokens,
    loadedContextTokens: loadedContextEstimate.contextTokens,
    loadedVisibleTokens: loadedContextEstimate.visibleTokens,
  });
  const accounting = contextAccountingSnapshot({
    localPromptTokens: localSessionContextTokens,
    draftTokens: attachmentTokens,
    runtime,
    session,
    modelContextTokens: stats.modelContextTokens,
  });
  const contextLimit = accounting.contextLimitTokens || stats.modelContextTokens;
  const runtimeLabel = [runtime.provider, runtime.model].filter(Boolean).join(' · ');
  const meter = contextMeterDisplay({ accounting, runtimeLabel, modelContextTokens: contextLimit });
  const compaction = contextCompactionState({ accounting, runtime, session });

  els.contextCompactLabel.textContent = meter.compactLabel;
  els.contextPercentLabel.textContent = meter.percentLabel;
  els.contextBarButton.title = meter.title;
  els.contextUsageDetail.textContent = compaction.detail;
  els.contextMeterFill.style.width = contextLimit ? `${Math.min(100, Math.max(0, meter.percent))}%` : '0%';

  const compactionStateLabels = {
    healthy: 'Healthy',
    due: 'Due next Hermes turn',
    'over-limit': 'Over limit · recovery pending',
    unknown: 'Telemetry unavailable',
  };
  const telemetrySourceLabels = {
    runtime: 'Live runtime',
    session: 'Persisted session',
    'local-estimate': 'Local next-request estimate',
    unknown: 'Unavailable',
  };
  const runtimeRows = [
    [translateUiText(accounting.source === 'local-estimate' ? 'Next request estimate' : 'Session context'), `${formatNumber(compaction.usedTokens)} ${translateUiText('tokens')}`],
    [translateUiText('Context limit'), compaction.contextLimitTokens ? `${formatNumber(compaction.contextLimitTokens)} ${translateUiText('tokens')}` : translateUiText('Not reported by Hermes')],
    [translateUiText('Auto-compact trigger'), compaction.thresholdTokens ? `${formatNumber(compaction.thresholdTokens)} ${translateUiText('tokens')} · ${compaction.thresholdPercent}%` : translateUiText('Not reported by Hermes')],
    [translateUiText('Compactions'), compaction.compressionCountKnown ? formatNumber(compaction.compressionCount) : translateUiText('Not reported by Hermes')],
    [translateUiText('Compaction state'), translateUiText(compactionStateLabels[compaction.state] || compactionStateLabels.unknown)],
    [translateUiText('Telemetry source'), translateUiText(telemetrySourceLabels[compaction.source] || telemetrySourceLabels.unknown)],
  ];
  els.contextRuntimeBreakdown.innerHTML = runtimeRows.map(([label, value]) => `
    <dt>${escapeHtml(label)}</dt>
    <dd>${escapeHtml(value)}</dd>
  `).join('');

  const controls = contextControlState({ capabilities: gatewayCapabilities, percentUsed: meter.percent, contextSource: accounting.source });
  if (els.contextControlStatus) {
    els.contextControlStatus.textContent = translateUiText(controls.canCompact
      ? controls.label
      : 'Hermes owns automatic compaction for this connection.');
  }
  if (els.contextCompactButton) {
    els.contextCompactButton.hidden = !controls.canCompact;
    els.contextCompactButton.disabled = !controls.canCompact || !settings.sessionId;
    els.contextCompactButton.textContent = translateUiText(controls.compactRecommended ? 'Compact recommended' : 'Compact context');
    els.contextCompactButton.title = translateUiText(controls.canCompact
      ? 'Ask Hermes to compact this session context.'
      : 'The connected Hermes runtime does not advertise native session compaction.');
  }

  const pc = currentContext?.pageContext;
  if (contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) {
    els.contextChipLabel.textContent = translateUiText('💬 Chat only');
    els.contextChip.title = translateUiText('No browser tab, selected text, open tabs, metadata, transcript, or page text will be attached.');
    els.contextPreview.textContent = translateUiText('Chat only mode is active. Hermes will not read or attach browser context for this turn.');
  } else {
    const chip = contextChipSummary({ pageContext: pc, activeTab: currentContext.activeTab, parts: stats.parts });
    els.contextChipLabel.textContent = translateUiText(chip.label);
    els.contextChip.title = translateUiText(chip.title);
    els.contextPreview.textContent = [
      currentContext.activeTab?.title || '(unknown tab)',
      currentContext.activeTab?.url || '',
      '',
      clampText(pc?.selectedText || pc?.text || pc?.reason || pc?.error || 'No readable page text captured yet.', 900),
    ].filter(Boolean).join('\n');
  }

  if (els.explicitSiteCaptureButton) {
    const action = contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY
      ? null
      : explicitSiteCaptureAction(pc);
    els.explicitSiteCaptureButton.hidden = !action;
    if (action) {
      els.explicitSiteCaptureButton.querySelector('strong').textContent = translateUiText(action.label);
      els.explicitSiteCaptureButton.querySelector('span').textContent = translateUiText(action.description);
    }
  }

  const rows = [
    [translateUiText('User draft'), stats.parts.userRequest],
    [translateUiText('Active tab'), stats.parts.activeTab],
    [translateUiText('Open tabs'), stats.parts.openTabs],
    [translateUiText('Selection'), stats.parts.selectedText],
    [translateUiText('Metadata'), stats.parts.pageMetadata],
    [translateUiText('YouTube transcript'), stats.parts.youtubeTranscript],
    [translateUiText('Page text'), stats.parts.pageText],
  ];
  els.contextBreakdown.innerHTML = rows.map(([label, part]) => `
    <dt>${label}</dt>
    <dd title="${part.enabled ? 'included' : 'disabled'}">${part.enabled ? `${formatNumber(part.estimatedTokens)} tok · ${formatNumber(part.chars)} chars` : 'disabled'}</dd>
  `).join('');
}

function applySelectedModel(selectedId, { persist = true, keepOpen = false } = {}) {
  const previousId = settings.model;
  const previousBinding = currentEffectiveModelBinding();
  const nextId = selectedId || DEFAULT_SETTINGS.model;
  const selected = availableModels.find((model) => model.id === nextId);
  if (selected?.source === 'external') {
    selectedModelProvider = modelProviderLabel(selected);
    renderModelMenu();
    setStatus('warn', 'Custom model source is discovery-only', 'This model was discovered from a custom endpoint, but Hermes must expose it through the connected runtime before Browser can route requests to it.');
    return;
  }
  if (selected) selectedModelProvider = modelProviderLabel(selected);
  const scope = updateBrowserModelScope({
    selectedModel: selected ? modelBindingFromModel(selected) : { modelId: nextId, rawModelId: nextId, contextTokens: 0 },
    sessionId: settings.sessionId,
    sessionModelBindings: settings.sessionModelBindings || {},
  });
  settings = {
    ...settings,
    model: nextId,
    modelContextTokens: selected?.contextTokens || 0,
    extensionPreferredModel: scope.extensionPreferredModel,
    sessionModelBindings: scope.sessionModelBindings,
    modelScopeVersion: DEFAULT_SETTINGS.modelScopeVersion,
  };
  sessionRoutesAvailable = null;
  renderModelOptions(availableModels);
  if (keepOpen) {
    updateDockFloatingAnchor();
    els.modelMenu.hidden = false;
    els.modelMenuButton.setAttribute('aria-expanded', 'true');
    els.modelSearchInput.focus();
  } else {
    els.modelMenu.hidden = true;
    els.modelMenuButton.setAttribute('aria-expanded', 'false');
  }
  if (persist) browserApi.storage.local.set({ hermesBrowserSettings: settings });
  if (persist && selected) {
    modelSelectionVersion += 1;
    pendingModelRuntimeAck = {
      version: modelSelectionVersion,
      model: selected.rawModelId || selected.model || selected.id || nextId,
      provider: selected.provider || '',
      gatewayAlias: selected.gatewayAlias === true,
      gatewayDefault: selected.gatewayDefault === true,
      modelLabel: modelDisplayName(selected),
      providerLabel: modelProviderLabel(selected),
    };
    const status = modelRuntimeStatus(selected);
    const requestedDetail = `${modelProviderLabel(selected)} · ${modelDisplayName(selected)}`;
    void syncSessionModelLock(selected, {
      previousId,
      previousBinding,
      requestedDetail,
      statusDetail: status.detail,
    });
  }
}

async function requestSessionModelLock(selected = currentSelectedModel(), { sessionId = settings.sessionId } = {}) {
  if (!sessionId) throw new Error('No active Hermes session for model lock.');
  const response = await apiFetch(`/api/sessions/${encodeSessionId(sessionId)}/model`, {
    method: 'POST',
    body: JSON.stringify({
      client_runtime_version: modelSelectionVersion,
      provider: selected?.provider || currentModelProviderSlug() || '',
      model: selected?.rawModelId || selected?.model || selected?.id || currentModelRequestId(),
      model_options: currentModelOptionsPayload(),
      require_model_lock: true,
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || `Hermes model lock failed (${response.status})`);
  }
  return payload;
}

async function syncSessionModelLock(selected, { previousId = '', previousBinding = null, requestedDetail = '', statusDetail = '' } = {}) {
  if (isRemoteWsMode()) {
    setStatus('warn', 'Cloud model switch pending', `${requestedDetail || modelDisplayName(selected) || settings.model} — waiting for the live Cloud session to confirm.`);
    try {
      const connection = await ensureRemoteWsClient();
      const liveSessionId = await ensureRemoteWsSession(connection);
      const request = buildSessionModelSwitchRequest({
        sessionId: liveSessionId,
        model: selected?.rawModelId || selected?.model || selected?.id || '',
        provider: selected?.provider || currentModelProviderSlug() || '',
      });
      const payload = await connection.client.request(request.method, request.params);
      if (payload?.confirm_required) {
        throw new Error(payload.confirm_message || 'Hermes requires confirmation before switching to this model.');
      }
      const statusPayload = await connection.client.request(WS_METHODS.sessionStatus, { session_id: liveSessionId });
      const runtime = runtimeModelFromSessionStatus(statusPayload);
      const ack = modelRuntimeAckState({
        requested: {
          provider: selected?.provider || '',
          model: selected?.rawModelId || selected?.model || selected?.id || '',
          gatewayAlias: selected?.gatewayAlias === true,
          gatewayDefault: selected?.gatewayDefault === true,
        },
        runtime,
      });
      if (ack.state !== 'confirmed') {
        const active = [runtime.provider, runtime.model].filter(Boolean).join(' · ') || 'an unreported model';
        throw new Error(`Hermes kept ${active} active instead of the requested model.`);
      }
      runtime.context_length = selected?.contextTokens || settings.modelContextTokens || 0;
      applySessionRuntimeSnapshot({
        sessionId: settings.sessionId || liveSessionId,
        runtime,
        source: 'Cloud model switch',
      });
      applyPendingModelRuntimeAck(runtime);
      setStatus('ok', 'Cloud model switched', `${modelProviderLabel(selected)} · ${modelDisplayName(selected)} is active for this session.`);
      return { state: 'confirmed', payload };
    } catch (error) {
      if (previousId) {
        const remoteRollbackScope = updateBrowserModelScope({
          selectedModel: previousBinding || { modelId: previousId, rawModelId: previousId, contextTokens: 0 },
          sessionId: settings.sessionId,
          sessionModelBindings: settings.sessionModelBindings || {},
        });
        settings = {
          ...settings,
          model: previousId,
          modelContextTokens: previousBinding?.contextTokens || settings.modelContextTokens || 0,
          extensionPreferredModel: remoteRollbackScope.extensionPreferredModel,
          sessionModelBindings: remoteRollbackScope.sessionModelBindings,
        };
        await browserApi.storage.local.set({ hermesBrowserSettings: settings });
        renderModelOptions(availableModels);
      }
      pendingModelRuntimeAck = null;
      setStatus('error', 'Cloud model switch failed', error?.message || String(error), { translateDetail: false });
      return { state: 'failed', error };
    }
  }
  if (isUnsavedBrowserDraftSession({ sessionId: settings.sessionId, sessions: availableSessions })) {
    setStatus(
      'warn',
      'Hermes model requested',
      `${requestedDetail || modelDisplayName(selected) || settings.model} — selected for this draft; Hermes will confirm it when the first message saves the session.${statusDetail ? ` ${statusDetail}` : ''}`,
    );
    return { state: 'pending', payload: null };
  }
  const requiresLock = shouldRequireModelLock({
    provider: selected?.provider || currentModelProviderSlug(),
    model: selected?.rawModelId || selected?.model || selected?.id || currentModelRequestId(),
    defaultModel: DEFAULT_SETTINGS.model,
    gatewayDefault: selected?.gatewayDefault === true,
  });
  if (!requiresLock) {
    setStatus(
      'warn',
      'Gateway default requested',
      `${requestedDetail || modelDisplayName(selected) || settings.model} — Hermes will report the provider and model that actually execute the next turn.`,
    );
    return { state: 'pending', payload: null };
  }
  const supportsLock = Boolean(gatewayCapabilities?.sessionModelLock || gatewayCapabilities?.endpoints?.session_model_lock);
  if (!supportsLock || !settings.sessionId) {
    setStatus(
      'warn',
      'Hermes model requested',
      `${requestedDetail || modelDisplayName(selected) || settings.model} — requested; gateway will confirm on next turn.${statusDetail ? ` ${statusDetail}` : ''}`,
    );
    return { state: 'pending', payload: null };
  }
  setStatus('warn', 'Model lock pending', `${requestedDetail || modelDisplayName(selected) || settings.model} — waiting for Hermes acknowledgement.`);
  try {
    const payload = await requestSessionModelLock(selected);
    const runtime = payload?.runtime || {};
    const ack = modelRuntimeAckState({
      requested: {
        provider: selected?.provider || '',
        model: selected?.rawModelId || selected?.model || selected?.id || '',
        gatewayAlias: selected?.gatewayAlias === true,
        gatewayDefault: selected?.gatewayDefault === true,
      },
      runtime,
    });
    if (ack.state === 'confirmed' || String(runtime.model_lock || '').toLowerCase() === 'accepted') {
      setStatus('ok', 'Hermes model lock accepted', ack.detail || requestedDetail || 'Backend accepted the session model lock.');
      if (runtime.provider || runtime.model) applyPendingModelRuntimeAck(runtime);
      return { state: 'confirmed', payload };
    }
    setStatus('warn', 'Model lock pending', ack.detail || 'Gateway accepted the lock request without full runtime confirmation.');
    return { state: 'pending', payload };
  } catch (error) {
    if (previousId) {
      const rollbackScope = updateBrowserModelScope({
        selectedModel: previousBinding || { modelId: previousId, rawModelId: previousId, contextTokens: 0 },
        sessionId: settings.sessionId,
        sessionModelBindings: settings.sessionModelBindings || {},
      });
      settings = {
        ...settings,
        model: previousId,
        modelContextTokens: previousBinding?.contextTokens || settings.modelContextTokens || 0,
        extensionPreferredModel: rollbackScope.extensionPreferredModel,
        sessionModelBindings: rollbackScope.sessionModelBindings,
      };
      browserApi.storage.local.set({ hermesBrowserSettings: settings });
      renderModelOptions(availableModels);
    }
    pendingModelRuntimeAck = null;
    setStatus('error', 'Model lock failed', error?.message || String(error), { translateDetail: false });
    return { state: 'failed', error };
  }
}

async function ensureActiveSessionModelLockOrThrow() {
  const selected = currentSelectedModel();
  const needsLock = shouldRequireModelLock({
    provider: currentModelProviderSlug(),
    model: currentModelRequestId(),
    defaultModel: DEFAULT_SETTINGS.model,
    gatewayDefault: selected?.gatewayDefault === true,
  });
  if (!needsLock) return true;
  const supportsLock = Boolean(gatewayCapabilities?.sessionModelLock || gatewayCapabilities?.endpoints?.session_model_lock);
  if (!supportsLock) return true;
  if (!settings.sessionId) return true;
  try {
    setStatus('warn', 'Model lock pending', 'Hermes has not acknowledged this session/model pair yet. Retrying lock before sending.');
    await requestSessionModelLock(selected);
    return true;
  } catch (error) {
    setStatus('error', 'Model lock failed', t('status.model_lock_failed_detail', { error: error?.message || error }), { translateDetail: false });
    throw error;
  }
}

function renderModelRefreshState() {
  const state = modelRefreshControlState({ refreshing: modelsRefreshing });
  if (els.refreshModelsButton) {
    els.refreshModelsButton.disabled = state.disabled;
    els.refreshModelsButton.textContent = translateUiText(state.label);
    els.refreshModelsButton.title = translateUiText(state.title);
    els.refreshModelsButton.setAttribute('aria-label', translateUiText(state.title));
    els.refreshModelsButton.setAttribute('aria-busy', state.ariaBusy);
    els.refreshModelsButton.classList.toggle('model-refreshing', modelsRefreshing);
  }
  if (els.modelRefreshStatus) {
    els.modelRefreshStatus.textContent = translateUiText(state.status);
    els.modelRefreshStatus.hidden = !state.status;
  }
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

async function writeCachedModelCatalog(models) {
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

async function loadModels({ quiet = false, payload = null, refresh = false } = {}) {
  const previousSelectedModel = settings.model;
  const trackRefresh = Boolean(refresh && !payload);
  if (trackRefresh) {
    if (modelsRefreshing) return { ok: false, skipped: true, error: 'Model refresh is already running.' };
    modelsRefreshing = true;
    renderModelRefreshState();
    if (!quiet) setStatus('ok', 'Refreshing models', 'Syncing Hermes model catalog… this can take 20–30 seconds.');
  }
  try {
    let data = payload;
    let registryModels = [];
    let registrySource = '';
    const cachedCatalogModels = await readCachedModelCatalog();

    if (!data && isRemoteWsMode()) {
      // Remote reads go over the WS (REST is CORS-blocked). Only possible once
      // a socket is open; otherwise keep the default model until connected.
      if (remoteWsConnection?.client?.readyState !== 1) {
        availableModels = normalizeHermesModels([], settings.model);
        renderModelOptions(availableModels);
        return { ok: false, count: availableModels.length, error: 'Remote Hermes is not connected.' };
      }
      data = modelRowsFromGatewayOptions(await remoteWsConnection.client.request(WS_METHODS.modelOptions));
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
          const cachedFallback = selectModelCatalogFallback({ cachedModels: cachedCatalogModels });
          if (cachedFallback.models.length) {
            registryModels = normalizeHermesModels(cachedFallback.models, settings.model);
            registrySource = cachedFallback.source;
            if (!quiet) {
              setStatus('warn', 'Using cached Hermes catalog', 'The live model catalog is unavailable; keeping the last verified provider/model list.');
            }
          } else {
            const virtualResult = await discoverGatewayVirtualModels({ apiFetch, readJsonResponse });
            if (!virtualResult.ok || !virtualResult.models.length) {
              throw new Error(virtualResult.error || 'Hermes did not advertise a gateway model alias.');
            }
            registryModels = normalizeHermesModels(virtualResult.models, settings.model);
            registrySource = 'gateway';
            if (!quiet && registryResult.error && registryResult.error !== 'status-404') {
              setStatus('warn', 'Model registry unavailable', t('status.model_registry_fallback', { error: registryResult.error }), { translateDetail: false });
            }
          }
        }
      }
    }

    if (!isRemoteWsMode() && registrySource !== 'gateway') {
      const virtualResult = await discoverGatewayVirtualModels({ apiFetch, readJsonResponse });
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
        setStatus('warn', 'Model discovery limited', t('status.model_discovery_limited', { error: sessionResult.error }), { translateDetail: false });
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
    await reconcileInlineAssistModelBinding(availableModels);
    renderModelOptions(availableModels);
    applySelectedModel(settings.model, { persist: false });
    if (!quiet) {
      const sourceLabel = registrySource === 'registry'
        ? 'from Hermes model registry'
        : registrySource === 'dashboard'
          ? 'from Hermes dashboard'
          : registrySource === 'sessions'
            ? 'from session history'
            : registrySource === 'cache'
              ? 'from the last verified Hermes catalog'
            : registrySource.includes('external')
              ? 'from Hermes plus custom model sources'
              : 'from local Hermes';
      setStatus('ok', 'Hermes models synced', `${availableModels.length} model${availableModels.length === 1 ? '' : 's'} available ${sourceLabel}`);
    }
    return { ok: true, count: availableModels.length, source: registrySource };
  } catch (error) {
    availableModels = normalizeHermesModels([], settings.model);
    renderModelOptions(availableModels);
    renderContextWindow();
    const diagnostic = classifyGatewayError(error);
    if (diagnostic.probeStatus === 'degraded') markGatewayDegraded(error);
    if (!quiet) setStatus(
      'warn',
      diagnostic.kind === 'unknown' ? 'Model sync failed' : diagnostic.title,
      diagnostic.kind === 'unknown' ? (error?.message || String(error)) : translateUiText(diagnostic.detail),
      { translateDetail: false },
    );
    return { ok: false, count: availableModels.length, error: diagnostic.kind === 'unknown' ? (error?.message || String(error)) : diagnostic.detail };
  } finally {
    if (trackRefresh) {
      modelsRefreshing = false;
      renderModelRefreshState();
    }
  }
}

async function refreshModelsFromMenu() {
  const outcome = await loadModels({ refresh: true });
  showOperationToast(outcome?.ok
    ? { title: 'Models refreshed', detail: `${outcome.count} model${outcome.count === 1 ? '' : 's'} ready in Hermes Browser.` }
    : { kind: 'warn', title: 'Model refresh incomplete', detail: outcome?.error || 'Hermes kept the current model catalog.' });
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
    if (!quiet) setStatus('warn', 'Skill sync failed', error?.message || String(error), { translateDetail: false });
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
    builtinSuggestions = browserCommandsForSurface('sidepanel').filter((c) => {
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
  if (!open) {
    clearQuickCommandDetail();
  } else {
    scrollInputToCaret();
  }
}

function scrollInputToCaret() {
  const input = els.input;
  if (!input) return;
  requestAnimationFrame(() => {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const pos = (typeof start === 'number' && Number.isInteger(start)) ? start : (input.value ? input.value.length : 0);
    if (typeof input.setSelectionRange === 'function' && typeof start === 'number' && typeof end === 'number') {
      input.setSelectionRange(start, end);
    }
    if (pos >= (input.value?.length || 0)) {
      input.scrollTop = input.scrollHeight;
    } else {
      const textBefore = String(input.value || '').slice(0, pos);
      const lines = textBefore.split('\n').length;
      const totalLines = Math.max(1, String(input.value || '').split('\n').length);
      input.scrollTop = Math.max(0, Math.round((lines / totalLines) * input.scrollHeight - input.clientHeight / 2));
    }
  });
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
  detail.querySelector('[data-command-detail-category]').textContent = translateUiText(cmd.category || 'Command');
  detail.querySelector('[data-command-detail-description]').textContent = translateUiText(cmd.description);
  detail.querySelector('[data-command-detail-hint]').textContent = translateUiText(cmd.promptHint || (cmd.requiresInput
    ? 'Add instructions after the slash command before sending.'
    : 'Runs immediately against the current browser context.'));
  detail.querySelector('[data-command-detail-footnote]').textContent = translateUiText(cmd.requiresInput
    ? 'Click to insert, then add details.'
    : 'Click or press Enter to run.');
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
  const surfaceCommands = browserCommandsForSurface('sidepanel');
  const commands = category === 'all'
    ? surfaceCommands
    : surfaceCommands.filter((c) => c.category === category);
  if (!commands.length) { setQuickCommandMenuOpen(false); return; }

  els.quickMoreMenu.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'quick-more-heading';
  const headerLabel = document.createElement('span');
  headerLabel.textContent = translateUiText('Commands');
  const headerHint = document.createElement('small');
  headerHint.textContent = translateUiText('Slash helpers');
  header.append(headerLabel, headerHint);
  els.quickMoreMenu.appendChild(header);

  const detail = document.createElement('aside');
  detail.id = 'quickCommandDetail';
  detail.className = 'quick-command-detail';
  detail.dataset.commandDetail = 'true';
  detail.hidden = true;
  detail.setAttribute('aria-live', 'polite');
  detail.setAttribute('aria-label', translateUiText('Command details'));

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
    description.textContent = translateUiText(cmd.description);
    const categoryTag = document.createElement('span');
    categoryTag.className = 'qmi-category';
    categoryTag.textContent = translateUiText(cmd.category || '');
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
  els.profileSelect.replaceChildren();
  const detectOption = document.createElement('option');
  detectOption.value = '';
  detectOption.textContent = translateUiText('Detect from Hermes gateway');
  els.profileSelect.appendChild(detectOption);
  for (const profile of availableProfiles) {
    const option = document.createElement('option');
    option.value = profile.name;
    option.textContent = `${profile.name}${profile.active ? ` · ${translateUiText('active')}` : ''}${profile.model ? ` · ${profile.model}` : ''}`;
    option.selected = profile.name === selected;
    els.profileSelect.appendChild(option);
  }
  els.profileSelect.value = selected;
  if (!settings.activeProfile && selected) settings = { ...settings, activeProfile: selected };
  if (availableProfiles.length) {
    const active = availableProfiles.find((profile) => profile.name === selected) || availableProfiles.find((profile) => profile.active);
    els.profileStatus.textContent = active
      ? t('profile.using', {
        name: active.name,
        model: active.model ? ` · ${active.model}` : '',
        skills: active.skillCount ? ` · ${active.skillCount} ${translateUiText('skills')}` : '',
      })
      : t('profile.available', { count: availableProfiles.length });
  } else if (isRemoteWsMode()) {
    els.profileStatus.textContent = 'Profile API unavailable from the extension origin. Open the Hermes dashboard and sign in to select a profile.';
  } else {
    els.profileStatus.textContent = translateUiText('Profile API unavailable. Browser will use the currently running Hermes gateway profile.');
  }
}

// The profile we send to the dashboard. Empty string is a valid signal
// (create under the running default profile), so we only fall back to the
// dashboard-detected active profile when nothing is explicitly chosen.
// An explicit persisted selection is preserved even when the roster is
// temporarily unavailable: silently downgrading it to '' would recreate the
// profile-routing bug this feature fixes (issue #60 review).
function safeActiveProfile() {
  if (settings.activeProfile) {
    if (availableProfiles.some((profile) => profile.name === settings.activeProfile)) {
      return settings.activeProfile;
    }
    // The roster may be empty after a transient discovery failure, but the
    // user explicitly chose this profile. Fail closed: keep sending it rather
    // than silently falling back to the default profile.
    if (!availableProfiles.length) return settings.activeProfile;
  }
  const detected = availableProfiles.find((profile) => profile.active)?.name || '';
  return detected;
}

function profileDiscoveryHelp(reason = '', origin = '') {
  switch (reason) {
    case 'no_dashboard_tab':
      return `Open ${origin || 'your Hermes dashboard'} in a tab and sign in, then refresh profiles.`;
    case 'not_signed_in':
      return 'Your Hermes dashboard tab is not signed in. Sign in there, then refresh profiles.';
    case 'no_dashboard_session_token':
      return 'The dashboard tab did not expose a session token; reload the dashboard and sign in.';
    case 'bad_base_url':
      return 'The remote gateway URL is not a valid https URL.';
    case 'scripting_unavailable':
      return 'This extension context cannot read the dashboard.';
    default:
      return `Could not discover Hermes profiles (${reason || 'unknown'}).`;
  }
}

async function loadProfiles({ quiet = false } = {}) {
  // Remote dashboard mode has no apiKey and its REST surface is CORS-blocked
  // from the extension origin. Discover profiles first-party inside the
  // signed-in dashboard tab (same trust model as ws-ticket minting).
  if (isRemoteWsMode()) {
    if (!settings.gatewayUrl) {
      availableProfiles = [];
      renderProfiles();
      return;
    }
    try {
      const result = await discoverProfilesViaTab({
        tabsApi: browserApi.tabs,
        scriptingApi: browserApi.scripting,
        baseUrl: normalizeGatewayUrl(settings.gatewayUrl),
      });
      if (!result.ok) {
        // Fail closed: keep the last verified roster instead of wiping it.
        // A transient discovery failure must not silently clear an explicit
        // profile selection (issue #60 review). renderProfiles() still runs so
        // the status area reflects the failure.
        renderProfiles();
        if (!quiet) {
          setStatus('warn', 'Profile discovery unavailable', profileDiscoveryHelp(result.reason, normalizeGatewayUrl(settings.gatewayUrl)));
        }
        return;
      }
      availableProfiles = normalizeHermesProfiles({ profiles: result.profiles }, settings.activeProfile);
      renderProfiles();
      if (!quiet) {
        setStatus('ok', 'Hermes profiles synced', `${availableProfiles.length} profile${availableProfiles.length === 1 ? '' : 's'} available`);
      }
    } catch (error) {
      // Fail closed: preserve the last verified roster (see above).
      renderProfiles();
      if (!quiet) setStatus('warn', 'Profile sync failed', error?.message || String(error), { translateDetail: false });
    }
    return;
  }
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
    // Fail closed: preserve the last verified roster so an explicit profile
    // selection is not silently dropped when /v1/profiles is unreachable.
    renderProfiles();
    if (!quiet) setStatus('warn', 'Profile sync unavailable', 'This Hermes gateway does not expose /v1/profiles yet. Using the currently running profile.');
  }
}

async function applySelectedProfile(profileName = '') {
  settings = { ...settings, activeProfile: profileName };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  renderProfiles();
  if (!profileName) return;
  if (isRemoteWsMode()) {
    // Remote dashboard mode only reads profiles (discovery runs first-party in
    // the signed-in dashboard tab); it does not POST a switch. The profile is
    // attached to session.create, so reloading models is enough to reflect the
    // new selection, and the next session will target it.
    setStatus('ok', 'Hermes profile selected', `${profileName}. New sessions will use this profile.`);
    await loadModels({ quiet: true });
    return;
  }
  if (!settings.apiKey) return;
  try {
    const response = await apiFetch('/v1/profiles/active', {
      method: 'POST',
      body: JSON.stringify({ name: profileName }),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Profile switch failed (${response.status})`);
    setStatus(
      'ok',
      'Hermes profile switched',
      payload.restart_required ? t('status.profile_selected_restart', { profile: profileName }) : profileName,
      { translateDetail: false },
    );
    await loadProfiles({ quiet: true });
    await loadModels({ quiet: true });
    await loadSkills({ quiet: true });
  } catch (error) {
    setStatus('warn', 'Profile switch unavailable', t('status.profile_switch_unavailable', { error: error?.message || String(error) }), { translateDetail: false });
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
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  syncSettingsForm();
}

function renderAgentList(agents = discoveredAgents) {
  if (!els.agentList) return;
  els.agentList.innerHTML = '';
  if (!agents.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = translateUiText('No agents scanned yet. Click "Scan agents".');
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
      meta.textContent = agent.error ? `port ${agent.port} · ${agent.error}` : `port ${agent.port} · ${translateUiText('offline')}`;
    }
    const status = document.createElement('span');
    status.className = `agent-card-status ${agent.ok ? 'agent-card-status-ok' : 'agent-card-status-off'}`;
    status.textContent = translateUiText(agent.ok ? 'online' : 'offline');
    card.append(name, meta, status);
    if (agent.ok && normalizeGatewayUrl(agent.url) !== currentUrl) {
      const switchButton = document.createElement('button');
      switchButton.type = 'button';
      switchButton.className = 'secondary';
      switchButton.textContent = translateUiText('Switch to this agent');
      switchButton.addEventListener('click', () => switchAgentGateway(agent));
      card.appendChild(switchButton);
    }
    els.agentList.appendChild(card);
  }
}

async function loadAgents({ quiet = false } = {}) {
  if (!els.agentList) return;
  // In remote-dashboard mode the transport is the dashboard WebSocket (443),
  // not a local sidecar on 8642-8646. The port probe is meaningless here and
  // would falsely report "no agents online", implying Dashboard Attach is down.
  // Skip it and let the connection indicator own the status.
  if (isRemoteWsMode()) {
    els.agentList.innerHTML = '<p class="hint">Sidecar agent scan is skipped in Remote dashboard mode. Dashboard Attach connects over the dashboard WebSocket (port 443); use the connection indicator for live status.</p>';
    if (els.agentPickerStatus) {
      els.agentPickerStatus.textContent = 'Skipped: remote dashboard mode uses the dashboard WebSocket, not a local sidecar.';
    }
    return;
  }
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
    setStatus('warn', 'Agent host invalid', error?.message || String(error), { translateDetail: false });
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
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  setStatus('ok', 'Switched gateway', `Reconnecting to ${agent.name} (${nextUrl})...`);
  // Re-run the full connect flow against the new gateway.
  try {
    await testConnection();
    await loadAgents({ quiet: true });
  } catch (error) {
    setStatus('warn', 'Switch partially failed', error?.message || String(error), { translateDetail: false });
  }
}

function renderBrowserIntroVisibility() {
  if (!els.browserIntroHero) return;
  els.browserIntroHero.hidden = browserIntroDismissedForPanel || messages.length > 0;
}

function renderEmptyState() {
  renderBrowserIntroVisibility();
  if (messages.length) return;
  els.messages.innerHTML = '';
  if (!shouldShowBrowserIntro({ seen: browserIntroSeen, connected: isConnected(), messageCount: messages.length })) return;
  const setupCopy = settings.apiKey
    ? 'Ask Hermes about what you are viewing. Active tab, selected text, page text, and open tabs are attached as untrusted context.'
    : 'Click Connect to Hermes, approve locally, then start chatting with page context. Manual API key setup is still available in settings.';
  els.messages.innerHTML = `<div class="empty-state"><strong>${escapeHtml(translateUiText('THE PAGE IS THE PROMPT'))}</strong><span>${escapeHtml(translateUiText(setupCopy))}</span></div>`;
}

async function persistBrowserIntroSeen() {
  browserIntroDismissedForPanel = true;
  renderBrowserIntroVisibility();
  if (browserIntroSeen) return;
  browserIntroSeen = true;
  await browserApi.storage.local.set({ [HERMES_BROWSER_INTRO_SEEN_STORAGE_KEY]: true });
}

function sessionDisplayName(session = {}) {
  return String(session.title || session.id || settings.sessionTitle || 'Hermes Browser Extension');
}

function updateSessionLabel() {
  const current = availableSessions.find((session) => session.id === settings.sessionId);
  const label = current ? sessionDisplayName(current) : (settings.sessionTitle || settings.sessionId || 'Hermes Browser Extension');
  els.currentSessionName.textContent = label;
  els.currentSessionName.title = `${label} · ${settings.sessionId}`;
  renderTaskStack();
}

async function copyTextToClipboard(text = '', { label = 'Text copied' } = {}) {
  const value = String(text || '').trim();
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    setStatus('ok', label, value, { translateDetail: false });
    return true;
  } catch (error) {
    try {
      window.prompt(label, value);
    } catch {
      /* ignore prompt fallback errors */
    }
    setStatus('warn', 'Copy unavailable', error?.message || `Use the prompt fallback to copy: ${value}`, { translateDetail: false });
    return false;
  }
}

async function promptRenameSession(session = {}) {
  const currentTitle = sessionDisplayName(session);
  const nextTitle = window.prompt(translateUiText('Rename session'), currentTitle);
  if (nextTitle == null) return false;
  const cleanTitle = String(nextTitle || '').trim();
  if (!cleanTitle || cleanTitle === currentTitle) return false;
  try {
    await renameHermesSessionTitle(session.id, cleanTitle);
    return true;
  } catch (error) {
    setStatus('warn', 'Could not rename session', error?.message || String(error), { translateDetail: false });
    return false;
  }
}

function renderSessionMenu(query = els.sessionSearchInput?.value || '') {
  const groups = groupSessionsForMenu(availableSessions, settings.sessionId, query);
  const searching = Boolean(String(query || '').trim());
  els.sessionMenuList.innerHTML = '';
  if (!groups.length) {
    const empty = document.createElement('div');
    empty.className = 'session-group-title';
    empty.textContent = translateUiText('No sessions found');
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
      const row = document.createElement('div');
      row.className = `session-option-row ${session.selected ? 'selected' : ''}`.trim();
      row.dataset.sessionId = session.id;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `session-option ${session.selected ? 'selected' : ''}`.trim();
      button.dataset.sessionId = session.id;

      const name = document.createElement('span');
      name.className = 'session-option-name';
      name.textContent = sessionDisplayName(session);

      const meta = document.createElement('span');
      meta.className = 'session-option-meta';
      const modelLabel = [session.provider, session.rawModelId || session.model].filter(Boolean).join(' · ');
      meta.textContent = session.selected ? '✓' : (modelLabel || (session.messageCount ? `${session.messageCount}` : ''));

      button.append(name, meta);
      button.addEventListener('click', () => openHermesSession(session));

      const actions = document.createElement('span');
      actions.className = 'session-actions';

      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'session-action-button';
      copyButton.textContent = 'ID';
      copyButton.title = translateUiText('Copy session ID');
      copyButton.setAttribute('aria-label', t('session.copy_id_for', { title: sessionDisplayName(session) }));
      copyButton.addEventListener('click', (event) => {
        event.stopPropagation();
        copyTextToClipboard(session.id, { label: translateUiText('Copy session ID') });
      });

      const renameButton = document.createElement('button');
      renameButton.type = 'button';
      renameButton.className = 'session-action-button';
      renameButton.textContent = translateUiText('Rename');
      renameButton.title = translateUiText('Rename session');
      renameButton.setAttribute('aria-label', t('session.rename_named', { title: sessionDisplayName(session) }));
      renameButton.addEventListener('click', (event) => {
        event.stopPropagation();
        promptRenameSession(session);
      });

      actions.append(copyButton, renameButton);
      row.append(button, actions);
      els.sessionMenuList.appendChild(row);
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
      return { ok: false, count: 0, error: 'Remote Hermes is not connected.' };
    }
    try {
      const result = await remoteWsConnection.client.request(WS_METHODS.sessionList, { limit: 200 });
      const desiredProfile = safeActiveProfile();
      availableSessions = applySessionModelBindings(
        normalizeHermesSessions(result),
        settings.sessionModelBindings,
      )
        .filter((session) => Number(session.messageCount || 0) > 0)
        // Profile-aware scoping: when the gateway reports a profile per
        // session, never show sessions from a different profile in the list
        // (issue #60 review). Sessions without a reported profile stay visible
        // because older gateways do not tag them.
        .filter((session) => !desiredProfile || !session.profile || session.profile === desiredProfile);
      syncActiveSessionRuntimeFromList();
      updateSessionLabel();
      renderSessionMenu();
      if (!quiet) setStatus('ok', 'Hermes sessions synced', `${availableSessions.length} sessions available`);
      return { ok: true, count: availableSessions.length };
    } catch (error) {
      updateSessionLabel();
      renderSessionMenu();
      if (!quiet) setStatus('warn', 'Session sync failed', error?.message || String(error), { translateDetail: false });
      return { ok: false, count: availableSessions.length, error: error?.message || String(error) };
    }
  }
  if (!settings.apiKey) {
    availableSessions = [];
    updateSessionLabel();
    renderSessionMenu();
    return { ok: false, count: 0, error: 'Connect to Hermes before refreshing sessions.' };
  }
  try {
    const payload = await loadAllHermesSessions();
    availableSessions = normalizeHermesSessions(payload).filter((session) => Number(session.messageCount || 0) > 0);
    syncActiveSessionRuntimeFromList();
    updateSessionLabel();
    renderSessionMenu();
    if (!quiet) setStatus('ok', 'Hermes sessions synced', `${availableSessions.length} sessions available`);
    return { ok: true, count: availableSessions.length };
  } catch (error) {
    updateSessionLabel();
    renderSessionMenu();
    if (!quiet) setStatus('warn', 'Session sync failed', error?.message || String(error), { translateDetail: false });
    return { ok: false, count: availableSessions.length, error: error?.message || String(error) };
  }
}

async function refreshSessionsFromMenu() {
  if (sessionsRefreshing) return;
  sessionsRefreshing = true;
  els.refreshSessionsButton.disabled = true;
  els.refreshSessionsButton.classList.add('is-refreshing');
  els.refreshSessionsButton.setAttribute('aria-busy', 'true');
  if (els.refreshSessionsLabel) els.refreshSessionsLabel.textContent = translateUiText('Refreshing Sessions…');
  let outcome;
  try {
    outcome = await loadSessions();
  } catch (error) {
    outcome = { ok: false, error: error?.message || String(error) };
  } finally {
    sessionsRefreshing = false;
    els.refreshSessionsButton.disabled = false;
    els.refreshSessionsButton.classList.remove('is-refreshing');
    els.refreshSessionsButton.removeAttribute('aria-busy');
    if (els.refreshSessionsLabel) els.refreshSessionsLabel.textContent = translateUiText('Refresh Sessions');
  }
  showOperationToast(outcome?.ok
    ? { title: 'Sessions refreshed', detail: `${outcome.count} canonical session${outcome.count === 1 ? '' : 's'} ready.` }
    : { kind: 'warn', title: 'Session refresh incomplete', detail: outcome?.error || 'Hermes kept the current session list.' });
}

async function renameHermesSessionTitle(sessionId, title, { quiet = false } = {}) {
  const nextTitle = String(title || '').trim();
  if (!sessionId || !nextTitle) return false;
  if (isRemoteWsMode()) {
    // Dashboard WS currently exposes create/resume/list/history but not rename.
    availableSessions = availableSessions.map((session) => (session.id === sessionId ? { ...session, title: nextTitle } : session));
    settings = { ...settings, sessionTitle: nextTitle };
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
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
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
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
    setStatus('warn', 'Could not rename session', error?.message || String(error), { translateDetail: false });
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
    setStatus('warn', 'Auto-name skipped', error?.message || String(error), { translateDetail: false });
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

async function beginHermesBrowserDraft({ title = makeBrowserSessionTitle(), focus = true } = {}) {
  if (!canSwitchActiveSession({ sending, runControl: activeRunControl })) {
    setStatus('warn', 'Hermes is working…', 'Stop the active run before switching sessions.');
    return false;
  }
  // Dashboard WebSocket sessions require a server-issued id; local API sessions
  // can remain drafts until the first turn reaches ensureHermesSession().
  if (isRemoteWsMode()) return createHermesBrowserSession({ title, focus });
  const sessionId = makeBrowserSessionId();
  const preferredBinding = preferredModelBindingForNewSession();
  const preferredOptions = preferredModelOptionsForNewSession();
  const preferredModel = modelForBinding(preferredBinding);
  settings = {
    ...settings,
    sessionId,
    sessionTitle: title,
    model: preferredModel?.id || preferredBinding?.modelId || settings.model,
    modelContextTokens: preferredModel?.contextTokens || preferredBinding?.contextTokens || settings.modelContextTokens || 0,
    extensionPreferredModel: preferredBinding,
    sessionModelBindings: { ...(settings.sessionModelBindings || {}), [sessionId]: preferredBinding },
    sessionModelOptionBindings: { ...(settings.sessionModelOptionBindings || {}), [sessionId]: preferredOptions },
    modelScopeVersion: DEFAULT_SETTINGS.modelScopeVersion,
  };
  activeSessionRuntime = { ...activeSessionRuntime, sessionId, usedTokens: 0, inputTokens: 0, outputTokens: 0, model: '', provider: '', source: '' };
  sessionRoutesAvailable = true;
  messages = [];
  await browserApi.storage.local.set({ hermesBrowserSettings: settings, [activeMessagesStorageKey(previousConversationScope)]: [] });
  await saveSessionBindingForActiveScope({ id: sessionId, title, source: DEFAULT_SETTINGS.sessionSource });
  renderMessagesFromStorage();
  updateSessionLabel();
  renderSessionMenu();
  if (focus) els.input.focus();
  return { id: sessionId, title, source: DEFAULT_SETTINGS.sessionSource, draft: true };
}

function preferredModelOptionsForNewSession() {
  return resolveBrowserEffectiveModelOptions({
    sessionId: '',
    sessionModelOptionBindings: {},
    extensionPreferredModelOptions: settings.extensionPreferredModelOptions,
  });
}

async function createHermesBrowserSession({ title = makeBrowserSessionTitle(), focus = true } = {}) {
  const preferredBinding = preferredModelBindingForNewSession();
  const preferredOptions = preferredModelOptionsForNewSession();
  const preferredModel = modelForBinding(preferredBinding);
  const requestModel = preferredModel?.rawModelId || preferredBinding?.rawModelId || preferredBinding?.modelId || settings.model || DEFAULT_SETTINGS.model;
  const requestProvider = preferredModel?.provider || preferredBinding?.provider || '';
  if (isRemoteWsMode()) {
    const connection = await ensureRemoteWsClient();
    const { liveId, storedId } = await establishGatewaySession({
      client: connection.client,
      createParams: {
        title,
        model: requestModel,
        provider: requestProvider || undefined,
        reasoning_effort: preferredOptions.thinkingEnabled ? preferredOptions.reasoningEffort : 'none',
        fast: preferredOptions.fastMode,
        profile: safeActiveProfile(),
      },
    });
    connection.wsSessionId = liveId;
    connection.wsStoredSessionId = storedId;
    const id = storedId;
    const session = normalizeHermesSessions({ sessions: [{ id, title, source: settings.sessionSource || DEFAULT_SETTINGS.sessionSource }] })[0]
      || { id, title, source: settings.sessionSource };
    availableSessions = normalizeHermesSessions({ sessions: [session, ...availableSessions.filter((item) => item.id !== id)] });
    settings = {
      ...settings,
      sessionId: id,
      sessionTitle: session.title || title,
      remoteDashboardSession: {
        storedSessionId: storedId,
        gatewayUrl: connection.baseUrl,
      },
      model: preferredModel?.id || preferredBinding?.modelId || settings.model,
      modelContextTokens: preferredModel?.contextTokens || preferredBinding?.contextTokens || settings.modelContextTokens || 0,
      extensionPreferredModel: preferredBinding,
      sessionModelBindings: {
        ...(settings.sessionModelBindings || {}),
        [id]: preferredBinding,
      },
      sessionModelOptionBindings: {
        ...(settings.sessionModelOptionBindings || {}),
        [id]: preferredOptions,
      },
      modelScopeVersion: DEFAULT_SETTINGS.modelScopeVersion,
    };
    activeSessionRuntime = { ...activeSessionRuntime, sessionId: id, usedTokens: 0, inputTokens: 0, outputTokens: 0, model: '', provider: '', source: '' };
    messages = [];
    await browserApi.storage.local.set({ hermesBrowserSettings: settings, [activeMessagesStorageKey(previousConversationScope)]: [] });
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
      model: requestModel,
      provider: requestProvider || undefined,
      model_options: buildHermesModelOptions(preferredOptions),
      system_prompt: currentHermesBrowserSystemPrompt(),
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Could not create session (${response.status})`);
  const session = normalizeHermesSessions({ data: [payload.session || payload] })[0] || { id: sessionId, title, source: settings.sessionSource };
  availableSessions = normalizeHermesSessions({ data: [session, ...availableSessions.filter((item) => item.id !== session.id)] });
  settings = {
    ...settings,
    sessionId: session.id,
    sessionTitle: session.title || title,
    model: preferredModel?.id || preferredBinding?.modelId || settings.model,
    modelContextTokens: preferredModel?.contextTokens || preferredBinding?.contextTokens || settings.modelContextTokens || 0,
    extensionPreferredModel: preferredBinding,
    sessionModelBindings: {
      ...(settings.sessionModelBindings || {}),
      [session.id]: preferredBinding,
    },
    sessionModelOptionBindings: {
      ...(settings.sessionModelOptionBindings || {}),
      [session.id]: preferredOptions,
    },
    modelScopeVersion: DEFAULT_SETTINGS.modelScopeVersion,
  };
  activeSessionRuntime = { ...activeSessionRuntime, sessionId: session.id, usedTokens: 0, inputTokens: 0, outputTokens: 0, model: '', provider: '', source: '' };
  sessionRoutesAvailable = true;
  messages = [];
  await browserApi.storage.local.set({ hermesBrowserSettings: settings, [activeMessagesStorageKey(previousConversationScope)]: [] });
  await saveSessionBindingForActiveScope(session);
  renderMessagesFromStorage();
  updateSessionLabel();
  renderSessionMenu();
  if (focus) els.input.focus();
  return session;
}

function renderSessionHistoryLoading(session = {}) {
  const loading = document.createElement('section');
  loading.className = 'session-history-loading';
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');

  const rail = document.createElement('span');
  rail.className = 'session-history-loading-rail';
  rail.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'session-history-loading-label';
  label.textContent = translateUiText('OPENING SESSION');

  const title = document.createElement('strong');
  title.textContent = sessionDisplayName(session);

  const detail = document.createElement('span');
  detail.className = 'session-history-loading-detail';
  detail.textContent = translateUiText('Loading canonical Hermes history…');

  loading.append(rail, label, title, detail);
  els.messages.replaceChildren(loading);
}

async function openHermesSession(selectedSession) {
  if (!canSwitchActiveSession({ sending, runControl: activeRunControl })) {
    setStatus('warn', 'Hermes is working…', 'Stop the active run before switching sessions.');
    return false;
  }
  els.sessionMenu.hidden = true;
  els.sessionMenuButton.setAttribute('aria-expanded', 'false');
  const requestId = ++sessionLoadRequestId;
  let session = selectedSession;
  renderSessionHistoryLoading(session);
  const requestedSessionId = session.id;
  let liveSessionId = session.id;
  if (isRemoteWsMode()) {
    try {
      const connection = await ensureRemoteWsClient();
      const { liveId, storedId, profile: reportedProfile } = await establishGatewaySession({
        client: connection.client,
        storedSessionId: session.id,
      });
      if (requestId !== sessionLoadRequestId) return;
      // Profile boundary check: a session that the gateway reports under a
      // different profile must not be resumed into the current selection. Fail
      // closed and refuse to bind it (issue #60 review).
      const desiredProfile = safeActiveProfile();
      if (desiredProfile && reportedProfile && reportedProfile !== desiredProfile) {
        setStatus(
          'error',
          'Session profile mismatch',
          `This session belongs to the "${reportedProfile}" profile. Switch to that profile before resuming it.`,
          { translateDetail: false },
        );
        return;
      }
      connection.wsSessionId = liveId;
      connection.wsStoredSessionId = storedId;
      liveSessionId = liveId;
      session = { ...session, id: storedId };
      availableSessions = normalizeHermesSessions({
        sessions: [session, ...availableSessions.filter((item) => item.id !== requestedSessionId && item.id !== storedId)],
      });
      settings = {
        ...settings,
        remoteDashboardSession: {
          storedSessionId: storedId,
          gatewayUrl: connection.baseUrl,
        },
      };
    } catch (error) {
      if (requestId !== sessionLoadRequestId) return;
      renderMessagesFromStorage();
      setStatus('error', 'Could not open session', error?.message || String(error), { translateDetail: false });
      return;
    }
  }
  const inheritedModelBinding = settings.sessionModelBindings?.[requestedSessionId];
  const inheritedModelOptions = settings.sessionModelOptionBindings?.[requestedSessionId];
  settings = {
    ...settings,
    sessionId: session.id,
    sessionTitle: session.title || session.id,
    sessionModelBindings: inheritedModelBinding
      ? { ...(settings.sessionModelBindings || {}), [session.id]: inheritedModelBinding }
      : settings.sessionModelBindings,
    sessionModelOptionBindings: inheritedModelOptions
      ? { ...(settings.sessionModelOptionBindings || {}), [session.id]: inheritedModelOptions }
      : settings.sessionModelOptionBindings,
  };
  applyModelBindingForSession(session);
  applyModelOptionsForSession(session);
  renderModelOptions(availableModels);
  activeSessionRuntime = { ...activeSessionRuntime, sessionId: session.id, usedTokens: 0, inputTokens: 0, outputTokens: 0, model: '', provider: '', source: '' };
  sessionRoutesAvailable = true;
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  await saveSessionBindingForActiveScope(session);
  await activateCurrentDelegationSession();
  updateSessionLabel();
  renderSessionMenu();
  const loaded = await loadSessionMessages(liveSessionId, { requestId });
  if (requestId !== sessionLoadRequestId) return;
  setStatus(loaded ? 'ok' : 'warn', loaded ? 'Session opened' : 'Session opened without history', `${session.sourceLabel || session.source || 'Hermes'} · ${session.id}`, { translateDetail: false });
}

async function fetchSessionMessagesQuietly(sessionId, { transport = isRemoteWsMode() ? 'dashboard-ws' : 'rest' } = {}) {
  if (transport === 'dashboard-ws') {
    if (remoteWsConnection?.client?.readyState !== 1) throw new Error('Remote Hermes is not connected.');
    if (!sessionId) throw new Error('A live dashboard session id is required for history.');
    const result = await remoteWsConnection.client.request(WS_METHODS.sessionHistory, { session_id: sessionId });
    const contextMessages = normalizeGatewayHistoryMessages(result)
      .map((message) => ({
        ...message,
        role: message.role,
        content: message.content,
        display_kind: message.display_kind,
        ts: Number(message.timestamp || message.ts || Date.now()),
      }));
    return {
      contextMessages,
      messages: contextMessages,
      session: null,
    };
  }
  if (!settings.apiKey) throw new Error('Connect to Hermes before loading session messages.');
  const response = await apiFetch(`/api/sessions/${encodeSessionId(sessionId)}/messages`, { method: 'GET' });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Messages failed (${response.status})`);
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const contextMessages = rows.map((message) => ({
    ...message,
    role: String(message.role || '').toLowerCase(),
    content: String(message.content || ''),
    display_kind: message.display_kind,
    ts: Number(message.timestamp || Date.now()),
  }));
  return {
    contextMessages,
    messages: contextMessages,
    session: payload.session || null,
  };
}

async function commitFetchedSessionMessages(result, { sessionId, requestId = null } = {}) {
  if (requestId != null && requestId !== sessionLoadRequestId) return false;
  if (String(settings.sessionId || '').trim() !== String(sessionId || '').trim()) return false;
  if (result?.session) applySessionRuntimeSnapshot({
    session: result.session,
    sessionId: result.session.id || sessionId,
    source: 'Hermes session',
  });
  const contextMessages = Array.isArray(result?.contextMessages) ? result.contextMessages : [];
  messages = Array.isArray(result?.messages) ? result.messages : [];
  loadedSessionContextEstimate = {
    sessionId,
    contextTokens: estimateLocalSessionContextTokens({ messages: contextMessages }),
    visibleTokens: estimateLocalSessionContextTokens({ messages: browserDisplayMessages(messages) }),
  };
  await saveMessagesForActiveScope();
  if (requestId != null && requestId !== sessionLoadRequestId) return false;
  if (String(settings.sessionId || '').trim() !== String(sessionId || '').trim()) return false;
  renderMessagesFromStorage();
  return true;
}

async function loadSessionMessages(sessionId = settings.sessionId, { requestId = null } = {}) {
  const expectedSessionId = String(settings.sessionId || '').trim();
  const isCurrentRequest = () => requestId == null || requestId === sessionLoadRequestId;
  if (isUnsavedBrowserDraftSession({ sessionId, sessions: availableSessions })) {
    await loadMessagesForActiveScope();
    return true;
  }
  try {
    const result = await fetchSessionMessagesQuietly(sessionId);
    if (!isCurrentRequest()) return false;
    return commitFetchedSessionMessages(result, { sessionId: expectedSessionId, requestId });
  } catch (error) {
    if (!isCurrentRequest()) return false;
    addMessage('system', `Could not load session messages: ${error?.message || String(error)}`);
    return false;
  }
}

function isHermesBrowserSession(session = {}) {
  return String(session.source || '').toLowerCase() === DEFAULT_SETTINGS.sessionSource;
}

function activeSessionForSend() {
  const sessionId = String(settings.sessionId || '').trim();
  if (!sessionId) return null;
  return availableSessions.find((session) => session.id === sessionId) || {
    id: sessionId,
    title: settings.sessionTitle || sessionId,
    source: DEFAULT_SETTINGS.sessionSource,
  };
}

function dismissLocalDocumentApprovalNotice() {
  if (!els.localDocumentApprovalNotice) return;
  els.localDocumentApprovalNotice.hidden = true;
}

function renderLocalDocumentApproval(tab = currentContext?.activeTab) {
  if (!els.localDocumentApprovalNotice) return;
  const url = tab?.url || '';
  const isLocal = isLocalDocumentUrl(url);
  if (!isLocal || settings.allowLocalDocuments === true) {
    dismissLocalDocumentApprovalNotice();
    return;
  }
  let fileName = 'presentation / local file';
  try {
    const parsed = new URL(url);
    fileName = parsed.pathname.split('/').filter(Boolean).pop() || 'local document';
  } catch {
    fileName = 'local document';
  }
  els.localDocumentApprovalTitle.textContent = `Local document · ${fileName}`;
  els.localDocumentApprovalDetail.textContent = 'Approve local document access to inspect this file, extract slides/text, and attach browser control.';
  els.localDocumentApprovalNotice.hidden = false;
}

function dismissSessionOwnershipNotice() {
  pendingForeignTurn = null;
  if (!els.sessionOwnershipNotice) return;
  els.sessionOwnershipNotice.hidden = true;
}

function showSessionOwnershipNotice(session = {}, userText = '', turnAttachments = []) {
  if (!els.sessionOwnershipNotice) return;
  const notice = sessionOwnershipNotice({
    session,
    expectedSource: SESSION_SURFACE_SOURCES.SIDE_PANEL,
  });
  pendingForeignTurn = {
    sessionId: String(session.id || ''),
    userText: String(userText || ''),
    attachments: [...turnAttachments],
    fromComposer: String(userText || '').trim() === els.input.value.trim(),
  };
  els.sessionOwnershipTitle.textContent = notice.title;
  els.sessionOwnershipDetail.textContent = notice.detail;
  const newButton = els.sessionOwnershipNotice.querySelector('[data-session-ownership-action="new-browser"]');
  if (newButton) newButton.textContent = notice.newChatLabel;
  const continueButton = els.sessionOwnershipNotice.querySelector('[data-session-ownership-action="continue"]');
  if (continueButton) continueButton.textContent = notice.continueLabel;
  els.sessionOwnershipNotice.hidden = false;
  newButton?.focus();
}

function guardForeignSessionSend(userText, turnAttachments) {
  const session = activeSessionForSend();
  if (!requiresSessionOwnershipConfirmation({
    session,
    expectedSource: SESSION_SURFACE_SOURCES.SIDE_PANEL,
    approvedSessionIds: approvedForeignSessionIds,
  })) {
    dismissSessionOwnershipNotice();
    return true;
  }
  showSessionOwnershipNotice(session, userText, turnAttachments);
  return false;
}

async function handleSessionOwnershipDecision(event) {
  const button = event.target.closest('[data-session-ownership-action]');
  if (!button) return;
  const session = activeSessionForSend();
  const pendingTurn = pendingForeignTurn;
  if (!session || !pendingTurn || session.id !== pendingTurn.sessionId) {
    dismissSessionOwnershipNotice();
    return;
  }

  const userText = pendingTurn.userText;
  const turnAttachments = pendingTurn.attachments;
  if (!userText && !turnAttachments.length) {
    dismissSessionOwnershipNotice();
    return;
  }

  const buttons = Array.from(els.sessionOwnershipNotice.querySelectorAll('button'));
  for (const actionButton of buttons) actionButton.disabled = true;
  try {
    if (button.dataset.sessionOwnershipAction === 'continue') {
      approvedForeignSessionIds.add(session.id);
      dismissSessionOwnershipNotice();
      await askHermes(userText, turnAttachments);
      return;
    }
    dismissSessionOwnershipNotice();
    await beginHermesBrowserDraft({ focus: false });
    await askHermes(userText, turnAttachments);
  } catch (error) {
    setStatus('error', 'Could not change session', error?.message || String(error), { translateDetail: false });
  } finally {
    for (const actionButton of buttons) actionButton.disabled = false;
  }
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
      setStatus('warn', 'Could not migrate Browser session', error?.message || String(error), { translateDetail: false });
    }
  }
  const existingBrowserSession = availableSessions.find(isHermesBrowserSession);
  if (existingBrowserSession) {
    await openHermesSession(existingBrowserSession);
    return;
  }
  await beginHermesBrowserDraft({ title: makeBrowserSessionTitle(), focus });
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
  element.innerHTML = renderMarkdownSafe(content || '');
  for (const image of element.querySelectorAll('img[data-slot="aui_generated-image"]')) {
    const wrapper = document.createElement('span');
    wrapper.className = 'generated-image-inspectable';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'button');
    wrapper.setAttribute('aria-label', 'Open generated image for closer inspection');
    const inspect = document.createElement('span');
    inspect.className = 'generated-image-inspect';
    inspect.setAttribute('aria-hidden', 'true');
    inspect.textContent = '⌕';
    image.replaceWith(wrapper);
    wrapper.append(image, inspect);
    wrapper.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openGeneratedImageLightbox(image);
    });
  }
}

function closeGeneratedImageLightbox() {
  document.querySelector('.generated-image-lightbox')?.remove();
}

function generatedImageDownloadName(source = '') {
  const dataType = /^data:image\/(png|jpe?g|gif|webp|bmp);/i.exec(source)?.[1]?.toLowerCase();
  const extension = dataType === 'jpeg' ? 'jpg' : dataType;
  return `hermes-generated-image.${extension || 'png'}`;
}

function openGeneratedImageLightbox(image) {
  const source = String(image?.currentSrc || image?.src || '').trim();
  if (!source) return;
  closeGeneratedImageLightbox();
  let viewerState = createImageViewerState();
  let panGesture = null;

  const dialog = document.createElement('div');
  dialog.className = 'generated-image-lightbox';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', image.alt || translateUiText('Generated image preview'));

  const frame = document.createElement('div');
  frame.className = 'generated-image-lightbox-frame';
  const stage = document.createElement('div');
  stage.className = 'generated-image-lightbox-stage';
  const preview = document.createElement('img');
  preview.src = source;
  preview.alt = image.alt || translateUiText('Generated image');
  preview.draggable = false;
  stage.append(preview);

  const actions = document.createElement('div');
  actions.className = 'generated-image-lightbox-actions';
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.textContent = '−';
  zoomOut.setAttribute('aria-label', translateUiText('Zoom out'));
  const zoomLabel = document.createElement('button');
  zoomLabel.type = 'button';
  zoomLabel.textContent = '100%';
  zoomLabel.setAttribute('aria-label', translateUiText('Reset zoom'));
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.textContent = '+';
  zoomIn.setAttribute('aria-label', translateUiText('Zoom in'));
  const download = document.createElement('a');
  download.className = 'generated-image-lightbox-download';
  download.href = source;
  download.download = generatedImageDownloadName(source);
  download.target = '_blank';
  download.rel = 'noopener noreferrer';
  download.textContent = translateUiText('Download');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'generated-image-lightbox-close';
  close.textContent = translateUiText('Close');
  close.addEventListener('click', closeGeneratedImageLightbox);
  const renderViewer = () => {
    preview.style.transform = `translate3d(${viewerState.x}px, ${viewerState.y}px, 0) scale(${viewerState.scale})`;
    zoomLabel.textContent = `${Math.round(viewerState.scale * 100)}%`;
    zoomOut.disabled = viewerState.scale <= 1;
    zoomLabel.disabled = viewerState.scale <= 1 && viewerState.x === 0 && viewerState.y === 0;
    stage.toggleAttribute('data-zoomed', viewerState.scale > 1);
  };
  const updateViewer = (action) => {
    viewerState = imageViewerReducer(viewerState, action);
    renderViewer();
  };
  zoomOut.addEventListener('click', () => updateViewer({ type: 'zoom-out' }));
  zoomLabel.addEventListener('click', () => updateViewer({ type: 'reset' }));
  zoomIn.addEventListener('click', () => updateViewer({ type: 'zoom-in' }));
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    updateViewer({ type: event.deltaY < 0 ? 'zoom-in' : 'zoom-out' });
  }, { passive: false });
  stage.addEventListener('pointerdown', (event) => {
    if (viewerState.scale <= 1) return;
    panGesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: viewerState.x, y: viewerState.y };
    stage.setPointerCapture?.(event.pointerId);
    stage.toggleAttribute('data-dragging', true);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!panGesture || panGesture.pointerId !== event.pointerId) return;
    updateViewer({ type: 'pan', x: panGesture.x + event.clientX - panGesture.startX, y: panGesture.y + event.clientY - panGesture.startY });
  });
  const endPan = () => {
    panGesture = null;
    stage.removeAttribute('data-dragging');
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);
  actions.append(zoomOut, zoomLabel, zoomIn, download, close);
  frame.append(stage, actions);
  dialog.append(frame);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeGeneratedImageLightbox();
  });
  document.body.append(dialog);
  renderViewer();
  close.focus();
}

function extractRenderableImageSource(content = '') {
  const html = renderMarkdownSafe(content || '');
  const template = document.createElement('template');
  template.innerHTML = html;
  const image = template.content.querySelector('img[data-slot="aui_generated-image"]');
  return String(image?.getAttribute('src') || '').trim();
}

function activeImageGenerationPlaceholder(node) {
  return node?.querySelector('.message-tool-activity .image-gen-placeholder') || null;
}

function loadGeneratedImageForReveal(source = '') {
  return new Promise((resolve, reject) => {
    const image = new globalThis.Image();
    image.className = 'generated-image-reveal-source';
    image.alt = '';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Generated image could not be decoded for reveal.'));
    image.src = source;
  });
}

async function revealGeneratedImage(placeholder, source = '') {
  if (!placeholder?._reveal || !source) return false;
  try {
    const image = await loadGeneratedImageForReveal(source);
    const naturalRatio = image.naturalWidth / image.naturalHeight;
    if (Number.isFinite(naturalRatio) && naturalRatio > 0) {
      placeholder.style.aspectRatio = String(naturalRatio);
      placeholder.style.setProperty('--image-gen-natural-ratio', String(naturalRatio));
      placeholder.style.width = `min(100%, calc(var(--image-gen-max-preview-height) * ${naturalRatio}))`;
    }
    placeholder.appendChild(image);
    placeholder.classList.add('generated-image-revealing');
    await placeholder._reveal(image);
    return true;
  } catch {
    return false;
  }
}

async function revealGeneratedImageFromContent(node, content = '') {
  const placeholder = activeImageGenerationPlaceholder(node);
  const source = extractRenderableImageSource(content);
  if (!placeholder || !source) return false;
  return revealGeneratedImage(placeholder, source);
}

function imageVisualSeed(activity = {}) {
  const values = new Uint32Array(2);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(values);
  else {
    values[0] = Date.now() >>> 0;
    values[1] = Math.floor(Math.random() * 0xffffffff) >>> 0;
  }
  return `${activity.activityId || 'image'}-${values[0]}-${values[1]}-${Date.now()}`;
}

function configureImageVhsLayer(layer, variant) {
  const scan = variant.scan;
  layer.style.setProperty('--image-gen-vhs-duration', `${scan.duration}s`);
  layer.style.setProperty('--image-gen-vhs-band-height', `${scan.bandHeight}%`);
  layer.style.setProperty('--image-gen-vhs-dropout-top', `${scan.dropoutTop}%`);
  layer.style.setProperty('--image-gen-vhs-dropout-duration', `${scan.dropoutDuration}s`);
  layer.style.setProperty('--image-gen-vhs-delay', `${scan.delay}s`);
  layer.style.setProperty('--image-gen-vhs-tear-shift', `${scan.tearShift}px`);
  layer.style.setProperty('--image-gen-vhs-line-gap', `${scan.lineGap}px`);
  layer.style.setProperty('--image-gen-vhs-luma-duration', `${scan.lumaDuration}s`);
  layer.style.setProperty('--image-gen-vhs-band-opacity', `${scan.bandOpacity}`);
}

function renderImageGenPlaceholder(activity = {}) {
  const root = document.createElement('div');
  const aspectRatio = activity.aspectRatio || 'landscape';
  const visualSeed = activity.visualSeed || imageVisualSeed(activity);
  const variant = diffusionVariantForSeed(visualSeed);
  root.className = `image-gen-placeholder image-gen-placeholder-${aspectRatio}`;
  root.dataset.toolName = activity.rawName || 'image_generate';
  root.dataset.toolStatus = activity.status || 'progress';
  root.dataset.visualSeed = String(variant.seed);
  root.dataset.visualProfile = variant.profile;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-label', translateUiText('Hermes is generating an image'));

  const canvas = document.createElement('canvas');
  canvas.className = 'image-gen-diffusion-canvas';
  canvas.setAttribute('aria-hidden', 'true');

  const grid = document.createElement('div');
  grid.className = 'image-gen-grid';
  grid.setAttribute('aria-hidden', 'true');
  const vhs = document.createElement('div');
  vhs.className = 'image-gen-vhs';
  vhs.setAttribute('aria-hidden', 'true');
  configureImageVhsLayer(vhs, variant);

  const registration = document.createElement('div');
  registration.className = 'image-gen-registration';
  registration.setAttribute('aria-hidden', 'true');
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const mark = document.createElement('i');
    mark.className = `image-gen-corner image-gen-corner-${corner}`;
    registration.appendChild(mark);
  }

  const imageChrome = document.createElement('div');
  imageChrome.className = 'image-gen-chrome';
  const title = document.createElement('strong');
  title.textContent = translateUiText('Hermes image synthesis');
  const meta = document.createElement('span');
  meta.textContent = t('image.meta_active', { aspectRatio });
  imageChrome.append(title, meta);

  const status = document.createElement('div');
  status.className = 'image-gen-status';
  const phaseTrack = document.createElement('div');
  phaseTrack.className = 'image-gen-phase-track';
  for (const phase of ['LATENT FIELD', 'DENOISING', 'RESOLVING', 'FINALIZING']) {
    const phaseLabel = document.createElement('span');
    phaseLabel.textContent = translateUiText(phase);
    phaseTrack.appendChild(phaseLabel);
  }
  const pulse = document.createElement('span');
  pulse.className = 'image-gen-pulse';
  pulse.setAttribute('aria-hidden', 'true');
  pulse.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  status.append(phaseTrack, pulse);

  root.append(canvas, grid, vhs, registration, imageChrome, status);
  const diffusion = createDiffusionCanvas(canvas, { aspectRatio, seed: visualSeed });
  root._start = () => diffusion.start();
  root._reveal = (image) => diffusion.reveal(image);
  root._dispose = () => diffusion.stop();
  return root;
}

function renderToolActivity(activity = {}) {
  if (/image_generate/i.test(activity.rawName || '')) return renderImageGenPlaceholder(activity);
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
    slot?.querySelector('.image-gen-placeholder')?._dispose?.();
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

  const existingImage = slot.querySelector('.image-gen-placeholder');
  const isImageGeneration = /image_generate/i.test(activity.rawName || '');
  const previousImageActivity = {
    rawName: slot.dataset.imageActivityName || '',
    activityId: slot.dataset.imageActivityId || '',
    status: slot.dataset.imageActivityStatus || '',
  };
  if (isImageGeneration && existingImage && shouldReuseImageGenerationActivity(previousImageActivity, activity)) {
    slot.dataset.imageActivityId = activity.activityId || previousImageActivity.activityId;
    slot.dataset.imageActivityStatus = activity.status || 'progress';
    existingImage.dataset.toolStatus = activity.status || 'progress';
    return;
  }
  if (existingImage && !isImageGeneration) {
    return;
  }

  let nextActivity = activity;
  if (isImageGeneration) {
    nextActivity = { ...activity, visualSeed: imageVisualSeed(activity) };
    slot.dataset.imageActivityName = activity.rawName || 'image_generate';
    slot.dataset.imageActivityId = activity.activityId || '';
    slot.dataset.imageActivityStatus = activity.status || 'progress';
  } else {
    delete slot.dataset.imageActivityName;
    delete slot.dataset.imageActivityId;
    delete slot.dataset.imageActivityStatus;
  }

  existingImage?._dispose?.();
  const toolActivity = renderToolActivity(nextActivity);
  slot.replaceChildren(toolActivity);
  toolActivity._start?.();
  requestAnimationFrame(() => {
    els.appScroll.scrollTop = els.appScroll.scrollHeight;
  });
}

function addMessage(role, content, { persist = true } = {}) {
  if (!messages.length) els.messages.innerHTML = '';
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector('.message-role').textContent = role === 'assistant' ? 'Hermes' : role;
  renderMessageContentElement(node.querySelector('.message-content'), messageDisplayText(role, content || ''));
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
  let revealPromise = null;
  const flush = async (content = pending) => {
    pending = content || '';
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    const existingImage = activeImageGenerationPlaceholder(node);
    const imageSource = extractRenderableImageSource(pending);
    if (existingImage && imageSource) {
      revealPromise ||= revealGeneratedImageFromContent(node, pending);
      await revealPromise;
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

async function persistInlineSessionState() {
  const title = String(settings.sessionTitle || settings.sessionId || 'Current Browser chat').slice(0, 160);
  await browserApi.storage.local.set({
    [INLINE_SESSION_STATE_KEY]: {
      sessionId: String(settings.sessionId || ''),
      title,
      messageCount: messages.filter((message) => ['user', 'assistant'].includes(message?.role)).length,
      updatedAt: Date.now(),
    },
  });
}

async function trimAndSaveMessages() {
  await saveMessagesForActiveScope();
  await persistInlineSessionState();
}

async function loadSettings({ restoreMessages = false } = {}) {
  loadContextScopeForInstance();
  await refreshCustomThemeStore({ render: false });
  const messageKey = activeMessagesStorageKey(previousConversationScope);
  const stored = await browserApi.storage.local.get(['hermesBrowserSettings', CONTEXT_CONSENT_STORAGE_KEY, messageKey, HERMES_BROWSER_INTRO_SEEN_STORAGE_KEY, TASK_STACKS_STORAGE_KEY]);
  taskStackStore = stored[TASK_STACKS_STORAGE_KEY] && typeof stored[TASK_STACKS_STORAGE_KEY] === 'object'
    ? stored[TASK_STACKS_STORAGE_KEY]
    : {};
  browserIntroSeen = stored[HERMES_BROWSER_INTRO_SEEN_STORAGE_KEY] === true;
  renderBrowserIntroVisibility();
  const migrateConnectionSchema = stored.hermesBrowserSettings?.connectionSchemaVersion !== DEFAULT_SETTINGS.connectionSchemaVersion;
  const storedSettings = migrateConnectionSettings(stored.hermesBrowserSettings || {});
  const storedWakeSettings = normalizeWakeWordSettings({ ...DEFAULT_SETTINGS, ...storedSettings });
  const migrateDesktopOptionDefaults = !storedSettings.modelOptionsVersion && storedSettings.reasoningEffort === 'medium';
  const migrateModelOptionScope = !storedSettings.extensionPreferredModelOptions || !storedSettings.sessionModelOptionBindings;
  const storedPanelAppearance = appearancePreferencesForSurface(storedSettings, 'panel');
  settings = { ...DEFAULT_SETTINGS, ...storedSettings, ...storedPanelAppearance };
  settings = {
    ...settings,
    thinkingEnabled: settings.thinkingEnabled !== false,
    connectionMode: normalizeConnectionMode(settings.connectionMode),
    connectionTransport: resolvePhaseATransport({
      connectionMode: settings.connectionMode,
      currentTransport: settings.connectionTransport,
      apiKey: settings.apiKey,
    }),
    gatewayMode: legacyGatewayModeForConnection(settings),
    gatewayUrl: normalizeGatewayUrl(settings.gatewayUrl),
    fastMode: normalizeFastMode(settings.fastMode),
    reasoningEffort: migrateDesktopOptionDefaults ? DEFAULT_SETTINGS.reasoningEffort : normalizeReasoningEffort(settings.reasoningEffort),
    modelOptionsVersion: DEFAULT_SETTINGS.modelOptionsVersion,
    agentDiscoveryHost: normalizeAgentDiscoveryHost(settings.agentDiscoveryHost || DEFAULT_SETTINGS.agentDiscoveryHost),
    agentDiscoveryScheme: normalizeAgentDiscoveryScheme(settings.agentDiscoveryScheme || DEFAULT_SETTINGS.agentDiscoveryScheme),
    autoNameSessions: settings.autoNameSessions !== false,
    sessionStartupMode: normalizeSessionStartupMode(settings.sessionStartupMode),
    inlineAssistEnabled: settings.inlineAssistEnabled !== false,
    inlineAssistDefaultRoute: normalizeInlineDraftRoutePreference(settings.inlineAssistDefaultRoute),
    inlineAssistModel: String(settings.inlineAssistModel || ''),
    inlineAssistRawModel: String(settings.inlineAssistRawModel || ''),
    inlineAssistProvider: String(settings.inlineAssistProvider || ''),
    inlineAssistSessionRetention: settings.inlineAssistSessionRetention === 'delete' ? 'delete' : 'keep',
    inlineAssistThinkingEnabled: settings.inlineAssistThinkingEnabled !== false,
    inlineAssistReasoningEffort: normalizeReasoningEffort(settings.inlineAssistReasoningEffort || 'low'),
    inlineAssistFastMode: settings.inlineAssistFastMode !== false,
    contextMenuDefaultRoute: ['current', 'new', 'background'].includes(settings.contextMenuDefaultRoute) ? settings.contextMenuDefaultRoute : 'ask',
    wakeWordEnabled: storedWakeSettings.enabled,
    wakeWordPhrase: storedWakeSettings.phrase,
    wakeWordPreferNative: storedWakeSettings.preferNative,
    wakeWordBrowserFallback: storedWakeSettings.browserFallback,
    wakeWordSpeakReplies: storedWakeSettings.speakReplies,
    colorMode: normalizeColorMode(settings.colorMode),
    appearanceTheme: normalizedPanelThemeId(settings.appearanceTheme),
    appearanceSchemaVersion: 2,
    textZoomPercent: normalizeTextZoomPercent(settings.textZoomPercent),
    fontProfile: settings.fontProfile || 'signature',
    customFontFamily: sanitizeLocalFontFamily(settings.customFontFamily),
    browserContextConsentLedger: normalizeContextConsentLedger(stored[CONTEXT_CONSENT_STORAGE_KEY] || settings.browserContextConsentLedger),
    panelResidencyMode: normalizePanelResidencyMode(settings.panelResidencyMode),
    extensionPreferredModel: normalizeBrowserModelBinding(settings.extensionPreferredModel),
    sessionModelBindings: Object.fromEntries(Object.entries(settings.sessionModelBindings && typeof settings.sessionModelBindings === 'object' ? settings.sessionModelBindings : {})
      .map(([sessionId, binding]) => [sessionId, normalizeBrowserModelBinding(binding)])
      .filter(([, binding]) => Boolean(binding))),
    extensionPreferredModelOptions: resolveAcknowledgedSessionModelOptions({
      sessionOptions: settings.extensionPreferredModelOptions,
      storedOptions: {
        thinkingEnabled: settings.thinkingEnabled !== false,
        reasoningEffort: migrateDesktopOptionDefaults ? DEFAULT_SETTINGS.reasoningEffort : normalizeReasoningEffort(settings.reasoningEffort),
        fastMode: normalizeFastMode(settings.fastMode),
        serviceTier: normalizeFastMode(settings.fastMode) ? 'priority' : null,
      },
    }),
    sessionModelOptionBindings: Object.fromEntries(Object.entries(settings.sessionModelOptionBindings && typeof settings.sessionModelOptionBindings === 'object' ? settings.sessionModelOptionBindings : {})
      .map(([sessionId, options]) => [sessionId, resolveAcknowledgedSessionModelOptions({ sessionOptions: options })])
      .filter(([, options]) => Boolean(options))),
    modelScopeVersion: DEFAULT_SETTINGS.modelScopeVersion,
  };
  trustedDashboardTabId = Number(settings.trustedDashboardTabId) || null;
  contextScope = normalizeContextScope(contextScope);
  await refreshContextConsentPrincipal({ settingsOverride: settings });
  saveContextScopeForInstance();
  const effectiveBinding = resolveBrowserEffectiveModel({
    sessionId: settings.sessionId,
    sessionModelBindings: settings.sessionModelBindings,
    extensionPreferredModel: settings.extensionPreferredModel,
    globalDefaultModel: { modelId: settings.model || DEFAULT_SETTINGS.model, rawModelId: settings.model || DEFAULT_SETTINGS.model, contextTokens: settings.modelContextTokens || 0 },
  });
  if (effectiveBinding?.modelId) {
    settings.model = effectiveBinding.modelId;
    settings.modelContextTokens = effectiveBinding.contextTokens || settings.modelContextTokens || 0;
  }
  const effectiveOptions = resolveBrowserEffectiveModelOptions({
    sessionId: settings.sessionId,
    sessionModelOptionBindings: settings.sessionModelOptionBindings,
    extensionPreferredModelOptions: settings.extensionPreferredModelOptions,
  });
  if (effectiveOptions) {
    settings.thinkingEnabled = effectiveOptions.thinkingEnabled;
    settings.reasoningEffort = effectiveOptions.reasoningEffort;
    settings.fastMode = effectiveOptions.fastMode;
  }
  applyAppearanceSettings();
  if (migrateConnectionSchema || migrateDesktopOptionDefaults || migrateModelOptionScope) {
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  }
  messages = restoreMessages && Array.isArray(stored[messageKey]) ? stored[messageKey] : [];
  syncSettingsForm();
  await ensureContextMenuEditor();
  await hydrateContextDeliveryState();
  renderMessagesFromStorage();
  hbeBootEmit('panel:messages-painted', { startMark: 'panel:body-start' });
  renderTaskStack();
}

function renderMessagesFromStorage() {
  els.messages.innerHTML = '';
  for (const message of browserDisplayMessages(messages)) {
    if (isDelegationCompletionMarkerMessage(message)) continue;
    addMessage(message.role, message.content, { persist: false });
  }
  renderEmptyState();
}

function syncSettingsForm() {
  renderAppearanceControls();
  renderProfiles();
  renderModelOptions(availableModels);
  if (els.connectionModeInput) els.connectionModeInput.value = normalizeConnectionMode(settings.connectionMode);
  if (els.gatewayModeInput) els.gatewayModeInput.value = settings.gatewayMode || DEFAULT_SETTINGS.gatewayMode;
  els.gatewayUrlInput.value = settings.gatewayUrl;
  renderConnectionModeCards();
  renderConnectionModePanel();
  els.apiKeyInput.value = settings.apiKey || '';
  els.sessionIdInput.value = settings.sessionId;
  els.sessionTitleInput.value = settings.sessionTitle;
  els.contextDepthInput.value = settings.contextDepth;
  els.includeTabsInput.checked = Boolean(settings.includeTabs);
  els.includePageTextInput.checked = Boolean(settings.includePageText);
  els.includeSelectedTextInput.checked = Boolean(settings.includeSelectedText);
  if (els.inlineAssistEnabled) els.inlineAssistEnabled.checked = settings.inlineAssistEnabled !== false;
  if (els.inlineAssistDefaultRoute) els.inlineAssistDefaultRoute.value = normalizeInlineDraftRoutePreference(settings.inlineAssistDefaultRoute);
  renderInlineAssistModelOptions();
  if (els.inlineAssistSessionRetention) els.inlineAssistSessionRetention.value = settings.inlineAssistSessionRetention === 'delete' ? 'delete' : 'keep';
  if (els.contextMenuDefaultRoute) els.contextMenuDefaultRoute.value = settings.contextMenuDefaultRoute || 'ask';
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
  if (els.wakeWordEnabledInput) els.wakeWordEnabledInput.checked = Boolean(settings.wakeWordEnabled);
  if (els.wakeWordPhraseInput) els.wakeWordPhraseInput.value = settings.wakeWordPhrase || DEFAULT_SETTINGS.wakeWordPhrase;
  if (els.wakeWordBrowserFallbackInput) els.wakeWordBrowserFallbackInput.checked = settings.wakeWordBrowserFallback !== false;
  if (els.wakeWordSpeakRepliesInput) els.wakeWordSpeakRepliesInput.checked = settings.wakeWordSpeakReplies !== false;
  renderWakeState();
  renderCompatibilityPanel();
  renderConnectionSecurity();
  renderBrowserContextConsentControl();
  renderRemoteDiagnostics(lastRemoteDiagnostic);
  renderBrowserControl();
}

async function saveSettingsFromForm() {
  const previousSettings = { ...settings };
  const selected = availableModels.find((model) => model.id === settings.model);
  const apiKey = els.apiKeyInput.value.trim();
  const previousApiKey = String(previousSettings.apiKey || '');
  const tokenSource = apiKey ? (apiKey === previousApiKey ? (previousSettings.tokenSource || settings.tokenSource || 'manual') : 'manual') : '';
  const connectionMode = normalizeConnectionMode(els.connectionModeInput?.value || settings.connectionMode);
  const connectionTransport = resolvePhaseATransport({
    connectionMode,
    currentTransport: connectionMode === 'remote'
      ? (apiKey ? CONNECTION_TRANSPORTS.REMOTE_API : CONNECTION_TRANSPORTS.REMOTE_DASHBOARD)
      : settings.connectionTransport,
    apiKey,
  });
  const gatewayMode = legacyGatewayModeForConnection({ connectionMode, connectionTransport });
  const remote = connectionMode !== 'local';
  const rawGatewayUrl = els.gatewayUrlInput.value.trim();
  const gatewayUrl = connectionMode === 'cloud'
    ? sanitizeGatewayUrlForConnectionMode({
        connectionMode,
        gatewayUrl: rawGatewayUrl,
        localDefaultUrl: DEFAULT_SETTINGS.gatewayUrl,
      })
    : rawGatewayUrl
      ? normalizeGatewayUrl(rawGatewayUrl)
      : (remote ? '' : normalizeGatewayUrl(''));
  const assistModelId = els.inlineAssistModel?.value || settings.inlineAssistModel || '';
  const assistBinding = resolveAssistModelBindingFromCatalog({
    settings: { ...settings, inlineAssistModel: assistModelId },
    models: availableModels,
  }) || {
    inlineAssistModel: String(settings.inlineAssistModel || ''),
    inlineAssistRawModel: String(settings.inlineAssistRawModel || ''),
    inlineAssistProvider: String(settings.inlineAssistProvider || ''),
  };
  settings = {
    ...settings,
    connectionMode: normalizeConnectionMode(connectionMode),
    connectionTransport,
    gatewayMode,
    gatewayUrl,
    trustedDashboardOrigin: isTrustedDashboardOrigin(gatewayUrl, settings.trustedDashboardOrigin)
      ? settings.trustedDashboardOrigin
      : '',
    apiKey: connectionMode === 'cloud' ? '' : apiKey,
    tokenSource: connectionMode === 'cloud' ? '' : tokenSource,
    model: settings.model || DEFAULT_SETTINGS.model,
    modelContextTokens: selected?.contextTokens || settings.modelContextTokens || 0,
    sessionId: els.sessionIdInput.value.trim() || DEFAULT_SETTINGS.sessionId,
    sessionTitle: els.sessionTitleInput.value.trim() || DEFAULT_SETTINGS.sessionTitle,
    activeProfile: els.profileSelect?.value || settings.activeProfile || DEFAULT_SETTINGS.activeProfile,
    contextDepth: els.contextDepthInput.value,
    includeTabs: els.includeTabsInput.checked,
    includePageText: els.includePageTextInput.checked,
    includeSelectedText: els.includeSelectedTextInput.checked,
    inlineAssistEnabled: els.inlineAssistEnabled ? els.inlineAssistEnabled.checked : settings.inlineAssistEnabled !== false,
    inlineAssistDefaultRoute: normalizeInlineDraftRoutePreference(els.inlineAssistDefaultRoute?.value || settings.inlineAssistDefaultRoute),
    ...assistBinding,
    inlineAssistSessionRetention: els.inlineAssistSessionRetention?.value === 'delete' ? 'delete' : 'keep',
    inlineAssistThinkingEnabled: settings.inlineAssistThinkingEnabled !== false,
    inlineAssistReasoningEffort: normalizeReasoningEffort(settings.inlineAssistReasoningEffort || 'low'),
    inlineAssistFastMode: settings.inlineAssistFastMode !== false,
    contextMenuDefaultRoute: ['current', 'new', 'background'].includes(els.contextMenuDefaultRoute?.value) ? els.contextMenuDefaultRoute.value : 'ask',
    panelResidencyMode: normalizePanelResidencyMode(els.panelResidencyInputs?.find((input) => input.checked)?.value || settings.panelResidencyMode),
    autoNameSessions: els.autoNameSessionsInput ? els.autoNameSessionsInput.checked : settings.autoNameSessions !== false,
    agentDiscoveryHost: normalizeAgentDiscoveryHost(els.agentHostInput?.value || settings.agentDiscoveryHost || DEFAULT_SETTINGS.agentDiscoveryHost),
    agentDiscoveryScheme: normalizeAgentDiscoveryScheme(els.agentSchemeInput?.value || settings.agentDiscoveryScheme || DEFAULT_SETTINGS.agentDiscoveryScheme),
    agentPorts: parseAgentPortsInput(els.agentPortsInput?.value || '').length ? parseAgentPortsInput(els.agentPortsInput?.value || '') : getAgentPorts(),
    customModelSources: normalizeExternalModelSourceList(els.customModelSourcesInput?.value?.split(/\n+/) || settings.customModelSources || []),
    transcriptProvider: els.transcriptProviderInput.value.trim() || DEFAULT_SETTINGS.transcriptProvider,
    wakeWordEnabled: els.wakeWordEnabledInput ? els.wakeWordEnabledInput.checked : Boolean(settings.wakeWordEnabled),
    wakeWordPhrase: normalizeWakeWordSettings({ wakeWordPhrase: els.wakeWordPhraseInput?.value }).phrase,
    wakeWordPreferNative: settings.wakeWordPreferNative !== false,
    wakeWordBrowserFallback: els.wakeWordBrowserFallbackInput ? els.wakeWordBrowserFallbackInput.checked : settings.wakeWordBrowserFallback !== false,
    wakeWordSpeakReplies: els.wakeWordSpeakRepliesInput ? els.wakeWordSpeakRepliesInput.checked : settings.wakeWordSpeakReplies !== false,
    colorMode: normalizeColorMode(settings.colorMode),
    appearanceTheme: normalizedPanelThemeId(settings.appearanceTheme),
    appearanceSchemaVersion: 2,
  };
  await refreshContextConsentPrincipal({ settingsOverride: settings });
  const consentIdentity = currentContextConsentIdentity(settings);
  if (consentIdentity && els.browserContextConsentInput && !els.browserContextConsentInput.disabled) {
    const ledger = await persistContextConsentDecision({
      storageArea: browserApi.storage.local,
      identity: consentIdentity,
      granted: els.browserContextConsentInput.checked,
    });
    settings = { ...settings, browserContextConsentLedger: ledger };
  }
  const connectionChanged = previousSettings.connectionMode !== settings.connectionMode
    || previousSettings.connectionTransport !== settings.connectionTransport
    || normalizeGatewayUrl(previousSettings.gatewayUrl) !== normalizeGatewayUrl(settings.gatewayUrl);
  if (connectionChanged) {
    connectionController.cancel('connection settings changed');
    try {
      remoteWsConnection?.client?.close();
    } catch {
      /* ignore */
    }
    remoteWsConnection = null;
  }
  if (gatewayMode !== 'remote-dashboard' || !settings.trustedDashboardOrigin) {
    trustedDashboardTabId = null;
  }
  const stored = await browserApi.storage.local.get('hermesBrowserSettings');
  const freshSettings = stored.hermesBrowserSettings || {};
  const panelSettings = { ...settings };
  for (const webAppearanceKey of ['webTextZoomPercent', 'webFontProfile', 'webCustomFontFamily', 'webTextSize']) {
    delete panelSettings[webAppearanceKey];
  }
  settings = withAppearancePreferenceUpdate(
    { ...freshSettings, ...panelSettings },
    'panel',
    panelAppearancePreferences(),
  );
  applyAppearanceSettings();
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  const wakeChanged = previousSettings.wakeWordEnabled !== settings.wakeWordEnabled
    || previousSettings.wakeWordPhrase !== settings.wakeWordPhrase
    || previousSettings.wakeWordBrowserFallback !== settings.wakeWordBrowserFallback
    || previousSettings.wakeWordSpeakReplies !== settings.wakeWordSpeakReplies
    || connectionChanged;
  if (wakeChanged) await setWakeWordEnabled(settings.wakeWordEnabled);
  await maybeRenameCurrentSessionTitle(previousSettings, settings.sessionTitle);
  syncSettingsForm();
  updateConnectionPrompt();
}

async function clearStoredToken() {
  const previousTransport = migrateConnectionSettings(settings).connectionTransport;
  const cleared = connectionSettingsAfterTokenClear(settings);
  settings = { ...settings, ...cleared };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  if (els.apiKeyInput) els.apiKeyInput.value = '';
  sessionRoutesAvailable = null;
  const dashboardFallback = settings.connectionTransport === CONNECTION_TRANSPORTS.REMOTE_DASHBOARD
    && previousTransport !== CONNECTION_TRANSPORTS.REMOTE_DASHBOARD;
  markConnectionProbe(dashboardFallback ? 'connecting' : 'unconfigured', 'Token cleared by user.');
  setGatewayCapabilities(normalizeGatewayCapabilities(null, { healthOk: false, hasApiKey: false, warning: 'Token cleared; reconnect to refresh capabilities.' }));
  syncSettingsForm();
  setStatus(
    dashboardFallback ? 'ok' : 'warn',
    'Hermes token cleared',
    dashboardFallback
      ? 'Remote dashboard WebSocket mode selected. Keep the dashboard open and signed in, then reconnect.'
      : 'Paste a Gateway API key or reconnect when you are ready.',
  );
  if (dashboardFallback) await runPanelConnectionReadiness();
}

async function activeTab() {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  return tab ? safeTab(tab) : null;
}

async function currentWindowTabs() {
  const tabs = await browserApi.tabs.query({ currentWindow: true });
  return tabs.map(safeTab);
}

async function tabsForCurrentScope() {
  const tabs = await currentWindowTabs();
  if (contextScope.mode !== CONTEXT_SCOPE_MODES.PINNED_TAB || contextScope.pinnedTabId === null) return tabs;
  if (tabs.some((tab) => Number(tab.id) === Number(contextScope.pinnedTabId))) return tabs;
  try {
    const pinned = await browserApi.tabs.get(Number(contextScope.pinnedTabId));
    return [safeTab(pinned), ...tabs.filter((tab) => Number(tab.id) !== Number(contextScope.pinnedTabId))];
  } catch {
    return tabs;
  }
}

function manifestContentScriptFiles() {
  const scripts = browserApi.runtime.getManifest()?.content_scripts?.flatMap((entry) => entry?.js || []) || [];
  return scripts.length ? scripts : ['content-extractor.js', 'content.js'];
}

async function sendContentMessageWithInstallFallback(tabId, message, { frameId = 0 } = {}) {
  const messageOptions = Number(frameId) > 0 ? { frameId: Number(frameId) } : undefined;
  const scriptTarget = Number(frameId) > 0
    ? { tabId, frameIds: [Number(frameId)] }
    : { tabId };
  try {
    return await browserApi.tabs.sendMessage(tabId, message, messageOptions);
  } catch (originalError) {
    try {
      // Issue #86: the fallback must be idempotent. The manifest bridge may
      // already be alive in this tab/frame (a rejection can mean "listener
      // not ready yet", "message target torn down", or "policy error"), and
      // blindly re-running content.js into an initialized frame wasted work
      // and risked double-binding listeners. Probe the re-entry sentinel the
      // bridge sets (content.js) and inject only what is actually missing.
      // Re-execution itself remains SAFE since content.js now scopes all
      // state inside an IIFE with listener-cleanup-first semantics.
      const sentinel = await browserApi.scripting.executeScript({
        target: scriptTarget,
        func: () => globalThis.__HERMES_BROWSER_CONTENT_LOADED__ || null,
      });
      const bridgeAlreadyLoaded = Boolean(sentinel?.[0]?.result);
      const files = manifestContentScriptFiles();
      const filesToInject = bridgeAlreadyLoaded
        ? files.filter((file) => file.endsWith('content-extractor.js'))
        : files;
      if (filesToInject.length) {
        await browserApi.scripting.executeScript({ target: scriptTarget, files: filesToInject });
      }
      return await browserApi.tabs.sendMessage(tabId, message, messageOptions);
    } catch (fallbackError) {
      if (fallbackError && typeof fallbackError === 'object' && !fallbackError.cause) fallbackError.cause = originalError;
      throw fallbackError;
    }
  }
}

function collectPageContextWithSharedExtractor(options = {}) {
  const TEXT_LIMITS = { minimal: 4_000, normal: 12_000, full: 30_000 };
  const HermesContentExtractor = globalThis.HermesContentExtractor;
  if (!HermesContentExtractor?.collectPageContext) {
    return { ok: false, error: 'Hermes content extractor runtime is unavailable.', text: '', selectedText: '', meta: {} };
  }
  const depth = options.depth || 'normal';
  const limit = TEXT_LIMITS[depth] || TEXT_LIMITS.normal;
  const pageContext = HermesContentExtractor.collectPageContext(document, {
    maxTextChars: limit,
    maxSelectedTextChars: Math.min(limit, 8_000),
    selectedText: globalThis.getSelection?.().toString() || '',
    source: 'scripting-fallback',
    url: location.href,
  });
  const HermesSiteAdapters = globalThis.HermesSiteAdapters;
  if (!HermesSiteAdapters?.inspectSite || !HermesSiteAdapters?.applySiteAdapterPolicy) return pageContext;
  const siteAdapter = HermesSiteAdapters.inspectSite(document, {
    url: location.href,
    explicitCapture: Boolean(options.explicitSiteCapture),
  });
  return HermesSiteAdapters.applySiteAdapterPolicy(pageContext, siteAdapter);
}

async function getPageContextViaScripting(tabId, options, originalError) {
  try {
    const extractorPath = manifestContentScriptFiles().find((file) => file.endsWith('content-extractor.js'));
    if (!extractorPath) throw new Error('Hermes content extractor is missing from the active manifest.');
    const scriptTarget = Number(options?.frameId) > 0
      ? { tabId, frameIds: [Number(options.frameId)] }
      : { tabId };
    await browserApi.scripting.executeScript({
      target: scriptTarget,
      files: [extractorPath],
    });
    const [injected] = await browserApi.scripting.executeScript({
      target: scriptTarget,
      func: collectPageContextWithSharedExtractor,
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

async function getPageContext(tab, options = {}) {
  const isLocal = isLocalDocumentUrl(tab?.url);
  const allowLocal = isLocal && (options.allowLocalDocuments !== false);
  if (!tab?.id || isRestrictedUrl(tab.url, { allowLocalDocuments: allowLocal })) {
    return {
      ok: false,
      restricted: true,
      reason: 'Hermes Browser Extension does not read browser internals, extension pages, or sensitive account/payment/password pages.',
      text: '',
      selectedText: '',
      meta: {},
    };
  }

  const requestOptions = {
    depth: settings.contextDepth,
    explicitSiteCapture: Boolean(options.explicitSiteCapture),
    frameId: Number(options.frameId || 0),
  };
  try {
    const response = await sendContentMessageWithInstallFallback(
      tab.id,
      { type: 'HERMES_GET_PAGE_CONTEXT', options: requestOptions },
      { frameId: requestOptions.frameId },
    );
    if (response?.ok && (response.text || response.selectedText || response.meta?.headings?.length)) {
      return options.selectedTextOverride === undefined
        ? response
        : { ...response, selectedText: String(options.selectedTextOverride || '') };
    }
    if (response?.ok) {
      const fallback = await getPageContextViaScripting(tab.id, requestOptions, new Error('Stale content script: empty page context'));
      if (fallback?.ok) {
        return options.selectedTextOverride === undefined
          ? fallback
          : { ...fallback, selectedText: String(options.selectedTextOverride || '') };
      }
    }
    return response || { ok: false, error: 'No page context response', text: '', selectedText: '', meta: {} };
  } catch (error) {
    const fallback = await getPageContextViaScripting(tab.id, requestOptions, error);
    if (fallback?.ok) {
      return options.selectedTextOverride === undefined
        ? fallback
        : { ...fallback, selectedText: String(options.selectedTextOverride || '') };
    }
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
    return await browserApi.runtime.sendMessage({
      type: 'HERMES_GET_YOUTUBE_TRANSCRIPT',
      videoId,
      tabId: tab.id,
      provider,
    });
  } catch (error) {
    return { ok: false, videoId, reason: error?.message || String(error), source: 'sidepanel' };
  }
}

function normalizeElementPickState(value = null) {
  if (!value || !['object'].includes(typeof value)) return null;
  const tabId = Number(value.tabId);
  const url = String(value.url || '');
  if (!Number.isFinite(tabId) || !url) return null;
  return { tabId, url, startedAt: String(value.startedAt || '') };
}

function applyElementPickState(value = null) {
  elementPickState = normalizeElementPickState(value);
  elementPickInProgress = Boolean(elementPickState);
  setPickButtonState();
}

async function persistElementPickState({ tabId, url } = {}) {
  const next = normalizeElementPickState({ tabId, url, startedAt: String(Date.now()) });
  if (!next) return;
  applyElementPickState(next);
  try {
    await browserApi.storage?.session?.set?.({ [PICK_STATE_STORAGE_NAME]: next });
  } catch (_error) {
    // Session storage is best-effort UI sync; the active panel still tracks state locally.
  }
}

async function loadElementPickState() {
  try {
    const stored = await browserApi.storage?.session?.get?.(PICK_STATE_STORAGE_NAME);
    applyElementPickState(stored?.[PICK_STATE_STORAGE_NAME] || null);
  } catch (_error) {
    applyElementPickState(null);
  }
}

async function clearElementPickState({ tabId = null } = {}) {
  if (tabId && elementPickState?.tabId && !Object.is(Number(tabId), elementPickState.tabId)) return;
  applyElementPickState(null);
  try {
    await browserApi.storage?.session?.remove?.(PICK_STATE_STORAGE_NAME);
  } catch (_error) {
    // Session storage is best-effort UI sync; the active panel still clears locally.
  }
}

function elementPickActiveForTab(tab = currentContext?.activeTab) {
  if (!elementPickInProgress || !elementPickState || !tab?.id) return false;
  if (!Object.is(Number(tab.id), elementPickState.tabId)) return false;
  const currentUrl = String(tab.url || currentContext?.pageContext?.url || '');
  return !elementPickState.url || !currentUrl || elementPickState.url === currentUrl;
}

function isSessionStorageArea(areaName = '') {
  return ['session'].includes(areaName);
}

function mergeStoredPickIntoPageContext(tab, pageContext) {
  if (!pageContext || !tab?.id) return pageContext;
  const stored = pickedElementsByTabId.get(tab.id);
  const picked = pickedElementForTab(stored, tab, pageContext);
  if (picked) {
    pageContext.pickedElement = picked;
  } else {
    delete pageContext.pickedElement;
    if (stored) pickedElementsByTabId.delete(tab.id);
  }
  return pageContext;
}

function activeStoredPick() {
  const tab = currentContext?.activeTab;
  if (!tab?.id) return null;
  return pickedElementForTab(pickedElementsByTabId.get(tab.id), tab, currentContext?.pageContext || {});
}

function clearPickedElementForTab(tabId, { silent = false } = {}) {
  if (!tabId) return;
  pickedElementsByTabId.delete(tabId);
  if (currentContext?.activeTab?.id === tabId && currentContext.pageContext) {
    delete currentContext.pageContext.pickedElement;
  }
  clearElementPickState({ tabId });
  setPickButtonState();
  renderContextWindow();
  if (!silent) setStatus('ok', 'Picked element cleared', '');
}

function setPickButtonState() {
  const hasPick = Boolean(activeStoredPick());
  const pickingActive = elementPickActiveForTab();
  const attachPick = document.querySelector('[data-attach="pick-element"]');
  if (attachPick) {
    attachPick.textContent = pickingActive
      ? translateUiText('◈ Picking element...')
      : hasPick
        ? translateUiText('◈ Pick a different element')
        : translateUiText('◈ Pick page element');
    attachPick.setAttribute('aria-pressed', String(pickingActive || Boolean(hasPick)));
  }
  const attachClear = document.getElementById('clearPickAttachButton');
  if (attachClear) {
    attachClear.hidden = !hasPick;
    attachClear.disabled = !hasPick;
  }
}

async function startElementPick() {
  if (contextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) {
    setStatus('warn', 'Chat only', 'Enable browser context before picking an element.');
    return;
  }
  const [active, tabs] = await Promise.all([activeTab(), tabsForCurrentScope()]);
  const tab = resolveContextTargetTab({ activeTab: active, tabs, scope: contextScope });
  if (!tab?.id) {
    setStatus('warn', 'No tab', 'Open a normal page tab first.');
    return;
  }
  if (isRestrictedUrl(tab.url)) {
    setStatus('warn', 'Restricted page', 'Element pick is not available on this URL.');
    return;
  }
  try {
    if (elementPickActiveForTab(tab)) {
      await browserApi.tabs.sendMessage(tab.id, { type: ELEMENT_PICK_MESSAGES.CANCEL });
      await clearElementPickState({ tabId: tab.id });
      setStatus('ok', 'Element pick cancelled', '');
      return;
    }
    const response = await sendContentMessageWithInstallFallback(tab.id, { type: ELEMENT_PICK_MESSAGES.START });
    if (response?.ok === false) throw new Error(response.error || 'Could not start element picker');
    await persistElementPickState({ tabId: tab.id, url: tab.url });
    setStatus('ok', 'Pick an element', 'Click any element on the page. Press Esc to cancel.');
  } catch (error) {
    await clearElementPickState({ tabId: tab.id });
    setStatus('warn', 'Element pick failed', error?.message || String(error), { translateDetail: false });
  }
}

function applyPickedElementResult(message = {}, sender = {}) {
  const tabId = sender.tab?.id || currentContext?.activeTab?.id;
  const pickedElement = message.pickedElement;
  if (!pickedElement?.ok) return;
  const pickedUrl = String(message.url || pickedElement.url || sender.tab?.url || currentContext?.activeTab?.url || '');
  const stored = storedPickedElementRecord({ tabId, url: pickedUrl, pickedElement });
  if (stored) pickedElementsByTabId.set(stored.tabId, stored);
  clearElementPickState({ tabId });
  const currentUrl = String(currentContext?.activeTab?.url || currentContext?.pageContext?.url || '');
  if (stored && currentContext.pageContext && currentContext.activeTab?.id === stored.tabId && stored.url === currentUrl) {
    currentContext.pageContext.pickedElement = stored.pickedElement;
  }
  setPickButtonState();
  renderContextWindow();
  const label = `${pickedElement.tag || 'element'} · ${pickedElement.selector || ''}`.trim();
  setStatus('ok', 'Element picked', label || 'Attached to context for the next message.');
}

function clearPickedElementForActiveTab() {
  clearPickedElementForTab(currentContext?.activeTab?.id);
}

async function refreshContext(options = {}) {
  const contextGate = effectiveContextGate(contextScope);
  let captureScope = contextGate.scope;
  if (captureScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY) {
    currentContext = { activeTab: null, tabs: [], selectedTabs: [], pageContext: null, contextScope: captureScope };
    selectedTabs = [];
    setStatus(
      'ok',
      'Chat only',
      contextGate.reason === 'consent_required'
        ? 'This non-local connection cannot read browser context until you approve its exact endpoint, account, profile, and controller in Settings.'
        : 'No browser context will be read or attached.',
    );
    renderContextScopeControls();
    renderContextWindow();
    return currentContext;
  }

  const [active, tabs] = await Promise.all([activeTab(), tabsForCurrentScope()]);
  const tab = resolveContextTargetTab({ activeTab: active, tabs, scope: captureScope });
  if (captureScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB && tab) {
    const nextScope = contextScopeFromTab(tab, contextScope);
    if (JSON.stringify(nextScope) !== JSON.stringify(contextScope)) {
      contextScope = nextScope;
      captureScope = normalizeContextScope(nextScope);
      saveContextScopeForInstance();
    }
  }
  const pinnedMissing = captureScope.mode === CONTEXT_SCOPE_MODES.PINNED_TAB && !tab;
  const pageContext = tab
    ? await getPageContext(tab, options)
    : pinnedMissing
      ? { ok: false, restricted: true, reason: 'Pinned tab is closed or no longer available.', text: '', selectedText: '', meta: {} }
      : null;
  const youtubeTranscript = tab ? await getYoutubeTranscriptForTab(tab) : null;
  if (pageContext && youtubeTranscript) pageContext.youtubeTranscript = youtubeTranscript;
  if (pageContext && tab) mergeStoredPickIntoPageContext(tab, pageContext);
  syncSelectedTabsFromContextScope(tabs);
  const promptTabs = filterPromptTabs(tabs, captureScope);
  currentContext = {
    activeTab: tab,
    tabs,
    selectedTabs: Array.isArray(captureScope.selectedTabIds) ? promptTabs : tabs,
    pageContext,
    contextScope: captureScope,
  };

  if (pinnedMissing) {
    setStatus('warn', 'Pinned tab closed', 'Choose another tab or follow the active tab.');
  } else if (!tab) {
    setStatus('warn', 'No active tab detected', 'Open a normal browser tab and try again.');
  } else if (pageContext?.restricted) {
    setStatus('warn', tab.title || translateUiText('Restricted page'), t('status.page_context_restricted', { url: tab.url }), { translateTitle: false, translateDetail: false });
  } else if (pageContext?.ok) {
    setStatus('ok', tab.title || translateUiText('Active tab ready'), tab.url || '', { translateTitle: false, translateDetail: false });
  } else {
    setStatus('warn', tab.title || translateUiText('Page context partial'), pageContext?.error || tab.url || '', { translateTitle: false, translateDetail: false });
  }
  renderLocalDocumentApproval(tab);
  renderContextScopeControls();
  renderContextWindow();
  return currentContext;
}

function setRefreshButtonBusy(busy) {
  if (els.refreshButton) {
    els.refreshButton.classList.toggle('is-refreshing', Boolean(busy));
    els.refreshButton.setAttribute('aria-busy', String(Boolean(busy)));
    els.refreshButton.disabled = Boolean(busy);
  }
  if (els.explicitSiteCaptureButton) {
    els.explicitSiteCaptureButton.setAttribute('aria-busy', String(Boolean(busy)));
    els.explicitSiteCaptureButton.disabled = Boolean(busy);
  }
}

function waitForRefreshButtonSpin(startedAt) {
  const elapsed = performance.now() - startedAt;
  const remaining = Math.max(0, REFRESH_BUTTON_MIN_BUSY_MS - elapsed);
  return remaining ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}

async function refreshContextWithSpin(options = {}) {
  if (contextRefreshingFromButton) return currentContext;
  contextRefreshingFromButton = true;
  const startedAt = performance.now();
  setRefreshButtonBusy(true);
  try {
    const refreshed = await refreshContext(options);
    forceFullContextNextTurn = true;
    return refreshed;
  } finally {
    await waitForRefreshButtonSpin(startedAt);
    contextRefreshingFromButton = false;
    setRefreshButtonBusy(false);
  }
}

async function apiFetch(path, options = {}) {
  return hermesClient.fetch(path, options);
}

async function compactCurrentSessionContext({ automaticRecovery = false } = {}) {
  if (!automaticRecovery && !canSwitchActiveSession({ sending, runControl: activeRunControl })) {
    setStatus('warn', 'Compaction blocked while Hermes is running', 'Stop the active run before compacting this session.');
    return { ok: false, reason: 'active-run' };
  }
  if (!settings.sessionId) {
    if (!automaticRecovery) setStatus('warn', 'No active session', 'Open or create a Hermes Browser Extension session before compacting context.');
    return { ok: false, reason: 'no-session' };
  }
  if (!gatewayCapabilities.sessionCompress) {
    if (!automaticRecovery) setStatus('warn', 'Context compaction unavailable', 'The connected Hermes runtime does not advertise native session compaction.');
    return { ok: false, reason: 'route-unavailable' };
  }
  const button = els.contextCompactButton;
  if (button) {
    button.disabled = true;
    button.textContent = translateUiText('Compacting…');
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
      await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    }
    if (payload && typeof payload === 'object') {
      applySessionRuntimeSnapshot({
        session: { id: compactedSessionId || settings.sessionId, input_tokens: payload.last_prompt_tokens || payload.estimated_prompt_tokens || 0 },
        runtime: payload.runtime,
        sessionId: compactedSessionId || settings.sessionId,
        source: 'context compaction',
      });
    }
    setStatus('ok', automaticRecovery ? 'Context recovered' : 'Context compacted', payload?.summary || 'Hermes compacted the active session context.');
    await clearContextDeliveryState();
    await loadSessions({ quiet: true });
    return { ok: true, sessionId: compactedSessionId || settings.sessionId, payload };
  } catch (error) {
    setStatus('warn', 'Context compaction failed', error?.message || String(error), { translateDetail: false });
    return { ok: false, reason: 'request-failed', error };
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

function safeHttpBodySnippet(text = '', limit = 500) {
  return String(text || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED_BEARER]')
    .replace(/(api[_-]?key|token|password|secret)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/(Authorization|Cookie):\s*[^\n]+/gi, '$1: [REDACTED]')
    .split(String.fromCharCode(13)).join(' ')
    .split(String.fromCharCode(10)).join(' ')
    .slice(0, limit)
    .trim();
}

function createSessionRouteError({ action, response, body = '' } = {}) {
  const status = response?.status || 0;
  const actionText = action || 'Hermes session request';
  const diagnostic = isRemoteMode()
    ? classifyRemoteGatewaySetup({
        url: settings.gatewayUrl,
        healthOk: true,
        status,
        body,
      })
    : null;
  const knownRemoteDiagnostic = diagnostic && diagnostic.kind !== 'unknown' ? diagnostic : null;
  const fallbackDetail = safeHttpBodySnippet(body) || `HTTP ${status}`;
  const message = knownRemoteDiagnostic
    ? `${knownRemoteDiagnostic.title}: ${knownRemoteDiagnostic.detail}`
    : `${actionText} failed (${status}): ${fallbackDetail}`;
  const error = new Error(message);
  error.name = 'HermesSessionRouteError';
  error.httpStatus = status;
  error.sessionRouteAction = actionText;
  error.remoteDiagnostic = knownRemoteDiagnostic;
  error.hermesSetupFailure = Boolean(knownRemoteDiagnostic)
    || status === 401
    || status === 403
    || status === 0;
  return error;
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
    throw createSessionRouteError({
      action: 'Inspect Hermes Browser Extension session',
      response: getResponse,
      body: text,
    });
  }

  const createResponse = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: settings.sessionId,
      title: settings.sessionTitle,
      source: settings.sessionSource || DEFAULT_SETTINGS.sessionSource,
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      system_prompt: currentHermesBrowserSystemPrompt(),
    }),
  });
  if (createResponse.status === 404 || createResponse.status === 405) {
    sessionRoutesAvailable = false;
    return false;
  }
  if (!createResponse.ok && createResponse.status !== 409) {
    const text = await createResponse.text();
    throw createSessionRouteError({
      action: 'Create Hermes Browser Extension session',
      response: createResponse,
      body: text,
    });
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

async function readSseResponse(response, onDelta, onTool, { signal, onRun, onSteerQueued, onRuntime, knownAssistantTexts = [] } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';
  let streamTextState = { text: '', finalized: false };
  let sawRunStarted = false;
  let sawTerminal = false;

  async function processBlock(block) {
    const event = parseSseBlock(block);
    const data = event.json || {};
    if (event.type === 'run.started' && data.run_id) {
      sawRunStarted = true;
      onRun?.(data.run_id);
    } else if ((event.type === 'assistant.delta' && data.delta) || (event.type === 'assistant.completed' && data.content)) {
      streamTextState = reduceAssistantStreamText(streamTextState, { type: event.type, data });
      finalText = streamTextState.text;
      onDelta(finalText);
    } else if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
      sawTerminal = true;
      onRuntime?.({ ...data, status: event.type.slice('run.'.length) });
      if (event.type === 'run.completed') {
        const nextState = reduceAssistantStreamText(streamTextState, { type: event.type, data });
        if (nextState.text !== finalText) {
          finalText = nextState.text;
          onDelta(finalText);
        }
        streamTextState = nextState;
      }
      return true;
    } else if (event.type === 'steer.queued' && data.text) {
      onSteerQueued?.(data.text);
    } else if (event.type === 'chat.completion.chunk' || event.type === 'message') {
      const nextText = appendOpenAiChunkText(event, finalText);
      if (nextText !== finalText) {
        finalText = nextText;
        streamTextState = { text: finalText, finalized: false };
        onDelta(finalText);
      }
    } else if (event.type?.startsWith('tool.') && onTool) {
      onTool(normalizeBrowserRuntimeEvent({ type: event.type, data }));
    } else if (event.type === 'hermes.tool.progress' && onTool) {
      onTool(normalizeBrowserRuntimeEvent({ type: event.type, data }));
    } else if (event.type === 'error') {
      throw new Error(data.message || event.data || 'Hermes stream error');
    }
    return false;
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
    let terminal = false;
    for (const block of parsed.blocks) {
      terminal = await processBlock(block) || terminal;
      if (terminal) break;
    }
    if (terminal) {
      await reader.cancel().catch(() => {});
      return finalText;
    }
  }

  buffer += decoder.decode();
  const parsed = sseBlocksFromBuffer(buffer, { flush: true });
  for (const block of parsed.blocks) await processBlock(block);
  if (sawRunStarted && !sawTerminal) {
    throw new Error('Hermes stream closed before terminal run state.');
  }
  return finalText;
}

function currentModelOptionsPayload() {
  return buildHermesModelOptions(settings);
}

function currentHermesBrowserSystemPrompt() {
  const runtimeSelection = buildHermesRuntimeSelectionNote({
    model: currentModelRequestId(),
    provider: currentModelProviderSlug() || 'Hermes runtime',
    modelOptions: currentModelOptionsPayload(),
  });
  return `${HERMES_BROWSER_SYSTEM_PROMPT}\n\n${runtimeSelection}`;
}

function currentSelectedModel() {
  const binding = currentEffectiveModelBinding();
  return modelForBinding(binding) || availableModels.find((model) => model.id === settings.model) || null;
}

function currentModelRequestId() {
  const binding = currentEffectiveModelBinding();
  const selected = currentSelectedModel();
  return selected?.rawModelId || selected?.model || binding?.rawModelId || binding?.modelId || settings.model;
}

function currentModelProviderSlug() {
  const binding = currentEffectiveModelBinding();
  const selected = currentSelectedModel();
  return selected?.provider || binding?.provider || '';
}

function applyPendingModelRuntimeAck(runtime = {}) {
  if (!pendingModelRuntimeAck || !runtime || typeof runtime !== 'object') return;
  const ack = modelRuntimeAckState({
    requested: {
      provider: pendingModelRuntimeAck.provider,
      model: pendingModelRuntimeAck.model,
      gatewayAlias: pendingModelRuntimeAck.gatewayAlias === true,
      gatewayDefault: pendingModelRuntimeAck.gatewayDefault === true,
    },
    runtime,
  });
  if (ack.state === 'pending') return;
  if (ack.state === 'confirmed') {
    setStatus('ok', 'Hermes model confirmed', ack.detail || 'Runtime metadata matched the requested model.');
  } else {
    setStatus('warn', 'Model mismatch', ack.detail);
  }
  pendingModelRuntimeAck = null;
}

function applyTurnRuntimePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return;
  captureDelegationRuntimePayload(payload);
  const runtime = payload.runtime || {};
  applySessionRuntimeSnapshot({
    sessionId: payload.session_id || payload.sessionId || settings.sessionId,
    usage: payload.usage,
    runtime,
    source: 'Hermes turn',
  });
  applyPendingModelRuntimeAck(runtime);
}

async function requestDashboardOriginTrust(baseUrl) {
  const origin = originOf(baseUrl);
  if (!origin) throw new Error('Set a remote https gateway URL without embedded credentials before connecting.');
  const tab = await findDashboardTab(browserApi.tabs, origin);
  if (!tab?.id) {
    const error = new Error(ticketFailureHelp('no_dashboard_tab', origin));
    error.ticketReason = 'no_dashboard_tab';
    throw error;
  }
  if (isTrustedDashboardOrigin(baseUrl, settings.trustedDashboardOrigin)) {
    trustedDashboardTabId = tab.id;
    settings = { ...settings, trustedDashboardTabId: tab.id };
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    return origin;
  }
  const approved = globalThis.confirm?.(dashboardTrustPrompt(origin)) === true;
  if (!approved) {
    const error = new Error('Dashboard Attach was not approved. Open Settings → Test connection when you are ready to trust this origin.');
    error.ticketReason = 'dashboard_origin_untrusted';
    throw error;
  }
  trustedDashboardTabId = tab.id;
  settings = { ...settings, trustedDashboardOrigin: origin, trustedDashboardTabId: tab.id };
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  return origin;
}

async function ensureRemoteWsClient() {
  const baseUrl = normalizeGatewayUrl(settings.gatewayUrl);
  if (!isUsableRemoteGatewayUrl(baseUrl)) {
    throw new Error('Set a remote https gateway URL in Settings before connecting.');
  }
  if (!isTrustedDashboardOrigin(baseUrl, settings.trustedDashboardOrigin)) {
    const error = new Error('This dashboard origin is not trusted yet. Open Settings → Test connection to review and approve Dashboard Attach.');
    error.ticketReason = 'dashboard_origin_untrusted';
    throw error;
  }
  if (!Number.isFinite(trustedDashboardTabId)) {
    const error = new Error('Select the signed-in dashboard tab, then use Settings → Test connection before attaching.');
    error.ticketReason = 'dashboard_tab_unselected';
    throw error;
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

  const ticket = await mintWsTicket({
    tabsApi: browserApi.tabs,
    scriptingApi: browserApi.scripting,
    baseUrl,
    tabId: trustedDashboardTabId,
  });
  if (!ticket.ok) {
    const error = new Error(ticketFailureHelp(ticket.reason, ticket.origin));
    error.ticketReason = ticket.reason;
    throw error;
  }
  await refreshContextConsentPrincipal({ dashboardPrincipal: ticket.principal });
  const wsUrl = buildDashboardWsUrl(baseUrl, ticket.ticket);
  const client = createGatewayClient();
  try {
    await client.connect(wsUrl);
  } catch (error) {
    console.warn('[Hermes] remote: WebSocket connect failed:', error?.message || error);
    throw error;
  }
  const connection = { client, baseUrl, wsSessionId: '', wsStoredSessionId: '' };
  client.on('close', () => {
    if (remoteWsConnection === connection) {
      remoteWsConnection = null;
      const durableSessionId = connection.wsStoredSessionId || settings.sessionId;
      const reconnectGeneration = connectionController.begin({
        mode: normalizeConnectionMode(settings.connectionMode),
        transport: settings.connectionTransport,
        detail: { sessionId: durableSessionId },
      });
      connectionController.transition(reconnectGeneration, CONNECTION_STATES.DEGRADED, {
        reason: 'dashboard-socket-closed',
        sessionId: durableSessionId,
      });
      setStartupReadiness(ticketTransportClosedReadiness({
        sessionId: connection.wsStoredSessionId || settings.sessionId,
      }));
      markGatewayUnreachable(new Error('Remote dashboard socket closed'));
    }
  });
  remoteWsConnection = connection;
  return connection;
}

async function ensureRemoteWsSession(connection) {
  if (connection.wsSessionId) return connection.wsSessionId;
  const binding = currentEffectiveModelBinding();
  const storedSessionId = remoteStoredSessionIdForGateway(settings.remoteDashboardSession, connection.baseUrl);
  const { liveId, storedId } = await establishGatewaySession({
    client: connection.client,
    storedSessionId,
    createParams: {
      title: settings.sessionTitle,
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || binding?.provider || undefined,
      reasoning_effort: normalizeReasoningEffort(settings.reasoningEffort),
      fast: normalizeFastMode(settings.fastMode),
      profile: safeActiveProfile(),
    },
  });
  connection.wsSessionId = liveId;
  connection.wsStoredSessionId = storedId;
  // Persist only the durable identity. Every socket replacement resumes it and
  // receives a fresh live id for prompt/history/steer/interrupt RPCs.
  settings = {
    ...settings,
    sessionId: storedId,
    remoteDashboardSession: {
      storedSessionId: storedId,
      gatewayUrl: connection.baseUrl,
    },
  };
  if (binding) {
    settings = {
      ...settings,
      model: modelForBinding(binding)?.id || binding.modelId || settings.model,
      modelContextTokens: modelForBinding(binding)?.contextTokens || binding.contextTokens || settings.modelContextTokens || 0,
      sessionModelBindings: {
        ...(settings.sessionModelBindings || {}),
        [storedId]: binding,
      },
      modelScopeVersion: DEFAULT_SETTINGS.modelScopeVersion,
    };
    try {
      const request = buildSessionModelSwitchRequest({
        sessionId: liveId,
        model: binding.rawModelId || binding.modelId,
        provider: binding.provider,
      });
      await connection.client.request(request.method, request.params);
    } catch (error) {
      console.warn('[Hermes] Cloud model selection was not applied:', error?.message || error);
    }
  }
  try {
    const statusPayload = await connection.client.request(WS_METHODS.sessionStatus, { session_id: liveId });
    const runtime = runtimeModelFromSessionStatus(statusPayload);
    const acknowledgedBinding = sessionModelBindingFromRuntime(runtime, availableModels);
    if (acknowledgedBinding) {
      settings = {
        ...settings,
        sessionModelBindings: {
          ...(settings.sessionModelBindings || {}),
          [storedId]: acknowledgedBinding,
        },
      };
      applySessionRuntimeSnapshot({ sessionId: storedId, runtime, source: 'Cloud session status' });
    }
  } catch (error) {
    console.warn('[Hermes] Cloud runtime metadata was not acknowledged:', error?.message || error);
  }
  await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  await activateCurrentDelegationSession();
  updateSessionLabel();
  return liveId;
}

async function streamRemoteWsChat(prompt, onDelta, onTool, { signal, onRun, knownAssistantTexts = [] } = {}) {
  const connection = await ensureRemoteWsClient();
  const sessionId = await ensureRemoteWsSession(connection);
  onRun?.(sessionId);
  const { client } = connection;

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
      const completionError = hermesGatewayTurnError({ payload: event.payload });
      if (completionError) {
        finish(reject, completionError);
        return;
      }
      finalText = event.payload?.text || finalText;
      onDelta(finalText);
      finish(resolve, finalText);
    }));
    offs.push(client.on('tool.start', (event) => {
      if (forThisSession(event) && onTool) onTool({ type: 'tool.start', tool_name: event.payload?.name });
    }));
    offs.push(client.on('tool.complete', (event) => {
      if (forThisSession(event) && onTool) onTool({
        type: 'tool.complete',
        tool_name: event.payload?.name,
        result: event.payload?.result,
      });
    }));
    offs.push(client.on(WS_EVENTS.error, (event) => {
      if (!forThisSession(event)) return;
      finish(reject, hermesGatewayTurnError({ payload: event.payload }) || new Error('Dashboard stream error'));
    }));
    offs.push(client.on('close', () => finish(reject, new Error('Dashboard connection closed mid-turn.'))));

    client.request(WS_METHODS.promptSubmit, { session_id: sessionId, text: prompt }).catch((error) => finish(reject, error));
  });
}

async function streamSessionChat(prompt, onDelta, onTool, { signal, attachments: turnAttachments = attachments, onRun, onSteerQueued, onRuntime, knownAssistantTexts = [] } = {}) {
  if (isRemoteWsMode()) return streamRemoteWsChat(prompt, onDelta, onTool, { signal, onRun, knownAssistantTexts });
  const hasSessionRoutes = await ensureHermesSession();
  if (!hasSessionRoutes) return streamChatCompletions(prompt, onDelta, onTool, { signal, attachments: turnAttachments, onRun, knownAssistantTexts });

  let response;
  try {
    response = await apiFetch(`/api/sessions/${encodeSessionId(settings.sessionId)}/chat/stream`, {
      method: 'POST',
      signal,
      body: JSON.stringify({
            client_runtime_version: modelSelectionVersion,
            model: currentModelRequestId(),
            provider: currentModelProviderSlug() || undefined,
            model_options: currentModelOptionsPayload(),
            require_model_lock: shouldRequireModelLock({
              provider: currentModelProviderSlug(),
              model: currentModelRequestId(),
              defaultModel: DEFAULT_SETTINGS.model,
              gatewayDefault: currentSelectedModel()?.gatewayDefault === true,
            }),
            message: outboundContent(prompt, turnAttachments),
            system_message: currentHermesBrowserSystemPrompt(),
          }),
    });
  } catch (error) {
    error.requestAccepted = true;
    throw error;
  }

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw hermesRequestError({
      status: response.status,
      body: text,
      operation: 'Hermes stream',
    });
  }
  try {
    return await readSseResponse(response, onDelta, onTool, { signal, onRun, onSteerQueued, onRuntime, knownAssistantTexts });
  } catch (error) {
    error.requestAccepted = true;
    throw error;
  }
}

async function streamChatCompletions(prompt, onDelta, onTool, { signal, attachments: turnAttachments = attachments, onRun, knownAssistantTexts = [] } = {}) {
  let response;
  try {
    response = await apiFetch('/v1/chat/completions', {
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
          { role: 'system', content: currentHermesBrowserSystemPrompt() },
          { role: 'user', content: outboundContent(prompt, turnAttachments) },
        ],
      }),
    });
  } catch (error) {
    error.requestAccepted = true;
    throw error;
  }
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw hermesRequestError({
      status: response.status,
      body: text,
      operation: 'Hermes chat-completions stream',
    });
  }
  try {
    const result = await readSseResponse(response, onDelta, onTool, { signal, onRun, knownAssistantTexts });
    await captureDelegationDispatchesFromCurrentRestHistory();
    return result;
  } catch (error) {
    error.requestAccepted = true;
    throw error;
  }
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
    redirect: 'error',
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recoverAcceptedTurn(prompt, turnAttachments = attachments, { attempts = 8, delay = 500 } = {}) {
  if (isRemoteWsMode() || !settings.apiKey) return '';
  const userContent = outboundContent(prompt, turnAttachments);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await apiFetch(`/api/sessions/${encodeSessionId(settings.sessionId)}/messages`, { method: 'GET' });
      const payload = await readJsonResponse(response);
      if (response.ok) {
        const rows = Array.isArray(payload.data) ? payload.data : [];
        captureDelegationRuntimePayload({ messages: rows });
        const answer = latestAssistantAfterUser(rows, userContent);
        if (answer) return answer;
      }
    } catch {
      // The original turn is already accepted; recovery is best effort and
      // must never post the user turn again.
    }
    if (attempt < attempts - 1) await sleep(delay);
  }
  return '';
}

async function openApprovalUrl(url) {
  if (!url) return;
  try {
    await browserApi.tabs.create({ url });
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
    els.connectStatus.textContent = translateUiText('Waiting for Hermes Desktop approval...');
    await sleep(delay);
  }
  throw new Error('Timed out waiting for Hermes Desktop approval.');
}

async function connectTicketTransport({ cloud = false } = {}) {
  const mode = cloud ? 'cloud' : 'remote';
  const transport = cloud ? CONNECTION_TRANSPORTS.CLOUD_TICKET_WS : CONNECTION_TRANSPORTS.REMOTE_DASHBOARD;
  const generation = connectionController.begin({ mode, transport });
  els.connectButton.disabled = true;
  els.connectButton.textContent = translateUiText(cloud ? 'Connecting Cloud…' : 'Attaching dashboard…');
  markConnectionProbe('connecting', cloud ? 'Finding active Hermes Cloud agent tab.' : settings.gatewayUrl);
  try {
    if (cloud) {
      const rememberedTabId = Number(settings.trustedDashboardTabId);
      const rememberedOrigin = String(settings.trustedDashboardOrigin || '').trim();
      let selected = Number.isFinite(rememberedTabId) && rememberedTabId > 0 && rememberedOrigin
        ? await assertCloudAgentTabStillMatches({
          tabsApi: browserApi.tabs,
          tabId: rememberedTabId,
          expectedOrigin: rememberedOrigin,
        }).catch(() => null)
        : null;
      const reusingTrustedTab = Boolean(selected);
      selected ||= await resolveActiveCloudAgentTab({ tabsApi: browserApi.tabs });
      if (!connectionController.isCurrent(generation)) return;
      if (!reusingTrustedTab) {
        const approved = globalThis.confirm?.(dashboardTrustPrompt(selected.origin)) === true;
        if (!approved) throw new Error('Hermes Cloud connection was cancelled before ticket minting.');
      }
      await assertCloudAgentTabStillMatches({ tabsApi: browserApi.tabs, tabId: selected.tabId, expectedOrigin: selected.origin });
      if (!connectionController.isCurrent(generation)) return;
      trustedDashboardTabId = selected.tabId;
      settings = {
        ...migrateConnectionSettings(settings),
        connectionMode: 'cloud',
        connectionTransport: CONNECTION_TRANSPORTS.CLOUD_TICKET_WS,
        gatewayMode: 'remote-dashboard',
        gatewayUrl: selected.origin,
        trustedDashboardOrigin: selected.origin,
        trustedDashboardTabId: selected.tabId,
        apiKey: '',
        tokenSource: '',
      };
    } else {
      const origin = await requestDashboardOriginTrust(normalizeGatewayUrl(settings.gatewayUrl));
      if (!connectionController.isCurrent(generation)) return;
      settings = {
        ...migrateConnectionSettings(settings),
        connectionMode: 'remote',
        connectionTransport: CONNECTION_TRANSPORTS.REMOTE_DASHBOARD,
        gatewayMode: 'remote-dashboard',
        gatewayUrl: origin,
      };
    }

    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    syncSettingsForm();
    const readiness = await runPanelConnectionReadiness({ restoreSettings: false });
    if (!connectionController.isCurrent(generation)) return;
    if (!connectionController.transition(generation, CONNECTION_STATES.READY, { gateway: 'dashboard-ws', sessionId: readiness.sessionId })) return;
    const target = normalizeGatewayUrl(settings.gatewayUrl);
    markGatewayReachable(target);
    setStatus('ok', cloud ? 'Hermes Cloud Preview connected' : 'Remote Hermes dashboard connected', `${target} · Session ${readiness.sessionId}`);
    els.connectStatus.textContent = cloud
      ? `Connected to the active signed-in Hermes Cloud agent (${target}).`
      : `Connected to ${target}.`;
    updateConnectionPrompt();
    renderEmptyState();
  } catch (error) {
    const diagnostic = classifyGatewayError(error);
    if (connectionController.transition(generation, CONNECTION_STATES.ERROR, { errorKind: diagnostic.kind })) {
      markGatewayUnreachable(error);
      els.connectStatus.textContent = error?.message || String(error);
      setStatus('error', cloud ? 'Hermes Cloud Preview failed' : 'Dashboard Attach failed', error?.message || String(error), { translateDetail: false });
    }
  } finally {
    if (connectionController.isCurrent(generation)) {
      els.connectButton.disabled = false;
      els.connectButton.textContent = translateUiText('Connect to Hermes');
    }
  }
}

async function connectToHermes() {
  settings = migrateConnectionSettings(settings);
  const action = connectionActionForSettings(settings);
  if (action === CONNECTION_ACTIONS.CLOUD_ACTIVE_TAB_ATTACH) return connectTicketTransport({ cloud: true });
  if (action === CONNECTION_ACTIONS.REMOTE_DASHBOARD_ATTACH) return connectTicketTransport({ cloud: false });
  return connectApiWithPairing();
}

async function connectApiWithPairing() {
  if (transportUsesDashboardTicket(settings.connectionTransport)) {
    throw new Error('Ticket-based Hermes connections must use Dashboard Attach.');
  }
  settings.gatewayUrl = normalizeGatewayUrl(settings.gatewayUrl || els.gatewayUrlInput.value || DEFAULT_SETTINGS.gatewayUrl);
  settings.gatewayMode = normalizeGatewayMode(settings.gatewayMode || els.gatewayModeInput?.value || DEFAULT_SETTINGS.gatewayMode);
  if (!automaticApiPairingAllowed(settings)) {
    const message = 'Automatic pairing is available only for a loopback Local gateway. Remote API connections require an explicitly configured URL and token; dashboard connections use Trusted Dashboard Attach.';
    els.connectStatus.textContent = message;
    setStatus('warn', 'Manual setup required', message);
    openSettingsDialog();
    return;
  }
  const generation = connectionController.begin({
    mode: normalizeConnectionMode(settings.connectionMode),
    transport: settings.connectionTransport,
  });
  const summary = currentGatewaySummary();
  markConnectionProbe('connecting', summary.normalizedUrl);
  els.connectButton.disabled = true;
  els.connectButton.textContent = translateUiText('Connecting...');
  els.connectStatus.textContent = `Looking for ${summary.title} at ${summary.normalizedUrl}...`;
  try {
    const health = await publicApiFetch('/health', { method: 'GET' });
    if (!connectionController.isCurrent(generation)) return;
    if (!health.ok) throw new Error(`Hermes API server is not reachable (${health.status}).`);

    const capabilities = await loadGatewayCapabilities({ quiet: true, publicOnly: true, healthOk: true });
    if (!connectionController.isCurrent(generation)) return;
    let pairingStart = null;
    let pairingPayload = null;
    if (capabilities.browserPairing) {
      pairingStart = await publicApiFetch('/api/browser-extension/pair/start', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Hermes Browser Extension',
          extensionId: browserApi.runtime?.id || '',
        }),
      });
      pairingPayload = await readJsonResponse(pairingStart);
      if (!connectionController.isCurrent(generation)) return;
      if (!pairingStart.ok) throw new Error(pairingFailureMessage(pairingStart.status, pairingPayload));
    } else {
      // Bootstrap pairing recovery (Firefox/401 hardening): some gateways keep
      // /v1/capabilities behind the API key, so the unauthenticated probe 401s
      // and the advertisement is unreadable even though the pairing bootstrap
      // route is open. Give loopback local gateways one optimistic pair/start
      // attempt before falling back to manual setup; a genuine miss lands in
      // that same manual-setup path below.
      pairingStart = await publicApiFetch('/api/browser-extension/pair/start', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Hermes Browser Extension',
          extensionId: browserApi.runtime?.id || '',
        }),
      });
      try { pairingPayload = await readJsonResponse(pairingStart); } catch { pairingPayload = null; }
      if (!connectionController.isCurrent(generation)) return;
      if (!pairingStart.ok || !pairingPayload || (!pairingPayload.token && !pairingPayload.approval_url)) {
        connectionController.transition(generation, CONNECTION_STATES.DEGRADED, { reason: 'manual-setup-required' });
        markConnectionProbe('unconfigured', 'Manual setup required; automatic browser pairing is not advertised by this Hermes runtime.');
        els.connectStatus.textContent = translateUiText('Automatic pairing is not available on this Hermes runtime. Open Settings and use Manual setup with your Gateway URL and API token.');
        setStatus('warn', 'Manual setup required', 'This Hermes runtime does not advertise browser pairing yet.');
        openSettingsDialog();
        return;
      }
    }

    let pairedToken = pairingPayload.token || '';
    if (!pairedToken) {
      els.connectStatus.textContent = translateUiText('Approval opened. Approve Hermes Browser Extension, then return here.');
      await openApprovalUrl(pairingPayload.approval_url);
      pairedToken = await pollPairing(pairingPayload.pairing_id);
    }
    if (!connectionController.isCurrent(generation)) return;
    settings.apiKey = pairedToken;

    settings.tokenSource = 'pairing';
    settings.lastConnectionTestedAt = Date.now();
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    syncSettingsForm();
    updateConnectionPrompt();
    await runPanelConnectionReadiness({ restoreSettings: false });
    if (!connectionController.transition(generation, CONNECTION_STATES.READY, { gateway: 'hermes' })) return;
    els.connectStatus.textContent = translateUiText('Connected to Hermes. You can start chatting with page context.');
    markGatewayReachable(normalizeGatewayUrl(settings.gatewayUrl));
    setStatus('ok', 'Hermes Browser Extension connected', normalizeGatewayUrl(settings.gatewayUrl));
    renderEmptyState();
  } catch (error) {
    const diagnostic = classifyGatewayError(error);
    if (!connectionController.transition(generation, CONNECTION_STATES.ERROR, { errorKind: diagnostic.kind })) return;
    markGatewayUnreachable(error);
    els.connectStatus.textContent = `${currentConnectionTroubleshooting() || error?.message || String(error)} Manual setup is still available in settings.`;
    openSettingsDialog();
  } finally {
    if (connectionController.isCurrent(generation)) {
      els.connectButton.disabled = false;
      els.connectButton.textContent = translateUiText('Connect to Hermes');
    }
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
          require_model_lock: shouldRequireModelLock({
            provider: currentModelProviderSlug(),
            model: currentModelRequestId(),
            defaultModel: DEFAULT_SETTINGS.model,
            gatewayDefault: currentSelectedModel()?.gatewayDefault === true,
          }),
          message: outboundContent(prompt, turnAttachments),
          system_message: currentHermesBrowserSystemPrompt(),
        }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw hermesRequestError({
    status: response.status,
    body: JSON.stringify(payload),
    operation: 'Hermes request',
  });
  onRuntime?.(payload);
  await captureDelegationDispatchesFromCurrentRestHistory();
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
        { role: 'system', content: currentHermesBrowserSystemPrompt() },
        { role: 'user', content: outboundContent(prompt, turnAttachments) },
      ],
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw hermesRequestError({
    status: response.status,
    body: JSON.stringify(payload),
    operation: 'Hermes chat-completions request',
  });
  await captureDelegationDispatchesFromCurrentRestHistory();
  return extractAssistantText(payload);
}

async function askHermes(userText, turnAttachments = [...attachments], turnOptions = {}) {
  const browserCommand = turnOptions.disableCommandParsing ? null : parseBrowserCommand(userText);
  if (browserCommand?.kind === 'native') {
    return executeNativeBrowserCommand(browserCommand);
  }
  if (!isConnected()) {
    updateConnectionPrompt();
    addMessage('system', isRemoteWsMode()
      ? 'Remote setup needed: enter your dashboard https URL in Settings and sign in to that dashboard in a browser tab. Your draft is still in the composer.'
      : 'Connection setup needed: click Connect to Hermes if your install supports pairing, or open Settings and use Manual setup with your Gateway URL and token. Your draft is still in the composer.');
    els.connectButton.focus();
    return false;
  }

  if (sending || !canSwitchActiveSession({ sending, runControl: activeRunControl })) return false;
  if (!guardForeignSessionSend(userText, turnAttachments)) return false;
  const autoTitle = turnOptions.disableAutoTitle ? '' : autoTitleForCurrentTurn(userText);
  const turnRunControlGeneration = ++runControlGeneration;
  activeRunControl = beginRunControl({ transport: isRemoteWsMode() ? 'dashboard-ws' : 'rest' });
  try {
    if (isRemoteWsMode()) {
      const remoteConnection = await ensureRemoteWsClient();
      await ensureRemoteWsSession(remoteConnection);
    } else {
      await ensureHermesSession();
    }
  } catch (error) {
    activeRunControl = markRunTerminal(activeRunControl, 'failed');
    sending = false;
    updateComposerBusyState();
    setStatus('error', 'Could not start Hermes session', error?.message || String(error), { translateDetail: false });
    return false;
  }
  const selectedModel = currentSelectedModel();
    if (selectedModel && !isModelRuntimeSelectable(selectedModel)) {
      setStatus('warn', 'Sending observed model request', `${modelDisplayName(selectedModel)} was discovered from session history. The extension will request it, but the connected Hermes gateway may use its configured model if it does not support per-request overrides.`);
    }
    try {
      await ensureActiveSessionModelLockOrThrow();
    } catch {
      activeRunControl = markRunTerminal(activeRunControl, 'failed');
      sending = false;
      updateComposerBusyState();
      return false;
    }
    activeAbortController = new AbortController();
  sending = true;
  activeRunId = '';
  updateComposerBusyState();
  if (!turnOptions.preserveComposer) {
    els.input.value = '';
    attachments = [];
    renderAttachments();
    renderSkillSuggestions();
    renderContextWindow('');
  }

  let didSend = false;
  let streamTerminalStatus = '';
  let streamView = null;
  try {
    const preparedAttachments = await saveImageAttachmentsForTurn(turnAttachments);
    if (typeof turnOptions.resolveUserText === 'function' && isRemoteWsMode()) {
      const consentConnection = await ensureRemoteWsClient();
      await ensureRemoteWsSession(consentConnection);
    }
    await persistBrowserIntroSeen();
    const contextOverride = turnOptions.contextOverride || null;
    const requestedTurnScope = turnOptions.forceChatOnly
      ? { mode: CONTEXT_SCOPE_MODES.CHAT_ONLY, selectedTabIds: [] }
      : contextOverride?.contextScope || contextScope;
    const contextGate = turnOptions.forceChatOnly
      ? { scope: normalizeContextScope(requestedTurnScope), allowed: true, reason: 'chat_only' }
      : effectiveContextGate(requestedTurnScope);
    const turnContextScope = contextGate.scope;
    const gatedContextOverride = contextGate.allowed ? contextOverride : null;
    const turnProtocolSettings = gatedContextOverride
      ? { ...settings, ...(gatedContextOverride.settingsOverride || {}) }
      : settings;
    const capturedContext = turnContextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY
      ? null
      : gatedContextOverride || await refreshContext();
    const context = turnContextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY
      ? { activeTab: null, tabs: [], pageContext: null, contextScope: turnContextScope }
      : capturedContext;
    const browserControl = await resolveBrowserControlForTurn({ context, scope: turnContextScope });
    if (typeof turnOptions.resolveUserText === 'function') {
      userText = String(await turnOptions.resolveUserText() || '');
    }

    // Command expansion is a declared instruction transform. Deliberately do
    // not pass page/tab data to it: Browser data remains in browser_context.
    const parsedCommand = browserCommand?.kind === 'helper' ? browserCommand : null;
    let basePromptText = userText;
    if (parsedCommand) {
      const resolved = resolveCommandPrompt(parsedCommand.command.name, parsedCommand.userInput, {
        activeTab: null,
        tabs: [],
        pageContext: {},
      });
      basePromptText = resolved?.prompt || userText;
    }
    const promptUserText = userTextWithAttachments(userText, preparedAttachments);
    const displayAttachments = preparedAttachments.filter((attachment) => attachment.kind !== 'image');
    const displayUserText = turnOptions.displayUserText || (displayAttachments.length
      ? `${userText || 'Attachment-only turn.'}\n${displayAttachments.map((attachment) => `${attachmentIcon(attachment.kind)} ${attachment.label}`).join('\n')}`
      : userText);
    const promptTabs = filterPromptTabs(context.tabs, turnContextScope);
    const selectedPromptTabs = Array.isArray(turnContextScope.selectedTabIds) ? promptTabs : undefined;
    const contextHash = turnContextScope.mode === CONTEXT_SCOPE_MODES.CHAT_ONLY ? '' : browserContextPayloadHash({
      activeTab: context.activeTab,
      selectedTabs: selectedPromptTabs || promptTabs,
      pageContext: context.pageContext,
      settings: turnProtocolSettings,
    });
    // Issue #71 pre-gate: the delivery key must use the exact durable WS
    // session identity (stored id). A live-id or settings fallback would key
    // the same session under two identities and duplicate a full snapshot;
    // deliveryIdentityForTurn fails closed (null) until the stored id exists.
    const deliveryIdentity = deliveryIdentityForTurn({
      gatewayUrl: settings.gatewayUrl,
      isRemoteWs: isRemoteWsMode(),
      wsStoredSessionId: remoteWsConnection?.wsStoredSessionId || '',
      wsSessionId: remoteWsConnection?.wsSessionId || '',
      settingsSessionId: settings.sessionId || '',
      scopeBindingKey: sessionBindingKeyForScope(turnContextScope),
    });
    const contextDeliverySessionKey = deliveryIdentity?.key || '';
    const deliveryDecision = contextDeliveryDecision({
      scopeMode: turnContextScope.mode,
      contextHash,
      previous: deliveryStateEntryForIdentity(contextDeliveryBySession, deliveryIdentity),
    });
    const contextDelivery = (turnOptions.forceFullContext || forceFullContextNextTurn) && deliveryDecision.mode !== CONTEXT_DELIVERY_MODES.NONE
      ? CONTEXT_DELIVERY_MODES.FULL
      : deliveryDecision.mode;
    const prompt = serializeBrowserTurnEnvelope({
      humanInput: promptUserText,
      instructionTransform: parsedCommand ? { kind: 'slash-command', text: basePromptText } : null,
      activeTab: context.activeTab,
      tabs: context.tabs,
      pageContext: context.pageContext,
      selectedTabs: selectedPromptTabs,
      contextScope: turnContextScope,
      attachments: preparedAttachments,
      settings: turnProtocolSettings,
      contextHash,
      contextDelivery,
      browserControl,
    });

    const receipt = buildContextReceipt({
      context,
      attachments: preparedAttachments,
      settings: turnProtocolSettings,
      contextHash,
      contextDelivery,
    });
    const { node: userNode } = addMessage('user', displayUserText);
    appendContextReceipt(userNode, receipt);
    // Prior completed assistant bubbles, for run.completed reconcile filtering.
    // Server degraded-history edge case must never restack them into this turn's
    // live bubble. See runtime-events.mjs:filterKnownAssistantReconcileParts.
    const priorAssistantTexts = messages
      .filter((message) => message.role === 'assistant' && message.content)
      .map((message) => String(message.content));
    appendUserImageAttachments(
      userNode.querySelector('.message-content'),
      preparedAttachments,
      { onOpen: (image) => openGeneratedImageLightbox(image) },
    );
    const { node } = addMessage('assistant', THINKING_PLACEHOLDER, { persist: false });
    streamView = createStreamingMessageUpdater(node);
    let answer = '';
    let liveText = '';
    try {
      answer = await streamSessionChat(
        prompt,
        (partial) => {
          if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
          liveText = partial || '';
          streamView.updateText(liveText || THINKING_PLACEHOLDER);
        },
        (tool) => {
          if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
          captureTaskToolEvent(tool).catch((error) => console.warn('[Hermes Browser] Task event persistence failed:', error));
          streamView.updateTool(normalizeToolActivity(tool));
        },
        {
          signal: activeAbortController.signal,
          attachments: preparedAttachments,
          onRun: (runId) => {
            if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
            activeRunId = runId;
            activeRunControl = withRunControlId(activeRunControl, runId);
          },
          onSteerQueued: restoreBackendQueuedSteerDraft,
          onRuntime: (payload) => {
            if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
            const status = String(payload?.status || '').trim().toLowerCase();
            if (['completed', 'failed', 'cancelled'].includes(status)) streamTerminalStatus = status;
            applyTurnRuntimePayload(payload);
          },
        },
      );
    } catch (streamError) {
      if (isAbortError(streamError)) {
        answer = liveText ? `${liveText}\n\n[stopped by user]` : '[stopped by user]';
      } else if (streamError?.hermesSetupFailure) {
        streamView.update(`Hermes setup issue.\n${streamError.message}`);
        throw streamError;
      } else if (sessionContextFailureRecovery(streamError, gatewayCapabilities)) {
        throw streamError;
      } else {
        const recoveryAction = classifyTurnRecovery(streamError);
        if (recoveryAction === 'reject') {
          throw streamError;
        } else if (isRemoteWsMode()) {
          // No REST fallback in remote-dashboard mode — the api_server surface is
          // not reachable cross-origin. Surface genuine WS/ticket errors directly.
          streamView.update(`Could not reach the Hermes dashboard.\n${streamError.message}`);
          throw streamError;
        } else if (recoveryAction === 'fallback') {
          streamView.update(`Streaming failed, retrying non-streaming...\n${streamError.message}`);
          answer = await fallbackSessionChat(prompt, preparedAttachments, {
            onRuntime: (payload) => {
              if (!runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) return;
              applyTurnRuntimePayload(payload);
            },
          });
        } else {
          streamView.update('Hermes accepted this turn; recovering the response without retrying it...');
          answer = await recoverAcceptedTurn(prompt, preparedAttachments);
          if (!answer) {
            const recoveryError = new Error('Hermes accepted the turn, but the stream disconnected before the response could be recovered. The turn was not retried to prevent a duplicate message.');
            recoveryError.requestAccepted = true;
            throw recoveryError;
          }
        }
      }
    }
    const finalAnswer = answer || liveText || '(empty response)';
    if (sessionContextFailureRecovery(finalAnswer, gatewayCapabilities)) {
      const contextError = new Error(finalAnswer);
      contextError.requestAccepted = true;
      throw contextError;
    }
    await streamView.flush(finalAnswer);
    messages.push({ role: 'assistant', content: finalAnswer, ts: Date.now() });
    await trimAndSaveMessages();
    if (autoTitle) await maybeAutoNameCurrentSession(autoTitle);
    if (contextDelivery !== CONTEXT_DELIVERY_MODES.NONE && contextDeliverySessionKey) {
      contextDeliveryBySession.set(contextDeliverySessionKey, recordContextDelivery(
        contextDeliveryBySession.get(contextDeliverySessionKey) || null,
        { mode: contextDelivery, contextHash },
      ));
      if (contextDelivery === CONTEXT_DELIVERY_MODES.FULL) forceFullContextNextTurn = false;
      // Record-only-after-success: the turn already produced a final answer.
      // Persist the bounded metadata for the durable identity so a panel
      // reload does not re-send a full snapshot of unchanged context.
      void persistContextDeliveryState();
    }
    if (typeof turnOptions.onComplete === 'function') {
      try {
        await turnOptions.onComplete(finalAnswer);
      } catch (callbackError) {
        console.warn('[Hermes Browser] Inline draft completion delivery failed:', callbackError);
      }
    }
    if (
      runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)
      && [RUN_CONTROL_PHASES.RUNNING, RUN_CONTROL_PHASES.STOPPING, RUN_CONTROL_PHASES.UNCONFIRMED].includes(activeRunControl?.phase)
    ) {
      activeRunControl = markRunTerminal(activeRunControl, streamTerminalStatus || 'completed');
    }
    didSend = true;
  } catch (error) {
    if (!isAbortError(error)) {
      const contextRecovery = sessionContextFailureRecovery(error, gatewayCapabilities);
      if (contextRecovery) {
        markGatewayDegraded(error);
        if (!turnOptions.preserveComposer) {
          if (!els.input.value.trim() && !attachments.length) {
            els.input.value = userText;
            attachments = [...turnAttachments];
            renderAttachments();
            renderSkillSuggestions();
          } else if (!queuedTurn) {
            queuedTurn = { text: userText, attachments: [...turnAttachments], kind: 'recovery', autoSend: false };
            renderQueueNotice();
          }
        }
        const compactResult = contextRecovery.action === 'compact'
          ? await compactCurrentSessionContext({ automaticRecovery: true })
          : { ok: false, reason: 'new-session-required' };
        const replayDetail = contextRecovery.retryTurn
          ? 'Hermes may retry the accepted turn.'
          : 'Browser did not replay the accepted turn, preventing a duplicate message.';
        const recoveryDetail = compactResult.ok
          ? 'Hermes compacted the session and Browser adopted the acknowledged successor when provided.'
          : 'This runtime could not recover the session automatically. Start a new session, then resend the preserved draft.';
        addMessage('system', `Session context reached its compression ceiling. ${recoveryDetail} ${replayDetail}`);
        return didSend;
      }
      if (error?.remoteDiagnostic && applyRemoteDiagnostic(error.remoteDiagnostic, { statusKind: 'error' })) {
        addMessage('system', `Hermes Browser Extension setup issue: ${error.remoteDiagnostic.detail} Open Settings → Support diagnostics → Copy Diagnostics and paste the redacted report if you need help.`);
        return didSend;
      }
      const requestFailure = turnRequestFailureState(error);
      if (requestFailure?.gatewayStatus === 'connected') {
        if (!turnOptions.preserveComposer && !els.input.value.trim() && !attachments.length) {
          els.input.value = userText;
          attachments = [...turnAttachments];
          renderAttachments();
          renderSkillSuggestions();
        }
        streamView.update(`${requestFailure.title}\n${requestFailure.detail}`);
        setStatus('error', requestFailure.title, `${requestFailure.detail} Gateway remains connected.`, {
          translateTitle: false,
          translateDetail: false,
        });
        return didSend;
      }
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
    if (turnRunControlGeneration === runControlGeneration) {
      activeRunControl = markRunStreamClosed(activeRunControl);
      if ([RUN_CONTROL_PHASES.RUNNING, RUN_CONTROL_PHASES.UNCONFIRMED].includes(activeRunControl?.phase)) {
        if (!activeRunId) {
          if (activeRunControl.phase === RUN_CONTROL_PHASES.RUNNING) activeRunControl = markRunTerminal(activeRunControl, 'failed');
        } else if (isRemoteWsMode() || gatewayCapabilities.runStatus) {
          try {
            await reconcileActiveRunTerminal({ stopRequested: false, expectedGeneration: turnRunControlGeneration });
          } catch (error) {
            if (runControlGenerationMatches(turnRunControlGeneration, runControlGeneration)) {
              activeRunControl = markTerminalTimeout(activeRunControl, error?.message || 'Runtime terminal confirmation timed out.');
              setStatus('warn', 'Runtime state unconfirmed', `The Browser stream closed before a terminal runtime state. Retry status from the recovery controls; the run identity and queued turns remain held: ${error?.message || String(error)}`, { translateDetail: false });
            }
          }
        } else {
          activeRunControl = markTerminalTimeout(activeRunControl, 'Connected Hermes runtime does not advertise terminal run status.');
          setStatus('warn', 'Runtime state unconfirmed', 'The Browser stream closed before a terminal event, and this runtime does not advertise run status. Update Hermes Agent or reconnect to a compatible runtime before starting another turn.', { translateDetail: false });
        }
      }
      if (activeRunControl?.phase === RUN_CONTROL_PHASES.TERMINAL && activeRunControl.writerLease === 'released') {
        await settleActiveRunTerminal();
      } else {
        updateComposerBusyState();
        renderContextWindow();
      }
      els.input.focus();
    }
  }
  return didSend;
}

let inlineDraftProcessing = false;

function inlineDraftPageKey(value = '') {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

async function sendInlineDraftResult(request, payload = {}) {
  if (!Number.isFinite(Number(request?.tabId))) return false;
  try {
    await browserApi.tabs.sendMessage(Number(request.tabId), {
      type: 'HERMES_INLINE_DRAFT_RESULT',
      requestId: request.requestId,
      documentId: request.documentId,
      ...payload,
    });
    return true;
  } catch (error) {
    console.warn('[Hermes Browser] Inline draft result delivery failed:', error);
    return false;
  }
}

async function createInlineBackgroundSession(request) {
  const id = makeBrowserSessionId();
  const adapterLabel = String(request.adapterId || 'Browser').replace(/(^|[-_\s])([a-z])/g, (_, lead, letter) => `${lead}${letter.toUpperCase()}`);
  const titleStamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const title = `Hermes Browser context · ${adapterLabel} · ${titleStamp} · ${id.slice(-4)}`;
  if (isRemoteWsMode()) {
    const connection = await ensureRemoteWsClient();
    const { liveId, storedId } = await establishGatewaySession({
      client: connection.client,
      createParams: {
        title,
        model: currentModelRequestId(),
        provider: currentModelProviderSlug() || undefined,
        reasoning_effort: normalizeReasoningEffort(settings.reasoningEffort),
        fast: normalizeFastMode(settings.fastMode),
      },
    });
    return { id: storedId, liveId, title, client: connection.client };
  }
  const response = await apiFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id,
      title,
      source: settings.sessionSource || DEFAULT_SETTINGS.sessionSource,
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      model_options: currentModelOptionsPayload(),
      system_prompt: currentHermesBrowserSystemPrompt(),
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok && response.status !== 409) {
    throw new Error(payload?.error?.message || payload?.error || `Could not create background session (${response.status})`);
  }
  const session = payload?.session || payload || {};
  return { id: String(session.id || id), title: String(session.title || title) };
}

async function runRemoteInlineBackground(session, prompt) {
  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const offs = [];
    const timer = globalThis.setTimeout(() => finish(reject, new Error('Background assist timed out.')), 5 * 60 * 1000);
    const forSession = (event) => event.sessionId === session.liveId;
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      offs.forEach((off) => off());
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    offs.push(session.client.on(WS_EVENTS.messageDelta, (event) => {
      if (forSession(event)) text += event.payload?.text || '';
    }));
    offs.push(session.client.on(WS_EVENTS.messageComplete, (event) => {
      if (!forSession(event)) return;
      finish(resolve, event.payload?.text || text);
    }));
    offs.push(session.client.on(WS_EVENTS.error, (event) => {
      if (!forSession(event)) return;
      finish(reject, new Error(event.payload?.message || 'Background assist failed.'));
    }));
    session.client.request(WS_METHODS.promptSubmit, { session_id: session.liveId, text: prompt }).catch((error) => finish(reject, error));
  });
}

async function runInlineDraftInBackground(request, resolvePrompt) {
  const session = await createInlineBackgroundSession(request);
  const prompt = typeof resolvePrompt === 'function'
    ? await resolvePrompt()
    : String(resolvePrompt || '');
  if (session.client) {
    const answer = await runRemoteInlineBackground(session, prompt);
    return { answer, session };
  }
  const response = await apiFetch(`/api/sessions/${encodeSessionId(session.id)}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: currentModelRequestId(),
      provider: currentModelProviderSlug() || undefined,
      model_options: currentModelOptionsPayload(),
      require_model_lock: shouldRequireModelLock({
        provider: currentModelProviderSlug(),
        model: currentModelRequestId(),
        defaultModel: DEFAULT_SETTINGS.model,
        gatewayDefault: currentSelectedModel()?.gatewayDefault === true,
      }),
      message: prompt,
      system_message: currentHermesBrowserSystemPrompt(),
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Background assist failed (${response.status})`);
  return { answer: extractAssistantText(payload), session };
}

async function runInlineDraftInCurrentSession(request) {
  await ensureHermesSession();
  const prompt = await resolveInlineDraftPrompt(request);
  const { policy, request: exactRouteRequest } = buildAssistModelRouteRequest(settings, gatewayCapabilities);
  const requestedSelection = policy.selection || policy.requestedSelection || null;
  let attemptSelection = policy.selection;
  let routeRequest = exactRouteRequest;
  let modelNotice = policy.mode === 'gateway-default-fallback'
    ? assistModelFallbackNotice(requestedSelection, 'this gateway does not advertise exact model routing')
    : '';

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await apiFetch(`/api/sessions/${encodeSessionId(settings.sessionId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({
        ...routeRequest,
        message: prompt,
        system_message: currentHermesBrowserSystemPrompt(),
      }),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      const reason = payload?.error?.message || payload?.error || `Hermes Assist failed (${response.status}).`;
      if (attemptSelection && attempt === 0) {
        modelNotice = assistModelFallbackNotice(attemptSelection, String(reason));
        attemptSelection = null;
        routeRequest = {};
        continue;
      }
      throw new Error(reason);
    }
    const answer = extractAssistantText(payload);
    try {
      assertAssistModelSelectionAcknowledged(payload, attemptSelection);
    } catch (modelError) {
      if (!answer) throw modelError;
      modelNotice = assistModelFallbackNotice(attemptSelection, 'the gateway returned the draft without acknowledging the selected model');
    }
    return { answer, modelNotice };
  }
  throw new Error('Hermes Assist could not complete the selected-model fallback.');
}

function inlineDraftRequestForEffectiveContext(request, source = settings) {
  const gate = effectiveContextGate(contextScope, source);
  if (gate.scope.mode !== CONTEXT_SCOPE_MODES.CHAT_ONLY) return request;
  return {
    ...request,
    pageContext: '',
    pageUrl: '',
    fieldLabel: '',
  };
}

async function resolveInlineDraftPrompt(request, source = settings) {
  const consentSettings = { ...source };
  const sendTimeSettings = await refreshContextConsentLedger(consentSettings);
  return buildInlineDraftPrompt(inlineDraftRequestForEffectiveContext(request, sendTimeSettings));
}

async function processInlineDraftRequest(rawRequest) {
  if (!rawRequest || inlineDraftProcessing) return false;
  const request = normalizeInlineDraftRequest(rawRequest);
  const tabId = Number(rawRequest?.tabId);
  const expiresAt = Number(rawRequest?.expiresAt);
  if (!request || !Number.isFinite(tabId) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await browserApi.storage.session.remove(INLINE_DRAFT_STORAGE_KEY);
    return false;
  }
  if (isAttachedPanelResidency() && Number(sidePanelParams.tabId) !== tabId) return false;
  if (sending) {
    globalThis.setTimeout(() => consumePendingInlineDraftRequest(), 750);
    return false;
  }
  const tab = await browserApi.tabs.get(tabId).catch(() => null);
  if (!tab || inlineDraftPageKey(tab.url || tab.pendingUrl) !== inlineDraftPageKey(request.pageUrl)) {
    await browserApi.storage.session.remove(INLINE_DRAFT_STORAGE_KEY);
    await sendInlineDraftResult({ ...request, tabId }, { ok: false, reason: 'The originating page changed before Hermes could draft.' });
    return false;
  }

  inlineDraftProcessing = true;
  await browserApi.storage.session.remove(INLINE_DRAFT_STORAGE_KEY);
  let resultSent = false;
  try {
    if (request.route === INLINE_DRAFT_ROUTES.BACKGROUND) {
      const { answer, session } = await runInlineDraftInBackground(request, () => resolveInlineDraftPrompt(request));
      const text = sanitizeInlineDraftResult(answer);
      resultSent = await sendInlineDraftResult({ ...request, tabId }, { ok: true, text, sessionId: session.id, sessionTitle: session.title });
      await loadSessions({ quiet: true });
      return resultSent;
    }
    if (request.route === INLINE_DRAFT_ROUTES.CURRENT && !isRemoteWsMode()) {
      const { answer, modelNotice } = await runInlineDraftInCurrentSession(request);
      const text = sanitizeInlineDraftResult(answer);
      resultSent = await sendInlineDraftResult({ ...request, tabId }, {
        ok: true,
        text,
        sessionId: String(settings.sessionId || ''),
        sessionTitle: String(settings.sessionTitle || 'Inline assist'),
        modelNotice,
      });
      await loadSessions({ quiet: true });
      return resultSent;
    }
    if (request.route === INLINE_DRAFT_ROUTES.NEW) {
      await beginHermesBrowserDraft({ title: `Inline assist · ${request.adapterId || 'Browser'}`, focus: false });
    }
    const inlineAssistRoute = buildAssistModelRouteRequest(settings, gatewayCapabilities).policy;
    const inlineAssistModelNotice = inlineAssistRoute.mode === 'gateway-default-fallback'
      ? assistModelFallbackNotice(
        inlineAssistRoute.requestedSelection,
        isRemoteWsMode()
          ? 'dashboard transport uses the gateway-selected runtime model'
          : 'this gateway does not advertise exact model routing',
      )
      : '';
    const inlineSessionId = String(settings.sessionId || '');
    const inlineSessionTitle = String(settings.sessionTitle || 'Inline assist');
    const prompt = await resolveInlineDraftPrompt(request);
    const didSend = await askHermes(prompt, [], {
      forceChatOnly: true,
      resolveUserText: () => resolveInlineDraftPrompt(request),
      preserveComposer: true,
      disableCommandParsing: true,
      disableAutoTitle: true,
      displayUserText: `Inline draft · ${request.actionLabel}`,
      onComplete: async (answer) => {
        const text = sanitizeInlineDraftResult(answer);
        resultSent = await sendInlineDraftResult({ ...request, tabId }, {
          ok: true,
          text,
          sessionId: inlineSessionId,
          sessionTitle: inlineSessionTitle,
          modelNotice: inlineAssistModelNotice,
        });
      },
    });
    if (!didSend && !resultSent) {
      await sendInlineDraftResult({ ...request, tabId }, { ok: false, reason: 'Hermes is not connected or the selected session cannot accept this draft.' });
    }
    return didSend;
  } catch (error) {
    await sendInlineDraftResult({ ...request, tabId }, { ok: false, reason: error?.message || String(error) });
    return false;
  } finally {
    inlineDraftProcessing = false;
  }
}

async function consumePendingInlineDraftRequest() {
  if (!browserApi.storage?.session || inlineDraftProcessing) return false;
  const stored = await browserApi.storage.session.get(INLINE_DRAFT_STORAGE_KEY);
  return processInlineDraftRequest(stored?.[INLINE_DRAFT_STORAGE_KEY]);
}

function normalizeContextMenuRoute(value = '') {
  const route = String(value || '').trim().toLowerCase();
  return ['ask', 'current', 'new', 'background'].includes(route) ? route : 'ask';
}

function contextMenuTurnForEffectiveContext(turn, source = settings) {
  const gate = effectiveContextGate(turn?.context?.contextScope || contextScope, source);
  if (gate.scope.mode !== CONTEXT_SCOPE_MODES.CHAT_ONLY) return turn;
  return {
    ...turn,
    context: {
      ...turn.context,
      activeTab: null,
      tabs: [],
      selectedTabs: [],
      pageContext: null,
      contextScope: gate.scope,
      settingsOverride: {
        ...turn.context.settingsOverride,
        includePageText: false,
        includeSelectedText: false,
        includeTabs: false,
      },
    },
  };
}

async function prepareContextMenuTurn(rawRequest) {
  const request = normalizeContextMenuRequest(rawRequest);
  if (!request) return null;
  const tab = await browserApi.tabs.get(request.tabId).catch(() => null);
  if (!tab || !await contextMenuRequestMatchesTab(request, tab)) return null;
  const initialTurn = await buildContextMenuTurn({ request, tab });
  if (!initialTurn) return null;
  const gate = effectiveContextGate(initialTurn.context?.contextScope || contextScope);
  const capturedPageContext = initialTurn.capturePage && gate.scope.mode !== CONTEXT_SCOPE_MODES.CHAT_ONLY
    ? await getPageContext(tab, {
      frameId: request.frameId,
      selectedTextOverride: request.selection,
    })
    : null;
  const preparedTurn = await buildContextMenuTurn({ request, tab, capturedPageContext });
  return contextMenuTurnForEffectiveContext(preparedTurn);
}

function serializePreparedContextMenuTurn(turn, browserControl) {
  const contextSettings = { ...settings, ...(turn.context.settingsOverride || {}) };
  const contextHash = browserContextPayloadHash({
    activeTab: turn.context.activeTab,
    selectedTabs: turn.context.selectedTabs,
    pageContext: turn.context.pageContext,
    settings: contextSettings,
  });
  return serializeBrowserTurnEnvelope({
    humanInput: turn.humanInput,
    activeTab: turn.context.activeTab,
    tabs: turn.context.tabs,
    selectedTabs: turn.context.selectedTabs,
    pageContext: turn.context.pageContext,
    contextScope: turn.context.contextScope,
    attachments: turn.attachments,
    settings: contextSettings,
    contextHash,
    contextDelivery: CONTEXT_DELIVERY_MODES.FULL,
    browserControl,
  });
}

async function executeContextMenuRequest(request, requestedRoute) {
  const turn = await prepareContextMenuTurn(request);
  if (!turn) throw new Error('The page changed before Hermes could start the right-click task.');
  const userText = turn.humanInput;
  let route = normalizeContextMenuRoute(requestedRoute);
  if (route === 'ask') route = settings.sessionId ? 'current' : 'new';
  if (route === 'current' && !settings.sessionId) route = 'new';
  if (route === 'new') {
    await beginHermesBrowserDraft({ title: makeBrowserSessionTitle(), focus: false });
  }
  if (route === 'background') {
    const consentSettings = { ...settings };
    const { session } = await runInlineDraftInBackground(
      { adapterId: 'right-click', tabId: request.tabId, frameId: request.frameId },
      async () => {
        const browserControl = await resolveBrowserControlForTurn({
          context: turn.context,
          scope: turn.context.contextScope,
        });
        const sendTimeSettings = await refreshContextConsentLedger(consentSettings);
        const sendTimeTurn = contextMenuTurnForEffectiveContext(turn, sendTimeSettings);
        return serializePreparedContextMenuTurn(sendTimeTurn, browserControl);
      },
    );
    await loadSessions({ quiet: true });
    const completed = availableSessions.find((item) => item.id === session.id) || { id: session.id, title: session.title, source: DEFAULT_SETTINGS.sessionSource };
    await openHermesSession(completed);
    showOperationToast({ title: 'Right-click task complete', detail: session.title });
    return true;
  }
  els.input.value = '';
  const sent = await askHermes(userText, turn.attachments, {
    contextOverride: turn.context,
    forceFullContext: true,
    preserveComposer: true,
    disableCommandParsing: true,
    displayUserText: `Right-click task · ${String(request.prompt || '').replace(/:$/, '')}`,
  });
  if (!sent) throw new Error('Hermes could not start the right-click task.');
  return true;
}

function showContextMenuRouteNotice(request) {
  pendingContextMenuRequest = request;
  if (!els.contextMenuRouteNotice) return;
  if (els.contextMenuRememberRoute) els.contextMenuRememberRoute.checked = false;
  els.contextMenuRouteNotice.hidden = false;
  els.contextMenuRouteNotice.querySelector('[data-context-menu-route="current"]')?.focus();
}

async function handleContextMenuRouteChoice(event) {
  const button = event.target.closest('[data-context-menu-route]');
  if (!button || !pendingContextMenuRequest) return;
  const request = pendingContextMenuRequest;
  const route = normalizeContextMenuRoute(button.dataset.contextMenuRoute);
  pendingContextMenuRequest = null;
  els.contextMenuRouteNotice.hidden = true;
  if (els.contextMenuRememberRoute?.checked) {
    settings.contextMenuDefaultRoute = route;
    if (els.contextMenuDefaultRoute) els.contextMenuDefaultRoute.value = route;
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
  }
  await executeContextMenuRequest(request, route);
}

async function consumePendingContextMenuRequest() {
  if (!browserApi.runtime?.sendMessage) return false;
  const claim = await browserApi.runtime.sendMessage({
    type: CONTEXT_MENU_REQUEST_CLAIM,
    sourceTabId: isAttachedPanelResidency() ? Number(sidePanelParams.tabId) : null,
  }).catch(() => null);
  const request = claim?.request;
  if (!request) return false;
  const normalizedRequest = normalizeContextMenuRequest(request);
  if (!normalizedRequest) return false;
  const route = normalizeContextMenuRoute(normalizedRequest.route || settings.contextMenuDefaultRoute);
  if (route === 'ask') {
    showContextMenuRouteNotice(normalizedRequest);
    return true;
  }
  await executeContextMenuRequest(normalizedRequest, route);
  return true;
}

async function consumePendingOpenSessionRequest() {
  if (!browserApi.storage?.session) return false;
  const stored = await browserApi.storage.session.get(OPEN_SESSION_STORAGE_KEY);
  const request = stored?.[OPEN_SESSION_STORAGE_KEY];
  if (!request) return false;
  await browserApi.storage.session.remove(OPEN_SESSION_STORAGE_KEY);
  if (Number(request.expiresAt || 0) <= Date.now()) return false;
  const sessionId = String(request.sessionId || '').trim();
  if (!sessionId) return false;
  await loadSessions({ quiet: true });
  const session = availableSessions.find((item) => item.id === sessionId) || { id: sessionId, title: `Inline assist · ${sessionId.slice(-8)}` };
  await openHermesSession(session);
  return true;
}

let testConnectionFlashTimer = null;

function connectionTestButtons() {
  return [els.testConnectionButton, els.startupTestConnectionButton].filter(Boolean);
}

function setTestConnectionButtonLabel(label) {
  for (const button of connectionTestButtons()) {
    const target = button.querySelector('.settings-connection-test-label');
    const nextLabel = button === els.startupTestConnectionButton && label === 'TEST'
      ? 'TEST CONNECTION'
      : label;
    if (target) target.textContent = nextLabel;
    else button.textContent = nextLabel;
  }
}

function setTestConnectionBusy(busy) {
  for (const button of connectionTestButtons()) {
    button.disabled = Boolean(busy);
    button.classList.toggle('is-testing', Boolean(busy));
    button.setAttribute('aria-busy', String(Boolean(busy)));
  }
  if (busy) setTestConnectionButtonLabel('TESTING');
}

function flashTestConnectionResult(ok) {
  clearTimeout(testConnectionFlashTimer);
  for (const button of connectionTestButtons()) {
    button.classList.remove('is-testing', 'success', 'error');
    button.classList.add(ok ? 'success' : 'error');
    button.setAttribute('aria-busy', 'false');
  }
  setTestConnectionButtonLabel(ok ? 'ONLINE' : 'FAILED');
  testConnectionFlashTimer = setTimeout(() => {
    for (const button of connectionTestButtons()) button.classList.remove('success', 'error');
    setTestConnectionButtonLabel('TEST');
  }, 2600);
}

async function testConnection() {
  clearTimeout(testConnectionFlashTimer);
  for (const button of connectionTestButtons()) button.classList.remove('success', 'error');
  setTestConnectionBusy(true);
  try {
    await saveSettingsFromForm();
  } catch (error) {
    setTestConnectionBusy(false);
    flashTestConnectionResult(false);
    throw error;
  }
  const action = connectionActionForSettings(settings);
  if (action === CONNECTION_ACTIONS.CLOUD_ACTIVE_TAB_ATTACH || action === CONNECTION_ACTIONS.REMOTE_DASHBOARD_ATTACH) {
    let connected = false;
    try {
      await connectTicketTransport({ cloud: action === CONNECTION_ACTIONS.CLOUD_ACTIVE_TAB_ATTACH });
      connected = isConnected();
    } finally {
      setTestConnectionBusy(false);
      flashTestConnectionResult(connected);
    }
    return;
  }
  const generation = connectionController.begin({
    mode: normalizeConnectionMode(settings.connectionMode),
    transport: settings.connectionTransport,
  });
  markConnectionProbe('connecting', normalizeGatewayUrl(settings.gatewayUrl));
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
        modelNote = availableModels.length ? `  ${availableModels.length} models` : '';
      } catch {
        // model.options shape varies across gateways; the socket is already proven.
      }
      // First-party profile discovery runs inside the signed-in dashboard tab.
      await loadProfiles({ quiet: true });
      updateConnectionPrompt();
      markGatewayReachable(`${normalizeGatewayUrl(settings.gatewayUrl)}${modelNote}`);
      lastRemoteDiagnostic = null;
      renderRemoteDiagnostics(null);
      setStatus('ok', 'Remote Hermes dashboard connected', `${normalizeGatewayUrl(settings.gatewayUrl)}${modelNote}`);
      settings = { ...settings, lastConnectionTestedAt: Date.now() };
      await browserApi.storage.local.set({ hermesBrowserSettings: settings });
      renderConnectionSecurity();
      ok = true;
      return;
    }
    const response = await apiFetch('/health', { method: 'GET' });
    const text = await response.text();
    if (!connectionController.isCurrent(generation)) return;
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
    if (!connectionController.isCurrent(generation)) return;
    if (!apiCredentialSatisfied(settings) && gatewayCapabilities.browserPairing && automaticApiPairingAllowed(settings)) {
      await connectApiWithPairing();
      if (!connectionController.isCurrent(generation)) return;
      if (!apiCredentialSatisfied(settings)) {
        throw new Error('Pairing was not completed. Approve the Hermes Browser request in the opened tab, then test again.');
      }
      await loadGatewayCapabilities({ quiet: true, healthOk: true });
    }

    const modelsResponse = await apiFetch('/v1/models', { method: 'GET' });
    const modelsPayload = await readJsonResponse(modelsResponse);
    if (!connectionController.isCurrent(generation)) return;
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
    if (!connectionController.isCurrent(generation)) return;
    if (degradedDiagnostic) {
      connectionController.transition(generation, CONNECTION_STATES.DEGRADED, { errorKind: degradedDiagnostic.kind });
      setStatus('warn', 'Hermes gateway connected with runtime warning', degradedDiagnostic.detail);
      markGatewayDegraded(degradedDiagnostic.detail);
    } else {
      if (!connectionController.transition(generation, CONNECTION_STATES.READY, { gateway: 'api' })) return;
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
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    renderConnectionSecurity();

    ok = true;
  } catch (error) {
    const diagnostic = classifyGatewayError(error);
    if (!connectionController.transition(generation, CONNECTION_STATES.ERROR, { errorKind: diagnostic.kind })) return;
    if (error?.remoteDiagnostic && applyRemoteDiagnostic(error.remoteDiagnostic, { statusKind: 'error' })) {
      return;
    }
    markGatewayUnreachable(error);
    if (isRemoteMode()) {
      const diagnostic = classifyRemoteGatewaySetup({
        url: settings.gatewayUrl,
        error: error?.message || String(error),
      });
      if (diagnostic.kind !== 'unknown') {
        applyRemoteDiagnostic(diagnostic, { statusKind: 'error' });
      } else {
        setStatus('error', 'Hermes gateway test failed', currentConnectionTroubleshooting() || error?.message || String(error), { translateDetail: false });
      }
    } else {
      setStatus('error', 'Hermes gateway test failed', currentConnectionTroubleshooting() || error?.message || String(error), { translateDetail: false });
    }
  } finally {
    if (connectionController.isCurrent(generation)) {
      setTestConnectionBusy(false);
      flashTestConnectionResult(ok);
    }
  }
}

function closeFloatingPanels() {
  els.modelMenu.hidden = true;
  els.modelMenuButton.setAttribute('aria-expanded', 'false');
  els.inlineAssistModelButton?.setAttribute('aria-expanded', 'false');
  els.sessionMenu.hidden = true;
  els.sessionMenuButton.setAttribute('aria-expanded', 'false');
  els.attachMenu.hidden = true;
  els.attachMenuButton.setAttribute('aria-expanded', 'false');
  if (els.skillMenu) els.skillMenu.hidden = true;
  els.contextPopover.hidden = true;
  els.contextBarButton.setAttribute('aria-expanded', 'false');
}

function updateDockFloatingAnchor() {
  if (!els.bottomDock) return;
  const rect = els.bottomDock.getBoundingClientRect();
  const viewportHeight = globalThis.innerHeight || document.documentElement.clientHeight || rect.bottom || 0;
  const dockHeight = Math.max(0, Math.round(viewportHeight - rect.top));
  document.documentElement.style.setProperty('--hermes-bottom-dock-height', `${dockHeight}px`);
}

function portalDockFloatingPanels() {
  const parent = els.shell || document.body;
  for (const panel of [els.modelMenu, els.contextPopover]) {
    if (panel && panel.parentElement !== parent) parent.appendChild(panel);
  }
  updateDockFloatingAnchor();
}

function observeDockFloatingAnchor() {
  updateDockFloatingAnchor();
  globalThis.addEventListener?.('resize', () => {
    updateDockFloatingAnchor();
    if (!els.modelMenu?.hidden && modelSelectionTarget === 'assist') positionAssistModelMenu();
  });
  if (!bottomDockResizeObserver && typeof globalThis.ResizeObserver === 'function' && els.bottomDock) {
    bottomDockResizeObserver = new globalThis.ResizeObserver(updateDockFloatingAnchor);
    bottomDockResizeObserver.observe(els.bottomDock);
  }
}

function eventPathContains(event, node) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path.includes(node) || node.contains(event.target);
}

function bindEvents() {
  portalDockFloatingPanels();
  observeDockFloatingAnchor();
  els.messages?.addEventListener('copy', (event) => {
    writeAssistantClipboardEvent(event, {
      selection: globalThis.getSelection?.(),
      messagesRoot: els.messages,
      document,
      assistantSelector: '.message.assistant',
    });
  });
  window.addEventListener('resize', positionOperationToast);
  els.settingsButton.addEventListener('click', openSettingsDialog);
  els.languageSelect?.addEventListener('change', () => {
    setLocale(els.languageSelect.value).catch((error) => {
      console.warn('[Hermes Browser] Language change failed:', error);
    });
  });
  els.startupTestConnectionButton?.addEventListener('click', testConnection);
  els.taskStackToggle?.addEventListener('click', () => {
    taskStackExpanded = !taskStackExpanded;
    renderTaskStack();
  });
  els.openFullViewButton?.addEventListener('click', () => {
    openFullView().catch((error) => setStatus('warn', 'Could not open full view', error?.message || String(error), { translateDetail: false }));
  });
  els.manualSettingsButton.addEventListener('click', openSettingsDialog);
  [els.modelMenu, els.sessionMenu, els.contextPopover, els.attachMenu, els.skillMenu].filter(Boolean).forEach((panel) => {
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('pointerdown', (event) => event.stopPropagation());
  });
  els.connectButton.addEventListener('click', connectToHermes);
  els.startupConnectButton?.addEventListener('click', () => {
    connectToHermes().catch((error) => {
      setStatus('warn', 'Connect failed', error?.message || String(error), { translateDetail: false });
    });
  });
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
      await persistBrowserIntroSeen();
      await beginHermesBrowserDraft();
      await loadSessions({ quiet: true });
      setStatus('ok', 'New Hermes Browser Extension draft', 'Saved when you send the first message.');
    } catch (error) {
      setStatus('error', 'Could not create session', error?.message || String(error), { translateDetail: false });
    }
  });
  els.createSessionButton.addEventListener('click', async () => {
    try {
      await persistBrowserIntroSeen();
      await beginHermesBrowserDraft();
      els.sessionMenu.hidden = true;
      els.sessionMenuButton.setAttribute('aria-expanded', 'false');
      await loadSessions({ quiet: true });
    } catch (error) {
      setStatus('error', 'Could not create session', error?.message || String(error), { translateDetail: false });
    }
  });
  els.refreshSessionsButton.addEventListener('click', refreshSessionsFromMenu);
  els.sessionSearchInput.addEventListener('input', () => renderSessionMenu(els.sessionSearchInput.value));
  els.closeSettingsButton.addEventListener('click', closeSettingsDialog);
  els.messages.addEventListener('click', (event) => {
    const image = event.target?.closest?.('.generated-image-inspectable')?.querySelector?.('img[data-slot="aui_generated-image"]')
      || event.target?.closest?.('img[data-slot="aui_generated-image"]');
    if (!image) return;
    openGeneratedImageLightbox(image);
  });
  els.copyRemoteEnvButton?.addEventListener('click', async () => {
    const text = els.remoteEnvBlock?.textContent || remoteEnvBlockText();
    try {
      await navigator.clipboard.writeText(text);
      setStatus('ok', 'Remote env copied', 'Paste this into the Hermes API-server environment on the remote machine.');
    } catch (error) {
      setStatus('warn', 'Could not copy env block', error?.message || String(error), { translateDetail: false });
    }
  });
  els.settingsDialog.addEventListener('click', (event) => {
    if (event.target === els.settingsDialog) closeSettingsDialog();
  });
  els.updateDialog?.addEventListener('click', (event) => {
    if (event.target === els.updateDialog) closeUpdateDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (document.querySelector('.generated-image-lightbox')) {
        closeGeneratedImageLightbox();
        return;
      }
      if (!els.updateDialog?.hidden) {
        closeUpdateDialog();
        return;
      }
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
    refreshContextWithSpin().catch((error) => setStatus('warn', 'Context refresh unavailable', error?.message || String(error), { translateDetail: false }));
  });
  els.explicitSiteCaptureButton?.addEventListener('click', async () => {
    try {
      const refreshed = await refreshContextWithSpin({ explicitSiteCapture: true });
      const pageContext = refreshed?.pageContext;
      const adapter = pageContext?.meta?.siteAdapter;
      if (adapter?.id === 'gmail' && adapter?.suppressed === false && String(pageContext?.text || '').trim()) {
        setStatus('ok', 'Gmail thread captured', 'Rendered message bodies will be attached to the next Hermes turn.');
        showOperationToast({
          kind: 'ok',
          title: 'Gmail thread captured',
          detail: 'Draft and input values stayed excluded.',
        });
        return;
      }
      setStatus('warn', 'Gmail thread capture unavailable', pageContext?.error || t('status.gmail_no_rendered'), { translateDetail: false });
    } catch (error) {
      setStatus('warn', 'Gmail thread capture unavailable', error?.message || String(error), { translateDetail: false });
    }
  });
  els.stopButton?.addEventListener('click', stopCurrentTurn);
  els.retryRunStatusButton?.addEventListener('click', () => { void retryActiveRunTerminalStatus(); });
  els.discardHeldQueueButton?.addEventListener('click', discardHeldQueuedTurn);
  browserApi.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === ELEMENT_PICK_MESSAGES.RESULT) {
      applyPickedElementResult(message, sender);
      return;
    }
    if (message?.type === ELEMENT_PICK_MESSAGES.CANCELLED) {
      clearElementPickState({ tabId: sender?.tab?.id || currentContext?.activeTab?.id });
      setStatus('ok', 'Element pick cancelled', '');
    }
  });
  browserApi.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName === 'local' && changes?.[TASK_STACKS_STORAGE_KEY]) {
      taskStackStore = changes[TASK_STACKS_STORAGE_KEY].newValue && typeof changes[TASK_STACKS_STORAGE_KEY].newValue === 'object'
        ? changes[TASK_STACKS_STORAGE_KEY].newValue
        : {};
      renderTaskStack();
      return;
    }
    if (!isSessionStorageArea(areaName)) return;
    const inlineDraftChange = changes?.[INLINE_DRAFT_STORAGE_KEY];
    if (inlineDraftChange?.newValue) {
      processInlineDraftRequest(inlineDraftChange.newValue).catch((error) => {
        console.warn('[Hermes Browser] Inline draft handoff failed:', error);
      });
    }
    if (changes?.[CONTEXT_MENU_STORAGE_KEY]?.newValue) {
      consumePendingContextMenuRequest().catch((error) => console.warn('[Hermes Browser] Context-menu handoff failed:', error));
    }
    if (changes?.[OPEN_SESSION_STORAGE_KEY]?.newValue) {
      consumePendingOpenSessionRequest().catch((error) => console.warn('[Hermes Browser] Inline session open failed:', error));
    }
    const pickStateChange = changes?.[PICK_STATE_STORAGE_NAME];
    if (pickStateChange) applyElementPickState(pickStateChange.newValue || null);
  });
  browserApi.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
    if (changeInfo?.url) clearPickedElementForTab(tabId, { silent: true });
  });
  browserApi.tabs?.onRemoved?.addListener?.((tabId) => {
    clearPickedElementForTab(tabId, { silent: true });
  });
  els.queueButton?.addEventListener('click', queueCurrentDraft);
  els.steerButton?.addEventListener('click', () => { steerCurrentDraft(); });
  els.queueNotice?.addEventListener('click', (event) => {
    const action = event.target?.closest?.('[data-queued-action]')?.dataset?.queuedAction;
    if (action === 'delete') deleteQueuedTurn();
    if (action === 'steer') steerQueuedTurn();
  });
  els.wakeButton?.addEventListener('click', () => {
    setWakeWordEnabled(!(wakeState.enabled || settings.wakeWordEnabled)).catch((error) => {
      setStatus('warn', 'Wake word unavailable', error?.message || String(error), { translateDetail: false });
      refreshWakeState();
    });
  });
  els.voiceButton?.addEventListener('click', toggleVoiceDictation);
  els.checkUpdatesButton?.addEventListener('click', () => checkForUpdates());
  els.reviewUpdateButton?.addEventListener('click', () => checkForUpdates({ openReview: true }));
  els.closeUpdateDialogButton?.addEventListener('click', () => closeUpdateDialog());
  els.maybeLaterButton?.addEventListener('click', () => closeUpdateDialog());
  els.updateNowButton?.addEventListener('click', launchBrowserUpdateWithHermes);
  els.closeOperationToastButton?.addEventListener('click', hideOperationToast);
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
    }).then(() => loadAgents()).catch((error) => setStatus('warn', 'Agent settings invalid', error?.message || String(error), { translateDetail: false }));
  });
  els.agentPortsInput?.addEventListener('change', () => {
    const ports = parseAgentPortsInput(els.agentPortsInput.value);
    if (ports.length) {
      persistAgentDiscoverySettings({ ports }).catch((error) => setStatus('warn', 'Agent ports invalid', error?.message || String(error), { translateDetail: false }));
    }
  });
  els.agentHostInput?.addEventListener('change', () => {
    persistAgentDiscoverySettings({ host: els.agentHostInput.value }).catch((error) => setStatus('warn', 'Agent host invalid', error?.message || String(error), { translateDetail: false }));
  });
  els.agentSchemeInput?.addEventListener('change', () => {
    persistAgentDiscoverySettings({ scheme: els.agentSchemeInput.value }).catch((error) => setStatus('warn', 'Agent scheme invalid', error?.message || String(error), { translateDetail: false }));
  });
  els.editModelsButton.addEventListener('click', () => {
    closeFloatingPanels();
    openSettingsDialog();
    setStatus('warn', 'Edit models in Hermes Desktop', 'Use Hermes Desktop model settings or the Hermes model command, then Refresh Models here.');
  });
  els.contextMenuRouteNotice?.addEventListener('click', (event) => {
    handleContextMenuRouteChoice(event).catch((error) => setStatus('error', 'Right-click task failed', error?.message || String(error), { translateDetail: false }));
  });
  els.modelMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextHidden = !els.modelMenu.hidden;
    closeFloatingPanels();
    updateDockFloatingAnchor();
    if (nextHidden) return;
    setModelSelectionTarget('chat');
    els.modelMenu.hidden = false;
    els.modelMenuButton.setAttribute('aria-expanded', 'true');
    els.modelSearchInput.focus();
  });
  els.inlineAssistModelButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    const nextHidden = !els.modelMenu.hidden && modelSelectionTarget === 'assist';
    closeFloatingPanels();
    if (nextHidden) return;
    setModelSelectionTarget('assist');
    els.modelMenu.hidden = false;
    positionAssistModelMenu();
    els.inlineAssistModelButton.setAttribute('aria-expanded', 'true');
    els.modelSearchInput.focus();
  });
  els.modelMenuCloseButton?.addEventListener('click', () => {
    const focusTarget = modelSelectionTarget === 'assist' ? els.inlineAssistModelButton : els.modelMenuButton;
    closeFloatingPanels();
    focusTarget?.focus();
  });
  els.modelOptionsList.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle]');
    const effort = event.target.closest('[data-effort]');
    if (modelSelectionTarget === 'assist') {
      if (toggle?.dataset.toggle === 'thinking') settings.inlineAssistThinkingEnabled = settings.inlineAssistThinkingEnabled === false;
      if (toggle?.dataset.toggle === 'fast') settings.inlineAssistFastMode = !normalizeFastMode(settings.inlineAssistFastMode);
      if (effort) settings.inlineAssistReasoningEffort = normalizeReasoningEffort(effort.dataset.effort);
      if (!toggle && !effort) return;
      renderModelRuntimeOptions();
      browserApi.storage.local.set({ hermesBrowserSettings: settings });
      return;
    }
    if (toggle) {
      const key = toggle.dataset.toggle;
      if (key === 'thinking') setModelRuntimeOption('thinkingEnabled', settings.thinkingEnabled === false);
      if (key === 'fast') setModelRuntimeOption('fastMode', !normalizeFastMode(settings.fastMode));
      return;
    }
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
      if (kind === 'pick-element') {
        els.attachMenu.hidden = true;
        els.attachMenuButton.setAttribute('aria-expanded', 'false');
        await startElementPick();
        return;
      }
      if (kind === 'clear-pick') {
        clearPickedElementForActiveTab();
        return;
      }
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
    updateDockFloatingAnchor();
    els.contextPopover.hidden = nextHidden;
    els.contextBarButton.setAttribute('aria-expanded', String(!nextHidden));
  });
  els.contextCompactButton?.addEventListener('click', () => {
    compactCurrentSessionContext().catch((error) => setStatus('warn', 'Context compaction failed', error?.message || String(error), { translateDetail: false }));
  });
  els.testConnectionButton.addEventListener('click', testConnection);
  els.copyDiagnosticsButton?.addEventListener('click', () => {
    copySupportDiagnostics().catch((error) => setStatus('warn', 'Diagnostics copy failed', error?.message || String(error), { translateDetail: false }));
  });
  els.statusCopyDiagnosticsButton?.addEventListener('click', () => {
    copySupportDiagnostics().catch((error) => setStatus('warn', 'Diagnostics copy failed', error?.message || String(error), { translateDetail: false }));
  });
  els.clearTokenButton?.addEventListener('click', () => {
    clearStoredToken().catch((error) => setStatus('warn', 'Could not clear token', error?.message || String(error), { translateDetail: false }));
  });
  els.browserContextConsentInput?.addEventListener('change', () => {
    setBrowserContextConsent(els.browserContextConsentInput.checked).catch((error) => {
      renderBrowserContextConsentControl();
      setStatus('warn', 'Context sharing unchanged', error?.message || String(error), { translateDetail: false });
    });
  });
  els.browserControlEnableButton?.addEventListener('click', async () => {
    els.browserControlEnableButton.disabled = true;
    try {
      await enableBrowserControl();
    } catch (error) {
      showOperationToast({ kind: 'warn', title: 'Control not enabled', detail: error?.message || String(error) });
    } finally {
      els.browserControlEnableButton.disabled = false;
      renderBrowserControl();
    }
  });
  els.browserControlAttachButton?.addEventListener('click', async () => {
    if (els.browserControlAttachButton.dataset.mode === 'detach') {
      detachBrowserControl().catch((error) => showOperationToast({ kind: 'warn', title: 'Detach incomplete', detail: error?.message || String(error) }));
      return;
    }
    els.browserControlAttachButton.disabled = true;
    try {
      await attachBrowserControlToCurrentTab();
    } catch (error) {
      showOperationToast({ kind: 'warn', title: 'Control not attached', detail: error?.message || String(error) });
    } finally {
      els.browserControlAttachButton.disabled = false;
      renderBrowserControl();
    }
  });
  els.browserControlDetachButton?.addEventListener('click', () => {
    detachBrowserControl().catch((error) => showOperationToast({ kind: 'warn', title: 'Detach incomplete', detail: error?.message || String(error) }));
  });
  els.browserControlDismissButton?.addEventListener('click', () => {
    detachBrowserControl().catch((error) => showOperationToast({ kind: 'warn', title: 'Detach incomplete', detail: error?.message || String(error) }));
  });
  els.browserIntroDismissButton?.addEventListener('click', () => {
    persistBrowserIntroSeen();
  });
  els.browserControlScopeInput?.addEventListener('change', () => {
    if (settings.browserControlEnabled === true) {
      renderBrowserControl();
      return;
    }
    persistBrowserControlPreferences({ browserControlScope: els.browserControlScopeInput.value })
      .then(renderBrowserControl)
      .catch((error) => showOperationToast({ kind: 'warn', title: 'Scope unchanged', detail: error?.message || String(error) }));
  });
  els.browserControlStayButton?.addEventListener('click', () => {
    setBrowserControlViewBehavior('stay').catch((error) => showOperationToast({ kind: 'warn', title: 'View unchanged', detail: error?.message || String(error) }));
  });
  els.browserControlFollowButton?.addEventListener('click', () => {
    setBrowserControlViewBehavior('follow').catch((error) => showOperationToast({ kind: 'warn', title: 'View unchanged', detail: error?.message || String(error) }));
  });
  els.browserControlPauseButton?.addEventListener('click', () => {
    toggleBrowserControlPause().catch((error) => showOperationToast({ kind: 'warn', title: 'Control state unchanged', detail: error?.message || String(error) }));
  });
  els.browserControlStopButton?.addEventListener('click', () => {
    browserControlMessage('HERMES_CONTROLLER_STOP')
      .then(() => refreshBrowserControlStatus())
      .catch((error) => showOperationToast({ kind: 'warn', title: 'Stop failed', detail: error?.message || String(error) }));
  });
  els.browserControlApproveButton?.addEventListener('click', () => {
    decideBrowserControlApproval(true).catch((error) => showOperationToast({ kind: 'warn', title: 'Approval not accepted', detail: error?.message || String(error) }));
  });
  els.browserControlRejectButton?.addEventListener('click', () => {
    decideBrowserControlApproval(false).catch((error) => showOperationToast({ kind: 'warn', title: 'Rejection not accepted', detail: error?.message || String(error) }));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (browserControlPollTimer) clearTimeout(browserControlPollTimer);
      browserControlPollTimer = null;
      return;
    }
    void refreshBrowserControlStatus().then(scheduleBrowserControlPoll);
  });
  els.gatewayModeInput?.addEventListener('change', () => {
    const summary = currentGatewaySummary({ gatewayMode: els.gatewayModeInput.value, gatewayUrl: els.gatewayUrlInput.value });
    if (!els.gatewayUrlInput.value.trim() || els.gatewayUrlInput.value.trim() === DEFAULT_SETTINGS.gatewayUrl) {
      els.gatewayUrlInput.value = summary.mode.defaultUrl || DEFAULT_SETTINGS.gatewayUrl;
    }
    renderGatewayHelp();
    renderAgentDiscoveryAvailability();
  });
  els.gatewayUrlInput?.addEventListener('input', renderGatewayHelp);
  for (const card of document.querySelectorAll('[data-connection-mode]')) {
    card.addEventListener('click', () => {
      applyConnectionMode(card.dataset.connectionMode);
    });
  }
  // Phase A preserves the legacy Remote adapter: key present means API server,
  // blank means dashboard WebSocket. Phase C replaces this with explicit probe UI.
  els.apiKeyInput?.addEventListener('input', () => {
    if (normalizeConnectionMode(els.connectionModeInput?.value) === 'remote') {
      applyConnectionMode('remote');
    }
  });
  for (const button of els.colorModeButtons || []) {
    button.addEventListener('click', () => void setAppearanceOption('colorMode', button.dataset.colorMode));
  }
  els.textZoomPresetGrid?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-text-zoom-percent]');
    const percent = Number(button?.dataset.textZoomPercent);
    if (!button || !ZOOM_PRESETS.includes(percent)) return;
    void setAppearanceOption('textZoomPercent', percent);
  });
  els.textZoomInput?.addEventListener('change', () => {
    void setAppearanceOption('textZoomPercent', els.textZoomInput.value);
  });
  els.textZoomDecreaseButton?.addEventListener('click', () => {
    const current = appearancePreferencesForSurface(settings, 'panel').textZoomPercent;
    void setAppearanceOption('textZoomPercent', stepTextZoomPercent(current, 'down'));
  });
  els.textZoomIncreaseButton?.addEventListener('click', () => {
    const current = appearancePreferencesForSurface(settings, 'panel').textZoomPercent;
    void setAppearanceOption('textZoomPercent', stepTextZoomPercent(current, 'up'));
  });
  els.fontProfileSelect?.addEventListener('change', () => {
    void setAppearanceOption('fontProfile', els.fontProfileSelect.value);
  });
  els.customFontFamilyInput?.addEventListener('change', () => {
    const family = sanitizeLocalFontFamily(els.customFontFamilyInput.value);
    if (!family) {
      appearanceMutationId += 1;
      appearanceSaveStatus = t('appearance.invalid_local_font_family');
      if (els.appearanceSaveStatus) els.appearanceSaveStatus.textContent = appearanceSaveStatus;
      return;
    }
    void setAppearanceOption('customFontFamily', family);
  });
  els.themeGrid?.addEventListener('click', (event) => {
    const exportButton = event.target.closest('[data-custom-theme-export]');
    if (exportButton) {
      exportCustomTheme(exportButton.dataset.customThemeExport);
      return;
    }
    const deleteButton = event.target.closest('[data-custom-theme-delete]');
    if (deleteButton) {
      void handleCustomThemeDelete(deleteButton.dataset.customThemeDelete);
      return;
    }
    const card = event.target.closest('[data-theme]');
    if (!card) return;
    customThemeDeleteArmedId = '';
    void setAppearanceOption('appearanceTheme', card.dataset.theme);
  });
  els.customThemeImportTextarea?.addEventListener('input', () => {
    customThemePreviewState = null;
    customThemeImportStatus = '';
    renderCustomThemeManagement();
  });
  els.customThemeFileInput?.addEventListener('change', () => void handleCustomThemeFileSelection());
  els.customThemePreviewButton?.addEventListener('click', () => void previewCustomThemeImport());
  els.customThemeInstallButton?.addEventListener('click', () => void installPreviewedCustomTheme());
  els.customThemeResetButton?.addEventListener('click', () => void handleCustomThemeReset());
  els.agentThemeCreateButton?.addEventListener('click', () => void createAgentTheme());
  els.agentThemeDescription?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void createAgentTheme();
  });
  els.customThemeManager?.addEventListener('toggle', () => {
    if (els.customThemeManager.open && !marketplaceThemeLoaded) void loadMarketplaceThemes();
  });
  els.marketplaceThemeSearchInput?.addEventListener('input', () => {
    clearTimeout(marketplaceThemeDebounceTimer);
    marketplaceThemeRevision += 1;
    marketplaceThemeLoading = true;
    marketplaceThemeError = '';
    renderMarketplaceThemes();
    marketplaceThemeDebounceTimer = setTimeout(() => void loadMarketplaceThemes(), 300);
  });
  els.marketplaceThemeSearchButton?.addEventListener('click', () => void loadMarketplaceThemes());
  els.marketplaceThemeResults?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-marketplace-install]');
    if (button) void installMarketplaceTheme(button.dataset.marketplaceInstall);
  });
  browserApi.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.hasOwn(changes, CUSTOM_THEME_STORAGE_KEY)) void handleCustomThemeStoreChange();
    if (Object.hasOwn(changes, CONTEXT_CONSENT_STORAGE_KEY)) {
      settings = {
        ...settings,
        browserContextConsentLedger: normalizeContextConsentLedger(changes[CONTEXT_CONSENT_STORAGE_KEY]?.newValue),
      };
      renderBrowserContextConsentControl();
      void refreshContext();
    }
  });
  systemColorQuery?.addEventListener?.('change', () => {
    if (normalizeColorMode(settings.colorMode) === 'system') renderAppearanceControls();
  });
  els.settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await saveSettingsFromForm();
      await probeGatewayLiveness({ quiet: false });
      if (minimumConnectionReady()) {
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
      setStatus('warn', 'Settings not saved', error?.message || String(error), { translateDetail: false });
    }
  });
  els.localDocumentApproveButton?.addEventListener('click', async () => {
    settings = { ...settings, allowLocalDocuments: true };
    await browserApi.storage.local.set({ hermesBrowserSettings: settings });
    dismissLocalDocumentApprovalNotice();
    await refreshContext({ allowLocalDocuments: true });
    await attachBrowserControlToCurrentTab();
  });
  els.localDocumentDismissButton?.addEventListener('click', () => {
    dismissLocalDocumentApprovalNotice();
  });
  els.sessionOwnershipNotice?.addEventListener('click', handleSessionOwnershipDecision);
  els.composer.addEventListener('submit', async (event) => {
    event.preventDefault();
    const browserCommand = parseBrowserCommand(els.input.value);
    if (browserCommand?.kind === 'native') {
      await executeNativeBrowserCommand(browserCommand);
      return;
    }
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
    if (pendingForeignTurn?.fromComposer) dismissSessionOwnershipNotice();
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
        .catch((error) => setStatus('warn', 'Could not switch to Chat only', error?.message || String(error), { translateDetail: false }));
      return;
    }
    if (action === 'follow-active' || action === 'unlock') {
      unlockContextScope().catch((error) => setStatus('warn', 'Could not unlock tab scope', error?.message || String(error), { translateDetail: false }));
      return;
    }
    if (action === 'pin-active') {
      activeTab().then(pinContextTab).catch((error) => setStatus('warn', 'Could not pin active tab', error?.message || String(error), { translateDetail: false }));
      return;
    }
    if (action.startsWith('pin-tab:')) {
      const tabId = Number(action.slice('pin-tab:'.length));
      pinContextTabById(tabId).catch((error) => setStatus('warn', 'Could not pin tab', error?.message || String(error), { translateDetail: false }));
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
  browserApi.tabs?.onActivated?.addListener?.((activeInfo) => {
    if (shouldRefreshForTabEvent({ scope: contextScope, eventType: 'activated', eventTabId: activeInfo?.tabId })) refreshContext();
  });
  browserApi.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
    if (!(changeInfo.status === 'complete' || changeInfo.title || changeInfo.url)) return;
    if (shouldRefreshForTabEvent({ scope: contextScope, eventType: 'updated', eventTabId: tabId })) refreshContext();
  });
  browserApi.tabs?.onRemoved?.addListener?.((tabId) => {
    if (shouldRefreshForTabEvent({ scope: contextScope, eventType: 'removed', eventTabId: tabId })) refreshContext();
  });
  browserApi.runtime?.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type === WAKE_MESSAGES.localState) {
      renderWakeState(message);
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type === WAKE_MESSAGES.turnReady) {
      consumeWakeTurn(message.turn).catch((error) => {
        setStatus('warn', 'Wake command handoff failed', error?.message || String(error), { translateDetail: false });
      });
      sendResponse?.({ ok: true, accepted: true, surface: SURFACE_KINDS.SIDE_PANEL });
      return false;
    }
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
  browserApi.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes?.[WAKE_STORAGE_KEYS.state]?.newValue) renderWakeState(changes[WAKE_STORAGE_KEYS.state].newValue);
    if (changes?.[WAKE_STORAGE_KEYS.turn]?.newValue) {
      consumeWakeTurn(changes[WAKE_STORAGE_KEYS.turn].newValue).catch((error) => {
        setStatus('warn', 'Wake command handoff failed', error?.message || String(error), { translateDetail: false });
      });
    }
    if (changes?.[VOICE_DRAFT_STORAGE_KEY]?.newValue) {
      consumeVoiceDraft(changes[VOICE_DRAFT_STORAGE_KEY].newValue).catch((error) => {
        setStatus('warn', 'Voice transcript handoff failed', error?.message || String(error), { translateDetail: false });
      });
    }
  });
}

async function runPanelConnectionReadiness({ restoreSettings = false } = {}) {
  startupReadiness = initialStartupReadiness(settings);
  renderStartupReadiness();
  return runCanonicalConnectionReadiness({
    mode: normalizeConnectionMode(settings.connectionMode),
    transport: settings.connectionTransport,
    operations: {
      restoreSettings: async () => {
        if (restoreSettings) {
          await loadSettings({ restoreMessages: false });
          await loadElementPickState();
        }
        settings = migrateConnectionSettings(settings);
        return {
          mode: settings.connectionMode,
          transport: settings.connectionTransport,
          detail: restoreSettings ? 'Settings restored.' : 'Settings confirmed.',
          gateway: { mode: settings.gatewayMode, url: settings.gatewayUrl },
        };
      },
      connectGateway: async () => {
        if (isRemoteWsMode()) {
          const connection = await ensureRemoteWsClient();
          return {
            detail: `Dashboard transport ready at ${connection.baseUrl}.`,
            gateway: { connected: true, state: 'connected', url: connection.baseUrl },
          };
        }
        const state = await probeGatewayLiveness({ quiet: true });
        if (!apiCredentialSatisfied(settings)) {
          const error = new Error('Add a Hermes API token or complete pairing to use full Hermes Browser mode.');
          error.readinessStatus = 'unconfigured';
          throw error;
        }
        if (!state.connected) throw new Error(currentConnectionTroubleshooting(state));
        return {
          detail: connectionStateTitle(state, currentGatewaySummary()),
          gateway: { connected: true, state: state.state, url: settings.gatewayUrl },
        };
      },
      loadCapabilities: async () => {
        await loadGatewayCapabilities({ quiet: true, healthOk: true });
        return gatewayCapabilities.source === 'legacy'
          ? { status: 'legacy', detail: 'Legacy runtime detected; Browser-specific controls are capability-gated.' }
          : { status: 'ready', detail: 'Capabilities loaded.' };
      },
      loadModels: async () => {
        await loadModels({ quiet: true });
        return availableModels.length
          ? { status: 'ready', detail: `${availableModels.length} models loaded.` }
          : { status: 'fallback', detail: 'Model catalog unavailable; using fallback runtime metadata.' };
      },
      selectModel: async () => selectedModelReadiness({ settings, availableModels, activeSessionRuntime }),
      loadSkills: async () => {
        await loadSkills({ quiet: true });
        return gatewayCapabilities.skills
          ? { status: 'ready', detail: `${availableSkills.length} skills available.` }
          : { status: 'skipped', detail: 'Skills route unavailable on this runtime.' };
      },
      loadProfiles: async () => {
        await loadProfiles({ quiet: true });
        return gatewayCapabilities.profiles
          ? { status: 'ready', detail: `${availableProfiles.length} profiles available.` }
          : { status: 'skipped', detail: 'Profiles route unavailable on this runtime.' };
      },
      loadSessions: async () => {
        const outcome = await loadSessions({ quiet: true });
        return outcome?.ok && sessionRoutesAvailable !== false
          ? { status: 'ready', detail: `${availableSessions.length} sessions loaded.` }
          : { ok: false, detail: outcome?.error || (sessionRoutesAvailable === false ? 'Session routes unavailable; using chat fallback.' : 'Session list unavailable; keeping the current list.') };
      },
      bindSession: async () => {
        await initializeSessionForPanelOpen({ focus: false });
        const sessionId = String(settings.sessionId || '').trim();
        if (!sessionId) {
          if (transportUsesDashboardTicket(settings.connectionTransport) || sessionRoutesAvailable !== false) {
            throw new Error('Hermes did not create or resume a durable Browser session.');
          }
          return {
            status: 'fallback',
            sessionId: '',
            detail: 'OpenAI-compatible chat fallback ready; canonical session routes are unavailable.',
          };
        }
        return { status: 'ready', sessionId, detail: `Session ready: ${sessionId}` };
      },
    },
    onEvent: (event) => {
      if (event.type === 'stage') {
        setStartupReadiness(event);
        const stageKey = String(event?.step || event?.phase || '').trim();
        if (stageKey) hbeBootEmit(`panel:stage-settle:${stageKey}`, { startMark: 'panel:body-start' });
        if (stageKey === 'settings') hbeBootEmit('panel:settings-restored', { startMark: 'panel:body-start' });
      }
    },
  });
}

async function runStartupReadiness() {
  try {
    await runPanelConnectionReadiness({ restoreSettings: true });
    hbeBootEmit('panel:readiness-complete');
    await hydrateDelegationWatches();
    await refreshWakeState();
    await consumePendingVoiceDraft();
    await consumePendingWakeTurn();
  } catch (error) {
    setStatus('error', `Startup ${error?.stage || 'readiness'} failed`, error?.message || String(error), { translateDetail: false });
    renderEmptyState();
    hbeBootEmit('panel:readiness-failed');
  }
}

subscribeLocale(() => {
  contextMenuEditor?.setTranslator(contextMenuEditorTranslate);
  renderAppearanceControls();
  renderGatewayHelp();
  renderContextScopeControls();
  renderTaskStack();
  renderStartupReadiness();
  renderContextWindow();
  updateComposerBusyState();
  renderWakeState();
  renderModelRefreshState();
  renderBrowserControl();
  if (lastVisibleStatus) setStatus(lastVisibleStatus.kind, lastVisibleStatus.title, lastVisibleStatus.detail, {
    translateTitle: lastVisibleStatus.translateTitle,
    translateDetail: lastVisibleStatus.translateDetail,
  });
});
await initI18n();
hbeBootEmit('panel:i18n-ready');
bindEvents();
await runStartupReadiness();
renderBrowserControl();
await refreshBrowserControlStatus({ follow: false });
scheduleBrowserControlPoll();
try {
  await consumePendingInlineDraftRequest();
  await consumePendingContextMenuRequest();
  await consumePendingOpenSessionRequest();
  await persistInlineSessionState();
} catch (error) {
  console.warn('[Hermes Browser] Pending Browser handoff could not be restored:', error);
}
try {
  await refreshContext();
} catch (error) {
  setStatus('warn', 'Context refresh unavailable', error?.message || String(error), { translateDetail: false });
}
updateConnectionPrompt();
renderVersionInfo();
renderContextScopeControls();
updateVoiceButtonState();
renderEmptyState();
