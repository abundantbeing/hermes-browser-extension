import test from 'node:test';
import assert from 'node:assert/strict';

const contextMenu = await import('../extension/lib/context-menu-config.mjs');

const {
  CONTEXT_MENU_ACTION_TYPES,
  CONTEXT_MENU_CONFIG_STORAGE_KEY,
  CONTEXT_MENU_ROOT_ID,
  DEFAULT_CONTEXT_MENU_CONFIG,
  applyContextMenuConfigMutation,
  browserMenuIdForItem,
  contextMenuClickEnvelope,
  contextMenuContextPolicy,
  contextMenuUrlDigest,
  normalizeContextMenuConfig,
  parseBrowserMenuId,
} = contextMenu;

test('context-menu config uses a dedicated versioned storage record with deep-cloned defaults', () => {
  assert.equal(CONTEXT_MENU_CONFIG_STORAGE_KEY, 'hermesBrowserContextMenuConfig');
  const first = normalizeContextMenuConfig(undefined);
  const second = normalizeContextMenuConfig(undefined);
  assert.equal(first.version, 1);
  assert.equal(first.revision, 0);
  assert.equal(first.items.length, DEFAULT_CONTEXT_MENU_CONFIG.items.length);
  first.items[0].contexts.push('page');
  assert.deepEqual(second.items[0].contexts, ['selection']);
});

test('context-menu config preserves an intentional empty list', () => {
  const config = normalizeContextMenuConfig({ version: 1, revision: 7, items: [] });
  assert.equal(config.revision, 7);
  assert.deepEqual(config.items, []);
});

test('context-menu config rejects reserved ids, duplicate ids, empty prompts, and unsupported action types', () => {
  const config = normalizeContextMenuConfig({
    version: 1,
    revision: 3,
    items: [
      { id: CONTEXT_MENU_ROOT_ID, title: 'Collision', contexts: ['page'], action: { type: 'open' } },
      { id: 'valid', title: 'Valid', contexts: ['selection'], action: { type: 'prompt', prompt: 'Explain this.' } },
      { id: 'valid', title: 'Duplicate', contexts: ['page'], action: { type: 'open' } },
      { id: 'empty-prompt', title: 'Empty', contexts: ['selection'], action: { type: 'prompt', prompt: '   ' } },
      { id: 'script', title: 'Nope', contexts: ['page'], action: { type: 'javascript', code: 'alert(1)' } },
    ],
  });
  assert.deepEqual(config.items.map((item) => item.id), ['valid']);
});

test('context-menu config constrains inline actions to allowlisted editable behavior', () => {
  const config = normalizeContextMenuConfig({
    version: 1,
    revision: 0,
    items: [
      { id: 'good', title: 'Improve', contexts: ['page', 'editable'], action: { type: 'inline', actionId: 'improve' } },
      { id: 'bad-context', title: 'Improve page', contexts: ['page'], action: { type: 'inline', actionId: 'improve' } },
      { id: 'bad-action', title: 'Execute', contexts: ['editable'], action: { type: 'inline', actionId: 'execute' } },
    ],
  });
  assert.deepEqual(config.items, [{
    id: 'good',
    title: 'Improve',
    titleKey: '',
    enabled: true,
    contexts: ['editable'],
    action: { type: CONTEXT_MENU_ACTION_TYPES.INLINE, actionId: 'improve' },
  }]);
});

test('browser menu ids bind the configuration revision, action type, and stable item id', () => {
  const item = { id: 'explain-selection', action: { type: 'prompt', prompt: 'Explain.' } };
  const browserId = browserMenuIdForItem(item);
  assert.equal(browserId, 'hermes-browser-action:0:prompt:explain-selection');
  assert.deepEqual(parseBrowserMenuId(browserId), { revision: 0, actionType: 'prompt', itemId: 'explain-selection' });
  assert.equal(parseBrowserMenuId('hermes-browser-root'), null);
  assert.equal(parseBrowserMenuId('hermes-browser-action:javascript:nope'), null);
});

test('click envelopes bind the exact clicked tab, frame, trigger, and sanitized resource', () => {
  const envelope = contextMenuClickEnvelope({
    item: { id: 'inspect-resource', action: { type: 'prompt', prompt: 'Inspect it.' } },
    info: {
      menuItemId: 'hermes-browser-action:0:prompt:inspect-resource',
      frameId: 4,
      pageUrl: 'https://example.com/article?session=private#section',
      linkUrl: 'https://docs.example.com/guide?token=private#part',
      selectionText: ' selected words ',
    },
    tab: { id: 17, windowId: 9, url: 'https://example.com/article' },
    route: 'background',
    now: 1_000,
    sourceUrlDigest: 'a'.repeat(64),
  });
  assert.deepEqual(envelope, {
    version: 1,
    itemId: 'inspect-resource',
    actionType: 'prompt',
    prompt: 'Inspect it.',
    route: 'background',
    trigger: 'link',
    selection: 'selected words',
    pageUrl: 'https://example.com/article',
    sourceUrlDigest: 'a'.repeat(64),
    resourceUrl: 'https://docs.example.com/guide',
    tabId: 17,
    windowId: 9,
    frameId: 4,
    createdAt: 1_000,
    expiresAt: 301_000,
  });
});

test('context-menu URL digests reuse Browser Context Protocol restricted-page policy', async () => {
  const digest = await contextMenuUrlDigest('https://example.com/docs?debug=reader');
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(await contextMenuUrlDigest('https://example.com/billing'), '');
  assert.equal(await contextMenuUrlDigest('chrome://extensions'), '');
});

test('selection-only context policy never captures the page body', () => {
  const selectionPolicy = contextMenuContextPolicy({
    trigger: 'selection',
    selection: 'literal selection',
    pageUrl: 'https://example.com/article',
    resourceUrl: '',
    tabId: 17,
    frameId: 0,
  });
  assert.deepEqual(selectionPolicy, {
    capturePage: false,
    selectedText: 'literal selection',
    resourceUrl: '',
    target: { tabId: 17, frameId: 0, pageUrl: 'https://example.com/article' },
  });

  const pagePolicy = contextMenuContextPolicy({
    trigger: 'page',
    selection: '',
    pageUrl: 'https://example.com/article',
    resourceUrl: '',
    tabId: 17,
    frameId: 2,
  });
  assert.equal(pagePolicy.capturePage, true);
  assert.deepEqual(pagePolicy.target, { tabId: 17, frameId: 2, pageUrl: 'https://example.com/article' });
});

test('serialized item mutations apply to the latest revision without replacing unrelated items', () => {
  const start = normalizeContextMenuConfig({
    version: 1,
    revision: 4,
    items: [
      { id: 'a', title: 'A', contexts: ['selection'], action: { type: 'prompt', prompt: 'A prompt' } },
      { id: 'b', title: 'B', contexts: ['page'], action: { type: 'open' } },
    ],
  });
  const updated = applyContextMenuConfigMutation(start, {
    type: 'update',
    id: 'a',
    patch: { title: 'Updated A' },
  });
  assert.equal(updated.revision, 5);
  assert.equal(updated.items[0].title, 'Updated A');
  assert.deepEqual(updated.items[1], start.items[1]);

  const removed = applyContextMenuConfigMutation(updated, { type: 'remove', id: 'b' });
  assert.equal(removed.revision, 6);
  assert.deepEqual(removed.items.map((item) => item.id), ['a']);
});
