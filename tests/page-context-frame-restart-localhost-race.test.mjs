import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isPageContextCaptureUrlBlocked } from '../extension/lib/page-context-capture-guard.mjs';
import {
  createPageContextBundleRestartCoalescer,
  createPageContextGateEnsureRunner,
  pageContextBundleRestartFilesFromManifest,
  pageContextVerifyInstallAnchor,
  probePageContextBundleRestartNeeded,
  runPageContextBundleRestart,
} from '../extension/lib/page-context-bundle-restart.mjs';
import {
  packagedPageContextScriptFiles,
  pageContextAllowLocalDocumentsForUrl,
  pageContextHostPolicyDecision,
} from '../extension/lib/page-script-host-policy.mjs';
import { pageContextScriptInjectionTarget } from '../extension/lib/page-context-document-target.mjs';

const MANIFEST_FILES = packagedPageContextScriptFiles();
const gateSourceUrl = new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url);
const captureGuardUrl = new URL('../extension/lib/page-context-capture-guard.js', import.meta.url);
const browserApiUrl = new URL('../extension/lib/browser-api-global.js', import.meta.url);

test('frame fallback gate ensure reinjects gate and blocks capture after localhost navigation race', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  let href = 'https://example.com/app';
  const fileInjections = [];
  const injectionDecision = (url) => pageContextHostPolicyDecision(url, settings);
  let binding = {
    tabId: 12,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href,
    anchorToken: `${new URL(href).origin}\u0000${href}`,
  };
  const pageVm = await loadFrameGateVm(href, injectionDecision);

  const executeScript = async (request) => {
    const target = request.target || {};
    if (request.files) {
      fileInjections.push({ href, files: [...request.files] });
      return [{ result: undefined }];
    }
    const source = request.func.toString();
    if (source.includes('location.href')) {
      return [{
        result: {
          href,
          origin: new URL(href).origin,
          token: `${new URL(href).origin}\u0000${href}`,
        },
      }];
    }
    if (source.includes('HermesContentExtractor')) {
      return [{ result: { restart: true, extractorReady: false, bridgeLoaded: true } }];
    }
    if (source.includes('typeof globalThis.hermesRefreshPageScriptPolicy')) {
      return [{ result: true }];
    }
    if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
      href = 'http://localhost/app';
      binding = {
        ...binding,
        href,
        anchorToken: `${new URL(href).origin}\u0000${href}`,
      };
      pageVm.globalThis.location = { href, origin: new URL(href).origin };
      const outcome = await pageVm.run(request.func);
      return [{ result: outcome }];
    }
    const result = typeof request.func === 'function' ? await pageVm.run(request.func) : undefined;
    return [{ result }];
  };

  async function verifyInstallBinding(currentBinding) {
    const target = pageContextScriptInjectionTarget(currentBinding);
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
      currentBinding,
      injectionDecision,
      (url) => isPageContextCaptureUrlBlocked(url, { allowLocalDocuments: allowLocal }),
    );
  }

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

  const runGateEnsure = createPageContextGateEnsureRunner({
    executeScript,
    manifestContentScriptFiles: () => [...MANIFEST_FILES],
    pageContextBundleRestartFiles: () => pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
    pageContextInjectionDecision: injectionDecision,
    acquireInstallBinding: async () => binding,
    verifyInstallBinding: verifyInstallBinding,
    awaitPageContextBundleRestart: bundleRestart.awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries: bundleRestart.reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
  });

  const allowed = await runGateEnsure(12, binding);
  assert.equal(allowed, false);
  const injectedBundle = fileInjections.some((row) =>
    row.files.some((file) => file.endsWith('content.js') || file.endsWith('content-extractor.js')));
  assert.equal(injectedBundle, false, 'must not boot bundle on blocked localhost');
});

test('frame fallback refresh on stable allowed page does not schedule bundle restart', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const href = 'https://example.com/stable';
  const injectionDecision = (url) => pageContextHostPolicyDecision(url, settings);
  const pageVm = await loadFrameGateVm(href, injectionDecision);
  const binding = {
    tabId: 13,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href,
    anchorToken: `${new URL(href).origin}\u0000${href}`,
  };
  const restarts = [];

  const executeScript = async (request) => {
    if (request.files) {
      restarts.push([...request.files]);
      return [{ result: undefined }];
    }
    const source = request.func.toString();
    if (source.includes('location.href')) {
      return [{
        result: {
          href,
          origin: new URL(href).origin,
          token: `${new URL(href).origin}\u0000${href}`,
        },
      }];
    }
    if (source.includes('HermesContentExtractor')) {
      return [{ result: { restart: false, extractorReady: true, bridgeLoaded: true } }];
    }
    if (source.includes('typeof globalThis.hermesRefreshPageScriptPolicy')) {
      return [{ result: true }];
    }
    if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
      return [{ result: await pageVm.run(request.func) }];
    }
    return [{ result: await pageVm.run(request.func) }];
  };

  const bundleRestart = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
    runBundleRestart: async () => { restarts.push(['restart']); },
  });

  const runGateEnsure = createPageContextGateEnsureRunner({
    executeScript,
    manifestContentScriptFiles: () => [...MANIFEST_FILES],
    pageContextBundleRestartFiles: () => pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
    pageContextInjectionDecision: injectionDecision,
    acquireInstallBinding: async () => binding,
    verifyInstallBinding: async () => true,
    awaitPageContextBundleRestart: bundleRestart.awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries: bundleRestart.reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
  });

  const allowed = await runGateEnsure(13, binding);
  assert.equal(allowed, true);
  assert.equal(restarts.length, 0);
});

async function loadFrameGateVm(href, injectionDecision) {
  const [gateSource, captureGuardSource, browserSource] = await Promise.all([
    readFile(gateSourceUrl, 'utf8'),
    readFile(captureGuardUrl, 'utf8'),
    readFile(browserApiUrl, 'utf8'),
  ]);
  const context = {
    location: { href, origin: new URL(href).origin },
    __HERMES_BROWSER_CONTENT_LOADED__: 'restart-race',
    bundleBoots: 0,
    browser: {
      runtime: {
        sendMessage(message) {
          const decision = injectionDecision(message?.url || href);
          return Promise.resolve({
            inject: decision.inject,
            seq: message.seq,
            allowLocalDocuments: false,
          });
        },
      },
    },
    globalThis: {},
    URL,
  };
  context.globalThis = context;
  vm.createContext(context);
  context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = false;
  context.__HERMES_PAGE_SCRIPT_POLICY__ = {
    decided: true,
    latestInject: true,
    policyLocationToken: `https://example.com\u0000https://example.com/app`,
    policySeq: 0,
  };
  vm.runInContext(gateSource, context);
  vm.runInContext(captureGuardSource, context);
  vm.runInContext(browserSource, context);
  const token = `${new URL(href).origin}\u0000${href}`;
  context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = false;
  context.__HERMES_PAGE_SCRIPT_POLICY__.decided = true;
  context.__HERMES_PAGE_SCRIPT_POLICY__.latestInject = true;
  context.__HERMES_PAGE_SCRIPT_POLICY__.policyLocationToken = token;
  delete context.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__;
  return {
    globalThis: context,
    async run(fn) {
      return vm.runInContext(`(async () => (${fn})())()`, context);
    },
  };
}