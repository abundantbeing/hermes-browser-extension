import assert from 'node:assert/strict';
import test from 'node:test';

import { pageContextInjectionDecision } from '../extension/lib/page-script-host-policy.mjs';
import {
  createPageContextBundleRestartCoalescer,
  createPageContextGateEnsureRunner,
  pageContextBundleRestartFilesFromManifest,
  probePageContextBundleRestartNeeded,
  runPageContextBundleRestart,
} from '../extension/lib/page-context-bundle-restart.mjs';

const MANIFEST_FILES = Object.freeze([
  'lib/page-context-bundle-gate.js',
  'lib/browser-api-global.js',
  'content-extractor.js',
  'content.js',
]);

function hrefAnchor(href) {
  const origin = new URL(href).origin;
  return { href, origin, token: `${origin}\u0000${href}` };
}

function createNavigationGuardHarness({ settings, onBeforeRestart } = {}) {
  let currentHref = 'https://example.com/dashboard';
  const fileInjections = [];
  const injectionDecision = (url) => pageContextInjectionDecision(url, settings);

  const executeScript = async (request) => {
    if (request.files) {
      fileInjections.push({ href: currentHref, files: [...request.files] });
      return [{ result: undefined }];
    }
    const source = request.func.toString();
    if (source.includes('location.href')) {
      return [{ result: hrefAnchor(currentHref) }];
    }
    if (source.includes('HermesContentExtractor')) {
      return [{ result: { restart: true, extractorReady: false, bridgeLoaded: true } }];
    }
    if (source.includes('typeof globalThis.hermesRefreshPageScriptPolicy')) {
      return [{ result: true }];
    }
    if (source.includes('hermesRefreshPageScriptPolicy')) {
      currentHref = 'http://localhost/dashboard';
      onBeforeRestart?.(currentHref);
      return [{ result: { allowed: true, restart: true } }];
    }
    const result = await request.func();
    return [{ result }];
  };

  const bundleRestart = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: (target) => probePageContextBundleRestartNeeded(executeScript, target),
    runBundleRestart: async (scriptTarget) => {
      const binding = hrefAnchor(currentHref);
      await runPageContextBundleRestart(
        executeScript,
        scriptTarget,
        pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
        {
          beforeInject: async () => injectionDecision(currentHref).inject,
          afterInject: async () => injectionDecision(currentHref).inject,
        },
      );
      if (!injectionDecision(currentHref).inject) return;
      void binding;
    },
  });

  const runGateEnsure = createPageContextGateEnsureRunner({
    executeScript,
    manifestContentScriptFiles: () => [...MANIFEST_FILES],
    pageContextBundleRestartFiles: () => pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
    pageContextInjectionDecision: injectionDecision,
    awaitPageContextBundleRestart: bundleRestart.awaitPageContextBundleRestart,
    reinstallPageContextBundleEntries: bundleRestart.reinstallPageContextBundleEntries,
    probePageContextBundleRestartNeeded: (target) => probePageContextBundleRestartNeeded(executeScript, target),
  });

  return { runGateEnsure, fileInjections, getHref: () => currentHref };
}

test('navigation to blocked origin between allow and restart does not inject bundle', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const { runGateEnsure, fileInjections, getHref } = createNavigationGuardHarness({ settings });

  const allowed = await runGateEnsure(7, { tabId: 7, frameIds: [0] });

  assert.equal(allowed, false);
  assert.equal(getHref(), 'http://localhost/dashboard');
  assert.equal(fileInjections.length, 0, 'must not inject bundle after navigation to blocked origin');
  assert.ok(
    !fileInjections.some((row) => row.files.includes('lib/page-context-bundle-gate.js')),
    'gate must not boot on localhost after stale allow',
  );
});

test('restart file list includes gate so a reinstall always re-checks policy', () => {
  const restartFiles = pageContextBundleRestartFilesFromManifest(MANIFEST_FILES);
  assert.equal(restartFiles[0], 'lib/page-context-bundle-gate.js');
  assert.ok(restartFiles.includes('content.js'));
});