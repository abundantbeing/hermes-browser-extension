import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isPageContextCaptureUrlBlocked } from '../extension/lib/page-context-capture-guard.mjs';
import {
  captureRequestAnchorToken,
  createPageContextBundleRestartCoalescer,
  createPageContextGateEnsureRunner,
  liveAnchorMatchesCaptureRequest,
  pageContextBundleRestartFilesFromManifest,
  pageContextPolicyGrantMatchesAnchor,
  pageContextVerifyInstallAnchor,
  probePageContextBundleRestartNeeded,
  runPageContextBundleRestart,
  sealPageContextPolicyGrant,
} from '../extension/lib/page-context-bundle-restart.mjs';
import {
  packagedPageContextScriptFiles,
  pageContextAllowLocalDocumentsForUrl,
  pageContextHostPolicyDecision,
} from '../extension/lib/page-script-host-policy.mjs';
import { pageContextScriptInjectionTarget } from '../extension/lib/page-context-document-target.mjs';

const MANIFEST_FILES = packagedPageContextScriptFiles();
const gateUrl = new URL('../extension/lib/page-context-bundle-gate.js', import.meta.url);
const contentUrl = new URL('../extension/content.js', import.meta.url);

const PAGE_A = 'https://example.com/page-a';
const PAGE_B = 'https://example.com/page-b';
const LOCALHOST = 'http://localhost/private';
const tokenFor = (href) => `${new URL(href).origin}\u0000${href}`;

test('legacy permissive anchor match would accept a mismatched live page (guard regression)', () => {
  const legacyWithoutTokenGate = (binding, anchor) => {
    const requestToken = binding?.captureRequestAnchorToken || binding?.anchorToken || null;
    if (!anchor?.token) return false;
    if (!requestToken) return true;
    return requestToken === anchor.token;
  };
  assert.equal(
    legacyWithoutTokenGate({}, { token: tokenFor(PAGE_B) }),
    true,
    'missing-token guard allows any live page',
  );
  assert.equal(liveAnchorMatchesCaptureRequest({}, { token: tokenFor(PAGE_B) }), false);
  assert.equal(
    liveAnchorMatchesCaptureRequest(
      { captureRequestAnchorToken: tokenFor(PAGE_A) },
      { token: tokenFor(PAGE_B) },
    ),
    false,
  );
});

test('Firefox capture request token is immutable when live frame navigates A to B before ensure', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const policyForUrl = (url) => pageContextHostPolicyDecision(url, settings);
  let href = PAGE_A;
  const installBinding = {
    tabId: 51,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href: PAGE_A,
    anchorToken: tokenFor(PAGE_A),
    captureRequestAnchorToken: tokenFor(PAGE_A),
  };
  const pageVm = await loadPageVm(PAGE_A, policyForUrl);
  pageVm.loadContent(PAGE_A);

  const executeScript = createExecuteScript({
    getHref: () => href,
    pageVm,
    onPreFirstAnchor: () => {
      href = PAGE_B;
      pageVm.navigate(PAGE_B);
    },
    firstAnchorOnly: true,
  });

  const runGateEnsure = buildGateEnsureRunner({
    executeScript,
    installBinding,
    policyForUrl,
    verifyInstallBinding: () => verifyBinding(installBinding, executeScript, policyForUrl, settings),
  });

  const allowed = await runGateEnsure(51, installBinding);
  assert.equal(allowed, false);
  assert.equal(installBinding.captureRequestAnchorToken, tokenFor(PAGE_A));
  assert.equal(installBinding.anchorToken, tokenFor(PAGE_A));
  assert.equal(installBinding.pageContextPolicyGrantToken, undefined);

  href = PAGE_B;
  pageVm.navigate(PAGE_B);
  const capture = await pageVm.getPageContext({ captureRequestAnchorToken: tokenFor(PAGE_A) });
  assert.equal(capture?.ok, false);
  assert.notEqual(capture?.text, 'PAGE_B_SECRET');
  assert.equal(pageContextPolicyGrantMatchesAnchor(installBinding, { token: tokenFor(PAGE_B) }), false);
});

test('capture token invariant refuses navigation at each Firefox restart step', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const policyForUrl = (url) => pageContextHostPolicyDecision(url, settings);
  const scenarios = [
    { name: 'before grant', phase: 'before-grant', nextHref: LOCALHOST },
    { name: 'after grant before restart', phase: 'after-grant', nextHref: LOCALHOST },
    { name: 'after restart before message', phase: 'before-message', nextHref: LOCALHOST },
    { name: 'before grant to allowed page B', phase: 'before-grant', nextHref: PAGE_B },
    { name: 'after grant to allowed page B', phase: 'after-grant', nextHref: PAGE_B },
  ];

  for (const scenario of scenarios) {
    let href = PAGE_A;
    let phase = 'start';
    const installBinding = {
      tabId: 52,
      frameId: 0,
      documentId: null,
      allowFrameFallback: true,
      href: PAGE_A,
      anchorToken: tokenFor(PAGE_A),
      captureRequestAnchorToken: tokenFor(PAGE_A),
    };
    const fileInjections = [];
    const pageVm = await loadPageVm(PAGE_A, policyForUrl);
    pageVm.loadContent(PAGE_A);
    pageVm.globalThis.HermesContentExtractor = {};
    pageVm.globalThis.__HERMES_BROWSER_CONTENT_LOADED__ = 'vm';
    pageVm.globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__ = scenario.phase === 'after-grant';

    const expectHrefAtStep = (stepHref) => {
      assert.equal(href, stepHref, `${scenario.name} navigation at step`);
    };
    const executeScript = createExecuteScript({
      getHref: () => href,
      pageVm,
      onRefresh: async () => {
        if (scenario.phase === 'before-grant') {
          href = scenario.nextHref;
          pageVm.navigate(scenario.nextHref);
        }
      },
      onRefreshObserveHref: () => {
        if (scenario.phase === 'before-grant') expectHrefAtStep(scenario.nextHref);
      },
      onBeforeRestart: () => {
        if (scenario.phase === 'after-grant') {
          href = scenario.nextHref;
          pageVm.navigate(scenario.nextHref);
          expectHrefAtStep(scenario.nextHref);
        }
      },
      onAfterRestart: () => {
        if (scenario.phase === 'before-message') {
          href = scenario.nextHref;
          pageVm.navigate(scenario.nextHref);
          expectHrefAtStep(scenario.nextHref);
        }
      },
      phaseHook: () => {
        if (phase === 'during-capture') href = scenario.nextHref;
      },
      phase: () => phase,
      setPhase: (next) => { phase = next; },
      fileInjections,
    });

    const runGateEnsure = buildGateEnsureRunner({
      executeScript,
      installBinding,
      policyForUrl,
      verifyInstallBinding: () => verifyBinding(installBinding, executeScript, policyForUrl, settings),
      onRunBundleRestart: async (binding) => {
        phase = 'restarting';
        await runPageContextBundleRestart(
          executeScript,
          binding,
          pageContextBundleRestartFilesFromManifest(MANIFEST_FILES),
          {
            verifyBinding: () => verifyBinding(binding, executeScript, policyForUrl, settings),
            beforeInject: () => {
              executeScript.onBeforeRestart?.();
              return verifyBinding(binding, executeScript, policyForUrl, settings);
            },
            afterInject: () => {
              executeScript.onAfterRestart?.();
              return verifyBinding(binding, executeScript, policyForUrl, settings);
            },
          },
        );
      },
    });

    const allowed = await runGateEnsure(52, installBinding);
    assert.equal(allowed, false, scenario.name);

    const bundleBootedOnWrongPage = fileInjections.some((row) =>
      row.href === scenario.nextHref
      && row.files.some((f) => f.endsWith('content.js')));
    assert.equal(bundleBootedOnWrongPage, false, `${scenario.name} must not boot bundle off-request page`);
    assert.equal(captureRequestAnchorToken(installBinding), tokenFor(PAGE_A), `${scenario.name} keeps request token`);
  }
});

test('unchanged page completes gate ensure and capture with original request token', async () => {
  const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
  const policyForUrl = (url) => pageContextHostPolicyDecision(url, settings);
  const installBinding = {
    tabId: 54,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href: PAGE_A,
    anchorToken: tokenFor(PAGE_A),
    captureRequestAnchorToken: tokenFor(PAGE_A),
  };
  const pageVm = await loadPageVm(PAGE_A, policyForUrl);
  pageVm.loadContent(PAGE_A);
  pageVm.globalThis.HermesContentExtractor = pageVm.globalThis.HermesContentExtractor || {};
  pageVm.globalThis.HermesContentExtractor.collectPageContext = () => ({
    ok: true,
    text: 'PAGE_A_SECRET',
    selectedText: '',
    meta: {},
  });
  pageVm.globalThis.__HERMES_BROWSER_CONTENT_LOADED__ = 'vm';

  const executeScript = createExecuteScript({
    getHref: () => PAGE_A,
    pageVm,
    fileInjections: [],
  });

  const runGateEnsure = buildGateEnsureRunner({
    executeScript,
    installBinding,
    policyForUrl,
    verifyInstallBinding: () => verifyBinding(installBinding, executeScript, policyForUrl, settings),
  });

  const allowed = await runGateEnsure(54, installBinding);
  assert.equal(allowed, true);
  const capture = await pageVm.getPageContext({ captureRequestAnchorToken: tokenFor(PAGE_A) });
  assert.equal(capture?.ok, true);
  assert.equal(capture?.text, 'PAGE_A_SECRET');
});

for (const nextHref of [LOCALHOST, PAGE_B]) {
  test(`capture message refuses when page moved after grant (${nextHref})`, async () => {
    const settings = { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] };
    const policyForUrl = (url) => pageContextHostPolicyDecision(url, settings);
    const installBinding = {
      tabId: 53,
      frameId: 0,
      documentId: null,
      allowFrameFallback: true,
      href: PAGE_A,
      anchorToken: tokenFor(PAGE_A),
      captureRequestAnchorToken: tokenFor(PAGE_A),
      pageContextPolicyGrantToken: tokenFor(PAGE_A),
    };
    const pageVm = await loadPageVm(PAGE_A, policyForUrl);
    pageVm.loadContent(PAGE_A);
    pageVm.navigate(nextHref);
    const capture = await pageVm.getPageContext({ captureRequestAnchorToken: tokenFor(PAGE_A) });
    assert.equal(capture?.ok, false);
    assert.notEqual(capture?.text, 'PAGE_B_SECRET');
    assert.notEqual(capture?.text, 'LOCALHOST_SECRET');
  });
}

function buildGateEnsureRunner({
  executeScript,
  installBinding,
  policyForUrl,
  verifyInstallBinding,
  onRunBundleRestart,
}) {
  const bundleRestart = createPageContextBundleRestartCoalescer({
    probeRestartNeeded: (b) => probePageContextBundleRestartNeeded(executeScript, b),
    runBundleRestart: onRunBundleRestart || (async () => {}),
  });

  return createPageContextGateEnsureRunner({
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
}

async function verifyBinding(binding, executeScript, policyForUrl, settings) {
  const target = pageContextScriptInjectionTarget(binding);
  const [row] = await executeScript({
    target,
    func: () => ({
      href: location.href,
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

function createExecuteScript({
  getHref,
  pageVm,
  onPreFirstAnchor,
  onRefresh,
  onBeforeRestart,
  onAfterRestart,
  phaseHook,
  firstAnchorOnly,
  fileInjections,
  phase,
  setPhase,
  onRefreshObserveHref,
}) {
  let firstAnchorRead = false;
  const executeScript = async (request) => {
    if (request.files) {
      fileInjections?.push({ href: getHref(), files: [...request.files] });
      return [{ result: undefined }];
    }
    if (typeof request.func !== 'function') return [{ result: undefined }];
    const source = request.func.toString();
    if (source.includes('location.href') && source.includes('token:') && !source.includes('collectPageContext')) {
      if (onPreFirstAnchor && !firstAnchorRead) {
        firstAnchorRead = true;
        onPreFirstAnchor();
      }
    }
  if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
      setPhase?.('refreshed');
      onRefreshObserveHref?.(getHref());
      if (onRefresh) await onRefresh();
    }
    phaseHook?.();
    const raw = await pageVm.executeFunc(request.func);
    if (source.includes('hermesRefreshPageScriptPolicy') && source.includes('async')) {
      const allowed = typeof raw === 'object' && raw !== null ? Boolean(raw.allowed) : Boolean(raw);
      const restart = typeof raw === 'object' && raw !== null
        ? Boolean(raw.restart)
        : Boolean(pageVm.globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__);
      if (typeof raw !== 'object' || raw === null) {
        pageVm.globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__ = false;
      }
      setPhase?.('after-grant');
      return [{ result: typeof raw === 'object' && raw !== null ? raw : { allowed, restart } }];
    }
    return [{ result: raw }];
  };
  executeScript.onBeforeRestart = onBeforeRestart;
  executeScript.onAfterRestart = onAfterRestart;
  executeScript.phaseHook = phaseHook;
  return executeScript;
}

async function loadPageVm(href, policyForUrl) {
  const [gateSource, contentSource] = await Promise.all([
    readFile(gateUrl, 'utf8'),
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
          return Promise.resolve({ inject: decision.inject, seq: message.seq, allowLocalDocuments: false });
        },
      },
    },
    chrome: null,
    document: { addEventListener() {} },
    window: {},
    HermesContentExtractor: {
      collectPageContext: () => ({
        ok: true,
        text: context.location.href.includes('localhost')
          ? 'LOCALHOST_SECRET'
          : context.location.href.includes('page-b')
            ? 'PAGE_B_SECRET'
            : 'PAGE_A_SECRET',
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
  vm.createContext(context);
  vm.runInContext(gateSource, context);
  context.__HERMES_PAGE_SCRIPT_POLICY__ = { ...(context.__HERMES_PAGE_SCRIPT_POLICY__ || {}), policySeq: 1 };
  context.__HERMES_PAGE_SCRIPTS_BLOCKED__ = false;
  context.__HERMES_PAGE_SCRIPT_POLICY__.decided = true;
  context.__HERMES_PAGE_SCRIPT_POLICY__.latestInject = true;
  context.__HERMES_PAGE_SCRIPT_POLICY__.policyLocationToken = tokenFor(href);
  delete context.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__;

  return {
    globalThis: context,
    async executeFunc(fn) {
      const script = new vm.Script(`(async () => { const runner = ${fn.toString()}; return await runner(); })()`);
      return script.runInContext(context);
    },
    navigate(nextHref) {
      context.location = { href: nextHref, origin: new URL(nextHref).origin };
      context.__HERMES_PAGE_SCRIPT_POLICY__.policyLocationToken = tokenFor(nextHref);
    },
    loadContent(initialHref) {
      if (context.__contentLoaded) return;
      context.location = { href: initialHref, origin: new URL(initialHref).origin };
      context.hermesAwaitPageScriptPolicy = (boot) => boot();
      vm.runInContext(contentSource, context);
      context.__contentLoaded = true;
    },
    async runRefresh() {
      return context.hermesRefreshPageScriptPolicy();
    },
    async run(fn) {
      return vm.runInContext(`(async () => (${fn})())()`, context);
    },
    async getPageContext(options = {}) {
      const listener = context.globalThis.__HERMES_BROWSER_CONTENT_LISTENER__;
      if (typeof listener !== 'function') return { ok: false };
      return new Promise((resolve) => {
        listener({ type: 'HERMES_GET_PAGE_CONTEXT', options }, {}, (value) => resolve(value));
      });
    },
  };
}