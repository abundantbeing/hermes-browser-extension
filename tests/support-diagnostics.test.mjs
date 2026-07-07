import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildSupportDiagnostics,
  browserFamilyFromUserAgent,
  redactDiagnosticUrl,
  redactExtensionOrigin,
} from '../extension/lib/support-diagnostics.mjs';

test('buildSupportDiagnostics creates a public-safe copy block without secrets or page content', () => {
  const diagnostics = buildSupportDiagnostics({
    extensionVersion: '0.1.9',
    extensionOrigin: 'chrome-extension://abc123/sidepanel.html?debug=extension-origin-query',
    buildInfo: {
      commit: 'abcdef1234567890',
      shortCommit: 'abcdef1',
      builtAt: '2026-07-05T00:00:00.000Z',
      dirty: false,
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    platform: 'Win32',
    settings: {
      gatewayMode: 'remote-api',
      gatewayUrl: 'https://user:pass@agent.example.com:8642/path?credential=example-secret&session=abc',
      apiKey: 'demo',
      model: 'gpt-5.5',
      activeProfile: 'roxas',
      includeTabs: true,
      includePageText: true,
      includeSelectedText: true,
      transcriptProvider: 'default',
      contextDepth: 'normal',
    },
    connection: {
      state: 'degraded',
      detail: "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'",
    },
    health: {
      ok: true,
      version: '0.17.0',
      build: '5d613a56',
    },
    capabilities: {
      models: true,
      sessions: true,
      skills: true,
      profiles: false,
      runEvents: true,
      browserContextProvider: true,
      browserCompanionPlugin: false,
      browserContextUpload: false,
      pluginActions: false,
      browserControl: false,
      warnings: ['Profile API unavailable — using fallback.'],
    },
    selectedModel: { id: 'openai/gpt-5.5', provider: 'openai', label: 'GPT-5.5' },
    contextScope: { mode: 'pinned-tab' },
    lastError: {
      kind: 'upstream-runtime',
      title: 'Hermes runtime exception',
      detail: 'gateway traceback contains computer_use NoneType parse failure',
    },
    currentContext: {
      activeTab: { title: 'Private banking', url: 'https://bank.example.com/account' },
      pageContext: { selectedText: 'private selected text', text: 'private page body' },
    },
    extractorMode: 'dom-fallback',
  });

  assert.match(diagnostics.markdown, /Hermes Browser Diagnostics/);
  assert.match(diagnostics.markdown, /Extension version: 0\.1\.9/);
  assert.match(diagnostics.markdown, /Extension origin: chrome-extension:\/\/abc123/);
  assert.match(diagnostics.markdown, /Browser family: Chrome/);
  assert.match(diagnostics.markdown, /Gateway URL origin: https:\/\/agent\.example\.com:8642/);
  assert.match(diagnostics.markdown, /Connection state: degraded/);
  assert.match(diagnostics.markdown, /Companion plugin: missing/);
  assert.match(diagnostics.markdown, /Browser control: disabled/);
  assert.match(diagnostics.markdown, /Context source mode: pinned-tab/);
  assert.match(diagnostics.markdown, /Extractor mode: dom-fallback/);

  for (const forbidden of [
    'demo',
    'extension-origin-query',
    'sidepanel.html',
    'user:pass',
    'credential=example-secret',
    'session=abc',
    'Private banking',
    'bank.example.com/account',
    'private selected text',
    'private page body',
    'Authorization',
    'Cookie',
  ]) {
    assert.doesNotMatch(diagnostics.markdown, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${forbidden} must not leak`);
  }
});

test('redactDiagnosticUrl returns only safe origins for support copy', () => {
  assert.equal(redactDiagnosticUrl('https://user:pass@example.com:8642/api?credential=example-secret'), 'https://example.com:8642');
  assert.equal(redactDiagnosticUrl('http://127.0.0.1:8642/v1?session=abc'), 'http://127.0.0.1:8642');
  assert.equal(redactDiagnosticUrl('not a url'), '(invalid URL)');
});

test('redactExtensionOrigin returns only extension scheme and id', () => {
  assert.equal(redactExtensionOrigin('chrome-extension://abc123/sidepanel.html?token=secret'), 'chrome-extension://abc123');
  assert.equal(redactExtensionOrigin('moz-extension://9b7f-uuid/sidebar.html?token=secret'), 'moz-extension://9b7f-uuid');
  assert.equal(redactExtensionOrigin('safari-web-extension://ABCD/settings.html?token=secret'), 'safari-web-extension://ABCD');
  assert.equal(redactExtensionOrigin('not a url'), '(invalid extension origin)');
});

test('browserFamilyFromUserAgent recognizes Chromium-family support targets', () => {
  assert.equal(browserFamilyFromUserAgent('Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36'), 'Chrome');
  assert.equal(browserFamilyFromUserAgent('Mozilla/5.0 Edg/150.0.0.0 Chrome/150.0.0.0'), 'Edge');
  assert.equal(browserFamilyFromUserAgent('Mozilla/5.0 OPR/120.0.0.0 Chrome/120.0.0.0'), 'Opera');
  assert.equal(browserFamilyFromUserAgent('Mozilla/5.0 Firefox/140.0'), 'Firefox (unsupported preview)');
});

test('sidepanel exposes Copy Diagnostics support controls without raw diagnostics markup', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

  assert.match(html, /id="copyDiagnosticsButton"/);
  assert.match(html, /id="diagnosticsCopyStatus"/);
  assert.match(js, /buildSupportDiagnostics/);
  assert.match(js, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(html, /<textarea[^>]+diagnostics/i);
});
