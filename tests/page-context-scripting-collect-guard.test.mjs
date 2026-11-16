import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { pageContextInjectionDecision, pageContextSkipMessageKey } from '../extension/lib/page-script-host-policy.mjs';

const root = new URL('../', import.meta.url);
const panelSource = await readFile(new URL('extension/sidepanel.js', root), 'utf8');

function extractFunction(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  return source.slice(from, to);
}

const collectSource = extractFunction(
  panelSource,
  'function collectPageContextWithSharedExtractor(options = {}) {',
  'async function getPageContextViaScripting(tabId, options, originalError, tabUrl = \'\') {',
);

const viaSource = extractFunction(
  panelSource,
  'async function getPageContextViaScripting(tabId, options, originalError, tabUrl = \'\') {',
  'async function persistGmailCaptureEnabled(enabled) {',
);

const PUBLIC = 'https://example.com/page-a';
const LOCALHOST = 'http://localhost/private';
const tokenFor = (href) => `${new URL(href).origin}\u0000${href}`;

function buildScriptingFallbackRuntime({
  href,
  extractorInjected,
  enforceExtractorGuard = true,
}) {
  let documentReads = 0;
  const installBinding = {
    tabId: 71,
    frameId: 0,
    documentId: null,
    allowFrameFallback: true,
    href,
    anchorToken: tokenFor(PUBLIC),
    captureRequestAnchorToken: tokenFor(PUBLIC),
    pageContextPolicyGrantToken: tokenFor(PUBLIC),
  };
  const context = vm.createContext({
    settings: { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] },
    browserApi: {
      scripting: {
        executeScript: async (request) => {
          if (request.func) documentReads += 1;
          return [{ result: { ok: true, text: 'LOCALHOST_SECRET', selectedText: '', meta: {} } }];
        },
      },
    },
    resolveScriptTargetUrlForPageScriptPolicy: async () => PUBLIC,
    pageContextInjectionDecision,
    pageContextSkipMessageKey,
    t: (key) => key,
    acquirePageContextInstallBinding: async () => ({ ...installBinding }),
    pageContextScriptInjectionTarget: () => ({ tabId: 71, frameIds: [0] }),
    awaitPageContextBundleRestart: async () => {},
    ensurePageContextGateAndRefresh: async () => true,
    verifyPageContextInstallBinding: async () => true,
    manifestContentScriptFiles: () => ['content-extractor.js'],
    readPageScriptDocumentAnchor: async () => ({
      href: PUBLIC,
      origin: 'https://example.com',
      token: tokenFor(PUBLIC),
    }),
    pageContextPolicyGrantMatchesAnchor: () => true,
    runPageContextBundleRestart: async () => extractorInjected,
    executePageContextScript: async (request) => {
      if (request.func) documentReads += 1;
      return [{ result: request.func ? await request.func() : undefined }];
    },
    enforceExtractorGuard,
  });
  let patchedVia = viaSource;
  if (!enforceExtractorGuard) {
    patchedVia = patchedVia.replace(
      'if (!extractorInjected || !(await verifyPageContextInstallBinding(installBinding)))',
      'if (false && (!extractorInjected || !(await verifyPageContextInstallBinding(installBinding))))',
    );
  }
  vm.runInContext(`${collectSource}\n${patchedVia}; globalThis.getPageContextViaScripting = getPageContextViaScripting;`, context);
  return {
    context,
    async run() {
      return context.getPageContextViaScripting(71, {}, new Error('probe'), PUBLIC);
    },
    get documentReads() {
      return documentReads;
    },
  };
}

test('getPageContextViaScripting refuses extractor inject and never collects after navigation', async () => {
  const runtime = buildScriptingFallbackRuntime({
    href: LOCALHOST,
    extractorInjected: false,
    enforceExtractorGuard: true,
  });
  const result = await runtime.run();
  assert.equal(result?.ok, false);
  assert.equal(result?.skipped, undefined);
  assert.match(result?.error || result?.reason || '', /probe/);
  assert.equal(result?.text, '');
  assert.equal(runtime.documentReads, 0);
});

test('collectPageContextWithSharedExtractor refuses mismatched capture token in page', async () => {
  const context = vm.createContext({
    location: { href: LOCALHOST, origin: 'http://localhost' },
    globalThis: {},
    __HERMES_PAGE_SCRIPT_POLICY__: {
      latestInject: true,
      policyLocationToken: tokenFor(LOCALHOST),
    },
    __HERMES_PAGE_SCRIPTS_BLOCKED__: false,
    HermesContentExtractor: {
      collectPageContext: () => ({ ok: true, text: 'LOCALHOST_SECRET', selectedText: '', meta: {} }),
    },
    HermesSiteAdapters: {},
  });
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${collectSource}; globalThis.collectPageContextWithSharedExtractor = collectPageContextWithSharedExtractor;`, context);
  const refused = context.globalThis.collectPageContextWithSharedExtractor({
    captureRequestAnchorToken: tokenFor(PUBLIC),
  });
  assert.equal(refused?.ok, false);
  assert.equal(refused?.text, '');
});

test('without extractor inject guard the fallback test would read the navigated document', async () => {
  const guarded = buildScriptingFallbackRuntime({
    href: LOCALHOST,
    extractorInjected: false,
    enforceExtractorGuard: true,
  });
  const unguarded = buildScriptingFallbackRuntime({
    href: LOCALHOST,
    extractorInjected: false,
    enforceExtractorGuard: false,
  });
  assert.equal((await guarded.run())?.text, '');
  assert.equal(guarded.documentReads, 0);
  const leaked = await unguarded.run();
  assert.match(leaked?.text || '', /LOCALHOST_SECRET/);
  assert.ok(unguarded.documentReads > 0);
});