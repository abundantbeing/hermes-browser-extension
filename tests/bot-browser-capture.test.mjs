import test from 'node:test';
import assert from 'node:assert/strict';
import { captureBotTabScreenshot, collectBotPageContext } from '../extension/lib/bot-browser-capture.mjs';
import { prepareBotBrowserTurn } from '../extension/lib/bot-browser-turn.mjs';
const tab = { id: 7, windowId: 2, active: true, url: 'https://example.com/docs', title: 'Documentation' };
function browser(overrides = {}) {
  return { tabs: {
    get: async () => tab,
    query: async () => [tab],
    captureVisibleTab: async () => 'data:image/png;base64,aGVsbG8=',
    sendMessage: async () => ({ ok: true, url: tab.url, text: 'Page text', meta: {} }),
    ...overrides,
  } };
}
test('an explicitly requested visible-tab screenshot becomes a staged image attachment', async () => {
  const image = await captureBotTabScreenshot({ browserApi: browser(), tab, scopeMode: 'follow-active', allowed: true });
  assert.equal(image.kind, 'image');
  assert.equal(image.browserTabScreenshot, true);
  assert.equal(image.dataUrl, 'data:image/png;base64,aGVsbG8=');
  assert.equal(image.tabUrl, tab.url);
});
test('chat-only, denied consent and restricted pages never invoke capture', async () => {
  const browserApi = browser({ captureVisibleTab: () => assert.fail('must not capture') });
  for (const options of [
    { scopeMode: 'chat-only', allowed: true, tab },
    { scopeMode: 'follow-active', allowed: false, tab },
    { scopeMode: 'follow-active', allowed: true, tab: { ...tab, url: 'https://example.com/checkout' } },
  ]) await assert.rejects(captureBotTabScreenshot({ browserApi, ...options }), /context|page/i);
});
test('a target that is no longer visible cannot capture another tab', async () => {
  await assert.rejects(captureBotTabScreenshot({
    browserApi: browser({ query: async () => [{ ...tab, id: 8 }], captureVisibleTab: () => assert.fail('must not capture') }),
    tab, scopeMode: 'pinned-tab', allowed: true,
  }), /visible|changed/);
});
test('navigation during capture discards screenshot bytes', async () => {
  let reads = 0;
  await assert.rejects(captureBotTabScreenshot({
    browserApi: browser({ get: async () => ++reads === 1 ? tab : { ...tab, url: 'https://example.com/account' } }),
    tab, scopeMode: 'follow-active', allowed: true,
  }), /changed/);
});
test('page-context capture does not query tabs in chat-only mode', async () => {
  const result = await collectBotPageContext({ browserApi: browser({ query: () => assert.fail('must not read') }), scope: { mode: 'chat-only' } });
  assert.equal(result.activeTab, null);
});
test('pinned context addresses exactly the selected tab and validates extractor URL', async () => {
  const ids = [];
  const result = await collectBotPageContext({
    browserApi: browser({ sendMessage: async (id) => { ids.push(id); return { ok: true, url: tab.url, text: 'Correct page' }; } }),
    scope: { mode: 'pinned-tab', pinnedTabId: 7 }, settings: { includePageText: true },
  });
  assert.deepEqual(ids, [7]);
  assert.equal(result.pageContext.text, 'Correct page');
  const turn = await prepareBotBrowserTurn({
    scope: { mode: 'pinned-tab', pinnedTabId: 7 },
    getContext: async () => result,
  });
  assert.equal(turn.browserContext.enabled, true);
  assert.equal(turn.browserContext.extractedText, 'Correct page');
});
test('disabled page text does not invoke extraction', async () => {
  const result = await collectBotPageContext({ browserApi: browser({ sendMessage: () => assert.fail('must not extract') }), scope: { mode: 'follow-active' }, settings: { includePageText: false } });
  assert.equal(result.pageContext.text, '');
});
