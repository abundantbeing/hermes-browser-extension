import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { pageContextInjectionDecision } from '../extension/lib/page-script-host-policy.mjs';

const root = new URL('../', import.meta.url);
const panelSource = await readFile(new URL('extension/sidepanel.js', root), 'utf8');

function extractFunction(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  return source.slice(from, to);
}

const getPageContextSource = extractFunction(
  panelSource,
  'async function getPageContext(tab,',
  'async function getYoutubeTranscriptForTab(',
);

const refreshContextSource = extractFunction(
  panelSource,
  'async function refreshContext(options = {})',
  'async function refreshContextFromUser(',
);

function minimalGetPageContextHarness({ acquireImpl, sendImpl }) {
  let sendCalls = 0;
  const context = vm.createContext({
    settings: { contextDepth: 'normal', pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] },
    isLocalDocumentUrl: () => false,
    isRestrictedUrl: () => false,
    isGmailThreadUrl: () => false,
    usesDashboardWsChatTransport: () => false,
    pageContextInjectionDecision,
    pageContextSkipMessageKey: () => 'status.page_context_skipped',
    t: (key) => key,
    acquirePageContextInstallBinding: acquireImpl,
    sendContentMessageWithInstallFallback: async (...args) => {
      sendCalls += 1;
      return sendImpl(...args);
    },
    getPageContextViaScripting: async () => ({
      ok: false,
      skipped: true,
      text: '',
      selectedText: '',
      meta: {},
    }),
  });
  const readPromise = vm.runInContext(`(async () => { ${getPageContextSource}; return getPageContext; })()`, context);
  return {
    context,
    read: async (tab, options = {}) => {
      const fn = await readPromise;
      return fn(tab, options);
    },
    getSendCalls: () => sendCalls,
  };
}

test('binding probe rejection still attempts capture and returns empty page context', async () => {
  const { read, getSendCalls } = minimalGetPageContextHarness({
    acquireImpl: async () => {
      throw new Error('Frame script target unavailable');
    },
    sendImpl: async () => ({
      ok: false,
      skipped: true,
      text: '',
      selectedText: '',
      meta: {},
    }),
  });
  const tab = { id: 3, url: 'https://example.com/chat' };
  const result = await read(tab);
  assert.equal(getSendCalls(), 1);
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
});

test('refreshContext completes when getPageContext binding probe fails', async () => {
  const context = vm.createContext({
    settings: {},
    t: (key) => key,
    scopeRevision: { current: () => 1, isCurrent: () => true },
    contextRefreshRevision: { begin: () => 1, isCurrent: () => true },
    effectiveContextGate: () => ({ scope: { mode: 'active' }, reason: '' }),
    CONTEXT_SCOPE_MODES: { CHAT_ONLY: 'chat_only', PINNED_TAB: 'pinned_tab' },
    activeTab: async () => ({ id: 4, url: 'https://example.com/chat', title: 'Chat' }),
    tabsForCurrentScope: async () => [],
    resolveContextTargetTab: ({ activeTab: tab }) => tab,
    contextScopeFromTab: (tab, scope) => scope,
    normalizeContextScope: (scope) => scope,
    saveContextScopeForInstance: () => {},
    getPageContext: async () => ({
      ok: false,
      skipped: true,
      text: '',
      selectedText: '',
      meta: {},
    }),
    getYoutubeTranscriptForTab: async () => null,
    mergeStoredPickIntoPageContext: () => {},
    syncSelectedTabsFromContextScope: () => {},
    contextChipSummary: () => ({ label: 'ok' }),
    setStatus: () => {},
    renderContextScopeControls: () => {},
    renderContextWindow: () => {},
    renderLocalDocumentApproval: () => {},
    filterPromptTabs: (tabs) => tabs,
    translateUiText: (value) => value,
    pageContextSkipMessageKey: () => 'status.page_context_skipped',
    currentContext: null,
    selectedTabs: [],
    contextScope: { mode: 'active' },
  });
  const refresh = await vm.runInContext(`(async () => { ${refreshContextSource}; return refreshContext; })()`, context);
  const refreshed = await refresh({});
  assert.ok(refreshed);
  assert.equal(refreshed.pageContext?.text, '');
});