import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBotBrowserTurn } from '../extension/lib/bot-browser-turn.mjs';
const tab = { id: 7, url: 'https://example.com/docs', title: 'Documentation' };
const getContext = async () => ({ activeTab: tab, tabs: [tab], pageContext: { text: 'Page content' } });
test('enabled bot context is captured once and uses the shared BCP bridge', async () => {
  let calls = 0;
  const result = await prepareBotBrowserTurn({ scope: { mode: 'follow-active' }, gatewayUrl: 'http://127.0.0.1:8642', getContext: async () => { calls++; return getContext(); } });
  assert.equal(calls, 1);
  assert.equal(result.browserContext.enabled, true);
  assert.equal(result.browserContext.extractedText, 'Page content');
});
test('chat-only turns neither collect page context nor send screenshots', async () => {
  const result = await prepareBotBrowserTurn({ scope: { mode: 'chat-only' }, getContext: () => assert.fail('must not read') });
  assert.equal(result.browserContext.enabled, false);
  assert.equal(result.screenshotAttachments.length, 0);
});
test('remote group turns remain chat-only without per-member browser consent', async () => {
  const result = await prepareBotBrowserTurn({ group: true, gatewayUrl: 'https://remote.example', scope: { mode: 'follow-active' }, getContext: () => assert.fail('must not read') });
  assert.equal(result.browserContext.enabled, false);
});
test('a screenshot staged for a different page is refused instead of silently reassigned', async () => {
  await assert.rejects(prepareBotBrowserTurn({ gatewayUrl: 'http://localhost:8642', scope: { mode: 'follow-active' }, getContext,
    attachments: [{ browserTabScreenshot: true, tabId: 8, tabUrl: tab.url, dataUrl: 'data:image/png;base64,aGVsbG8=' }],
  }), /screenshot|tab/);
});
test('a stale scope cannot deliver captured page text', async () => {
  await assert.rejects(prepareBotBrowserTurn({ gatewayUrl: 'http://localhost:8642', scope: { mode: 'follow-active' }, getContext, isCurrent: () => false }), /changed/);
});
test('valid explicitly staged screenshots are mapped to the exact group wire shape', async () => {
  const result = await prepareBotBrowserTurn({ gatewayUrl: 'http://localhost:8642', scope: { mode: 'pinned-tab', pinnedTabId: 7 }, getContext,
    attachments: [{ browserTabScreenshot: true, tabId: 7, tabUrl: tab.url, dataUrl: 'data:image/png;base64,aGVsbG8=', label: 'browser-tab-7.png' }],
  });
  assert.equal(result.screenshotAttachments[0].type, 'image');
  assert.equal(result.screenshotAttachments[0].data, 'data:image/png;base64,aGVsbG8=');
});
