/** Coalesced page-context bundle reinstall and gate-ensure for one tab frame. */

export function pageContextBundleRestartKey(tabId, scriptTarget) {
  const frame = Math.max(0, Number(scriptTarget?.frameIds?.[0]) || 0);
  return `${tabId}\u0000${frame}`;
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

export async function runPageContextBundleRestart(executeScript, scriptTarget, restartFiles) {
  if (!restartFiles.length) return;
  await executeScript({ target: scriptTarget, files: restartFiles });
  await executeScript({
    target: scriptTarget,
    func: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
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