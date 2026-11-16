import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  createPageContextBundleRestartCoalescer,
  createPageContextGateEnsureCoalescer,
  probePageContextBundleRestartNeeded,
  runPageContextBundleRestart,
} from '../extension/lib/page-context-bundle-restart.mjs';

function createBundleRestartHarness({ restartDelayMs = 60 } = {}) {
  let restartInjectionCount = 0;
  let probeState = {
    restart: true,
    extractorReady: false,
    bridgeLoaded: true,
  };
  const anchorHref = 'https://coalesce.test/app';
  const anchorToken = `https://coalesce.test\u0000${anchorHref}`;
  const binding = {
    tabId: 1,
    frameId: 0,
    documentId: 'doc-coalesce-test',
    allowFrameFallback: false,
    anchorToken,
    captureRequestAnchorToken: anchorToken,
  };
  const executeScript = async (request) => {
    if (request.files) {
      restartInjectionCount += 1;
      await new Promise((resolve) => setTimeout(resolve, restartDelayMs));
      probeState = { restart: false, extractorReady: true, bridgeLoaded: true };
      return [{ result: undefined }];
    }
    const src = request.func?.toString() || '';
    if (src.includes('location.href') && src.includes('token')) {
      return [{
        result: {
          href: anchorHref,
          origin: 'https://coalesce.test',
          token: anchorToken,
        },
      }];
    }
    if (src.includes('HermesContentExtractor')) {
      return [{ result: { ...probeState } }];
    }
    const result = await request.func();
    return [{ result }];
  };
  const bundleRestart = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
    runBundleRestart: (b) => runPageContextBundleRestart(executeScript, b, [
      'lib/page-context-bundle-gate.js',
      'content.js',
    ]),
  });
  return { ...bundleRestart, getRestartInjectionCount: () => restartInjectionCount };
}

test('overlapping page-context ensures share one in-flight gate refresh per tab frame', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/lib\/page-context-bundle-restart\.mjs'/);
  assert.match(source, /createPageContextBundleRestartCoalescer/);
  assert.match(source, /createPageContextGateEnsureCoalescer/);
  assert.match(source, /pageContextScriptInjectionTarget/);
  assert.match(source, /probePageContextFrameDocumentId/);
  assert.doesNotMatch(source, /webNavigation/);
  const sendBlock = source.slice(
    source.indexOf('async function sendContentMessageWithInstallFallback'),
    source.indexOf('function collectPageContextWithSharedExtractor'),
  );
  assert.doesNotMatch(sendBlock, /await reinstallPageContextBundleEntries\(tabId, scriptTarget\)/);
});

test('coalesced bundle reinstall re-probes readiness after awaiting a shared restart', async () => {
  const tabId = 1;
  const anchorHref = 'https://coalesce.test/app';
  const anchorToken = `https://coalesce.test\u0000${anchorHref}`;
  const scriptTarget = {
    tabId,
    frameId: 0,
    documentId: 'doc-coalesce-test',
    allowFrameFallback: false,
    anchorToken,
    captureRequestAnchorToken: anchorToken,
  };
  const {
    reinstallPageContextBundleEntries,
    awaitPageContextBundleRestart,
    getRestartInjectionCount,
  } = createBundleRestartHarness({ restartDelayMs: 60 });
  const milestones = [];

  await Promise.all([
    (async () => {
      milestones.push('first-start');
      await reinstallPageContextBundleEntries(tabId, scriptTarget);
      milestones.push('first-done');
    })(),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      milestones.push('second-start');
      await reinstallPageContextBundleEntries(tabId, scriptTarget);
      milestones.push('second-done');
    })(),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      milestones.push('waiter-start');
      await awaitPageContextBundleRestart(tabId, scriptTarget);
      milestones.push('waiter-after-shared-restart');
    })(),
  ]);

  assert.equal(getRestartInjectionCount(), 1, 'overlapping actions must share exactly one bundle restart');
  const firstDoneIdx = milestones.indexOf('first-done');
  const waiterIdx = milestones.indexOf('waiter-after-shared-restart');
  const secondDoneIdx = milestones.indexOf('second-done');
  assert.ok(firstDoneIdx >= 0 && waiterIdx > firstDoneIdx, 'waiter must finish only after the shared restart');
  assert.ok(secondDoneIdx > firstDoneIdx, 'coalesced reinstall must await the in-flight restart before returning');
});

test('overlapping gate ensures share one runPageContextGateEnsureForTarget per tab frame', async () => {
  const tabId = 3;
  const target = { tabId, frameId: 0, documentId: 'doc-gate-coalesce', allowFrameFallback: false };
  let gateRuns = 0;
  let resolveGate;
  const gateStarted = new Promise((resolve) => { resolveGate = resolve; });
  const runPageContextGateEnsureForTarget = async () => {
    gateRuns += 1;
    resolveGate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return true;
  };
  const { ensurePageContextGateAndRefresh } = createPageContextGateEnsureCoalescer({
    resolveBinding: async (_tabId, scriptTarget) => scriptTarget || target,
    runPageContextGateEnsureForTarget,
  });
  const p1 = ensurePageContextGateAndRefresh(tabId, target);
  await gateStarted;
  const p2 = ensurePageContextGateAndRefresh(tabId, target);
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(gateRuns, 1);
  assert.equal(a, true);
  assert.equal(b, true);
});

test('content.js re-injection tears down stale element-pick handlers before cancel', async () => {
  const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(contentSource, /__HERMES_ELEMENT_PICK_HANDLERS__/);
  assert.match(contentSource, /detachGlobalPickHandlers/);

  const { document, window } = parseHTML('<!doctype html><html><body><button id="cta">Save</button></body></html>');
  let clickDefault = false;
  document.addEventListener('click', () => {
    clickDefault = true;
  }, false);

  const listeners = new Set();
  const sandbox = {
    console,
    document,
    window,
    location: { href: 'https://192.168.0.20/app' },
    CSS: { escape: (value) => String(value) },
    HermesContentExtractor: { clampExtractedText: (value, limit) => ({ text: String(value).slice(0, limit) }) },
    chrome: {
      runtime: {
        sendMessage: () => Promise.resolve(),
        onMessage: {
          addListener(fn) { listeners.add(fn); },
          removeListener(fn) { listeners.delete(fn); },
        },
      },
      storage: { local: { get: () => Promise.resolve({}) } },
    },
    hermesBrowserApi: null,
    globalThis: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.hermesBrowserApi = sandbox.chrome;
  sandbox.hermesAwaitPageScriptPolicy = (boot) => boot();
  vm.createContext(sandbox);
  vm.runInContext(contentSource, sandbox);

  sandbox.globalThis.__HERMES_BROWSER_CONTENT_LISTENER__({ type: 'HERMES_START_ELEMENT_PICK' }, {}, () => {});
  assert.ok(sandbox.globalThis.__HERMES_ELEMENT_PICK_HANDLERS__, 'pick attaches global handler registry');

  clickDefault = false;
  vm.runInContext(contentSource, sandbox);
  sandbox.globalThis.__HERMES_BROWSER_CONTENT_LISTENER__({ type: 'HERMES_CANCEL_ELEMENT_PICK' }, {}, () => {});

  document.querySelector('#cta').click();
  assert.equal(clickDefault, true, 'cancel after re-injection must remove stale capture click handlers');
});