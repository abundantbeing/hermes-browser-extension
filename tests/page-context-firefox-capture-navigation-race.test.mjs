import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isPageContextCaptureUrlBlocked } from '../extension/lib/page-context-capture-guard.mjs';
import {
  createPageContextBundleRestartCoalescer,
  createPageContextGateEnsureRunner,
  pageContextBundleRestartFilesFromManifest,
  pageContextPolicyGrantMatchesAnchor,
  pageContextVerifyInstallAnchor,
  probePageContextBundleRestartNeeded,
  sealPageContextPolicyGrant,
  runPageContextBundleRestart,
} from '../extension/lib/page-context-bundle-restart.mjs';
import {
  packagedPageContextScriptFiles,
  pageContextAllowLocalDocumentsForUrl,
  pageContextHostPolicyDecision,
} from '../extension/lib/page-script-host-policy.mjs';
import { pageContextScriptInjectionTarget } from '../extension/lib/page-context-document-target.mjs';

const MANIFEST_FILES = packagedPageContextScriptFiles();
const gateUrl = new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url);
const captureGuardUrl = new URL('../extension/lib/page-context-capture-guard.js', import.meta.url);
const browserApiUrl = new URL('../extension/lib/browser-api-global.js', import.meta.url);
const contentUrl = new URL('../extension/content.js', import.meta.url);

test('Firefox capture race: navigate after allow reply during refresh blocks bundle restart', async () => {
  const settings = {
    pageContextOnPrivateNetworks: false,
    pageContextExcludedOrigins: [],
  };
  const policyForUrl = (url) => pageContextHostPolicyDecision(url, settings);
  let href = 'https://example.com/capture';
  const fileInjections = [];
  const startToken = `${new URL(href).origin}\u0000${href}`;
  const installBinding = {
    tabId: 41,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href,
    anchorToken: startToken,
    captureRequestAnchorToken: startToken,
  };
  const pageVm = await loadCaptureVm(href, policyForUrl);
  pageVm.loadContent();
  const baseRefresh = pageVm.globalThis.hermesRefreshPageScriptPolicy;
  pageVm.globalThis.hermesRefreshPageScriptPolicy = async function navigateAfterAllow() {
    const inject = await baseRefresh.call(pageVm.globalThis);
    href = 'http://localhost/capture';
    pageVm.globalThis.location = { href, origin: 'http://localhost' };
    return inject;
  };

  const executeScript = async (request) => {
    const liveHref = pageVm.globalThis.location.href;
    if (request.files) {
      fileInjections.push({ href: liveHref, files: [...request.files] });
      return [{ result: undefined }];
    }
    const source = request.func.toString();
    if (source.includes('location.href') && !source.includes('collectPageContext')) {
      return [{
        result: { href: liveHref, origin: new URL(liveHref).origin, token: `${new URL(liveHref).origin}\u0000${liveHref}` },
      }];
    }
    if (source.includes('HermesContentExtractor')) {
      return [{ result: { restart: true, extractorReady: false, bridgeLoaded: true } }];
    }
    if (source.includes('typeof globalThis.hermesRefreshPageScriptPolicy')) {
      return [{ result: true }];
    }
    if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
      await pageVm.run(request.func);
      pageVm.globalThis.location = { href: 'http://localhost/capture', origin: 'http://localhost' };
      return [{ result: { allowed: false, restart: false } }];
    }
    return [{ result: typeof request.func === 'function' ? await pageVm.run(request.func) : undefined }];
  };

  const verifyInstallBinding = async (binding) => {
    const target = pageContextScriptInjectionTarget(binding);
    const [row] = await executeScript({
      target,
      func: () => ({
        href: location.href,
        origin: location.origin,
        token: `${location.origin}\u0000${location.href}`,
      }),
    });
    const anchor = row?.result;
    if (!anchor) return false;
    const allowLocal = pageContextAllowLocalDocumentsForUrl(anchor.href, settings);
    return pageContextVerifyInstallAnchor(
      anchor,
      binding,
      policyForUrl,
      (url) => isPageContextCaptureUrlBlocked(url, { allowLocalDocuments: allowLocal }),
    );
  };

  const bundleRestart = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
    runBundleRestart: async (b) => {
      await runPageContextBundleRestart(
        executeScript,
        b,
        pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
        {
          verifyBinding: () => verifyInstallBinding(b),
          beforeInject: () => verifyInstallBinding(b),
          afterInject: () => verifyInstallBinding(b),
        },
      );
    },
  });

  let observedNav = false;
  const executeScriptWithNav = executeScript;
  const wrappedExecute = async (request) => {
    const source = request.func?.toString?.() || '';
    if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
      observedNav = true;
    }
    return executeScriptWithNav(request);
  };

  const runGateEnsureWrapped = createPageContextGateEnsureRunner({
    executeScript: wrappedExecute,
    manifestContentScriptFiles: () => [...MANIFEST_FILES],
    pageContextBundleRestartFiles: () => pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
    pageContextInjectionDecision: policyForUrl,
    acquireInstallBinding: async () => installBinding,
    verifyInstallBinding,
    awaitPageContextBundleRestart: bundleRestart.awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries: bundleRestart.reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded: (b) => probePageContextBundleRestartNeeded(wrappedExecute, b),
  });

  const allowed = await runGateEnsureWrapped(41, installBinding);
  assert.equal(allowed, false);
  assert.equal(observedNav, true, 'navigation after allow must run injected refresh');
  const injectedBundle = fileInjections.some((row) =>
    row.files.some((file) => file.endsWith('content.js') || file.endsWith('content-extractor.js')));
  assert.equal(injectedBundle, false);
  const capture = await pageVm.getPageContext();
  assert.equal(capture?.ok, false);
  assert.notEqual(capture?.text, 'LOCALHOST_SECRET');
});

test('Firefox capture race: allow reply then localhost navigation blocks restart and capture', async () => {
  const settings = {
    pageContextOnPrivateNetworks: false,
    pageContextExcludedOrigins: [],
  };
  const policyForUrl = (url) => pageContextHostPolicyDecision(url, settings);

  let href = 'https://example.com/capture';
  let phase = 'refresh';
  const fileInjections = [];
  let installBinding = {
    tabId: 40,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href,
    anchorToken: `${new URL(href).origin}\u0000${href}`,
    captureRequestAnchorToken: `${new URL(href).origin}\u0000${href}`,
  };

  const pageVm = await loadCaptureVm(href, policyForUrl);
  pageVm.loadContent();

  const executeScript = async (request) => {
    if (request.files) {
      fileInjections.push({ href, files: [...request.files] });
      return [{ result: undefined }];
    }
    const source = request.func.toString();
    if (source.includes('location.href') && !source.includes('collectPageContext')) {
      return [{
        result: { href, origin: new URL(href).origin, token: `${new URL(href).origin}\u0000${href}` },
      }];
    }
    if (source.includes('HermesContentExtractor')) {
      return [{ result: { restart: phase === 'post-restart', extractorReady: false, bridgeLoaded: true } }];
    }
    if (source.includes('typeof globalThis.hermesRefreshPageScriptPolicy')) {
      return [{ result: true }];
    }
    if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
      const outcome = await pageVm.run(request.func);
      phase = 'post-allow';
      return [{ result: outcome }];
    }
    return [{ result: typeof request.func === 'function' ? await pageVm.run(request.func) : undefined }];
  };

  async function verifyInstallBinding(binding) {
    const target = pageContextScriptInjectionTarget(binding);
    const [row] = await executeScript({
      target,
      func: () => ({
        href: location.href,
        origin: location.origin,
        token: `${location.origin}\u0000${location.href}`,
      }),
    });
    const anchor = row?.result;
    if (!anchor) return false;
    const allowLocal = pageContextAllowLocalDocumentsForUrl(anchor.href, settings);
    return pageContextVerifyInstallAnchor(
      anchor,
      binding,
      policyForUrl,
      (url) => isPageContextCaptureUrlBlocked(url, { allowLocalDocuments: allowLocal }),
    );
  }

  const bundleRestart = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
    runBundleRestart: async (b) => {
      phase = 'post-restart';
      href = 'http://localhost/capture';
      pageVm.globalThis.location = { href, origin: 'http://localhost' };
      await runPageContextBundleRestart(
        executeScript,
        b,
        pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
        {
          verifyBinding: () => verifyInstallBinding(b),
          beforeInject: () => verifyInstallBinding(b),
          afterInject: () => verifyInstallBinding(b),
        },
      );
    },
  });

  const runGateEnsure = createPageContextGateEnsureRunner({
    executeScript,
    manifestContentScriptFiles: () => [...MANIFEST_FILES],
    pageContextBundleRestartFiles: () => pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
    pageContextInjectionDecision: policyForUrl,
    acquireInstallBinding: async () => installBinding,
    verifyInstallBinding,
    awaitPageContextBundleRestart: bundleRestart.awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries: bundleRestart.reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
  });

  const allowed = await runGateEnsure(40, installBinding);
  assert.equal(allowed, false, 'restart must not succeed after navigation to blocked localhost');

  sealPageContextPolicyGrant(installBinding, {
    href: 'https://example.com/capture',
    token: 'https://example.com\u0000https://example.com/capture',
  });
  pageVm.navigate('http://localhost/capture');
  const localhostHref = 'http://localhost/capture';
  const currentAnchor = {
    href: localhostHref,
    token: `http://localhost\u0000${localhostHref}`,
  };
  assert.equal(pageContextPolicyGrantMatchesAnchor(installBinding, currentAnchor), false);
  const capture = await pageVm.getPageContext();
  assert.equal(capture?.ok, false);
  assert.notEqual(capture?.text, 'LOCALHOST_SECRET');

  const injectedBundle = fileInjections.some((row) =>
    row.href.startsWith('http://localhost') && row.files.some((f) => f.endsWith('content.js')));
  assert.equal(injectedBundle, false);
});

async function loadCaptureVm(href, policyForUrl) {
  const [gateSource, captureGuardSource, browserSource, contentSource] = await Promise.all([
    readFile(gateUrl, 'utf8'),
    readFile(captureGuardUrl, 'utf8'),
    readFile(browserApiUrl, 'utf8'),
    readFile(contentUrl, 'utf8'),
  ]);

  const context = {
    location: { href, origin: new URL(href).origin },
    browserApi: {
      runtime: {
        onMessage: {
          addListener(fn) { context.__captureListener = fn; },
          removeListener(fn) {
            if (context.__captureListener === fn) context.__captureListener = null;
          },
        },
        sendMessage: () => Promise.resolve(),
      },
    },
    browser: {
      runtime: {
        sendMessage(message) {
          const decision = policyForUrl(message?.url || context.location.href);
          return Promise.resolve({
            inject: decision.inject,
            seq: message.seq,
            allowLocalDocuments: false,
          });
        },
      },
    },
    chrome: null,
    document: { addEventListener() {} },
    window: {},
    HermesContentExtractor: {
      collectPageContext: () => ({
        ok: true,
        text: 'LOCALHOST_SECRET',
        selectedText: '',
        meta: {},
      }),
    },
    HermesSiteAdapters: {
      inspectSite: () => ({}),
      applySiteAdapterPolicy: (pageContext) => pageContext,
    },
    hermesIsPageContextCaptureUrlBlocked: (url, opts) => isPageContextCaptureUrlBlocked(url, opts),
    hermesAwaitPageScriptPolicy: (boot) => boot(),
    globalThis: {},
    URL,
  };
  context.globalThis = context;
  context.chrome = context.browserApi;
  context.hermesBrowserApi = context.browserApi;
  context.globalThis.hermesBrowserApi = context.browserApi;
  vm.createContext(context);

  vm.runInContext(gateSource, context);
  vm.runInContext(captureGuardSource, context);
  vm.runInContext(browserSource, context);
  context.hermesBrowserApi = context.browserApi;

  const token = `${new URL(href).origin}\u0000${href}`;
  context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = false;
  context.__HERMES_PAGE_SCRIPT_POLICY__ = { ...(context.__HERMES_PAGE_SCRIPT_POLICY__ || {}), policySeq: 1 };
  context.__HERMES_PAGE_SCRIPT_POLICY__.decided = true;
  context.__HERMES_PAGE_SCRIPT_POLICY__.latestInject = true;
  context.__HERMES_PAGE_SCRIPT_POLICY__.policyLocationToken = token;
  delete context.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__;

  return {
    globalThis: context,
    async run(fn) {
      return vm.runInContext(`(async () => (${fn})())()`, context);
    },
    navigate(nextHref) {
      context.location = { href: nextHref, origin: new URL(nextHref).origin };
    },
    loadContent() {
      if (context.__contentLoaded) return;
      context.hermesBrowserApi = context.browserApi;
      context.globalThis.hermesBrowserApi = context.browserApi;
      const bootNow = (fn) => fn();
      context.hermesAwaitPageScriptPolicy = bootNow;
      vm.runInContext(contentSource, context);
      context.__contentLoaded = true;
    },
    async getPageContext() {
      const listener = context.globalThis.__HERMES_BROWSER_CONTENT_LISTENER__;
      if (typeof listener !== 'function') return { ok: false };
      return new Promise((resolve) => {
        listener({ type: 'HERMES_GET_PAGE_CONTEXT', options: {} }, {}, (value) => resolve(value));
      });
    },
  };
}