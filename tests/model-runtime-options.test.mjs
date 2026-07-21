import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MODEL_REASONING_EFFORTS,
  modelRuntimeCapabilities,
  modelRuntimeOptionsPayload,
  normalizeModelRuntimeOptions,
} from '../extension/lib/model-runtime-options.mjs';

test('Hermes surfaces expose all seven reasoning effort levels and preserve distinct Extra High, Max, and Ultra values', () => {
  assert.deepEqual(
    MODEL_REASONING_EFFORTS.map((option) => option.label),
    ['Minimal', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra'],
  );
  assert.equal(normalizeModelRuntimeOptions({ reasoningEffort: 'extra-high' }).reasoningEffort, 'xhigh');
  assert.equal(normalizeModelRuntimeOptions({ reasoningEffort: 'max' }).reasoningEffort, 'max');
  assert.equal(normalizeModelRuntimeOptions({ reasoningEffort: 'ultra' }).reasoningEffort, 'ultra');
  assert.deepEqual(modelRuntimeOptionsPayload({ reasoningEffort: 'ultra', thinkingEnabled: true, fastMode: true }), {
    reasoning: { enabled: true, effort: 'ultra' },
    fast: true,
    service_tier: 'priority',
  });
});

test('model runtime controls respect explicitly unavailable capabilities without hiding unknown-provider controls', () => {
  assert.deepEqual(modelRuntimeCapabilities({ reasoning: false, fast: false }), {
    reasoning: false,
    thinking: false,
    fast: false,
  });
  assert.deepEqual(modelRuntimeCapabilities({}), {
    reasoning: true,
    thinking: true,
    fast: true,
  });
});
