import {
  buildSidePanelPath,
  DEFAULT_PANEL_RESIDENCY_MODE,
  normalizePanelResidencyMode,
  PANEL_RESIDENCY_MODES,
} from './lib/panel-residency.mjs';
import {
  normalizeTranscriptPayload,
  parseTimedTextXml,
  parseYoutubeJson3,
  providerUrlForVideo,
} from './lib/transcript.mjs';

let cachedPanelResidencyMode = DEFAULT_PANEL_RESIDENCY_MODE;

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
  if (globalThis.opr?.sidebarAction || globalThis.chrome?.sidebarAction) return;
  if (!chrome.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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
    await applyPanelResidencyMode(panelResidencyMode, { tabId });
  } catch (error) {
    console.warn('[Hermes Browser] Unable to set side panel behavior:', error);
  }
}

function reapplyPanelResidencyForTab(tabId) {
  applyPanelResidencyMode(cachedPanelResidencyMode, { tabId })
    .catch((error) => console.warn('[Hermes Browser] Could not apply panel residency setting:', error));
}

async function openHermesPanel(tab) {
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

  // Try Opera native sidebar Action if available
  const sidebarAction = globalThis.opr?.sidebarAction || globalThis.chrome?.sidebarAction;
  if (sidebarAction && typeof sidebarAction.open === 'function') {
    try {
      await new Promise((resolve, reject) => {
        try {
          const res = sidebarAction.open((result) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve(result);
            }
          });
          if (res && typeof res.then === 'function') {
            res.then(resolve, reject);
          }
        } catch (e) {
          try {
            const res2 = sidebarAction.open();
            if (res2 && typeof res2.then === 'function') {
              res2.then(resolve, reject);
            } else {
              resolve();
            }
          } catch (innerErr) {
            reject(innerErr);
          }
        }
      });
      return;
    } catch (sidebarError) {
      console.warn('[Hermes Browser] Opera sidebar action open failed:', sidebarError);
    }
  }

  const sidePanelCanOpen = Boolean(chrome.sidePanel?.open);

  try {
    if (sidePanelCanOpen) {
      await applyPanelResidencyMode(panelResidencyMode, { tabId: useTabAttached ? tabId : null });
      if (useTabAttached) {
        try {
          await chrome.sidePanel.open({ tabId });
          return;
        } catch (tabOpenError) {
          if (!tab?.windowId) throw tabOpenError;
          const { windowId } = tab;
          console.warn('[Hermes Browser] Tab side panel open failed, retrying window side panel:', tabOpenError);
          await chrome.sidePanel.open({ windowId });
          return;
        }
      }
      if (tab?.windowId) {
        const { windowId } = tab;
        await chrome.sidePanel.open({ windowId });
        return;
      }
    }
  } catch (error) {
    console.warn('[Hermes Browser] Side panel open failed:', error);
    if (sidePanelCanOpen) return;
  }

  await chrome.tabs.create({ url: chrome.runtime.getURL(panelPath) });
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
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json, text/plain;q=0.9' } });
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
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
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

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup.addListener(configureSidePanel);
chrome.action.onClicked.addListener(openHermesPanel);
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
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'HERMES_GET_YOUTUBE_TRANSCRIPT') return false;
  getYoutubeTranscript(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, reason: error?.message || String(error) }));
  return true;
});
