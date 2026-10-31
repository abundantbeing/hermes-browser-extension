import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { FORBIDDEN_SENDER_RESPONSE, isExtensionPageSender } from '../extension/lib/message-sender.mjs';
import { WAKE_MESSAGES } from '../extension/lib/wake-word.mjs';

const runtime = { id: 'abcdefghijklmnopabcdefghijklmnop', getURL: (path = '') => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}` };
const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');

test('extension pages are recognised, content scripts and web pages are not', () => {
  // Side panel / offscreen document: extension URL, no tab.
  assert.equal(isExtensionPageSender({ id: runtime.id, url: runtime.getURL('sidepanel.html') }, runtime), true);
  assert.equal(isExtensionPageSender({ id: runtime.id }, runtime), true, 'no url and no tab is the worker itself or a bare page');
  // Extension page opened in a tab (permission / full-tab page).
  assert.equal(isExtensionPageSender({ id: runtime.id, tab: { id: 4 }, url: runtime.getURL('sidepanel.html') }, runtime), true);
  // Firefox-style base URL.
  const firefox = { id: 'uuid', getURL: (path = '') => `moz-extension://11111111-2222/${path}` };
  assert.equal(isExtensionPageSender({ id: 'uuid', url: 'moz-extension://11111111-2222/sidepanel.html' }, firefox), true);

  // Content script in a web page: the tab and the page URL are browser-supplied.
  assert.equal(isExtensionPageSender({ id: runtime.id, tab: { id: 9 }, frameId: 0, url: 'https://evil.example/' }, runtime), false);
  assert.equal(isExtensionPageSender({ id: runtime.id, tab: { id: 9 }, url: 'https://abcdefghijklmnopabcdefghijklmnop.chrome-extension.example/' }, runtime), false);
  assert.equal(isExtensionPageSender({ id: runtime.id, tab: { id: 9 } }, runtime), false, 'tab without an extension URL');
  // Other extension, missing sender, missing runtime id.
  assert.equal(isExtensionPageSender({ id: 'other-extension', url: runtime.getURL('x.html') }, runtime), false);
  assert.equal(isExtensionPageSender(undefined, runtime), false);
  assert.equal(isExtensionPageSender({ url: runtime.getURL('x.html') }, runtime), false);
  assert.equal(isExtensionPageSender({ id: runtime.id, url: runtime.getURL('x.html') }, { getURL: runtime.getURL }), false);
  assert.deepEqual(FORBIDDEN_SENDER_RESPONSE, { ok: false, reason: 'forbidden_sender' });
});

test('background router refuses tab senders for every extension-page-only message type', () => {
  const routerSource = background.match(/browserApi\.runtime\.onMessage\.addListener\(\(message, sender, sendResponse\) => \{[\s\S]*?\n\}\);/)?.[0] || '';
  assert.ok(routerSource, 'router located');
  const guardAt = routerSource.indexOf('isExtensionPageOnlyMessageType(message?.type) && !isExtensionPageSender(sender, browserApi.runtime)');
  assert.ok(guardAt >= 0, 'router checks the sender for extension-page-only types');
  assert.ok(guardAt < routerSource.indexOf('const action ='), 'the guard runs before any dispatch');
  assert.match(routerSource, /sendResponse\(\{ \.\.\.FORBIDDEN_SENDER_RESPONSE \}\);\s*return false;/);

  const setSource = background.match(/const EXTENSION_PAGE_ONLY_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  for (const entry of ['...WAKE_BACKGROUND_MESSAGE_TYPES', 'CONTEXT_MENU_CONFIG_GET', 'CONTEXT_MENU_CONFIG_MUTATE', 'CONTEXT_MENU_REQUEST_CLAIM', "'HERMES_GET_YOUTUBE_TRANSCRIPT'", 'LOOPBACK_FETCH_MESSAGE']) {
    assert.ok(setSource.includes(entry), `${entry} is extension-page-only`);
  }
  assert.match(background, /themeMarketplaceController\.handles\(type\)/);
  const wakeSet = background.match(/const WAKE_BACKGROUND_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  for (const type of [WAKE_MESSAGES.setEnabled, WAKE_MESSAGES.localDetected, WAKE_MESSAGES.localState, WAKE_MESSAGES.turnReply, WAKE_MESSAGES.claimTurn, WAKE_MESSAGES.getState]) {
    const key = Object.entries(WAKE_MESSAGES).find(([, value]) => value === type)[0];
    assert.ok(wakeSet.includes(`WAKE_MESSAGES.${key}`), `${type} is in the wake set`);
  }

  // Content-script types are not in the extension-page-only set.
  for (const contentType of ['HERMES_INLINE_DRAFT_REQUEST', 'HERMES_INLINE_SESSION_STATUS', 'HERMES_INLINE_OPEN_SESSION', 'HERMES_CONTROLLER_DOCUMENT_READY']) {
    assert.ok(!setSource.includes(contentType), `${contentType} must stay reachable from content scripts`);
  }
});

test('content scripts only send message types that the router still accepts from tabs', () => {
  const contentSources = ['content.js', 'content-inline-helper.js'].map((file) => readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8')).join('\n');
  const setSource = background.match(/const EXTENSION_PAGE_ONLY_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  for (const sent of ['HERMES_CONTROLLER_DOCUMENT_READY', 'HERMES_PAGE_COMMENT_CARD_SUBMIT', 'HERMES_PAGE_COMMENT_CARD_CANCEL']) assert.match(contentSources, new RegExp(sent));
  assert.doesNotMatch(contentSources, /HERMES_WAKE_|HERMES_LOOPBACK_FETCH|HERMES_GET_YOUTUBE_TRANSCRIPT'/);
  assert.doesNotMatch(setSource, /HERMES_CONTROLLER_DOCUMENT_READY/);
});

test('the real background router refuses tab senders for every extension-page-only type and still serves content-script types', async () => {
  const previousChrome = globalThis.chrome;
  let messageListener = null;
  const event = (capture) => ({ addListener(listener) { capture?.(listener); } });
  globalThis.chrome = {
    runtime: {
      id: 'hermes-test',
      getURL: (assetPath = '') => `chrome-extension://hermes-test/${assetPath}`,
      getManifest: () => ({ side_panel: { default_path: 'sidepanel.html' } }),
      onInstalled: event(),
      onStartup: event(),
      onMessage: event((listener) => { messageListener = listener; }),
    },
    action: { onClicked: event(), setPopup: async () => {} },
    tabs: { create: async () => {}, query: async () => [], onActivated: event() },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: event() },
    sidePanel: {},
  };
  const call = (message, sender) => new Promise((resolve) => {
    const handled = messageListener(message, sender, resolve);
    if (handled === false) resolve(undefined);
  });
  const contentScript = { id: 'hermes-test', tab: { id: 7 }, frameId: 0, url: 'https://page.example/' };
  const extensionPage = { id: 'hermes-test', url: 'chrome-extension://hermes-test/sidepanel.html' };
  try {
    await import(`../extension/background.js?message-sender=${Date.now()}`);
    assert.equal(typeof messageListener, 'function');
    const refused = { ok: false, reason: 'forbidden_sender' };
    const types = [
      'HERMES_WAKE_SET_ENABLED', 'HERMES_WAKE_GET_STATE', 'HERMES_WAKE_CLAIM_TURN', 'HERMES_WAKE_LOCAL_DETECTED', 'HERMES_WAKE_LOCAL_STATE', 'HERMES_WAKE_TURN_REPLY',
      'HERMES_LOOPBACK_FETCH', 'HERMES_GET_YOUTUBE_TRANSCRIPT',
      'HERMES_CONTEXT_MENU_CONFIG_GET', 'HERMES_CONTEXT_MENU_CONFIG_MUTATE', 'HERMES_CONTEXT_MENU_REQUEST_CLAIM',
    ];
    for (const type of types) {
      assert.deepEqual(await call({ type, enabled: true, settings: { gatewayUrl: 'https://attacker.example' }, url: 'http://127.0.0.1:9119/api/status' }, contentScript), refused, `${type} from a content script`);
      assert.deepEqual(await call({ type }, undefined), refused, `${type} with no sender`);
      assert.deepEqual(await call({ type }, { id: 'someone-else', url: 'chrome-extension://someone-else/x.html' }), refused, `${type} from another extension`);
    }
    // A loopback fetch from a content script returns nothing but the refusal.
    assert.deepEqual(await call({ type: 'HERMES_LOOPBACK_FETCH', url: 'http://127.0.0.1:1/' }, contentScript), refused);
    // The same type from this extension's own page is not refused by the sender guard.
    assert.notDeepEqual(await call({ type: 'HERMES_LOOPBACK_FETCH', url: 'https://example.com/' }, extensionPage), refused);
    assert.deepEqual(await call({ type: 'HERMES_WAKE_GET_STATE' }, extensionPage), (await call({ type: 'HERMES_WAKE_GET_STATE' }, { id: 'hermes-test', tab: { id: 2 }, url: 'chrome-extension://hermes-test/voice-dictation.html' })));
    // Content-script message types are unaffected by the guard.
    assert.notDeepEqual(await call({ type: 'HERMES_INLINE_SESSION_STATUS' }, contentScript), refused);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
