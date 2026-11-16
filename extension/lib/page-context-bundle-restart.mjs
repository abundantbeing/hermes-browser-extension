/** Coalesced page-context bundle reinstall and gate-ensure for one tab frame. */

export function pageContextBundleRestartKey(tabId, scriptTarget) {
  const frame = Math.max(0, Number(scriptTarget?.frameIds?.[0]) || 0);
  return `${tabId}\u0000${frame}`;
}

/** Gate-first bundle paths for dynamic reinstall (gate re-checks policy on every restart). */
export function pageContextBundleRestartFilesFromManifest(files = []) {
  const gateIdx = files.findIndex((file) => file.includes('page-context-bundle-gate'));
  return gateIdx >= 0 ? files.slice(gateIdx) : [...files];
}

export async function readPageScriptDocumentAnchor(executeScript, scriptTarget) {
  const [row] = await executeScript({
    target: scriptTarget,
    func: () => {
      let href = '';
      let origin = '';
      try {
        href = String(location.href || '');
        origin = String(location.origin || '');
      } catch {
        return null;
      }
      if (!href) return null;
      return { href, origin, token: `${origin}\u0000${href}` };
    },
  });
  const value = row?.result;
  return value && typeof value === 'object' && value.token ? value : null;
}

export function pageScriptDocumentAnchorsMatch(before, after) {
  if (!before || !after) return false;
  return before.token === after.token;
}

export function pageContextInstallAllowedForAnchor(anchor, injectionDecision) {
  if (!anchor?.href) return false;
  return injectionDecision(anchor.href).inject === true;
}

export async function probePageContextBundleRestartNeeded(executeScript, scriptTarget) {
  const [bundleState] = await executeScript({
    target: scriptTarget,
    func: () => {
      const restart = globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__ === true;
      if (restart) globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__ = false;
      return {
        restart,
        extractorReady: Boolean(globalThis.HermesContentExtractor?.collectPageContext),
        bridgeLoaded: Boolean(globalThis.__HERMES_BROWSER_CONTENT_LOADED__),
      };
    },
  });
  const state = bundleState?.result || {};
  return Boolean(state.restart || (state.bridgeLoaded && !state.extractorReady));
}

export async function runPageContextBundleRestart(executeScript, scriptTarget, restartFiles, hooks = {}) {
  if (hooks.beforeInject && (await hooks.beforeInject()) === false) return false;
  if (!restartFiles.length) return true;
  await executeScript({ target: scriptTarget, files: restartFiles });
  if (hooks.afterInject && (await hooks.afterInject()) === false) return false;
  await executeScript({
    target: scriptTarget,
    func: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  return true;
}

/**
 * @param {object} deps
 * @param {(scriptTarget: object) => Promise<boolean>} deps.probeRestartNeeded
 * @param {(scriptTarget: object) => Promise<void>} deps.runBundleRestart
 */
export function createPageContextBundleRestartCoalescer({ probeRestartNeeded, runBundleRestart }) {
  const pageContextBundleRestartByTarget = new Map();

  async function awaitPageContextBundleRestart(tabId, scriptTarget) {
    const pending = pageContextBundleRestartByTarget.get(pageContextBundleRestartKey(tabId, scriptTarget));
    if (pending) await pending;
  }

  async function reinstallPageContextBundleEntries(tabId, scriptTarget) {
    const key = pageContextBundleRestartKey(tabId, scriptTarget);
    while (true) {
      const existing = pageContextBundleRestartByTarget.get(key);
      if (existing) {
        await existing;
        if (!(await probeRestartNeeded(scriptTarget))) return;
        continue;
      }
      const run = (async () => {
        await runBundleRestart(scriptTarget);
      })();
      pageContextBundleRestartByTarget.set(key, run);
      try {
        await run;
      } finally {
        if (pageContextBundleRestartByTarget.get(key) === run) pageContextBundleRestartByTarget.delete(key);
      }
      return;
    }
  }

  return {
    pageContextBundleRestartByTarget,
    awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries,
  };
}

/**
 * @param {object} deps
 * @param {(request: object) => Promise<Array>} deps.executeScript
 * @param {() => string[]} deps.manifestContentScriptFiles
 * @param {() => string[]} deps.pageContextBundleRestartFiles
 * @param {(url: string) => { inject: boolean }} deps.pageContextInjectionDecision
 * @param {(tabId: number, scriptTarget: object) => Promise<void>} deps.awaitPageContextBundleRestart
 * @param {(tabId: number, scriptTarget: object) => Promise<void>} deps.reinstallPageContextBundleEntries
 * @param {(scriptTarget: object) => Promise<boolean>} deps.probePageContextBundleRestartNeeded
 */
export function createPageContextGateEnsureRunner(deps) {
  const {
    executeScript,
    manifestContentScriptFiles,
    pageContextBundleRestartFiles,
    pageContextInjectionDecision,
    awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded,
  } = deps;

  async function anchorStillAllowed(binding, scriptTarget) {
    const anchor = await readPageScriptDocumentAnchor(executeScript, scriptTarget);
    if (!pageScriptDocumentAnchorsMatch(binding, anchor)) return null;
    if (!pageContextInstallAllowedForAnchor(anchor, pageContextInjectionDecision)) return null;
    return anchor;
  }

  return async function runPageContextGateEnsureForTarget(tabId, target) {
    await awaitPageContextBundleRestart(tabId, target);
    try {
      const initial = await readPageScriptDocumentAnchor(executeScript, target);
      if (!pageContextInstallAllowedForAnchor(initial, pageContextInjectionDecision)) return false;

      const files = manifestContentScriptFiles();
      const gateFile = files.find((file) => file.includes('page-context-bundle-gate'));
      const [hasRefresh] = await executeScript({
        target,
        func: () => typeof globalThis.hermesRefreshPageScriptPolicy === 'function',
      });
      if (!hasRefresh?.result && gateFile) {
        if (!(await anchorStillAllowed(initial, target))) return false;
        await executeScript({ target, files: [gateFile] });
        if (!(await anchorStillAllowed(initial, target))) return false;
      }
      if (!(await anchorStillAllowed(initial, target))) return false;
      const [refreshed] = await executeScript({
        target,
        func: async () => {
          const refresh = globalThis.hermesRefreshPageScriptPolicy;
          if (typeof refresh !== 'function') return { allowed: false, restart: false };
          try {
            const allowed = Boolean(await refresh());
            const restart = globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__ === true;
            if (restart) globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__ = false;
            return { allowed, restart };
          } catch {
            return { allowed: false, restart: false };
          }
        },
      });
      if (!(await anchorStillAllowed(initial, target))) return false;
      const outcome = refreshed?.result || {};
      if (!outcome.allowed) return false;

      let needsRestart = outcome.restart || (await probePageContextBundleRestartNeeded(target));
      if (needsRestart) {
        if (!(await anchorStillAllowed(initial, target))) return false;
        await reinstallPageContextBundleEntries(tabId, target);
        await awaitPageContextBundleRestart(tabId, target);
        if (!(await anchorStillAllowed(initial, target))) return false;
        needsRestart = await probePageContextBundleRestartNeeded(target);
        if (needsRestart) {
          if (!(await anchorStillAllowed(initial, target))) return false;
          await reinstallPageContextBundleEntries(tabId, target);
        }
      }
      if (!(await anchorStillAllowed(initial, target))) return false;
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * @param {object} deps
 * @param {(tabId: number, scriptTarget: object | null) => object} deps.resolveTarget
 * @param {(tabId: number, target: object) => Promise<boolean>} deps.runPageContextGateEnsureForTarget
 */
export function createPageContextGateEnsureCoalescer({ resolveTarget, runPageContextGateEnsureForTarget }) {
  const pageContextGateEnsureByTarget = new Map();

  async function ensurePageContextGateAndRefresh(tabId, scriptTarget = null) {
    if (!tabId) return false;
    const target = resolveTarget(tabId, scriptTarget);
    const key = pageContextBundleRestartKey(tabId, target);
    const inflight = pageContextGateEnsureByTarget.get(key);
    if (inflight) return inflight;
    const run = runPageContextGateEnsureForTarget(tabId, target);
    pageContextGateEnsureByTarget.set(key, run);
    try {
      return await run;
    } finally {
      if (pageContextGateEnsureByTarget.get(key) === run) pageContextGateEnsureByTarget.delete(key);
    }
  }

  return { pageContextGateEnsureByTarget, ensurePageContextGateAndRefresh };
}