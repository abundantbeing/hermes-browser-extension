import {
  buildSidePanelPath,
  DEFAULT_PANEL_RESIDENCY_MODE,
  normalizePanelResidencyMode,
  PANEL_RESIDENCY_MODES,
} from './lib/panel-residency.mjs';
import {
  detectBrowserId,
  detectBrowserProduct,
  openNativeSidebar,
  openSidePanelWithConfirmation,
  setActionClickPanelBehavior as setPanelBehaviorForBrowser,
  setActionIconForBrowser,
} from './lib/browser-runtime.mjs';
import {
  normalizeTranscriptPayload,
  parseTimedTextXml,
  parseYoutubeJson3,
  providerUrlForVideo,
} from './lib/transcript.mjs';
import {
  INLINE_DRAFT_ROUTES,
  buildInlineDraftPrompt,
  normalizeInlineDraftRequest,
  sanitizeInlineDraftResult,
} from './lib/inline-draft-policy.mjs';
import { CONTEXT_CONSENT_STORAGE_KEY } from './lib/context-consent.mjs';
import { gateInlineDraftRequestContext } from './lib/inline-draft-consent.mjs';
import { createHermesClient } from './lib/hermes-client.mjs';
import { normalizeGatewayCapabilities } from './lib/capabilities.mjs';
import {
  assertAssistModelSelectionAcknowledged,
  assistModelFallbackNotice,
  buildAssistModelRouteRequest,
} from './lib/assist-model-contract.mjs';
import { createWakeBackgroundController } from './lib/wake-background.mjs';
import { WAKE_MESSAGES } from './lib/wake-word.mjs';
import { initI18n, subscribeLocale, translateUiText } from './lib/i18n.mjs';
import {
  CONTEXT_MENU_CONFIG_GET,
  CONTEXT_MENU_CONFIG_MUTATE,
  CONTEXT_MENU_REQUEST_CLAIM,
  createContextMenuController,
} from './lib/context-menu-controller.mjs';
import { createVscodeMarketplaceClient } from './lib/vscode-marketplace.mjs';
import { createThemeMarketplaceController } from './lib/theme-marketplace-controller.mjs';
import { resolveBrowserApi } from './lib/browser-api.mjs';
import {
  CONTROLLER_HEARTBEAT_ALARM,
  CONTROLLER_RECONCILE_ALARM,
} from './lib/controller-lifecycle.mjs';
import { createControllerConnector } from './lib/controller-connector.mjs';
import {
  CONTROLLER_WORKER_MESSAGES,
  createControllerServiceWorker,
} from './lib/controller-service-worker.mjs';
import { createBrowserControlRuntime } from './lib/browser-control-runtime.mjs';
import {
  createBrowserControlArtifactClient,
  createBrowserControlArtifactHttpTransport,
} from './lib/browser-control-artifacts.mjs';

const browserApiResolution = resolveBrowserApi();
const browserApi = browserApiResolution.api;
const browserProduct = detectBrowserProduct({
  userAgent: globalThis.navigator?.userAgent || '',
  brands: globalThis.navigator?.userAgentData?.brands || [],
  braveApi: globalThis.navigator?.brave || null,
  extensionUrl: browserApi.runtime.getURL(''),
});
const browserControlRuntime = createBrowserControlRuntime({
  browserApi,
  product: browserProduct,
  artifactClientFactory: (settings = {}) => {
    const baseUrl = String(settings.gatewayUrl || '').trim();
    const apiKey = String(settings.apiKey || '').trim();
    if (settings.browserControlArtifactTransport !== true || !baseUrl || !apiKey) return null;
    return createBrowserControlArtifactClient({
      transport: createBrowserControlArtifactHttpTransport({
        fetchImpl: globalThis.fetch?.bind(globalThis),
        baseUrl,
        apiKey,
      }),
    });
  },
});
let cachedPanelResidencyMode = DEFAULT_PANEL_RESIDENCY_MODE;

const controllerConnector = createControllerConnector({
  fetchImpl: globalThis.fetch?.bind(globalThis),
  WebSocketImpl: globalThis.WebSocket,
  tabsApi: browserApi.tabs,
  scriptingApi: browserApi.scripting,
});
const extensionOrigin = (() => {
  try {
    const parsed = new URL(browserApi.runtime.getURL(''));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
})();
const controllerWorker = typeof browserApi.storage?.local?.set === 'function'
  ? createControllerServiceWorker({
      storageArea: browserApi.storage.local,
      connector: controllerConnector,
      product: browserProduct,
      extensionOrigin,
      supportsTabGroups: Boolean(browserApi.tabGroups),
      approvalStore: browserControlRuntime.approvals,
      getControllerCapabilities: async (settings) => (await browserControlRuntime.status(settings)).capabilities,
      executeBrowserCommand: (frame, context) => browserControlRuntime.execute(frame, context, context.settings),
      getTab: (tabId) => browserApi.tabs.get(tabId),
    })
  : null;
browserControlRuntime.setDebuggerDetachHandler((event) => {
  controllerWorker?.handleDebuggerDetach(event)
    .catch((error) => console.warn('[Hermes Browser] Debugger detach reconciliation failed:', error));
});
const CONTROLLER_WORKER_MESSAGE_TYPES = new Set(Object.values(CONTROLLER_WORKER_MESSAGES));

function startControllerAlarms() {
  if (typeof browserApi?.alarms?.create !== 'function') return false;
  browserApi.alarms.create(CONTROLLER_HEARTBEAT_ALARM, { periodInMinutes: 1 });
  browserApi.alarms.create(CONTROLLER_RECONCILE_ALARM, { periodInMinutes: 5 });
  return true;
}

browserApi.alarms?.onAlarm?.addListener?.((alarm) => {
  if (!alarm?.name) return;
  if (alarm.name === CONTROLLER_HEARTBEAT_ALARM || alarm.name === CONTROLLER_RECONCILE_ALARM) {
    controllerWorker?.reconcile({ reason: alarm.name })
      .catch((error) => console.warn('[Hermes Browser] Controller alarm reconcile failed:', error));
  }
});

async function bootControllerWorker() {
  if (!controllerWorker) return { ok: false, connected: false, dormant: true };
  const result = await controllerWorker.boot();
  startControllerAlarms();
  return result;
}

async function reconcileControllerWorker(reason) {
  if (!controllerWorker) return { ok: false, connected: false, dormant: true };
  const result = await controllerWorker.reconcile({ reason });
  startControllerAlarms();
  return result;
}

bootControllerWorker().catch((error) => {
  console.warn('[Hermes Browser] Controller worker initialization failed:', error);
});
const INLINE_DRAFT_STORAGE_KEY = 'hermesBrowserInlineDraftRequest';
const INLINE_SESSION_STATE_KEY = 'hermesBrowserInlineSessionState';
const OPEN_SESSION_STORAGE_KEY = 'hermesBrowserOpenSessionRequest';
const INLINE_DRAFT_TTL_MS = 5 * 60 * 1000;
const HERMES_ASSIST_SOURCE = 'hermes_browser';

const WAKE_BACKGROUND_MESSAGE_TYPES = new Set([
  WAKE_MESSAGES.claimTurn,
  WAKE_MESSAGES.getState,
  WAKE_MESSAGES.setEnabled,
  WAKE_MESSAGES.localDetected,
  WAKE_MESSAGES.localState,
  WAKE_MESSAGES.turnReply,
]);
const wakeController = createWakeBackgroundController({
  chromeApi: browserApi,
  openPanel: (tab, options) => openHermesPanel(tab, options),
});
const contextMenuController = createContextMenuController({
  chromeApi: browserApi,
  openHermesSurface: (tab) => openHermesPanelFromContextGesture(tab),
  translate: (_key, fallback) => translateUiText(fallback),
});
const themeMarketplaceController = createThemeMarketplaceController({
  client: createVscodeMarketplaceClient(),
  storageArea: browserApi.storage.local,
});
function restoreWakeController() {
  if (!browserApi.runtime?.sendMessage || !browserApi.storage?.local?.get) return;
  wakeController.restore().catch((error) => console.warn('[Hermes Browser] Wake initialization failed:', error));
}
restoreWakeController();

function assistSessionId() {
  const entropy = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12)
    || Math.random().toString(36).slice(2, 14);
  return `hermes-assist-${Date.now().toString(36)}-${entropy}`;
}

function assistantText(payload = {}) {
  return String(
    payload?.content
      || payload?.message?.content
      || payload?.response
      || payload?.assistant?.content
      || payload?.data?.content
      || '',
  );
}

function pageKey(value = '') {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

async function sendDirectInlineResult(tabId, request, result) {
  return browserApi.tabs.sendMessage(tabId, {
    type: 'HERMES_INLINE_DRAFT_RESULT',
    requestId: request.requestId,
    documentId: request.documentId,
    ...result,
  }).catch(() => null);
}

async function deleteUnacknowledgedAssistSession(client, sessionId) {
  const response = await client.fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Hermes returned ${response.status} while deleting the unacknowledged Assist session.`);
  }
}

async function loadAssistGatewayCapabilities(client) {
  try {
    const response = await client.fetch('/v1/capabilities');
    const payload = await client.readJson(response);
    return normalizeGatewayCapabilities(response.ok ? payload : null, {
      healthOk: response.ok,
      warning: response.ok ? '' : `GET /v1/capabilities failed (${response.status})`,
    });
  } catch (error) {
    return normalizeGatewayCapabilities(null, {
      healthOk: false,
      warning: `GET /v1/capabilities failed (${error?.message || String(error)})`,
    });
  }
}

async function runInlineDraftInServiceWorker(request, sender, tabId) {
  try {
    const tab = await browserApi.tabs.get(tabId).catch(() => null);
    if (!tab || pageKey(tab.url || tab.pendingUrl) !== pageKey(request.pageUrl)) {
      throw new Error('The originating page changed before Hermes could draft.');
    }
    const stored = await browserApi.storage.local.get('hermesBrowserSettings');
    const settings = stored?.hermesBrowserSettings || {};
    const client = createHermesClient({
      getConnection: () => ({
        gatewayUrl: settings.gatewayUrl || settings.agentApiUrl || '',
        apiKey: settings.apiKey || settings.agentToken || '',
        activeProfile: settings.activeProfile || settings.profile || '',
      }),
    });
    const sessionId = assistSessionId();
    const adapterLabel = String(request.adapterId || 'Browser').replace(/(^|[-_\s])([a-z])/g, (_, lead, letter) => `${lead}${letter.toUpperCase()}`);
    const titleStamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const titleNonce = sessionId.slice(-4);
    const sessionTitle = `Hermes Assist · ${adapterLabel} · ${titleStamp} · ${titleNonce}`;
    const gatewayCapabilities = await loadAssistGatewayCapabilities(client);
    const { policy: assistPolicy, request: routeRequest } = buildAssistModelRouteRequest(
      settings,
      gatewayCapabilities,
    );
    const requestedSelection = assistPolicy.selection || assistPolicy.requestedSelection || null;
    let attemptSelection = assistPolicy.selection;
    let attemptRouteRequest = routeRequest;
    let modelNotice = assistPolicy.mode === 'gateway-default-fallback'
      ? assistModelFallbackNotice(requestedSelection, 'this gateway does not advertise exact model routing')
      : '';
    let resolvedSessionId = sessionId;
    let resolvedTitle = sessionTitle;
    let text = '';

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let createdThisAttempt = false;
      try {
        const createResponse = await client.fetch('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({
            id: sessionId,
            title: sessionTitle,
            source: HERMES_ASSIST_SOURCE,
            ...attemptRouteRequest,
          }),
        });
        const created = await client.readJson(createResponse);
        if (!createResponse.ok) {
          throw new Error(created?.error?.message || created?.error || `Could not create Hermes Assist session (${createResponse.status}).`);
        }
        createdThisAttempt = true;
        resolvedSessionId = String(created?.session?.id || created?.id || sessionId);
        resolvedTitle = String(created?.session?.title || created?.title || sessionTitle);
        assertAssistModelSelectionAcknowledged(created, attemptSelection);

        const consentStored = await browserApi.storage.local.get([CONTEXT_CONSENT_STORAGE_KEY]);
        const gatedRequest = await gateInlineDraftRequestContext({
          request,
          settings,
          ledger: consentStored[CONTEXT_CONSENT_STORAGE_KEY] || null,
          controller: String(browserApi.runtime.id || 'hermes-browser'),
        });
        const chatResponse = await client.fetch(`/api/sessions/${encodeURIComponent(resolvedSessionId)}/chat`, {
          method: 'POST',
          body: JSON.stringify({
            ...attemptRouteRequest,
            message: buildInlineDraftPrompt(gatedRequest.request),
          }),
        });
        const chatPayload = await client.readJson(chatResponse);
        if (!chatResponse.ok) {
          throw new Error(chatPayload?.error?.message || chatPayload?.error || `Hermes Assist failed (${chatResponse.status}).`);
        }
        text = sanitizeInlineDraftResult(assistantText(chatPayload));
        try {
          assertAssistModelSelectionAcknowledged(chatPayload, attemptSelection);
        } catch (modelError) {
          if (!text) throw modelError;
          modelNotice = assistModelFallbackNotice(attemptSelection, 'the gateway returned the draft without acknowledging the selected model');
        }
        if (!text) throw new Error('Hermes returned an empty draft.');
        break;
      } catch (error) {
        if (!attemptSelection || attempt > 0) throw error;
        if (createdThisAttempt) {
          try {
            await deleteUnacknowledgedAssistSession(client, resolvedSessionId);
          } catch (cleanupError) {
            console.error('[Hermes Browser] Assist fallback cleanup failed:', cleanupError);
            throw new Error(`${error?.message || String(error)} Cleanup also failed: ${cleanupError?.message || String(cleanupError)}`);
          }
        }
        modelNotice = assistModelFallbackNotice(attemptSelection, error?.message || 'the selected route was rejected');
        attemptSelection = null;
        attemptRouteRequest = {};
      }
    }

    let retainedSessionId = resolvedSessionId;
    let retainedSessionTitle = resolvedTitle;
    if (settings.inlineAssistSessionRetention === 'delete' && request.route === INLINE_DRAFT_ROUTES.BACKGROUND) {
      const deleteResponse = await client.fetch(`/api/sessions/${encodeURIComponent(resolvedSessionId)}`, { method: 'DELETE' });
      if (deleteResponse.ok || deleteResponse.status === 404) {
        retainedSessionId = '';
        retainedSessionTitle = 'Hermes Assist · deleted after run';
      } else {
        console.warn('[Hermes Browser] Assist session cleanup failed:', deleteResponse.status);
      }
    }
    await sendDirectInlineResult(tabId, request, {
      ok: true,
      text,
      sessionId: retainedSessionId,
      sessionTitle: retainedSessionTitle,
      modelNotice,
    });
    if (request.route === INLINE_DRAFT_ROUTES.NEW && retainedSessionId) {
      await queueOpenSessionRequest({ sessionId: retainedSessionId }, sender);
    }
    return { ok: true, requestId: request.requestId, background: request.route === INLINE_DRAFT_ROUTES.BACKGROUND, sessionId: retainedSessionId };
  } catch (error) {
    const reason = error?.message || String(error);
    await sendDirectInlineResult(tabId, request, { ok: false, reason });
    return { ok: false, requestId: request.requestId, reason };
  }
}

async function queueInlineDraftRequest(message, sender) {
  const tabId = Number(sender?.tab?.id);
  if (!Number.isFinite(tabId) || tabId <= 0 || Number(sender?.frameId || 0) !== 0) {
    return { ok: false, reason: 'Inline draft requests must come from the top-level active page.' };
  }
  const request = normalizeInlineDraftRequest(message?.request);
  if (!request) return { ok: false, reason: 'Inline draft request failed validation.' };
  if (!browserApi.storage?.session) return { ok: false, reason: 'Session-only draft handoff is unavailable in this browser.' };
  const queued = {
    ...request,
    tabId,
    windowId: Number(sender?.tab?.windowId) || null,
    expiresAt: Date.now() + INLINE_DRAFT_TTL_MS,
  };
  if ([INLINE_DRAFT_ROUTES.BACKGROUND, INLINE_DRAFT_ROUTES.NEW].includes(request.route)) {
    return runInlineDraftInServiceWorker(request, sender, tabId);
  }
  await Promise.all([
    browserApi.storage.session.set({ [INLINE_DRAFT_STORAGE_KEY]: queued }),
    openHermesPanel(sender.tab),
  ]);
  return { ok: true, requestId: request.requestId };
}

async function inlineSessionStatus() {
  const stored = await browserApi.storage.local.get(['hermesBrowserSettings', INLINE_SESSION_STATE_KEY]);
  const settings = stored?.hermesBrowserSettings || {};
  const state = stored?.[INLINE_SESSION_STATE_KEY] || {};
  const sessionId = String(state.sessionId || settings.sessionId || '').trim();
  return {
    ok: true,
    hasActiveSession: Boolean(sessionId),
    sessionId,
    title: String(state.title || settings.sessionTitle || 'Current Browser chat').slice(0, 160),
    messageCount: Math.max(0, Number(state.messageCount || 0)),
  };
}

async function queueOpenSessionRequest(message, sender) {
  const sessionId = String(message?.sessionId || '').trim();
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(sessionId)) return { ok: false, reason: 'Invalid session binding.' };
  const surface = message?.surface === 'web' ? 'web' : 'sidepanel';
  if (surface === 'web') {
    const sourceSidePanelPath = String(browserApi.runtime.getManifest()?.side_panel?.default_path || 'sidepanel.html');
    const appPath = sourceSidePanelPath.startsWith('extension/') ? 'extension/app.html' : 'app.html';
    const appUrl = new URL(browserApi.runtime.getURL(appPath));
    appUrl.searchParams.set('sessionId', sessionId);
    const sourceTabId = Number(sender?.tab?.id);
    if (Number.isFinite(sourceTabId) && sourceTabId > 0) appUrl.searchParams.set('sourceTabId', String(sourceTabId));
    appUrl.searchParams.set('sourceSurfaceId', 'inline-assist');
    await openHermesFullView(appUrl.href);
    return { ok: true, sessionId, surface };
  }

  const tab = sender?.tab || (await browserApi.tabs.query({ active: true, currentWindow: true }))[0];
  await browserApi.storage.session.set({
    [OPEN_SESSION_STORAGE_KEY]: {
      sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + INLINE_DRAFT_TTL_MS,
    },
  });
  const opened = await openHermesPanel(tab, { allowFallback: false });
  if (opened === false) {
    await browserApi.storage.session.remove(OPEN_SESSION_STORAGE_KEY);
    return { ok: false, reason: 'The Browser side panel could not open. Choose Hermes Web instead.' };
  }
  return { ok: true, sessionId, surface };
}

async function configureInstalledSurfaces({ controllerReason = 'extension-installed' } = {}) {
  await Promise.all([configureSidePanel(), contextMenuController.configure()]);
  await reconcileControllerWorker(controllerReason);
}

function defaultSidePanelPath() {
  return browserApi.runtime.getManifest().side_panel?.default_path || 'sidepanel.html';
}

function panelResidencyModeFromStorage(stored = {}) {
  return normalizePanelResidencyMode(
    stored?.hermesBrowserSettings?.panelResidencyMode
      || stored?.panelResidencyMode
      || DEFAULT_PANEL_RESIDENCY_MODE,
  );
}

async function refreshPanelResidencyModeFromStorage() {
  try {
    const stored = await browserApi.storage.local.get(['hermesBrowserSettings', 'panelResidencyMode']);
    cachedPanelResidencyMode = panelResidencyModeFromStorage(stored);
  } catch (error) {
    console.warn('[Hermes Browser] Could not read panel residency setting:', error);
    cachedPanelResidencyMode = DEFAULT_PANEL_RESIDENCY_MODE;
  }
  return cachedPanelResidencyMode;
}

async function setActionClickSidePanelBehavior() {
  await setPanelBehaviorForBrowser();
}

async function activeBrowserTabId() {
  try {
    const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
    const tabId = Number(tab?.id);
    return Number.isFinite(tabId) && tabId > 0 ? tabId : null;
  } catch {
    return null;
  }
}

async function applyPanelResidencyMode(mode = cachedPanelResidencyMode, { tabId = null } = {}) {
  const panelResidencyMode = normalizePanelResidencyMode(mode);
  const defaultPanelPath = defaultSidePanelPath();
  const cleanTabId = Number(tabId);
  const useTabAttached = panelResidencyMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED && Number.isFinite(cleanTabId) && cleanTabId > 0;

  await setActionClickSidePanelBehavior();
  if (!browserApi.sidePanel?.setOptions) return;

  if (panelResidencyMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED) {
    await browserApi.sidePanel.setOptions({ enabled: false });
    if (useTabAttached) {
      await browserApi.sidePanel.setOptions({
        tabId: cleanTabId,
        path: buildSidePanelPath({
          mode: panelResidencyMode,
          tabId: cleanTabId,
          defaultPath: defaultPanelPath,
        }),
        enabled: true,
      });
    }
    return;
  }

  // Update only the global default. Existing tab-scoped overrides intentionally
  // keep their attached panel documents and sessions; untouched and new tabs
  // resolve to this shared panel path.
  await browserApi.sidePanel.setOptions({
    path: buildSidePanelPath({
      mode: panelResidencyMode,
      defaultPath: defaultPanelPath,
    }),
    enabled: true,
  });
}

async function configureSidePanel() {
  try {
    const panelResidencyMode = await refreshPanelResidencyModeFromStorage();
    const tabId = await activeBrowserTabId();
    // No popup for any browser — background.js handles the click.
    await browserApi.action.setPopup({ popup: '' });
    // Brave-only Nous Girl action icon; best-effort and never blocks panel setup.
    await setActionIconForBrowser();
    await applyPanelResidencyMode(panelResidencyMode, { tabId });
  } catch (error) {
    console.warn('[Hermes Browser] Unable to set side panel behavior:', error);
  }
}

function reapplyPanelResidencyForTab(tabId) {
  applyPanelResidencyMode(cachedPanelResidencyMode, { tabId })
    .catch((error) => console.warn('[Hermes Browser] Could not apply panel residency setting:', error));
}

const pendingPanelTabOpens = new Map();

async function openOrFocusPanelTab(panelUrl) {
  const pendingOpen = pendingPanelTabOpens.get(panelUrl);
  if (pendingOpen) return pendingOpen;

  const openOperation = (async () => {
    let existingTab = null;
    try {
      const candidates = await browserApi.tabs.query({});
      existingTab = candidates.find((candidate) => (
        candidate.url === panelUrl || candidate.pendingUrl === panelUrl
      )) || null;
    } catch (queryError) {
      console.warn('[Hermes Browser] Could not search for an existing fallback tab:', queryError);
    }

    if (Number.isFinite(existingTab?.id)) {
      try {
        const activatedTab = await browserApi.tabs.update(existingTab.id, { active: true });
        if (Number.isFinite(existingTab.windowId) && browserApi.windows?.update) {
          try {
            await browserApi.windows.update(existingTab.windowId, { focused: true });
          } catch (focusError) {
            console.warn('[Hermes Browser] Could not focus the existing fallback window:', focusError);
          }
        }
        return activatedTab || existingTab;
      } catch (activateError) {
        console.warn('[Hermes Browser] Existing fallback tab disappeared before activation:', activateError);
      }
    }

    return browserApi.tabs.create({ url: panelUrl, active: true });
  })();

  pendingPanelTabOpens.set(panelUrl, openOperation);
  try {
    return await openOperation;
  } finally {
    if (pendingPanelTabOpens.get(panelUrl) === openOperation) {
      pendingPanelTabOpens.delete(panelUrl);
    }
  }
}

async function openHermesPanel(tab, { allowFallback = true } = {}) {
  await refreshPanelResidencyModeFromStorage();
  const panelResidencyMode = cachedPanelResidencyMode;
  const tabId = Number(tab?.id);
  const useTabAttached = panelResidencyMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED && Number.isFinite(tabId) && tabId > 0;
  const defaultPanelPath = defaultSidePanelPath();
  const panelPath = buildSidePanelPath({
    mode: panelResidencyMode,
    tabId: useTabAttached ? tabId : null,
    defaultPath: defaultPanelPath,
  });
  const panelUrl = browserApi.runtime.getURL(panelPath);

  // Try Opera/Firefox native sidebar first.
  const opened = await openNativeSidebar({ windowId: tab?.windowId ?? null });
  if (opened) return;

  // Chrome/Edge/Comet sidePanel API
  const sidePanelCanOpen = Boolean(browserApi.sidePanel?.open);
  const browserId = detectBrowserId();

  try {
    if (sidePanelCanOpen) {
      await applyPanelResidencyMode(panelResidencyMode, { tabId: useTabAttached ? tabId : null });
      let attemptedWindowScope = false;
      if (useTabAttached) {
        try {
          const panelOpened = await openSidePanelWithConfirmation({
            sidePanelApi: browserApi.sidePanel,
            runtimeApi: browserApi.runtime,
            openOptions: { tabId },
            panelUrl,
          });
          if (panelOpened) return;
        } catch (tabOpenError) {
          if (!tab?.windowId) throw tabOpenError;
          const { windowId } = tab;
          attemptedWindowScope = true;
          console.warn('[Hermes Browser] Tab side panel open failed, retrying window side panel:', tabOpenError);
          const panelOpened = await openSidePanelWithConfirmation({
            sidePanelApi: browserApi.sidePanel,
            runtimeApi: browserApi.runtime,
            openOptions: { windowId },
            panelUrl,
          });
          if (panelOpened) return;
        }
      }
      if (tab?.windowId && !attemptedWindowScope) {
        const { windowId } = tab;
        const panelOpened = await openSidePanelWithConfirmation({
          sidePanelApi: browserApi.sidePanel,
          runtimeApi: browserApi.runtime,
          openOptions: { windowId },
          panelUrl,
        });
        if (panelOpened) return;
      }
      console.warn('[Hermes Browser] Side panel open was not confirmed; using the extension fallback.');
    }
  } catch (error) {
    console.warn('[Hermes Browser] Side panel open failed:', error);
  }

  if (!allowFallback) {
    console.warn('[Hermes Browser] Strict side-panel open failed; refusing to open a fallback tab.');
    return false;
  }

  // Opera/Firefox: open as a narrow popup window that acts like a sidebar panel.
  // Opera's sidebarAction API is not available in MV3, so we use windows.create
  // with type: popup, a narrow width, and leftmost position.
  if (browserId === 'opera' || browserId === 'firefox') {
    try {
      await browserApi.windows.create({
        url: browserApi.runtime.getURL(panelPath),
        type: 'popup',
        width: 420,
        height: 800,
        left: 0,
        top: 0,
      });
      return;
    } catch (popupError) {
      console.warn('[Hermes Browser] Popup window creation failed:', popupError);
    }
  }

  // Last resort: reuse the matching extension tab or create it once.
  await openOrFocusPanelTab(panelUrl);
}

function openHermesPanelFromGesture(tab) {
  const browserId = detectBrowserId();
  const panelResidencyMode = cachedPanelResidencyMode;
  const tabId = Number(tab?.id);
  const useTabAttached = panelResidencyMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED
    && Number.isFinite(tabId)
    && tabId > 0;
  const panelUrl = browserApi.runtime.getURL(buildSidePanelPath({
    mode: panelResidencyMode,
    tabId: useTabAttached ? tabId : null,
    defaultPath: defaultSidePanelPath(),
  }));

  // Opera/Firefox: the single synchronous open attempt is the native sidebar.
  // It must be initiated in the listener stack before any await so the user
  // gesture (toolbar click, context menu, Alt+H) is not consumed by storage
  // hydration, setOptions, or detection probes.
  if (browserId === 'opera' || browserId === 'firefox') {
    try {
      const nativeAttempt = openNativeSidebar({ windowId: tab?.windowId ?? null });
      return Promise.resolve(nativeAttempt)
        .then((opened) => (opened ? true : openHermesPanelFallback(tab, browserId, panelUrl)))
        .catch(() => openHermesPanelFallback(tab, browserId, panelUrl));
    } catch {
      return openHermesPanelFallback(tab, browserId, panelUrl);
    }
  }

  if (!browserApi.sidePanel?.open) return openHermesPanelFallback(tab, browserId, panelUrl);

  // Chromium-family: one correctly scoped sidePanel attempt, opened
  // synchronously. A resolved native request owns the gesture even when the
  // visibility event is missed; opening a fallback tab in that state can show
  // both the side panel and a duplicate full-tab Hermes surface.
  const openOptions = useTabAttached
    ? { tabId }
    : { windowId: Number(tab?.windowId) };

  try {
    const panelAttempt = openSidePanelWithConfirmation({
      sidePanelApi: browserApi.sidePanel,
      runtimeApi: browserApi.runtime,
      openOptions,
      panelUrl,
    });
    return Promise.resolve(panelAttempt)
      .then((opened) => {
        if (!opened) {
          console.warn('[Hermes Browser] Side panel open resolved without visibility confirmation; not opening a fallback tab.');
        }
        return true;
      })
      .catch(() => openHermesPanelFallback(tab, browserId, panelUrl));
  } catch {
    return openHermesPanelFallback(tab, browserId, panelUrl);
  }
}

async function openHermesPanelFallback(tab, browserId, panelUrl) {
  // Gesture-free fallbacks only: never re-attempt a native sidebar or
  // sidePanel open after the initiating gesture window is spent.
  if (browserId === 'opera' || browserId === 'firefox') {
    try {
      await browserApi.windows.create({
        url: panelUrl,
        type: 'popup',
        width: 420,
        height: 800,
        left: 0,
        top: 0,
      });
      return true;
    } catch (popupError) {
      console.warn('[Hermes Browser] Popup window creation failed:', popupError);
    }
  }
  await openOrFocusPanelTab(panelUrl);
  return true;
}

// Backward-compatible entry name for the context-menu controller wiring.
const openHermesPanelFromContextGesture = openHermesPanelFromGesture;

async function openHermesFullView(requestedUrl = '') {
  const packagedAppUrl = new URL(browserApi.runtime.getURL('app.html'));
  const rootDevAppUrl = new URL(browserApi.runtime.getURL('extension/app.html'));
  const targetUrl = new URL(String(requestedUrl || packagedAppUrl.href));
  const allowedPaths = new Set([packagedAppUrl.pathname, rootDevAppUrl.pathname]);
  if (targetUrl.origin !== packagedAppUrl.origin || !allowedPaths.has(targetUrl.pathname)) {
    throw new Error('Refused to open a non-Hermes full-view URL.');
  }
  await browserApi.tabs.create({ url: targetUrl.href, active: true });
  return { ok: true };
}

function timeoutSignal(ms = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(timeout) };
}

async function fetchUserConfiguredTranscript(videoId, provider) {
  const url = providerUrlForVideo(provider, videoId);
  if (!url) return { ok: false, reason: 'custom_provider_not_configured', source: 'custom' };
  const { controller, done } = timeoutSignal();
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json, text/plain;q=0.9' } });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `custom_provider_${response.status}`, source: 'custom' };
    try {
      return normalizeTranscriptPayload(JSON.parse(text), 'custom');
    } catch {
      return normalizeTranscriptPayload({ text }, 'custom');
    }
  } finally {
    done();
  }
}

async function fetchDefaultTimedTextTranscript(videoId) {
  const attempts = [
    `https://video.google.com/timedtext?fmt=json3&lang=en&v=${encodeURIComponent(videoId)}`,
    `https://video.google.com/timedtext?fmt=json3&lang=en&kind=asr&v=${encodeURIComponent(videoId)}`,
    `https://video.google.com/timedtext?lang=en&v=${encodeURIComponent(videoId)}`,
    `https://video.google.com/timedtext?lang=en&kind=asr&v=${encodeURIComponent(videoId)}`,
  ];
  for (const url of attempts) {
    const { controller, done } = timeoutSignal();
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
      if (!response.ok) continue;
      const text = await response.text();
      if (!text.trim()) continue;
      let segments = [];
      if (url.includes('fmt=json3')) {
        try {
          segments = parseYoutubeJson3(JSON.parse(text));
        } catch {
          segments = [];
        }
      } else {
        segments = parseTimedTextXml(text);
      }
      if (segments.length) {
        return normalizeTranscriptPayload({ segments, language: 'en' }, 'default-timedtext');
      }
    } catch (_error) {
      // Try next shape.
    } finally {
      done();
    }
  }
  return { ok: false, reason: 'default_timedtext_unavailable', source: 'default-timedtext' };
}

async function fetchDomTranscript(tabId) {
  if (!tabId) return { ok: false, reason: 'no_active_tab', source: 'page-dom' };
  try {
    return normalizeTranscriptPayload(
      await browserApi.tabs.sendMessage(tabId, { type: 'HERMES_GET_YOUTUBE_TRANSCRIPT_DOM' }),
      'page-dom',
    );
  } catch (error) {
    return { ok: false, reason: error?.message || String(error), source: 'page-dom' };
  }
}

async function getYoutubeTranscript({ videoId, tabId, provider = 'default' } = {}) {
  const cleanVideoId = String(videoId || '').trim();
  const mode = String(provider || 'default').trim();
  if (!cleanVideoId) return { ok: false, reason: 'missing_video_id' };
  if (mode.toLowerCase() === 'off') return { ok: false, reason: 'transcripts_disabled' };

  const attempts = [];
  if (/^https?:\/\//i.test(mode)) attempts.push(() => fetchUserConfiguredTranscript(cleanVideoId, mode));
  attempts.push(() => fetchDefaultTimedTextTranscript(cleanVideoId));
  attempts.push(() => fetchDomTranscript(tabId));

  const failures = [];
  for (const attempt of attempts) {
    const result = await attempt();
    if (result?.ok && (result.text || result.segments?.length)) return { ...result, videoId: cleanVideoId };
    failures.push({ source: result?.source || 'unknown', reason: result?.reason || 'unavailable' });
  }
  return { ok: false, videoId: cleanVideoId, reason: failures.map((item) => `${item.source}:${item.reason}`).join('; ') || 'transcript_unavailable' };
}

subscribeLocale(() => contextMenuController.configure().catch((error) => {
  console.warn('[Hermes Browser] Localized context menus could not be configured:', error);
}));
void initI18n().catch((error) => {
  console.warn('[Hermes Browser] Localization initialization failed:', error);
});

browserApi.runtime.onInstalled.addListener(configureInstalledSurfaces);
browserApi.runtime.onStartup.addListener(async () => {
  await configureInstalledSurfaces({ controllerReason: 'browser-startup' });
  restoreWakeController();
});
browserApi.action.onClicked.addListener(openHermesPanelFromGesture);
browserApi.contextMenus?.onClicked?.addListener?.((info, tab) => {
  return contextMenuController.handleClick(info, tab)
    .catch((error) => console.warn('[Hermes Browser] Context menu action failed:', error));
});
browserApi.tabs?.onActivated?.addListener?.(({ tabId }) => reapplyPanelResidencyForTab(tabId));
browserApi.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
  controllerWorker?.handleTabUpdated(tabId, changeInfo)
    .catch((error) => console.warn('[Hermes Browser] Could not invalidate controller document authority:', error));
});
browserApi.tabs?.onRemoved?.addListener?.((tabId) => {
  controllerWorker?.handleTabRemoved(tabId)
    .catch((error) => console.warn('[Hermes Browser] Could not release removed controller tab state:', error));
});
browserApi.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== 'local') return;
  contextMenuController.handleStorageChanged(changes, areaName)
    .catch((error) => console.warn('[Hermes Browser] Context menu refresh failed:', error));
  if (changes.hermesBrowserSettings?.newValue && controllerWorker) {
    controllerWorker.syncSettings(changes.hermesBrowserSettings.newValue)
      .catch((error) => console.warn('[Hermes Browser] Controller settings rebind failed:', error));
  }
  let changed = false;
  if (changes.hermesBrowserSettings?.newValue?.panelResidencyMode) {
    cachedPanelResidencyMode = normalizePanelResidencyMode(changes.hermesBrowserSettings.newValue.panelResidencyMode);
    changed = true;
  } else if (changes.panelResidencyMode?.newValue) {
    cachedPanelResidencyMode = normalizePanelResidencyMode(changes.panelResidencyMode.newValue);
    changed = true;
  }
  if (changed) {
    activeBrowserTabId()
      .then((tabId) => reapplyPanelResidencyForTab(tabId));
  }
});
browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // SECURITY BOUNDARY: Untrusted Input — `message` arrives from extension
  // pages, content scripts, or (via forwarded events) web page code. Never
  // trust its fields; validate types and treat string payloads as
  // attacker-controlled until they pass through the sanitizer at render time.
  const action = CONTROLLER_WORKER_MESSAGE_TYPES.has(message?.type)
    ? controllerWorker
      ? controllerWorker.handleMessage(message, sender)
      : Promise.resolve({ ok: false, error: 'controller_worker_unavailable' })
    : WAKE_BACKGROUND_MESSAGE_TYPES.has(message?.type)
    ? wakeController.handleMessage(message)
    : [CONTEXT_MENU_CONFIG_GET, CONTEXT_MENU_CONFIG_MUTATE, CONTEXT_MENU_REQUEST_CLAIM].includes(message?.type)
      ? contextMenuController.handleMessage(message)
      : themeMarketplaceController.handles(message?.type)
        ? themeMarketplaceController.handleMessage(message)
    : message?.type === 'HERMES_INLINE_DRAFT_REQUEST'
      ? queueInlineDraftRequest(message, sender)
      : message?.type === 'HERMES_INLINE_SESSION_STATUS'
      ? inlineSessionStatus()
      : message?.type === 'HERMES_INLINE_OPEN_SESSION'
        ? queueOpenSessionRequest(message, sender)
        : message?.type === 'HERMES_OPEN_FULL_VIEW'
          ? openHermesFullView(message.url)
          : message?.type === 'HERMES_GET_YOUTUBE_TRANSCRIPT'
            ? getYoutubeTranscript(message)
            : null;
  if (!action) return false;
  action
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, reason: error?.message || String(error) }));
  return true;
});

initI18n().catch((error) => {
  console.warn('[Hermes Browser] Localization initialization failed:', error);
  return contextMenuController.configure();
}).catch((error) => {
  console.warn('[Hermes Browser] Default context menus could not be configured:', error);
});
refreshPanelResidencyModeFromStorage().catch((error) => {
  console.warn('[Hermes Browser] Panel residency initialization failed:', error);
});
