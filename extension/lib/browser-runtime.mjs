/**
 * Browser runtime detection and panel host abstraction for Hermes Browser Extension.
 *
 * Detects the active browser (Chrome/Edge/Comet, Opera, Firefox, Safari) and
 * provides a unified interface for opening/residency that prefers native
 * sidePanel/sidebarAction APIs and falls back to an extension tab.
 */

import { getBrowserApi } from './browser-api.mjs';

const BROWSER_IDS = Object.freeze({
  ARC: 'arc',
  BRAVE: 'brave',
  CHROME: 'chrome',
  CHROMIUM: 'chromium',
  COMET: 'comet',
  EDGE: 'edge',
  OPERA: 'opera',
  OPERA_GX: 'opera-gx',
  FIREFOX: 'firefox',
  SAFARI: 'safari',
  UNKNOWN: 'unknown',
});

function browserProduct(id, label, engine, confidence, source) {
  return Object.freeze({ id, label, engine, confidence, source });
}

function normalizedBrandNames(brands = []) {
  return (Array.isArray(brands) ? brands : [])
    .map((entry) => String(entry?.brand || entry || '').trim().toLowerCase())
    .filter(Boolean);
}

function detectBrowserProduct({
  userAgent = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '',
  brands = (typeof navigator !== 'undefined' ? navigator.userAgentData?.brands : []) || [],
  braveApi = typeof navigator !== 'undefined' ? navigator.brave : null,
  extensionUrl = '',
} = {}) {
  const ua = String(userAgent || '');
  const url = String(extensionUrl || '');
  const brandNames = normalizedBrandNames(brands);

  if (typeof braveApi?.isBrave === 'function') {
    return browserProduct(BROWSER_IDS.BRAVE, 'Brave', 'chromium', 'high', 'runtime-api');
  }
  if (/^comet-extension:/i.test(url) || /\bComet\//i.test(ua) || brandNames.some((brand) => brand.includes('comet'))) {
    return browserProduct(
      BROWSER_IDS.COMET,
      'Perplexity Comet',
      'chromium',
      'high',
      /^comet-extension:/i.test(url) ? 'extension-scheme' : (/\bComet\//i.test(ua) ? 'user-agent' : 'runtime-brand'),
    );
  }
  if (/^moz-extension:/i.test(url)) {
    return browserProduct(BROWSER_IDS.FIREFOX, 'Firefox', 'gecko', 'high', 'extension-scheme');
  }
  if (/^safari-web-extension:/i.test(url)) {
    return browserProduct(BROWSER_IDS.SAFARI, 'Safari', 'webkit', 'high', 'extension-scheme');
  }
  if (brandNames.some((brand) => brand.includes('opera gx')) || /\bOpera GX\//i.test(ua)) {
    return browserProduct(BROWSER_IDS.OPERA_GX, 'Opera GX', 'chromium', 'high', 'runtime-brand');
  }
  if (brandNames.some((brand) => brand === 'arc' || brand.includes('arc browser')) || /\bArc\//i.test(ua)) {
    return browserProduct(BROWSER_IDS.ARC, 'Arc', 'chromium', 'high', 'runtime-brand');
  }
  if (/\bOPR\/|Opera\b/i.test(ua) || brandNames.some((brand) => brand.includes('opera'))) {
    return browserProduct(BROWSER_IDS.OPERA, 'Opera / Opera GX', 'chromium', 'high', 'user-agent');
  }
  if (/\bEdg(?:A|iOS)?\//i.test(ua) || brandNames.some((brand) => brand.includes('microsoft edge'))) {
    return browserProduct(BROWSER_IDS.EDGE, 'Microsoft Edge', 'chromium', 'high', 'user-agent');
  }
  if (/\bFirefox\b/i.test(ua)) {
    return browserProduct(BROWSER_IDS.FIREFOX, 'Firefox', 'gecko', 'high', 'user-agent');
  }
  if (/\bSafari\b/i.test(ua) && !/\b(?:HeadlessChrome|Chrome|Chromium|CriOS)\b/i.test(ua)) {
    return browserProduct(BROWSER_IDS.SAFARI, 'Safari', 'webkit', 'high', 'user-agent');
  }
  if (brandNames.some((brand) => brand === 'google chrome')) {
    return browserProduct(BROWSER_IDS.CHROME, 'Google Chrome', 'chromium', 'high', 'user-agent-data');
  }
  if (/\b(?:HeadlessChrome|Chrome|Chromium|CriOS)\//i.test(ua) || brandNames.some((brand) => brand === 'chromium')) {
    return browserProduct(BROWSER_IDS.CHROMIUM, 'Chromium browser', 'chromium', 'masked', 'engine-only');
  }
  return browserProduct(BROWSER_IDS.UNKNOWN, 'Supported browser', 'unknown', 'unknown', 'unavailable');
}

function browserMicrophoneSettingsUrl({ product = detectBrowserProduct(), extensionUrl = '' } = {}) {
  if (product?.id === BROWSER_IDS.FIREFOX || product?.engine === 'gecko') return '';
  if (product?.id === BROWSER_IDS.SAFARI || product?.engine === 'webkit') return '';

  const settingsScheme = product?.id === BROWSER_IDS.EDGE ? 'edge'
    : product?.id === BROWSER_IDS.BRAVE ? 'brave'
      : [BROWSER_IDS.OPERA, BROWSER_IDS.OPERA_GX].includes(product?.id) ? 'opera'
        : product?.engine === 'chromium' ? 'chrome'
          : '';
  if (!settingsScheme) return '';

  try {
    const parsed = new URL(String(extensionUrl || ''));
    const extensionOrigin = `${parsed.protocol}//${parsed.host}/`;
    if (!parsed.host) return `${settingsScheme}://settings/content/microphone`;
    return `${settingsScheme}://settings/content/siteDetails?site=${encodeURIComponent(extensionOrigin)}`;
  } catch {
    return `${settingsScheme}://settings/content/microphone`;
  }
}

function hasMethod(owner, method) {
  return typeof owner?.[method] === 'function';
}

function probeBrowserCapabilities({
  product = detectBrowserProduct(),
  api = getBrowserApi() || {},
  sidebarAction = getSidebarAction(),
  speechRecognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null,
} = {}) {
  const apis = Object.freeze({
    action: Boolean(api?.action),
    commands: Boolean(api?.commands),
    contextMenus: hasMethod(api?.contextMenus, 'create'),
    debugger: hasMethod(api?.debugger, 'attach') && hasMethod(api?.debugger, 'sendCommand'),
    downloads: hasMethod(api?.downloads, 'download'),
    offscreen: hasMethod(api?.offscreen, 'createDocument'),
    scripting: hasMethod(api?.scripting, 'executeScript'),
    sidePanel: hasMethod(api?.sidePanel, 'open'),
    sidebarAction: hasMethod(sidebarAction, 'open') || hasMethod(sidebarAction, 'setOpenState'),
    storage: hasMethod(api?.storage?.local, 'get') && hasMethod(api?.storage?.local, 'set'),
    tabGroups: Boolean(api?.tabGroups),
    tabs: hasMethod(api?.tabs, 'query'),
    voiceRecognition: typeof speechRecognition === 'function',
    windows: Boolean(api?.windows),
  });
  return Object.freeze({
    product,
    panelHost: apis.sidePanel ? 'side-panel' : (apis.sidebarAction ? 'sidebar' : 'full-tab'),
    apis,
    fallbacks: Object.freeze({ fullTab: true }),
  });
}

function detectBrowserId({
  userAgent = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '',
  braveApi = typeof navigator !== 'undefined' ? navigator.brave : null,
} = {}) {
  // Brave exposes navigator.brave.isBrave on every page; its presence is the
  // stable synchronous runtime signal. Do not call the async isBrave() probe.
  if (typeof braveApi?.isBrave === 'function') return BROWSER_IDS.BRAVE;
  // Check UA first — more reliable than globalThis.opr which may not exist
  // in the MV3 service worker context even on Opera.
  if (/\bOPR\/|Opera\b/i.test(userAgent)) return BROWSER_IDS.OPERA;
  if (typeof globalThis !== 'undefined' && globalThis.opr?.sidebarAction) return BROWSER_IDS.OPERA;
  if (getBrowserApi()?.sidebarAction) return BROWSER_IDS.FIREFOX;
  if (/\bFirefox\b/i.test(userAgent)) return BROWSER_IDS.FIREFOX;
  if (/\bSafari\b/i.test(userAgent) && !/\bChrome\b/i.test(userAgent)) return BROWSER_IDS.SAFARI;
  return BROWSER_IDS.CHROMIUM;
}

function getSidebarAction() {
  if (typeof globalThis === 'undefined') return null;
  // Opera can expose sidebarAction on opr.sidebarAction; Firefox exposes it
  // through its selected WebExtension namespace.
  return globalThis.opr?.sidebarAction || getBrowserApi()?.sidebarAction || null;
}

function hasChromeSidePanel() {
  return Boolean(getBrowserApi()?.sidePanel?.open);
}

function hasSidebarAction() {
  const sa = getSidebarAction();
  if (!sa) return false;
  // Must have at least one of the known open methods
  return typeof sa.open === 'function' || typeof sa.setOpenState === 'function';
}

/**
 * Open the browser's native sidebar/side panel for the current window.
 * Returns true if the native path handled the open; false if a fallback
 * (extension tab) should be used.
 *
 * Opera uses sidebarAction.setOpenState(true), not .open().
 * Firefox uses sidebarAction.open() (promise/callback based).
 */
async function openNativeSidebar({ windowId = null } = {}) {
  const sidebarAction = getSidebarAction();
  if (!sidebarAction) return false;

  try {
    // Opera: sidebarAction.setOpenState(true) — no .open() method
    if (typeof sidebarAction.setOpenState === 'function') {
      await new Promise((resolve) => {
        try {
          const result = sidebarAction.setOpenState(true);
          if (result && typeof result.then === 'function') {
            result.then(resolve, resolve);
          } else {
            resolve();
          }
        } catch {
          resolve(); // best-effort — sidebar may already be open
        }
      });
      return true;
    }

    // Firefox: sidebarAction.open() — promise or callback based
    if (typeof sidebarAction.open === 'function') {
      await new Promise((resolve, reject) => {
        try {
          const result = sidebarAction.open();
          if (result && typeof result.then === 'function') {
            result.then(resolve, reject);
          } else {
            resolve();
          }
        } catch (err) {
          // Some implementations require a callback
          try {
            const cbResult = sidebarAction.open(() => {
              const lastError = getBrowserApi()?.runtime?.lastError;
              if (lastError) reject(lastError);
              else resolve();
            });
            if (cbResult && typeof cbResult.then === 'function') {
              cbResult.then(resolve, reject);
            }
          } catch {
            resolve(); // best-effort
          }
        }
      });
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[Hermes Browser] Native sidebar open failed:', err);
    return false;
  }
}

/**
 * Set panel behavior — toolbar click opens panel.
 * Chrome uses chrome.sidePanel.setPanelBehavior.
 * Opera/Firefox sidebarAction does not have a direct equivalent; the
 * _execute_sidebar_action manifest command handles keyboard shortcut.
 */
async function setActionClickPanelBehavior({
  browserId = detectBrowserId(),
  sidePanelApi = getBrowserApi()?.sidePanel,
} = {}) {
  // Brave: disable browser-owned automatic action ownership so the toolbar
  // click and _execute_action reach the extension's confirmed manual path.
  if (browserId === BROWSER_IDS.BRAVE) {
    if (!sidePanelApi?.setPanelBehavior) return;
    await sidePanelApi.setPanelBehavior({ openPanelOnActionClick: false });
    return;
  }

  // Opera/Firefox sidebarAction: no setPanelBehavior equivalent —
  // the _execute_sidebar_action manifest command handles keyboard shortcut
  // and toolbar click opens the sidebar via the sidebar_action manifest key.
  // But Opera also supports chrome.sidePanel — if available, set it too
  // so both the sidebar and sidePanel paths work.
  if (browserId === BROWSER_IDS.OPERA || browserId === BROWSER_IDS.FIREFOX) {
    // Still set Chrome sidePanel behavior if Opera supports it (it often does)
    if (sidePanelApi?.setPanelBehavior) {
      try {
        await sidePanelApi.setPanelBehavior({ openPanelOnActionClick: true });
      } catch {
        // Opera may not fully support this — best-effort
      }
    }
    return;
  }

  // Chrome/Edge/Comet sidePanel
  if (!sidePanelApi?.setPanelBehavior) return;
  await sidePanelApi.setPanelBehavior({ openPanelOnActionClick: true });
}

/**
 * Brave-only action icon override: the Nous Girl mark, generated from the
 * exact tracked source asset. Other browsers keep the manifest boxed icon.
 */
const BRAVE_ACTION_ICON_PATHS = Object.freeze({
  16: 'assets/icons/brave-nous-girl-16.png',
  32: 'assets/icons/brave-nous-girl-32.png',
  48: 'assets/icons/brave-nous-girl-48.png',
  128: 'assets/icons/brave-nous-girl-128.png',
});

function actionIconPathsForBrowser(browserId = detectBrowserId()) {
  return browserId === BROWSER_IDS.BRAVE ? { ...BRAVE_ACTION_ICON_PATHS } : null;
}

/**
 * Apply the browser-specific action icon. Best-effort: a missing API or a
 * rejected setIcon returns false and never throws, so icon setup cannot
 * block panel configuration.
 */
async function setActionIconForBrowser({
  browserId = detectBrowserId(),
  actionApi = getBrowserApi()?.action,
} = {}) {
  const path = actionIconPathsForBrowser(browserId);
  if (!path || typeof actionApi?.setIcon !== 'function') return false;
  try {
    await actionApi.setIcon({ path });
    return true;
  } catch (error) {
    console.warn('[Hermes Browser] Unable to apply browser-specific action icon:', error);
    return false;
  }
}

/**
 * Determine whether the extension should use native sidePanel (Chrome)
 * or native sidebarAction (Opera/Firefox) for panel residency.
 */
function nativePanelMode() {
  if (hasChromeSidePanel()) return 'chrome-sidePanel';
  if (hasSidebarAction()) return 'sidebarAction';
  return 'extension-tab';
}

function panelScopeMatches(candidate = {}, openOptions = {}) {
  if (Number.isFinite(openOptions.tabId)) return Number(candidate.tabId) === Number(openOptions.tabId);
  if (Number.isFinite(openOptions.windowId)) return Number(candidate.windowId) === Number(openOptions.windowId);
  return true;
}

function extensionLocalPath(value = '') {
  const text = String(value || '');
  if (!text) return '';
  try {
    const url = new URL(text);
    return `${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`;
  } catch {
    return text.replace(/^\/+/, '');
  }
}

function chromiumMajorVersion(userAgent = '') {
  const match = /\b(?:HeadlessChrome|Chrome|Chromium)\/(\d+)/i.exec(String(userAgent));
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Some Chromium forks resolve sidePanel.open() without displaying the panel.
 * Chrome 141+'s onOpened event is authoritative; context existence alone is
 * not proof of visible UI in modern partial implementations. Fall back to the
 * MV3 context registry only on Chrome 116-140.
 */
async function openSidePanelWithConfirmation({
  sidePanelApi,
  runtimeApi,
  openOptions = {},
  panelUrl = '',
  pollDelays = [0, 75, 150, 300, 500],
  userAgent = globalThis.navigator?.userAgent || '',
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof sidePanelApi?.open !== 'function') return false;

  const expectedPanelPath = extensionLocalPath(panelUrl);
  const panelPathMatches = (value) => !expectedPanelPath || extensionLocalPath(value) === expectedPanelPath;
  let openedByEvent = false;
  const onOpened = (info = {}) => {
    if (panelScopeMatches(info, openOptions) && panelPathMatches(info.path)) openedByEvent = true;
  };
  const openedEvent = sidePanelApi?.onOpened;
  const confirmsWithOpenedEvent = typeof openedEvent?.addListener === 'function';
  const requiresOpenedEvent = confirmsWithOpenedEvent || chromiumMajorVersion(userAgent) >= 141;
  if (confirmsWithOpenedEvent) openedEvent.addListener(onOpened);

  try {
    await sidePanelApi.open(openOptions);
    for (const delay of pollDelays) {
      if (delay > 0) await wait(delay);
      if (openedByEvent) return true;
      if (requiresOpenedEvent) continue;
      if (typeof runtimeApi?.getContexts !== 'function') continue;
      try {
        const query = { contextTypes: ['SIDE_PANEL'] };
        if (panelUrl) query.documentUrls = [panelUrl];
        const contexts = await runtimeApi.getContexts(query);
        const panelOpened = (contexts || []).some((context) => (
          context?.contextType === 'SIDE_PANEL'
          && panelScopeMatches(context, openOptions)
          && panelPathMatches(context.documentUrl)
        ));
        if (panelOpened) return true;
      } catch {
        // A partial sidePanel implementation is not proof that a panel opened.
      }
    }
    return false;
  } finally {
    openedEvent?.removeListener?.(onOpened);
  }
}

export {
  BROWSER_IDS,
  actionIconPathsForBrowser,
  browserMicrophoneSettingsUrl,
  detectBrowserId,
  detectBrowserProduct,
  getSidebarAction,
  hasChromeSidePanel,
  hasSidebarAction,
  openNativeSidebar,
  openSidePanelWithConfirmation,
  probeBrowserCapabilities,
  setActionClickPanelBehavior,
  setActionIconForBrowser,
  nativePanelMode,
};
