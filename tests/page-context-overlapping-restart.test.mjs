import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseHTML } from 'linkedom';

test('overlapping page-context ensures share one in-flight gate refresh per tab frame', async () => {
  const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('const pageContextBundleRestartByTarget'),
    source.indexOf('function pageContextPermissionControlDirty'),
  );
  assert.match(block, /const pageContextGateEnsureByTarget = new Map\(\)/);
  assert.match(block, /pageContextGateEnsureByTarget\.get\(key\)/);
  assert.match(block, /probePageContextBundleRestartNeeded/);
  const refreshBlock = source.slice(
    source.indexOf('async function runPageContextGateEnsureForTarget'),
    source.indexOf('async function ensurePageContextGateAndRefresh'),
  );
  assert.match(refreshBlock, /await probePageContextBundleRestartNeeded\(target\)/);
  const gateBlock = source.slice(
    source.indexOf('async function ensurePageContextGateAndRefresh'),
    source.indexOf('function pageContextPermissionControlDirty'),
  );
  assert.match(gateBlock, /const inflight = pageContextGateEnsureByTarget\.get\(key\)/);
  const sendBlock = source.slice(
    source.indexOf('async function sendContentMessageWithInstallFallback'),
    source.indexOf('function collectPageContextWithSharedExtractor'),
  );
  assert.doesNotMatch(sendBlock, /await reinstallPageContextBundleEntries\(tabId, scriptTarget\)/);
});

test('coalesced bundle reinstall re-probes readiness after awaiting a shared restart', async () => {
  const executeCalls = [];
  let extractorReady = false;
  const restartByTarget = new Map();

  function restartKey(tabId, frame) {
    return `${tabId}\u0000${frame}`;
  }

  async function probeRestartNeeded() {
    return !extractorReady;
  }

  async function reinstallBundleEntries(tabId, frame) {
    const key = restartKey(tabId, frame);
    while (true) {
      const existing = restartByTarget.get(key);
      if (existing) {
        await existing;
        if (!(await probeRestartNeeded())) return;
        continue;
      }
      const run = (async () => {
        executeCalls.push('restart');
        extractorReady = true;
      })();
      restartByTarget.set(key, run);
      try {
        await run;
      } finally {
        if (restartByTarget.get(key) === run) restartByTarget.delete(key);
      }
      return;
    }
  }

  extractorReady = false;
  await Promise.all([
    (async () => {
      if (await probeRestartNeeded()) await reinstallBundleEntries(1, 0);
    })(),
    (async () => {
      if (await probeRestartNeeded()) await reinstallBundleEntries(1, 0);
    })(),
  ]);
  assert.equal(executeCalls.length, 1, 'overlapping actions must share exactly one bundle restart');
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