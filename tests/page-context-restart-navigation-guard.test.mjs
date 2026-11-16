import assert from 'node:assert/strict';
import test from 'node:test';

import { isPageContextCaptureUrlBlocked } from '../extension/lib/page-context-capture-guard.mjs';
import {
  buildRegisteredPageScriptDefinition,
  packagedPageContextScriptFiles,
  pageContextAllowLocalDocumentsForUrl,
  pageContextHostPolicyDecision,
} from '../extension/lib/page-script-host-policy.mjs';
import {
  createPageContextBundleRestartCoalescer,
  createPageContextGateEnsureRunner,
  pageContextBundleRestartFilesFromManifest,
  pageContextInstallBindingStillLive,
  pageContextVerifyInstallAnchor,
  probePageContextBundleRestartNeeded,
  runPageContextBundleRestart,
} from '../extension/lib/page-context-bundle-restart.mjs';
import {
  PageContextMissingGateError,
  pageContextScriptInjectionTarget,
} from '../extension/lib/page-context-document-target.mjs';

const MANIFEST_FILES = Object.freeze(packagedPageContextScriptFiles());

function hrefAnchor(href) {
  const origin = new URL(href).origin;
  return { href, origin, token: `${origin}\u0000${href}` };
}

function createDocumentBoundHarness({
  settings,
  enableDocumentIds = true,
  navigateOnRefresh = true,
  bundleComplete = false,
} = {}) {
  let currentHref = 'https://example.com/dashboard';
  let liveDocumentId = 'doc-example-001';
  let refreshNavigationObserved = false;
  const fileInjections = [];
  const documentById = new Map([
    ['doc-example-001', 'https://example.com/dashboard'],
    ['doc-localhost-002', 'http://localhost/dashboard'],
  ]);
  const settingsWithLocal = { ...settings };
  const injectionDecision = (url) => pageContextHostPolicyDecision(url, settingsWithLocal);

  const executeScript = async (request) => {
    const target = request.target || {};
    if (target.documentIds?.length) {
      const id = target.documentIds[0];
      const href = documentById.get(id);
      if (!href || id !== liveDocumentId) {
        throw new Error(`No document with id: ${id}`);
      }
      if (request.files) {
        fileInjections.push({ documentId: id, href, files: [...request.files] });
        return [{ result: undefined }];
      }
      const source = request.func.toString();
      if (source.includes('location.href')) {
        return [{ result: hrefAnchor(href) }];
      }
      if (source.includes('HermesContentExtractor')) {
        return [{
          result: bundleComplete
            ? { restart: false, extractorReady: true, bridgeLoaded: true }
            : { restart: true, extractorReady: false, bridgeLoaded: true },
        }];
      }
      if (source.includes('typeof globalThis.hermesRefreshPageScriptPolicy')) {
        return [{ result: true }];
      }
      if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
        if (typeof request.func === 'function') {
          await request.func().catch(() => ({ allowed: false, restart: false }));
        }
        if (navigateOnRefresh) {
          currentHref = 'http://localhost/dashboard';
          liveDocumentId = enableDocumentIds ? 'doc-localhost-002' : liveDocumentId;
          documentById.set('doc-localhost-002', currentHref);
          refreshNavigationObserved = true;
          return [{ result: { allowed: false, restart: false } }];
        }
        const decision = pageContextHostPolicyDecision(currentHref, settingsWithLocal);
        return [{ result: { allowed: decision.inject, restart: !bundleComplete && decision.inject } }];
      }
      const result = typeof request.func === 'function' ? await request.func() : undefined;
      return [{ result }];
    }
    if (target.frameIds?.length) {
      if (request.files) {
        fileInjections.push({ frame: true, href: currentHref, files: [...request.files] });
        return [{ result: undefined }];
      }
      const source = request.func.toString();
      if (source.includes('location.href')) {
        return [{ result: hrefAnchor(currentHref) }];
      }
      if (source.includes('HermesContentExtractor')) {
        return [{
          result: bundleComplete
            ? { restart: false, extractorReady: true, bridgeLoaded: true }
            : { restart: true, extractorReady: false, bridgeLoaded: true },
        }];
      }
      if (source.includes('typeof globalThis.hermesRefreshPageScriptPolicy')) {
        return [{ result: true }];
      }
      if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
        if (typeof request.func === 'function') {
          await request.func().catch(() => ({ allowed: false, restart: false }));
        }
        if (navigateOnRefresh) {
          currentHref = 'http://localhost/dashboard';
          liveDocumentId = enableDocumentIds ? 'doc-localhost-002' : liveDocumentId;
          documentById.set('doc-localhost-002', currentHref);
          refreshNavigationObserved = true;
          return [{ result: { allowed: false, restart: false } }];
        }
        const decision = pageContextHostPolicyDecision(currentHref, settingsWithLocal);
        return [{ result: { allowed: decision.inject, restart: !bundleComplete && decision.inject } }];
      }
      const result = typeof request.func === 'function' ? await request.func() : undefined;
      return [{ result }];
    }
    throw new Error('unexpected executeScript target');
  };

  async function acquireInstallBinding(tabId, frameId) {
    const documentId = enableDocumentIds ? 'doc-example-001' : null;
    const binding = {
      tabId,
      frameId,
      documentId,
      allowFrameFallback: !enableDocumentIds,
      href: currentHref,
      anchorToken: hrefAnchor(currentHref).token,
      captureRequestAnchorToken: hrefAnchor(currentHref).token,
    };
    if (!pageContextScriptInjectionTarget(binding)) return null;
    return binding;
  }

  async function verifyInstallBinding(binding) {
    if (!binding) return false;
    const live = await pageContextInstallBindingStillLive(binding, async () => liveDocumentId);
    if (!live) return false;
    const target = pageContextScriptInjectionTarget(binding);
    const [row] = await executeScript({
      target,
      func: () => ({ href: location.href, origin: location.origin, token: `${location.origin}\u0000${location.href}` }),
    });
    const anchor = row?.result;
    if (!anchor) return false;
    const allowLocal = pageContextAllowLocalDocumentsForUrl(anchor.href, settingsWithLocal);
    return pageContextVerifyInstallAnchor(
      anchor,
      binding,
      injectionDecision,
      (href) => isPageContextCaptureUrlBlocked(href, { allowLocalDocuments: allowLocal }),
    );
  }

  const bundleRestart = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: (binding) => probePageContextBundleRestartNeeded(executeScript, binding),
    runBundleRestart: async (binding) => {
      await runPageContextBundleRestart(
        executeScript,
        binding,
        pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
        {
          verifyBinding: verifyInstallBinding,
          beforeInject: async () => verifyInstallBinding(binding),
          afterInject: async () => verifyInstallBinding(binding),
        },
      );
    },
  });

  const runGateEnsure = createPageContextGateEnsureRunner({
    executeScript,
    manifestContentScriptFiles: () => [...MANIFEST_FILES],
    pageContextBundleRestartFiles: () => pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
    pageContextInjectionDecision: injectionDecision,
    acquireInstallBinding,
    verifyInstallBinding,
    awaitPageContextBundleRestart: bundleRestart.awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries: bundleRestart.reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded: (binding) => probePageContextBundleRestartNeeded(executeScript, binding),
  });

  return {
    runGateEnsure,
    fileInjections,
    getLiveDocumentId: () => liveDocumentId,
    getCurrentHref: () => currentHref,
    refreshNavigationObserved: () => refreshNavigationObserved,
  };
}

test('navigation to blocked origin between allow and restart does not inject bundle (documentId target)', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const { runGateEnsure, fileInjections, refreshNavigationObserved, getCurrentHref } = createDocumentBoundHarness({ settings, enableDocumentIds: true });

  const start = hrefAnchor('https://example.com/dashboard');
  const allowed = await runGateEnsure(7, {
    tabId: 7,
    frameId: 0,
    documentId: 'doc-example-001',
    allowFrameFallback: false,
    href: start.href,
    anchorToken: start.token,
    captureRequestAnchorToken: start.token,
  });

  assert.equal(allowed, false);
  assert.equal(refreshNavigationObserved(), true);
  assert.equal(getCurrentHref(), 'http://localhost/dashboard');
  assert.equal(fileInjections.length, 0, 'must not inject bundle after navigation to blocked origin');
});

test('frame-only fallback aborts when navigation reaches a blocked origin', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const { runGateEnsure, fileInjections, getCurrentHref, refreshNavigationObserved } = createDocumentBoundHarness({ settings, enableDocumentIds: false });

  const start = hrefAnchor('https://example.com/dashboard');
  const allowed = await runGateEnsure(8, {
    tabId: 8,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href: start.href,
    anchorToken: start.token,
    captureRequestAnchorToken: start.token,
  });

  assert.equal(allowed, false);
  assert.equal(refreshNavigationObserved(), true, 'policy refresh must observe navigation to blocked origin');
  assert.equal(getCurrentHref(), 'http://localhost/dashboard');
  const injectedBundle = fileInjections.some((row) =>
  row.files.some((file) => file.endsWith('content.js') || file.endsWith('content-extractor.js')));
  assert.equal(injectedBundle, false, 'must not inject bundle entries after navigation to blocked origin');
  const injectedGate = fileInjections.some((row) =>
    row.files.some((file) => file.includes('page-context-bundle-gate')));
  assert.equal(injectedGate, false, 'loaded frame must refresh policy without reinjecting gate');
});

test('frame fallback direct restart after navigation to localhost does not inject bundle files', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  let currentHref = 'https://example.com/app';
  const fileInjections = [];
  const binding = {
    tabId: 11,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    anchorToken: `${new URL(currentHref).origin}\u0000${currentHref}`,
    captureRequestAnchorToken: `${new URL(currentHref).origin}\u0000${currentHref}`,
  };
  const executeScript = async (request) => {
    if (request.files) {
      fileInjections.push([...request.files]);
      return [{ result: undefined }];
    }
    const source = request.func.toString();
    if (source.includes('location.href')) {
      return [{ result: { href: currentHref, origin: new URL(currentHref).origin, token: `${new URL(currentHref).origin}\u0000${currentHref}` } }];
    }
    if (typeof request.func === 'function') {
      await request.func();
    }
    return [{ result: undefined }];
  };
  currentHref = 'http://localhost/app';
  const injectionDecision = (url) => pageContextHostPolicyDecision(url, settings);
  const verify = async () => {
    const target = pageContextScriptInjectionTarget(binding);
    const [row] = await executeScript({
      target,
      func: () => ({ href: location.href, origin: location.origin, token: `${location.origin}\u0000${location.href}` }),
    });
    const allowLocal = pageContextAllowLocalDocumentsForUrl(row.result.href, settings);
    return pageContextVerifyInstallAnchor(
      row.result,
      binding,
      injectionDecision,
      (href) => isPageContextCaptureUrlBlocked(href, { allowLocalDocuments: allowLocal }),
    );
  };
  const ok = await runPageContextBundleRestart(
    executeScript,
    binding,
    pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
    {
      verifyBinding: verify,
      beforeInject: verify,
      afterInject: verify,
    },
  );
  assert.equal(ok, false);
  assert.equal(fileInjections.length, 0);
});

test('registered bundle restart list starts with gate from real manifest', () => {
  const packaged = buildRegisteredPageScriptDefinition({}, { packaged: true }).js;
  const restartFiles = pageContextBundleRestartFilesFromManifest(packaged);
  assert.equal(restartFiles[0], packagedPageContextScriptFiles()[0]);
  assert.match(restartFiles[0], /page-context-bundle-gate/);
});

test('restart file list without gate is a hard failure', () => {
  assert.throws(
    () => pageContextBundleRestartFilesFromManifest(['content.js']),
    PageContextMissingGateError,
  );
});

test('frame fallback unchanged allowed origin completes gate ensure with no bundle inject', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const { runGateEnsure, fileInjections, getCurrentHref, refreshNavigationObserved } = createDocumentBoundHarness({
    settings,
    enableDocumentIds: false,
    navigateOnRefresh: false,
    bundleComplete: true,
  });
  const start = hrefAnchor('https://example.com/dashboard');
  const allowed = await runGateEnsure(9, {
    tabId: 9,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href: start.href,
    anchorToken: start.token,
    captureRequestAnchorToken: start.token,
  });
  assert.equal(allowed, true);
  assert.equal(refreshNavigationObserved(), false);
  assert.equal(getCurrentHref(), 'https://example.com/dashboard');
  assert.equal(fileInjections.length, 0);
});