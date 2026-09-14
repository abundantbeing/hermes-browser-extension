import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_PICKER_VISIBLE_MODEL_IDS,
  modelPickerVisibilityFromAllowlist,
  modelPickerVisibilityStats,
  normalizeModelPickerVisibility,
  visibleModelsForPicker,
} from '../extension/lib/model-picker-visibility.mjs';

const model = (id, provider, source = 'registry') => ({
  id: `${provider}::${id}`,
  rawModelId: id,
  provider,
  source,
  runtimeSelectable: true,
});

test('default operational allowlist keeps profiles and Q38 variants visible', () => {
  const models = [
    { id: 'hermes-agent', rawModelId: 'hermes-agent', provider: 'Hermes', source: 'gateway', runtimeSelectable: true },
    model('gpt-5.6-luna-900k', 'openai-codex'),
    model('gpt-5.6-terra-900k', 'openai-codex'),
    model('gemini-3.8-flash-high', 'antigravity'),
    model('qwen3.8-27b', 'custom:omlx-local'),
    model('qwen3.8-27b:hermes', 'custom:omlx-local'),
    model('qwen3.8-27b:chat', 'custom:omlx-local'),
    model('qwen3.8-27b:thinking', 'custom:omlx-local'),
    model('qwen3.6-35b-a3b-uncensored-heretic-mlx', 'custom:omlx-local'),
    model('claude-opus-4.8', 'copilot'),
  ];
  const stats = modelPickerVisibilityStats(
    models,
    modelPickerVisibilityFromAllowlist(DEFAULT_MODEL_PICKER_VISIBLE_MODEL_IDS),
  );
  assert.equal(stats.visibleCount, 8);
  assert.equal(stats.hiddenCount, 2);
  assert.deepEqual(stats.visible.map((row) => row.rawModelId), [
    'hermes-agent',
    'gpt-5.6-luna-900k',
    'gpt-5.6-terra-900k',
    'gemini-3.8-flash-high',
    'qwen3.8-27b',
    'qwen3.8-27b:hermes',
    'qwen3.8-27b:chat',
    'qwen3.8-27b:thinking',
  ]);
});

test('refresh cannot reintroduce models outside the durable allowlist', () => {
  const visibility = modelPickerVisibilityFromAllowlist(['openai-codex::gpt-5.6-luna-900k']);
  const firstRefresh = [model('gpt-5.6-luna-900k', 'openai-codex'), model('old-model', 'copilot')];
  const secondRefresh = [...firstRefresh, model('new-model', 'opencode-free')];
  assert.deepEqual(visibleModelsForPicker(firstRefresh, visibility).map((row) => row.rawModelId), ['gpt-5.6-luna-900k']);
  assert.deepEqual(visibleModelsForPicker(secondRefresh, visibility).map((row) => row.rawModelId), ['gpt-5.6-luna-900k']);
});

test('active selected model is retained without changing routing data', () => {
  const visibility = normalizeModelPickerVisibility({ allowedModelIds: [] });
  const hidden = model('active-legacy', 'custom:omlx-local');
  const visible = visibleModelsForPicker([hidden], visibility, { selectedModelId: hidden.id });
  assert.deepEqual(visible, [hidden]);
  assert.deepEqual(visibility, {
    schemaVersion: 1,
    mode: 'allowlist',
    allowedModelIds: [],
    allowedProviderIds: [],
    hiddenModelIds: [],
    hiddenProviderIds: [],
  });
});
