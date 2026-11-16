/** Coalesced page-context bundle reinstall and gate-ensure for one tab frame/document. */

import {
  PageContextMissingGateError,
  pageContextInstallBindingKey,
  pageContextInstallBindingStillLive,
  pageContextScriptInjectionTarget,
} from './page-context-document-target.mjs';

const GATE_FILE_MARKER = 'page-context-bundle-gate';

export function pageContextBundleRestartKey(tabId, bindingOrLegacyTarget) {
  if (bindingOrLegacyTarget?.tabId && (bindingOrLegacyTarget.documentId || bindingOrLegacyTarget.allowFrameFallback != null)) {
    return pageContextInstallBindingKey(bindingOrLegacyTarget);
  }
  const frame = Math.max(0, Number(bindingOrLegacyTarget?.frameIds?.[0] ?? bindingOrLegacyTarget?.frameId) || 0);
  return `${tabId}\u0000f${frame}`;
}

/** Gate-first bundle paths for dynamic reinstall (gate re-checks policy on every restart). */
export function pageContextBundleRestartFilesFromManifest(files = []) {
  const list = Array.isArray(files) ? files : [];
  const gateIdx = list.findIndex((file) => file.includes(GATE_FILE_MARKER));
  if (gateIdx < 0) {
    throw new PageContextMissingGateError();
  }
  return list.slice(gateIdx);
}

export async function readPageScriptDocumentAnchor(executeScript, binding) {
  const target = pageContextScriptInjectionTarget(binding);
  if (!target) return null;
  const [row] = await executeScript({
    target,
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

export function shouldScheduleBundleRestart(outcome, anchorBefore, anchorAfter, bundleIncomplete) {
  if (!outcome?.allowed) return false;
  if (anchorBefore && anchorAfter && !pageScriptDocumentAnchorsMatch(anchorBefore, anchorAfter)) {
    return false;
  }
  if (!bundleIncomplete) return false;
  if (outcome.restart === true) return true;
  return true;
}

export function pageContextInstallAllowedForAnchor(anchor, injectionDecision) {
  if (!anchor?.href) return false;
  return injectionDecision(anchor.href).inject === true;
}

export function captureRequestAnchorToken(binding) {
  return binding?.captureRequestAnchorToken || binding?.anchorToken || null;
}

export function liveAnchorMatchesCaptureRequest(binding, anchor) {
  const requestToken = captureRequestAnchorToken(binding);
  if (!anchor?.token) return false;
  if (!requestToken) return false;
  return requestToken === anchor.token;
}

export function sealPageContextPolicyGrant(binding, anchor) {
  if (!binding || !anchor?.token) return false;
  if (!liveAnchorMatchesCaptureRequest(binding, anchor)) return false;
  binding.pageContextPolicyGrantToken = anchor.token;
  return true;
}

export function pageContextPolicyGrantMatchesAnchor(binding, anchor) {
  if (!liveAnchorMatchesCaptureRequest(binding, anchor)) return false;
  const requestToken = captureRequestAnchorToken(binding);
  if (binding?.pageContextPolicyGrantToken) {
    return binding.pageContextPolicyGrantToken === requestToken;
  }
  return Boolean(requestToken);
}

export function pageContextVerifyInstallAnchor(anchor, binding, injectionDecision, isCaptureBlocked) {
  if (!pageContextInstallAllowedForAnchor(anchor, injectionDecision)) return false;
  if (typeof isCaptureBlocked === 'function' && isCaptureBlocked(anchor.href)) return false;
  if (!pageContextPolicyGrantMatchesAnchor(binding, anchor)) return false;
  return true;
}

export async function probePageContextBundleRestartNeeded(executeScript, binding) {
  const target = pageContextScriptInjectionTarget(binding);
  if (!target) return false;
  const [bundleState] = await executeScript({
    target,
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

export function describePageContextBundleRestartInjection(binding, restartFiles) {
  const target = pageContextScriptInjectionTarget(binding);
  return {
    target,
    files: [...(restartFiles || [])],
    gateFirst: Boolean(restartFiles?.[0]?.includes(GATE_FILE_MARKER)),
  };
}

export async function runPageContextBundleRestart(executeScript, binding, restartFiles, hooks = {}) {
  const target = pageContextScriptInjectionTarget(binding);
  if (!target) return false;
  if (hooks.verifyBinding && !(await hooks.verifyBinding(binding))) return false;
  const anchorAtStart = await readPageScriptDocumentAnchor(executeScript, binding);
  if (!anchorAtStart) return false;
  if (captureRequestAnchorToken(binding) && !liveAnchorMatchesCaptureRequest(binding, anchorAtStart)) {
    return false;
  }
  if (hooks.beforeInject && (await hooks.beforeInject()) === false) return false;
  if (!restartFiles.length) return true;
  if (hooks.verifyBinding && !(await hooks.verifyBinding(binding))) return false;
  await executeScript({ target, files: restartFiles });
  if (hooks.afterInject && (await hooks.afterInject()) === false) return false;
  await executeScript({
    target,
    func: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  return true;
}

/**
 * @param {object} deps
 * @param {(binding: object) => Promise<boolean>} deps.probeRestartNeeded
 * @param {(binding: object) => Promise<void>} deps.runBundleRestart
 */
export function createPageContextBundleRestartCoalescer({ probeRestartNeeded, runBundleRestart }) {
  const pageContextBundleRestartByTarget = new Map();

  async function awaitPageContextBundleRestart(tabId, binding) {
    const pending = pageContextBundleRestartByTarget.get(pageContextBundleRestartKey(tabId, binding));
    if (pending) await pending;
  }

  async function reinstallPageContextBundleEntries(tabId, binding) {
    const key = pageContextBundleRestartKey(tabId, binding);
    while (true) {
      const existing = pageContextBundleRestartByTarget.get(key);
      if (existing) {
        await existing;
        if (!(await probeRestartNeeded(binding))) return;
        continue;
      }
      const run = (async () => {
        try {
          await runBundleRestart(binding);
        } catch {
          /* Fail closed: no bundle entries when restart is refused. */
        }
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
 * @param {(tabId: number, frameId: number) => Promise<object|null>} deps.acquireInstallBinding
 * @param {(binding: object) => Promise<boolean>} deps.verifyInstallBinding
 * @param {(tabId: number, binding: object) => Promise<void>} deps.awaitPageContextBundleRestart
 * @param {(tabId: number, binding: object) => Promise<void>} deps.reinstallPageContextBundleEntries
 * @param {(binding: object) => Promise<boolean>} deps.probePageContextBundleRestartNeeded
 */
export function createPageContextGateEnsureRunner(deps) {
  const {
    executeScript,
    manifestContentScriptFiles,
    pageContextBundleRestartFiles,
    pageContextInjectionDecision,
    acquireInstallBinding,
    verifyInstallBinding,
    awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded,
  } = deps;

  return async function runPageContextGateEnsureForTarget(tabId, request = {}) {
    const frameId = Math.max(0, Number(request?.frameIds?.[0] ?? request?.frameId) || 0);
    let binding = request?.documentId || request?.allowFrameFallback != null
      ? { ...request }
      : await acquireInstallBinding(tabId, frameId);
    if (!binding) return false;
    const firstAnchor = await readPageScriptDocumentAnchor(executeScript, binding);
    if (!firstAnchor || !liveAnchorMatchesCaptureRequest(request, firstAnchor)) return false;
    const frozenRequestToken = captureRequestAnchorToken(request) || captureRequestAnchorToken(binding);
    if (frozenRequestToken) {
      request.captureRequestAnchorToken = frozenRequestToken;
      binding.captureRequestAnchorToken = frozenRequestToken;
      binding.anchorToken = binding.anchorToken || frozenRequestToken;
    } else {
      binding.captureRequestAnchorToken = firstAnchor.token;
      binding.anchorToken = firstAnchor.token;
      request.captureRequestAnchorToken = firstAnchor.token;
      request.anchorToken = request.anchorToken || firstAnchor.token;
    }
    binding = { ...binding, href: firstAnchor.href };
    await awaitPageContextBundleRestart(tabId, binding);
    try {
      if (!(await verifyInstallBinding(binding))) return false;
      const initial = await readPageScriptDocumentAnchor(executeScript, binding);
      if (!liveAnchorMatchesCaptureRequest(request, initial)) return false;
      if (!pageContextInstallAllowedForAnchor(initial, pageContextInjectionDecision)) return false;

      const files = manifestContentScriptFiles();
      const gateFile = files.find((file) => file.includes(GATE_FILE_MARKER));
      const target = pageContextScriptInjectionTarget(binding);
      if (!target) return false;
      const [hasRefresh] = await executeScript({
        target,
        func: () => typeof globalThis.hermesRefreshPageScriptPolicy === 'function',
      });
      if (!hasRefresh?.result && gateFile) {
        if (!(await verifyInstallBinding(binding))) return false;
        if (!liveAnchorMatchesCaptureRequest(request, await readPageScriptDocumentAnchor(executeScript, binding))) {
          return false;
        }
        const gateInjected = await runPageContextBundleRestart(executeScript, binding, [gateFile], {
          verifyBinding: verifyInstallBinding,
          beforeInject: async () => verifyInstallBinding(binding),
          afterInject: async () => verifyInstallBinding(binding),
        });
        if (!gateInjected) return false;
      }
      if (!(await verifyInstallBinding(binding))) return false;
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
      if (!(await verifyInstallBinding(binding))) return false;
      const outcome = refreshed?.result || {};
      if (!outcome.allowed) return false;
      const anchorAfterAllow = await readPageScriptDocumentAnchor(executeScript, binding);
      if (!liveAnchorMatchesCaptureRequest(request, anchorAfterAllow)) return false;
      if (!pageContextInstallAllowedForAnchor(anchorAfterAllow, pageContextInjectionDecision)) return false;
      if (!pageScriptDocumentAnchorsMatch(initial, anchorAfterAllow)) return false;
      if (!sealPageContextPolicyGrant(binding, anchorAfterAllow)) return false;
      if (!sealPageContextPolicyGrant(request, anchorAfterAllow)) return false;
      if (!(await verifyInstallBinding(binding))) return false;

      const bundleIncomplete = await probePageContextBundleRestartNeeded(binding);
      let needsRestart = shouldScheduleBundleRestart(outcome, initial, anchorAfterAllow, bundleIncomplete);
      if (needsRestart) {
        const anchorBeforeRestart = await readPageScriptDocumentAnchor(executeScript, binding);
        if (!pageScriptDocumentAnchorsMatch(anchorAfterAllow, anchorBeforeRestart)) return false;
        if (!pageContextPolicyGrantMatchesAnchor(binding, anchorBeforeRestart)) return false;
        if (!(await verifyInstallBinding(binding))) return false;
        try {
          await reinstallPageContextBundleEntries(tabId, binding);
        } catch {
          return false;
        }
        await awaitPageContextBundleRestart(tabId, binding);
        if (!(await verifyInstallBinding(binding))) return false;
        if (!liveAnchorMatchesCaptureRequest(request, await readPageScriptDocumentAnchor(executeScript, binding))) {
          return false;
        }
        needsRestart = await probePageContextBundleRestartNeeded(binding);
        if (needsRestart) {
          if (!(await verifyInstallBinding(binding))) return false;
          try {
            await reinstallPageContextBundleEntries(tabId, binding);
          } catch {
            return false;
          }
        }
      }
      if (!(await verifyInstallBinding(binding))) return false;
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * @param {object} deps
 * @param {(tabId: number, scriptTarget: object | null) => Promise<object>|object} deps.resolveBinding
 * @param {(tabId: number, binding: object) => Promise<boolean>} deps.runPageContextGateEnsureForTarget
 */
export function createPageContextGateEnsureCoalescer({ resolveBinding, runPageContextGateEnsureForTarget }) {
  const pageContextGateEnsureByTarget = new Map();

  async function ensurePageContextGateAndRefresh(tabId, scriptTarget = null) {
    if (!tabId) return false;
    const binding = await resolveBinding(tabId, scriptTarget);
    if (!binding) return false;
    const key = pageContextBundleRestartKey(tabId, binding);
    const inflight = pageContextGateEnsureByTarget.get(key);
    if (inflight) return inflight;
    const run = runPageContextGateEnsureForTarget(tabId, binding);
    pageContextGateEnsureByTarget.set(key, run);
    try {
      return await run;
    } finally {
      if (pageContextGateEnsureByTarget.get(key) === run) pageContextGateEnsureByTarget.delete(key);
    }
  }

  return { pageContextGateEnsureByTarget, ensurePageContextGateAndRefresh };
}

export { pageContextInstallBindingStillLive };