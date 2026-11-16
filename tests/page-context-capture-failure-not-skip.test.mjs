import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { pageContextInjectionDecision } from '../extension/lib/page-script-host-policy.mjs';

const panelSource = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function extractFunction(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  return source.slice(from, to);
}

const getPageContextSource = extractFunction(
  panelSource,
  'async function getPageContext(tab, options = {}) {',
  'async function getYoutubeTranscriptForTab(tab) {',
);

const PUBLIC = 'https://example.com/article';

test('capture failure on an allowed page keeps ok:false without skipped', async () => {
  const captureError = new Error('Receiving end does not exist.');
  const context = vm.createContext({
    settings: { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] },
    tab: { id: 90, url: PUBLIC },
    pageContextInjectionDecision,
    pageContextSkipMessageKey: (reason) => `skip.${reason}`,
    t: (key) => key,
    isLocalDocumentUrl: () => false,
    isRestrictedUrl: () => false,
    usesDashboardWsChatTransport: () => false,
    isGmailThreadUrl: () => false,
    acquirePageContextInstallBinding: async () => ({
      tabId: 90,
      frameId: 0,
      captureRequestAnchorToken: `${new URL(PUBLIC).origin}\u0000${PUBLIC}`,
    }),
    sendContentMessageWithInstallFallback: async () => {
      throw captureError;
    },
    globalThis: {},
  });
  context.globalThis = context;
  vm.runInContext(getPageContextSource, context);
  context.getPageContextViaScripting = async () => ({
    ok: false,
    error: 'scripting executeScript denied',
    reason: 'scripting executeScript denied',
    text: '',
    selectedText: '',
    meta: {},
  });
  const result = await context.getPageContext(context.tab);
  assert.equal(result?.ok, false);
  assert.equal(result?.skipped, undefined);
  assert.match(result?.error || '', /Receiving end does not exist|scripting executeScript denied/);
  assert.match(result?.reason || '', /scripting executeScript denied|Receiving end does not exist/);
  assert.equal(result?.skipReason, undefined);
});

test('scripting fallback policy skip in catch preserves skipped and skipReason', async () => {
  const captureError = new Error('Receiving end does not exist.');
  const context = vm.createContext({
    settings: { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] },
    tab: { id: 92, url: 'https://example.com/frame-parent' },
    pageContextInjectionDecision,
    pageContextSkipMessageKey: (reason) => `skip.${reason}`,
    t: (key, params) => `${key}:${params?.url || ''}`,
    isLocalDocumentUrl: () => false,
    isRestrictedUrl: () => false,
    usesDashboardWsChatTransport: () => false,
    isGmailThreadUrl: () => false,
    sendContentMessageWithInstallFallback: async () => {
      throw captureError;
    },
    globalThis: {},
  });
  context.globalThis = context;
  vm.runInContext(getPageContextSource, context);
  context.getPageContextViaScripting = async () => ({
    ok: false,
    skipped: true,
    skipReason: 'private',
    reason: 'skip.private:https://example.com/frame-parent',
    text: '',
    selectedText: '',
    meta: {},
  });
  const result = await context.getPageContext(context.tab);
  assert.equal(result?.ok, false);
  assert.equal(result?.skipped, true);
  assert.equal(result?.skipReason, 'private');
  assert.equal(result?.error, undefined);
  assert.equal(result?.text, '');
});

test('empty ok response with scripting policy skip preserves skipped state', async () => {
  const context = vm.createContext({
    settings: { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] },
    tab: { id: 93, url: PUBLIC },
    pageContextInjectionDecision,
    pageContextSkipMessageKey: (reason) => `skip.${reason}`,
    t: (key) => key,
    isLocalDocumentUrl: () => false,
    isRestrictedUrl: () => false,
    usesDashboardWsChatTransport: () => false,
    isGmailThreadUrl: () => false,
    sendContentMessageWithInstallFallback: async () => ({
      ok: true,
      text: '',
      selectedText: '',
      meta: {},
    }),
    globalThis: {},
  });
  context.globalThis = context;
  vm.runInContext(getPageContextSource, context);
  context.getPageContextViaScripting = async () => ({
    ok: false,
    skipped: true,
    skipReason: 'private',
    reason: 'skip.private',
    text: '',
    selectedText: '',
    meta: {},
  });
  const result = await context.getPageContext(context.tab);
  assert.equal(result?.skipped, true);
  assert.equal(result?.skipReason, 'private');
  assert.equal(result?.error, undefined);
});

test('policy denial on blocked host still returns skipped', async () => {
  const localhost = 'http://localhost/app';
  const context = vm.createContext({
    settings: { pageContextOnPrivateNetworks: false, pageContextExcludedOrigins: [] },
    tab: { id: 91, url: localhost },
    pageContextInjectionDecision,
    pageContextSkipMessageKey: (reason) => `skip.${reason}`,
    t: (key, params) => `${key}:${params?.url || ''}`,
    isLocalDocumentUrl: () => false,
    isRestrictedUrl: () => false,
    usesDashboardWsChatTransport: () => false,
    isGmailThreadUrl: () => false,
    globalThis: {},
  });
  context.globalThis = context;
  vm.runInContext(getPageContextSource, context);
  const result = await context.getPageContext(context.tab);
  assert.equal(result?.ok, false);
  assert.equal(result?.skipped, true);
  assert.ok(result?.skipReason);
});