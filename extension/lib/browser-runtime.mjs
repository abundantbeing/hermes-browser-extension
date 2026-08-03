/**
 * Browser runtime detection and panel host abstraction for Hermes Browser Extension.
 *
 * Detects the active browser (Chrome/Edge/Comet, Opera, Firefox, Safari) and
 * provides a unified interface for opening/residency that prefers native
 * sidePanel/sidebarAction APIs and falls back to an extension tab.
 */

const BROWSER_IDS = Object.freeze({
  BRAVE: 'brave',
  CHROMIUM: 'chromium',
  OPERA: 'opera',
  FIREFOX: 'firefox',
  SAFARI: 'safari',
  UNKNOWN: 'unknown',
});

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
  if (typeof globalThis !== 'undefined' && globalThis.browser?.sidebarAction) return BROWSER_IDS.FIREFOX;
  if (/\bFirefox\b/i.test(userAgent)) return BROWSER_IDS.FIREFOX;
  if (/\bSafari\b/i.test(userAgent) && !/\bChrome\b/i.test(userAgent)) return BROWSER_IDS.SAFARI;
  return BROWSER_IDS.CHROMIUM;
}

function getSidebarAction() {
  if (typeof globalThis === 'undefined') return null;
  // Opera exposes sidebarAction on chrome.sidebarAction or opr.sidebarAction
  return globalThis.opr?.sidebarAction || globalThis.browser?.sidebarAction || globalThis.chrome?.sidebarAction || null;
}

function hasChromeSidePanel() {
  return typeof globalThis !== 'undefined' && Boolean(globalThis.chrome?.sidePanel?.open);
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
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
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
  sidePanelApi = globalThis.chrome?.sidePanel,
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
  actionApi = globalThis.chrome?.action,
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
  detectBrowserId,
  getSidebarAction,
  hasChromeSidePanel,
  hasSidebarAction,
  openNativeSidebar,
  openSidePanelWithConfirmation,
  setActionClickPanelBehavior,
  setActionIconForBrowser,
  nativePanelMode,
};
