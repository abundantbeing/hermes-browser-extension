import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createPageContextBundleRestartCoalescer,
  createPageContextGateEnsureRunner,
  pageContextBundleRestartFilesFromManifest,
  probePageContextBundleRestartNeeded,
} from '../extension/lib/page-context-bundle-restart.mjs';
import {
  packagedPageContextScriptFiles,
  pageContextHostPolicyDecision,
} from '../extension/lib/page-script-host-policy.mjs';
import { pageContextScriptInjectionTarget } from '../extension/lib/page-context-document-target.mjs';

const gateSourceUrl = new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url);

test('Firefox frame fallback refresh does not reinject gate or restart an already-loaded bundle', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const href = 'https://example.com/pick';
  const fileInjections = [];
  const injectionDecision = (url) => pageContextHostPolicyDecision(url, settings);
  const binding = {
    tabId: 20,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href,
    anchorToken: `${new URL(href).origin}\u0000${href}`,
  };

  const pageVm = await loadLoadedFrameVm(href, injectionDecision);

  const executeScript = async (request) => {
    const target = request.target || {};
    if (request.files) {
      fileInjections.push([...request.files]);
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
      return [{
        result: {
          restart: false,
          extractorReady: true,
          bridgeLoaded: true,
        },
      }];
    }
    if (source.includes('typeof globalThis.hermesRefreshPageScriptPolicy')) {
      return [{ result: true }];
    }
    if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
      const outcome = await pageVm.run(request.func);
      return [{ result: outcome }];
    }
    const result = typeof request.func === 'function' ? await pageVm.run(request.func) : undefined;
    return [{ result }];
  };

  const bundleRestart = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
    runBundleRestart: async () => {
      fileInjections.push(['bundle-restart']);
    },
  });

  const runGateEnsure = createPageContextGateEnsureRunner({
    executeScript,
    manifestContentScriptFiles: () => [...packagedPageContextScriptFiles()],
    pageContextBundleRestartFiles: () => pageContextBundleRestartFilesFromManifest(packagedPageContextScriptFiles()),
    pageContextInjectionDecision: injectionDecision,
    acquireInstallBinding: async () => binding,
    verifyInstallBinding: async () => true,
    awaitPageContextBundleRestart: bundleRestart.awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries: bundleRestart.reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
  });

  pageVm.globalThis.__HERMES_ELEMENT_PICK_ACTIVE__ = true;
  pageVm.globalThis.__HERMES_COMMENT_PINS_VISIBLE__ = true;

  const first = await runGateEnsure(20, binding);
  const second = await runGateEnsure(20, binding);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(fileInjections.length, 0, 'loaded frame must not reinject gate or restart bundle on refresh');
  assert.equal(pageVm.globalThis.__HERMES_ELEMENT_PICK_ACTIVE__, true, 'refresh must keep active element pick');
  assert.equal(pageVm.globalThis.__HERMES_COMMENT_PINS_VISIBLE__, true, 'refresh must not tear down comment pins');
});

async function loadLoadedFrameVm(href, injectionDecision) {
  const gateSource = await readFile(gateSourceUrl, 'utf8');
  const context = {
    get location() {
      return { href, origin: new URL(href).origin };
    },
    __HERMES_BROWSER_CONTENT_LOADED__: 'loaded-frame',
    HermesContentExtractor: { collectPageContext: () => ({ ok: true }) },
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
    policyLocationToken: `${new URL(href).origin}\u0000${href}`,
    policySeq: 1,
  };
  vm.runInContext(gateSource, context);
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