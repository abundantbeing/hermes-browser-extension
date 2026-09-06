import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_SCOPE_MODES,
  DEFAULT_CONTEXT_SCOPE,
  filterPromptTabs,
  normalizeContextScope,
  resolveContextTargetTab,
} from '../extension/lib/context-scope.mjs';
import { getCommand, parseBrowserCommand, resolveCommandPrompt } from '../extension/lib/commands.mjs';

const sampleTabs = [
  { id: 101, title: 'AGI $235.08K - DexScreener', url: 'https://dexscreener.com/solana/agi' },
  { id: 102, title: 'DeepSWE Software Engineering', url: 'https://github.com/nousresearch/deepswe' },
  { id: 103, title: 'Fable Mode PR #42', url: 'https://github.com/rex-codebase/fable-mode' },
  { id: 104, title: 'Steamworks Documentation', url: 'https://partner.steamgames.com/doc' },
];

test('Page-only scope retains target active tab and omits other tabs', () => {
  const scope = normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE, selectedTabIds: [] });
  const target = sampleTabs[0];
  const promptTabs = filterPromptTabs(sampleTabs, scope, { activeTab: target });

  assert.equal(promptTabs.length, 1);
  assert.equal(promptTabs[0].id, 101);
  assert.equal(promptTabs[0].title, 'AGI $235.08K - DexScreener');
});

test('Explicitly opted-in tabs are included alongside target active tab', () => {
  const scope = normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE, selectedTabIds: [103] });
  const target = sampleTabs[0];
  const promptTabs = filterPromptTabs(sampleTabs, scope, { activeTab: target });

  assert.equal(promptTabs.length, 2);
  assert.deepEqual(promptTabs.map((t) => t.id), [101, 103]);
});

test('Include-all tabs (selectedTabIds null) returns all open tabs', () => {
  const scope = normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE, selectedTabIds: null });
  const target = sampleTabs[0];
  const promptTabs = filterPromptTabs(sampleTabs, scope, { activeTab: target });

  assert.equal(promptTabs.length, 4);
});

test('Chat-only scope returns zero prompt tabs', () => {
  const scope = normalizeContextScope({ mode: CONTEXT_SCOPE_MODES.CHAT_ONLY, selectedTabIds: [101, 102] });
  const promptTabs = filterPromptTabs(sampleTabs, scope, { activeTab: sampleTabs[0] });

  assert.equal(promptTabs.length, 0);
});

test('sort-tabs command triages, categorizes, and provides removal checklist', () => {
  const cmd = getCommand('sort-tabs');
  assert.ok(cmd, 'sort-tabs command must be registered');
  assert.equal(cmd.category, 'Tabs');
  assert.ok(cmd.aliases.includes('organize-tabs'));
  assert.ok(cmd.aliases.includes('clean-tabs'));

  const parsed = parseBrowserCommand('/sort-tabs');
  assert.equal(parsed?.kind, 'helper');
  assert.equal(parsed?.command.name, 'sort-tabs');

  const resolved = resolveCommandPrompt('sort-tabs', '', { tabs: sampleTabs });
  assert.match(resolved.prompt, /Analyze and triage all 4 open tabs/);
  assert.match(resolved.prompt, /Group by Category/);
  assert.match(resolved.prompt, /Duplicate & Duplicate Domain Detection/);
  assert.match(resolved.prompt, /Actionable Removal Checklist/);
});
