// The connect status the panel (and setup's Connect step) shows must go through
// the locale system: the text is composed from catalog messages, not built from
// English literals, so a person using another language never sees English here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { SUPPORTED_LOCALES, loadLocaleMessages } from '../extension/lib/i18n-registry.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';

const js = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

const CONNECT_KEYS = Object.freeze({
  'connect.title.local_api': [],
  'connect.title.remote_api': [],
  'connect.title.remote_dashboard': [],
  'connect.status.ready': ['title'],
  'connect.status.checking': ['title', 'url'],
  'connect.status.looking': ['title', 'url'],
  'connect.status.failed': ['reason'],
  'connect.status.loopback_only': [],
  'connect.status.degraded': ['detail'],
});

const placeholders = (text) => [...new Set([...String(text).matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))].sort();

test('every connect status message exists in all 21 locales, translated, with its placeholders intact', async () => {
  const english = await loadLocaleMessages('en');
  assert.equal(SUPPORTED_LOCALES.length, 21);
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = await loadLocaleMessages(locale.id);
    for (const [key, names] of Object.entries(CONNECT_KEYS)) {
      assert.equal(typeof english[key], 'string', `en has ${key}`);
      assert.equal(typeof catalog[key], 'string', `${locale.id} has ${key}`);
      assert.deepEqual(placeholders(catalog[key]), [...names].sort(), `${locale.id} ${key} keeps its placeholders`);
      if (locale.id !== 'en') assert.notEqual(catalog[key], english[key], `${locale.id} ${key} is translated, not copied`);
    }
  }
});

function functionSource(name) {
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = js.indexOf('\n}\n', start);
  return js.slice(start, end + 3);
}

async function runConnectPrompt(localeId, { state, mode = 'local-api', remoteWs = false }) {
  const messages = await loadLocaleMessages(localeId);
  const statuses = [];
  const els = {
    connectPanel: { hidden: true },
    connectStatus: { textContent: '' },
    sendButton: { textContent: '' },
  };
  const title = { 'local-api': 'Local Hermes API server', 'remote-api': 'Remote Hermes API server', 'remote-dashboard': 'Remote Hermes dashboard' }[mode];
  const context = {
    els,
    sending: false,
    currentConnectionState: () => ({ connected: state === 'connected' || state === 'degraded', state }),
    currentGatewaySummary: () => ({ title, normalizedUrl: 'http://127.0.0.1:8642', mode: { value: mode } }),
    currentConnectionTroubleshooting: () => 'A reason.',
    isRemoteWsMode: () => remoteWs,
    translateUiText: (value) => value,
    t: (key, params) => formatMessage(messages[key] ?? key, params, localeId),
    setStatus: (...args) => statuses.push(args),
    updateComposerBusyState: () => {},
  };
  vm.createContext(context);
  vm.runInContext(`${functionSource('gatewayTitleText')}\n${functionSource('updateConnectionPrompt')}`, context);
  vm.runInContext('updateConnectionPrompt()', context);
  return { els, statuses, messages };
}

test('the ready, checking and degraded statuses are composed from catalog messages in the active language', async () => {
  for (const localeId of ['en', 'ar', 'de', 'ja', 'zh-CN']) {
    const ready = await runConnectPrompt(localeId, { state: 'not-configured' });
    assert.equal(ready.els.connectStatus.textContent, formatMessage(ready.messages['connect.status.ready'], { title: ready.messages['connect.title.local_api'] }, localeId), `${localeId} ready`);
    assert.equal(ready.statuses.at(-1)[2], ready.els.connectStatus.textContent, `${localeId} the status bar says the same thing`);
    const checking = await runConnectPrompt(localeId, { state: 'connecting' });
    assert.equal(checking.els.connectStatus.textContent, formatMessage(checking.messages['connect.status.checking'], { title: checking.messages['connect.title.local_api'], url: 'http://127.0.0.1:8642' }, localeId), `${localeId} checking`);
    const degraded = await runConnectPrompt(localeId, { state: 'degraded' });
    assert.equal(degraded.els.connectStatus.textContent, formatMessage(degraded.messages['connect.status.degraded'], { detail: 'A reason.' }, localeId), `${localeId} degraded`);
  }
  const arabic = await runConnectPrompt('ar', { state: 'not-configured' });
  assert.doesNotMatch(arabic.els.connectStatus.textContent, /Click Connect|Manual setup/, 'Arabic never shows the English sentence');
  assert.match(arabic.els.connectStatus.textContent, /[؀-ۿ]/);
});

test('a language switch re-says the connect status while a connection is still needed', () => {
  const subscriber = js.slice(js.indexOf('subscribeLocale(() => {'), js.indexOf('await initI18n();'));
  assert.match(subscriber, /if \(els\.connectPanel && !els\.connectPanel\.hidden\) updateConnectionPrompt\(\);/);
});

test('connectApiWithPairing builds its status text from the catalog, not from English literals', () => {
  const connect = functionSource('connectApiWithPairing');
  assert.doesNotMatch(connect, /`Looking for /);
  assert.doesNotMatch(connect, /Manual setup is still available in settings/);
  assert.doesNotMatch(connect, /Automatic pairing is available only for a loopback Local gateway/);
  assert.match(connect, /t\('connect\.status\.looking', \{ title: gatewayTitleText\(summary\), url: summary\.normalizedUrl \}\)/);
  assert.match(connect, /t\('connect\.status\.failed', \{ reason: /);
  assert.match(connect, /t\('connect\.status\.loopback_only'\)/);
  const prompt = functionSource('updateConnectionPrompt');
  for (const literal of ['Click Connect to Hermes or use Manual setup', '`Checking ${summary.title}', 'Connected to Hermes with a runtime warning', "textContent = 'Connected to Hermes. You can start chatting with page context.'"]) {
    assert.ok(!prompt.includes(literal), `updateConnectionPrompt no longer hard-codes ${literal}`);
  }
});
