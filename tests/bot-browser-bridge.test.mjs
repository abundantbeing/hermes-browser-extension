import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOT_SCREENSHOT_MAX_BYTES,
  prepareTabScreenshotAttachment,
  resolveBotBrowserContext,
  screenshotAttachParams,
  shouldAttachBrowserContextToBotTurn,
} from '../extension/lib/bot-browser-bridge.mjs';
import { MAX_INLINE_SCREENSHOT_CHARS } from '../extension/lib/screenshot-limits.mjs';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// ---------------------------------------------------------------------------
// Scope decision
// ---------------------------------------------------------------------------

test('shouldAttachBrowserContextToBotTurn is false for a chat-only scope', () => {
  assert.equal(shouldAttachBrowserContextToBotTurn({ scopeMode: 'chat-only', activeTab: { id: 1, url: 'https://example.com' } }), false);
});

test('shouldAttachBrowserContextToBotTurn is false without an active tab', () => {
  assert.equal(shouldAttachBrowserContextToBotTurn({ scopeMode: 'follow-active', activeTab: null }), false);
  assert.equal(shouldAttachBrowserContextToBotTurn({ scopeMode: 'follow-active', activeTab: { id: 1, url: '' } }), false);
});

test('shouldAttachBrowserContextToBotTurn fails closed on a restricted or credential-bearing URL', () => {
  assert.equal(shouldAttachBrowserContextToBotTurn({ scopeMode: 'follow-active', activeTab: { id: 1, url: 'https://bank.example.com/accounts' } }), false);
  assert.equal(shouldAttachBrowserContextToBotTurn({ scopeMode: 'follow-active', activeTab: { id: 1, url: 'https://example.com/cb?access_token=abc123' } }), false);
  assert.equal(shouldAttachBrowserContextToBotTurn({ scopeMode: 'follow-active', activeTab: { id: 1, url: 'chrome://settings' } }), false);
});

test('shouldAttachBrowserContextToBotTurn is true for a normal follow-active tab', () => {
  assert.equal(shouldAttachBrowserContextToBotTurn({ scopeMode: 'follow-active', activeTab: { id: 101, url: 'https://example.com/docs' } }), true);
});

// ---------------------------------------------------------------------------
// resolveBotBrowserContext
// ---------------------------------------------------------------------------

test('resolveBotBrowserContext reports disabled for a chat-only scope and carries no tab data', () => {
  const result = resolveBotBrowserContext({
    scopeMode: 'chat-only',
    activeTab: { id: 1, url: 'https://example.com/pricing', title: 'Pricing' },
    pageContext: { text: 'secret page' },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'chat-only');
  assert.equal(result.activeTab, null);
  assert.equal(result.tab, null);
  assert.equal(result.extractedText, '');
});

test('resolveBotBrowserContext fails closed on a sensitive URL instead of leaking tab or text', () => {
  const result = resolveBotBrowserContext({
    scopeMode: 'follow-active',
    activeTab: { id: 9, url: 'https://example.com/checkout', title: 'Checkout' },
    pageContext: { text: 'card on file 4111 1111 1111 1111' },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'restricted-url');
  assert.equal(result.activeTab, null);
  assert.equal(result.tab, null);
  assert.equal(result.extractedText, '');
});

test('resolveBotBrowserContext fails closed on a credential-bearing URL', () => {
  const result = resolveBotBrowserContext({
    scopeMode: 'follow-active',
    activeTab: { id: 9, url: 'https://example.com/oauth?session_token=abc123', title: 'OAuth' },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'restricted-url');
});

test('resolveBotBrowserContext fails closed when the pinned tab does not match the active tab', () => {
  const result = resolveBotBrowserContext({
    scopeMode: 'pinned-tab',
    activeTab: { id: 5, url: 'https://example.com/other', title: 'Other' },
    tabs: [{ id: 7, url: 'https://example.com/pinned', title: 'Pinned' }],
    contextScope: { mode: 'pinned-tab', pinnedTabId: 7 },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'pinned-mismatch');
  assert.equal(result.tab, null);
});

test('resolveBotBrowserContext captures the pinned tab when it matches', () => {
  const result = resolveBotBrowserContext({
    scopeMode: 'pinned-tab',
    activeTab: { id: 7, url: 'https://example.com/pinned', title: 'Pinned' },
    tabs: [{ id: 7, url: 'https://example.com/pinned', title: 'Pinned' }],
    contextScope: { mode: 'pinned-tab', pinnedTabId: 7 },
    pageContext: { text: 'pinned body' },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.tab.url, 'https://example.com/pinned');
  assert.match(result.extractedText, /pinned body/);
});

test('resolveBotBrowserContext builds an enabled, privacy-safe context with a bounded extracted text', () => {
  const result = resolveBotBrowserContext({
    scopeMode: 'follow-active',
    activeTab: { id: 101, url: 'https://example.com/pricing', title: 'Example Pricing', favIconUrl: 'https://example.com/favicon.ico' },
    tabs: [{ id: 101, url: 'https://example.com/pricing', title: 'Example Pricing' }],
    pageContext: { text: `Standard tier is $29/mo. Pro tier is $99/mo. ${'x'.repeat(40_000)}` },
    settings: { contextDepth: 'minimal' },
    contextHash: 'abc123',
    contextDelivery: 'full',
  });

  assert.equal(result.enabled, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.tab.url, 'https://example.com/pricing');
  assert.equal(result.tab.title, 'Example Pricing');
  assert.equal(result.activeTab.favIconUrl, 'https://example.com/favicon.ico');
  assert.match(result.extractedText, /Standard tier/);
  assert.ok(result.extractedText.length < 40_000, 'extracted text is bounded');
  assert.match(result.extractedText, /truncated/);
  assert.equal(result.contextHash, 'abc123');
  assert.equal(result.contextDelivery, 'full');
  assert.equal(result.contextScope.mode, 'follow-active');
});

test('resolveBotBrowserContext redacts secrets in the extracted text', () => {
  const result = resolveBotBrowserContext({
    scopeMode: 'follow-active',
    activeTab: { id: 101, url: 'https://example.com/docs', title: 'Docs' },
    pageContext: { text: 'token sk-abcdefghijklmnopqrstuvwx should never cross the boundary' },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.extractedText.includes('sk-abcdefghijklmnopqrstuvwx'), false);
  assert.match(result.extractedText, /\[REDACTED_SECRET\]/);
});

test('resolveBotBrowserContext keeps the privacy-safe shape when no page context is supplied', () => {
  const result = resolveBotBrowserContext({
    scopeMode: 'follow-active',
    activeTab: { id: 3, url: 'https://example.com/', title: 'Home' },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.extractedText, '');
  assert.deepEqual(result.tabs, []);
});

// ---------------------------------------------------------------------------
// Screenshot attachments
// ---------------------------------------------------------------------------

test('prepareTabScreenshotAttachment builds a valid attachment from a raster data URL', () => {
  const attachment = prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 101, title: 'Dashboard Preview' });
  assert.equal(attachment.type, 'image');
  assert.equal(attachment.mime, 'image/png');
  assert.equal(attachment.name, 'browser-tab-101.png');
  assert.equal(attachment.data, PNG_DATA_URL);
  assert.ok(attachment.bytes > 0);
});

test('prepareTabScreenshotAttachment rejects a non-raster data URL', () => {
  assert.equal(prepareTabScreenshotAttachment('data:text/plain;base64,aGVsbG8=', { tabId: 1 }), null);
  assert.equal(prepareTabScreenshotAttachment('https://example.com/shot.png', { tabId: 1 }), null);
  assert.equal(prepareTabScreenshotAttachment('', { tabId: 1 }), null);
});

test('prepareTabScreenshotAttachment rejects an oversize payload instead of shipping it', () => {
  const oversize = `data:image/png;base64,${'A'.repeat(64)}`;
  assert.equal(prepareTabScreenshotAttachment(oversize, { tabId: 1, maxBytes: 8 }), null);
  assert.equal(prepareTabScreenshotAttachment(`data:image/png;base64,${'A'.repeat(MAX_INLINE_SCREENSHOT_CHARS)}`, { tabId: 1 }), null);
  assert.ok(BOT_SCREENSHOT_MAX_BYTES >= 1_000_000, 'the default cap is at least 1 MB');
});

test('screenshotAttachParams shapes the exact image.attach_bytes request', () => {
  const attachment = prepareTabScreenshotAttachment(PNG_DATA_URL, { tabId: 55 });
  const params = screenshotAttachParams(attachment, 'live-alpha');
  assert.equal(params.session_id, 'live-alpha');
  assert.equal(params.content_base64, PNG_DATA_URL);
  assert.equal(params.filename, 'browser-tab-55.png');
  assert.equal(Object.hasOwn(params, 'attachments'), false, 'never a generic attachments field');
});