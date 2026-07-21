import {
  buildSidePanelPath,
  DEFAULT_PANEL_RESIDENCY_MODE,
  normalizePanelResidencyMode,
  PANEL_RESIDENCY_MODES,
} from './lib/panel-residency.mjs';
import {
  detectBrowserId,
  openNativeSidebar,
  openSidePanelWithConfirmation,
  setActionClickPanelBehavior as setPanelBehaviorForBrowser,
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
import { createHermesClient } from './lib/hermes-client.mjs';
import { normalizeGatewayCapabilities } from './lib/capabilities.mjs';
import {
  assertAssistModelSelectionAcknowledged,
  assistModelFallbackNotice,
  buildAssistModelRouteRequest,
} from './lib/assist-model-contract.mjs';

let cachedPanelResidencyMode = DEFAULT_PANEL_RESIDENCY_MODE;
const INLINE_DRAFT_STORAGE_KEY = 'hermesBrowserInlineDraftRequest';
const INLINE_SESSION_STATE_KEY = 'hermesBrowserInlineSessionState';
const CONTEXT_MENU_STORAGE_KEY = 'hermesBrowserContextMenuRequest';
const OPEN_SESSION_STORAGE_KEY = 'hermesBrowserOpenSessionRequest';
const INLINE_DRAFT_TTL_MS = 5 * 60 * 1000;
const HERMES_ASSIST_SOURCE = 'hermes_assist';
const CONTEXT_MENU_ROOT_ID = 'hermes-browser-root';
const CONTEXT_MENU_ITEMS = Object.freeze([
  { id: 'hermes-browser-ask-selection', title: 'Ask Hermes about this selection', contexts: ['selection'], prompt: 'Help me understand or work with this selected text:' },
  { id: 'hermes-browser-summarize-selection', title: 'Summarize selection', contexts: ['selection'], prompt: 'Summarize this selected text concisely:' },
  { id: 'hermes-browser-explain-selection', title: 'Explain selection', contexts: ['selection'], prompt: 'Explain this selected text clearly:' },
  { id: 'hermes-browser-improve-editable', title: 'Improve selected text', contexts: ['editable'], inlineAction: 'improve' },
  { id: 'hermes-browser-draft-reply', title: 'Draft reply with Hermes', contexts: ['editable'], inlineAction: 'draft-reply' },
  { id: 'hermes-browser-open', title: 'Open Hermes Browser', contexts: ['page', 'link', 'image', 'video', 'audio'] },
]);

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

function normalizeContextMenuRoute(value = '') {
  const route = String(value || '').trim().toLowerCase();
  return ['ask', 'current', 'new', 'background'].includes(route) ? route : 'ask';
}

async function sendDirectInlineResult(tabId, request, result) {
  return chrome.tabs.sendMessage(tabId, {
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
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || pageKey(tab.url || tab.pendingUrl) !== pageKey(request.pageUrl)) {
      throw new Error('The originating page changed before Hermes could draft.');
    }
    const stored = await chrome.storage.local.get('hermesBrowserSettings');
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

        const chatResponse = await client.fetch(`/api/sessions/${encodeURIComponent(resolvedSessionId)}/chat`, {
          method: 'POST',
          body: JSON.stringify({
            ...attemptRouteRequest,
            message: buildInlineDraftPrompt(request),
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
  if (!chrome.storage?.session) return { ok: false, reason: 'Session-only draft handoff is unavailable in this browser.' };
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
    chrome.storage.session.set({ [INLINE_DRAFT_STORAGE_KEY]: queued }),
    openHermesPanel(sender.tab),
  ]);
  return { ok: true, requestId: request.requestId };
}

async function inlineSessionStatus() {
  const stored = await chrome.storage.local.get(['hermesBrowserSettings', INLINE_SESSION_STATE_KEY]);
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
    const sourceSidePanelPath = String(chrome.runtime.getManifest()?.side_panel?.default_path || 'sidepanel.html');
    const appPath = sourceSidePanelPath.startsWith('extension/') ? 'extension/app.html' : 'app.html';
    const appUrl = new URL(chrome.runtime.getURL(appPath));
    appUrl.searchParams.set('sessionId', sessionId);
    const sourceTabId = Number(sender?.tab?.id);
    if (Number.isFinite(sourceTabId) && sourceTabId > 0) appUrl.searchParams.set('sourceTabId', String(sourceTabId));
    appUrl.searchParams.set('sourceSurfaceId', 'inline-assist');
    await openHermesFullView(appUrl.href);
    return { ok: true, sessionId, surface };
  }

  const tab = sender?.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  await chrome.storage.session.set({
    [OPEN_SESSION_STORAGE_KEY]: {
      sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + INLINE_DRAFT_TTL_MS,
    },
  });
  const opened = await openHermesPanel(tab, { allowFallback: false });
  if (opened === false) {
    await chrome.storage.session.remove(OPEN_SESSION_STORAGE_KEY);
    return { ok: false, reason: 'The Browser side panel could not open. Choose Hermes Web instead.' };
  }
  return { ok: true, sessionId, surface };
}

async function configureContextMenus() {
  if (!chrome.contextMenus?.create) return;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ROOT_ID,
    title: 'Hermes Browser',
    contexts: ['page', 'selection', 'editable', 'link', 'image', 'video', 'audio'],
  });
  for (const item of CONTEXT_MENU_ITEMS) {
    chrome.contextMenus.create({
      id: item.id,
      parentId: CONTEXT_MENU_ROOT_ID,
      title: item.title,
      contexts: item.contexts,
    });
  }
}

function safeContextPageUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

async function handleContextMenuClick(info, tab) {
  const item = CONTEXT_MENU_ITEMS.find((candidate) => candidate.id === info?.menuItemId);
  if (!item || !tab?.id) return;
  if (item.id === 'hermes-browser-open') {
    await openHermesPanel(tab, { allowFallback: false });
    return;
  }
  if (item.inlineAction) {
    await chrome.tabs.sendMessage(tab.id, { type: 'HERMES_INLINE_CONTEXT_ACTION', actionId: item.inlineAction }).catch(() => null);
    return;
  }
  const selection = String(info?.selectionText || '').trim().slice(0, 8_000);
  if (!selection || !chrome.storage?.session) return;
  const stored = await chrome.storage.local.get('hermesBrowserSettings');
  const route = normalizeContextMenuRoute(stored?.hermesBrowserSettings?.contextMenuDefaultRoute);
  await chrome.storage.session.set({
    [CONTEXT_MENU_STORAGE_KEY]: {
      prompt: item.prompt,
      selection,
      pageUrl: safeContextPageUrl(info?.pageUrl || tab.url),
      tabId: Number(tab.id),
      route,
      createdAt: Date.now(),
      expiresAt: Date.now() + INLINE_DRAFT_TTL_MS,
    },
  });
  await openHermesPanel(tab, { allowFallback: false });
}

async function configureInstalledSurfaces() {
  await Promise.all([configureSidePanel(), configureContextMenus()]);
}

function defaultSidePanelPath() {
  return chrome.runtime.getManifest().side_panel?.default_path || 'sidepanel.html';
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
    const stored = await chrome.storage.local.get(['hermesBrowserSettings', 'panelResidencyMode']);
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
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
  if (!chrome.sidePanel?.setOptions) return;

  if (panelResidencyMode === PANEL_RESIDENCY_MODES.TAB_ATTACHED) {
    await chrome.sidePanel.setOptions({ enabled: false });
    if (useTabAttached) {
      await chrome.sidePanel.setOptions({
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
  await chrome.sidePanel.setOptions({
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
    await chrome.action.setPopup({ popup: '' });
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
      const candidates = await chrome.tabs.query({});
      existingTab = candidates.find((candidate) => (
        candidate.url === panelUrl || candidate.pendingUrl === panelUrl
      )) || null;
    } catch (queryError) {
      console.warn('[Hermes Browser] Could not search for an existing fallback tab:', queryError);
    }

    if (Number.isFinite(existingTab?.id)) {
      try {
        const activatedTab = await chrome.tabs.update(existingTab.id, { active: true });
        if (Number.isFinite(existingTab.windowId) && chrome.windows?.update) {
          try {
            await chrome.windows.update(existingTab.windowId, { focused: true });
          } catch (focusError) {
            console.warn('[Hermes Browser] Could not focus the existing fallback window:', focusError);
          }
        }
        return activatedTab || existingTab;
      } catch (activateError) {
        console.warn('[Hermes Browser] Existing fallback tab disappeared before activation:', activateError);
      }
    }

    return chrome.tabs.create({ url: panelUrl, active: true });
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
  const panelUrl = chrome.runtime.getURL(panelPath);

  // Try Opera/Firefox native sidebar first.
  const opened = await openNativeSidebar({ windowId: tab?.windowId ?? null });
  if (opened) return;

  // Chrome/Edge/Comet sidePanel API
  const sidePanelCanOpen = Boolean(chrome.sidePanel?.open);
  const browserId = detectBrowserId();

  try {
    if (sidePanelCanOpen) {
      await applyPanelResidencyMode(panelResidencyMode, { tabId: useTabAttached ? tabId : null });
      let attemptedWindowScope = false;
      if (useTabAttached) {
        try {
          const panelOpened = await openSidePanelWithConfirmation({
            sidePanelApi: chrome.sidePanel,
            runtimeApi: chrome.runtime,
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
            sidePanelApi: chrome.sidePanel,
            runtimeApi: chrome.runtime,
            openOptions: { windowId },
            panelUrl,
          });
          if (panelOpened) return;
        }
      }
      if (tab?.windowId && !attemptedWindowScope) {
        const { windowId } = tab;
        const panelOpened = await openSidePanelWithConfirmation({
          sidePanelApi: chrome.sidePanel,
          runtimeApi: chrome.runtime,
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
      await chrome.windows.create({
        url: chrome.runtime.getURL(panelPath),
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

async function openHermesFullView(requestedUrl = '') {
  const packagedAppUrl = new URL(chrome.runtime.getURL('app.html'));
  const rootDevAppUrl = new URL(chrome.runtime.getURL('extension/app.html'));
  const targetUrl = new URL(String(requestedUrl || packagedAppUrl.href));
  const allowedPaths = new Set([packagedAppUrl.pathname, rootDevAppUrl.pathname]);
  if (targetUrl.origin !== packagedAppUrl.origin || !allowedPaths.has(targetUrl.pathname)) {
    throw new Error('Refused to open a non-Hermes full-view URL.');
  }
  await chrome.tabs.create({ url: targetUrl.href, active: true });
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
      await chrome.tabs.sendMessage(tabId, { type: 'HERMES_GET_YOUTUBE_TRANSCRIPT_DOM' }),
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

chrome.runtime.onInstalled.addListener(configureInstalledSurfaces);
chrome.runtime.onStartup.addListener(configureInstalledSurfaces);
chrome.action.onClicked.addListener(openHermesPanel);
chrome.contextMenus?.onClicked?.addListener?.((info, tab) => {
  handleContextMenuClick(info, tab).catch((error) => console.warn('[Hermes Browser] Context menu action failed:', error));
});
chrome.tabs?.onActivated?.addListener?.(({ tabId }) => reapplyPanelResidencyForTab(tabId));
chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName !== 'local') return;
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.type === 'HERMES_INLINE_DRAFT_REQUEST'
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
