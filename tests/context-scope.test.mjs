import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_SCOPE_MODES,
  compactPinnedTitle,
  contextScopeForGateway,
  contextScopeFromTab,
  filterPromptTabs,
  messageStorageKeyForScope,
  normalizeContextScope,
  resolveContextTargetTab,
  sessionBindingKeyForScope,
  shouldRefreshForTabEvent,
  tabScopeId,
} from '../extension/lib/context-scope.mjs';

const tabs = [
  { id: 1, windowId: 10, title: 'One', url: 'https://one.example' },
  { id: 2, windowId: 10, title: 'Two', url: 'https://two.example' },
];

test('normalizeContextScope defaults to follow-active', () => {
  const scope = normalizeContextScope({});
  assert.equal(scope.mode, CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE);
  assert.deepEqual(scope.selectedTabIds, [], 'fresh follow-active scope should start as page-only, not include-all');
  assert.equal(tabScopeId({}), 'follow-active');
  assert.deepEqual(filterPromptTabs(tabs, scope), []);
});

test('pinned tab scope resolves the pinned tab instead of active tab', () => {
  const scope = normalizeContextScope({ mode: 'pinned-tab', pinnedTabId: 2 });
  assert.deepEqual(resolveContextTargetTab({ activeTab: tabs[0], tabs, scope }), tabs[1]);
});

test('pinned tab scope returns null when the pinned tab is gone', () => {
  const scope = normalizeContextScope({ mode: 'pinned-tab', pinnedTabId: 99 });
  assert.equal(resolveContextTargetTab({ activeTab: tabs[0], tabs, scope }), null);
});

test('pinned tab scope ignores active-tab switches but refreshes pinned-tab updates', () => {
  const scope = normalizeContextScope({ mode: 'pinned-tab', pinnedTabId: 2 });
  assert.equal(shouldRefreshForTabEvent({ scope, eventType: 'activated', eventTabId: 1 }), false);
  assert.equal(shouldRefreshForTabEvent({ scope, eventType: 'updated', eventTabId: 1 }), false);
  assert.equal(shouldRefreshForTabEvent({ scope, eventType: 'updated', eventTabId: 2 }), true);
});

test('scope storage keys isolate messages and sessions per pinned tab', () => {
  const scope = normalizeContextScope({ mode: 'pinned-tab', pinnedTabId: 2 });
  assert.equal(messageStorageKeyForScope(scope), 'hermesBrowserMessages:tab:2');
  assert.equal(sessionBindingKeyForScope(scope), 'hermesBrowserSession:tab:2');
});

test('pinned tab titles are clipped before storage/session naming', () => {
  const longTitle = 'Forward deployed engineer - Nous Research '.repeat(4);
  const scope = contextScopeFromTab({ id: 3, windowId: 10, title: longTitle, url: 'https://nousresearch.com' });
  assert.equal(scope.pinnedTitle.length <= 72, true);
  assert.equal(scope.pinnedTitle.endsWith('…'), true);
  assert.equal(compactPinnedTitle('short title'), 'short title');
});

test('filterPromptTabs keeps selected tab ids only and allows empty selections', () => {
  assert.deepEqual(filterPromptTabs(tabs, normalizeContextScope({ selectedTabIds: [2] })), [tabs[1]]);
  assert.deepEqual(filterPromptTabs(tabs, normalizeContextScope({ selectedTabIds: [] })), []);
  assert.deepEqual(filterPromptTabs(tabs, normalizeContextScope({ selectedTabIds: null })), tabs, 'explicit null still means include all tabs');
});

test('chat-only mode resolves no tab while preserving the active conversation storage scope', () => {
  const conversationScope = normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.PINNED_TAB, pinnedTabId: 2 });
  const scope = normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.CHAT_ONLY, pinnedTabId: 2, selectedTabIds: [1, 2] });
  assert.equal(scope.mode, CONTEXT_SCOPE_MODES.CHAT_ONLY);
  assert.equal(scope.pinnedTabId, null);
  assert.deepEqual(scope.selectedTabIds, []);
  assert.equal(tabScopeId(scope), CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE);
  assert.equal(tabScopeId(scope, conversationScope), 'tab:2');
  assert.equal(resolveContextTargetTab({ activeTab: tabs[0], tabs, scope }), null);
  assert.deepEqual(filterPromptTabs(tabs, scope), []);
  assert.equal(messageStorageKeyForScope(scope), 'hermesBrowserMessages:follow-active');
  assert.equal(sessionBindingKeyForScope(scope), 'hermesBrowserSession:follow-active');
  assert.equal(messageStorageKeyForScope(scope, conversationScope), 'hermesBrowserMessages:tab:2');
  assert.equal(sessionBindingKeyForScope(scope, conversationScope), 'hermesBrowserSession:tab:2');
});

test('chat-only mode does not refresh for tab events', () => {
  const scope = normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.CHAT_ONLY });
  assert.equal(shouldRefreshForTabEvent({ scope, eventType: 'activated', eventTabId: 1 }), false);
  assert.equal(shouldRefreshForTabEvent({ scope, eventType: 'updated', eventTabId: 1 }), false);
  assert.equal(shouldRefreshForTabEvent({ scope, eventType: 'removed', eventTabId: 1 }), false);
});

test('remote dashboard connections enforce chat-only context', () => {
  const pinned = normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.PINNED_TAB, pinnedTabId: 2, selectedTabIds: [2] });
  assert.equal(contextScopeForGateway(pinned, 'remote-dashboard').mode, CONTEXT_SCOPE_MODES.CHAT_ONLY);
  assert.deepEqual(contextScopeForGateway(pinned, 'remote-dashboard').selectedTabIds, []);
  assert.deepEqual(contextScopeForGateway(pinned, 'local-api'), pinned);
  assert.deepEqual(contextScopeForGateway(pinned, 'remote-api'), pinned);
});
