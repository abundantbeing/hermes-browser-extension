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
      const ctx = await loadFrameGateVm(href, injectionDecision);
      return [{ result: await ctx.hermesRefreshPageScriptPolicy() }];
    }
    return [{ result: await request.func() }];
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
  const injectedGate = fileInjections.some((row) => row.files[0]?.includes('page-context-bundle-gate'));
  assert.equal(injectedGate, true, 'frame fallback must inject gate before evaluating current location');
  const injectedBundle = fileInjections.some((row) =>
    row.files.some((file) => file.endsWith('content.js')));
  assert.equal(injectedBundle, false, 'must not boot bundle on blocked localhost');
});

async function loadFrameGateVm(href, injectionDecision) {
  const [gateSource, captureGuardSource, browserSource] = await Promise.all([
    readFile(gateSourceUrl, 'utf8'),
    readFile(captureGuardUrl, 'utf8'),
    readFile(browserApiUrl, 'utf8'),
  ]);
  const context = {
    get location() {
      return { href, origin: new URL(href).origin };
    },
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
  return context;
}