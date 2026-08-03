import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContextMenuTurn,
  contextMenuRequestMatchesTab,
  normalizeContextMenuRequest,
} from '../extension/lib/context-menu-request.mjs';

const baseRequest = {
  version: 1,
  itemId: 'inspect',
  actionType: 'prompt',
  prompt: 'Inspect this.',
  route: 'current',
  trigger: 'selection',
  selection: 'literal selection',
  pageUrl: 'https://example.com/article',
  sourceUrlDigest: '3050ba45d23506907842dad2c3d8a312e976507220b255896d565f60bd1b56f5',
  resourceUrl: '',
  tabId: 17,
  windowId: 9,
  frameId: 4,
  createdAt: 1_000,
  expiresAt: 301_000,
};

const tab = {
  id: 17,
  windowId: 9,
  title: 'Article',
  url: 'https://example.com/article?view=reader#top',
  favIconUrl: 'https://example.com/favicon.ico',
};

test('context-menu requests normalize bounded prompt envelopes and reject expired or non-prompt work', () => {
  assert.deepEqual(normalizeContextMenuRequest(baseRequest, { now: 2_000 }), baseRequest);
  assert.equal(normalizeContextMenuRequest({ ...baseRequest, expiresAt: 1_500 }, { now: 2_000 }), null);
  assert.equal(normalizeContextMenuRequest({ ...baseRequest, actionType: 'inline' }, { now: 2_000 }), null);
  assert.equal(normalizeContextMenuRequest({ ...baseRequest, prompt: ' ' }, { now: 2_000 }), null);
});

test('selection turns pin the clicked tab and attach selection without page-body capture', async () => {
  const turn = await buildContextMenuTurn({ request: baseRequest, tab });
  assert.equal(turn.humanInput, 'Inspect this.');
  assert.deepEqual(turn.attachments, []);
  assert.equal(turn.capturePage, false);
  assert.deepEqual(turn.context.activeTab, tab);
  assert.deepEqual(turn.context.tabs, [tab]);
  assert.deepEqual(turn.context.selectedTabs, [tab]);
  assert.deepEqual(turn.context.contextScope, {
    mode: 'pinned-tab',
    pinnedTabId: 17,
    pinnedWindowId: 9,
    pinnedTitle: 'Article',
    pinnedUrl: 'https://example.com/article',
    selectedTabIds: [17],
  });
  assert.deepEqual(turn.context.pageContext, {
    ok: true,
    restricted: false,
    text: '',
    selectedText: 'literal selection',
    meta: {},
  });
  assert.deepEqual(turn.context.settingsOverride, {
    includePageText: false,
    includeSelectedText: true,
    includeTabs: false,
  });
});

test('link and media turns carry the sanitized target as untrusted attachment data', async () => {
  const turn = await buildContextMenuTurn({
    request: {
      ...baseRequest,
      trigger: 'link',
      selection: '',
      resourceUrl: 'https://docs.example.com/guide',
    },
    tab,
  });
  assert.equal(turn.capturePage, false);
  assert.deepEqual(turn.attachments, [{
    id: 'context-menu-resource-inspect',
    kind: 'url',
    label: 'Right-click link target',
    detail: 'https://docs.example.com/guide',
    text: 'Right-click link target URL: https://docs.example.com/guide',
  }]);
  assert.equal(turn.context.pageContext.text, '');
});

test('page turns retain exact captured page data and override selected text from the click envelope', async () => {
  const turn = await buildContextMenuTurn({
    request: { ...baseRequest, trigger: 'page', selection: 'clicked selection' },
    tab,
    capturedPageContext: {
      ok: true,
      text: 'captured frame text',
      selectedText: 'stale active selection',
      meta: { language: 'en' },
    },
  });
  assert.equal(turn.capturePage, true);
  assert.equal(turn.context.pageContext.text, 'captured frame text');
  assert.equal(turn.context.pageContext.selectedText, 'clicked selection');
  assert.equal(turn.context.settingsOverride.includePageText, true);
});

test('request target verification fails closed when the clicked tab, window, or complete URL changes', async () => {
  assert.equal(await contextMenuRequestMatchesTab(baseRequest, tab), true);
  assert.equal(await contextMenuRequestMatchesTab(baseRequest, { ...tab, url: 'https://example.com/other' }), false);
  assert.equal(await contextMenuRequestMatchesTab(baseRequest, { ...tab, url: 'https://example.com/article?view=changed#top' }), false);
  assert.equal(await contextMenuRequestMatchesTab(baseRequest, { ...tab, id: 18 }), false);
  assert.equal(await contextMenuRequestMatchesTab(baseRequest, { ...tab, windowId: 10 }), false);
});
