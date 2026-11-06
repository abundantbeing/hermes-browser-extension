import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assistModelChoices,
  assistModelSettingsFor,
  createInlineAssistModelServer,
  INLINE_ASSIST_MODELS_REQUEST,
} from '../extension/lib/inline-assist-models.mjs';

const settings = { gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642', activeProfile: 'default', inlineAssistModel: 'anthropic::claude-haiku-5-5' };
const cache = {
  'local-api|http://127.0.0.1:8642|default': {
    savedAt: 2,
    models: [
      { id: 'anthropic::claude-haiku-5-5', rawModelId: 'claude-haiku-5-5', provider: 'anthropic', providerLabel: 'Anthropic', label: 'Claude Haiku 5.5' },
      { id: 'openai-codex::gpt-6.1-terra', rawModelId: 'gpt-6.1-terra', provider: 'openai-codex', label: 'gpt-6.1-terra' },
      { id: 'hermes-agent', rawModelId: 'hermes-agent', gatewayAlias: true },
      { id: 'old::observed', rawModelId: 'observed', provider: 'old', runtimeSelectable: false },
    ],
  },
  'local-api|http://127.0.0.1:8642|__shared__': { savedAt: 1, models: [{ id: 'x::other-profile-model', rawModelId: 'other-profile-model', provider: 'x' }] },
};

test('Assist offers the models the side panel verified for this connection, selectable ones only', () => {
  const choices = assistModelChoices(cache, settings);
  assert.deepEqual(choices.map((choice) => choice.id), ['anthropic::claude-haiku-5-5', 'openai-codex::gpt-6.1-terra']);
  assert.deepEqual(choices[0], { id: 'anthropic::claude-haiku-5-5', rawModelId: 'claude-haiku-5-5', provider: 'anthropic', label: 'Claude Haiku 5.5', providerLabel: 'Anthropic' });
});

test('with no catalog for this profile yet, the connection-wide one is used', () => {
  const choices = assistModelChoices(cache, { ...settings, activeProfile: 'writer' });
  assert.deepEqual(choices.map((choice) => choice.id), ['x::other-profile-model']);
  assert.deepEqual(assistModelChoices({}, settings), []);
});

test('choosing a model sets the three Assist model settings Settings → Hermes Assist also writes', () => {
  assert.deepEqual(assistModelSettingsFor(assistModelChoices(cache, settings)[1]), {
    inlineAssistModel: 'openai-codex::gpt-6.1-terra',
    inlineAssistRawModel: 'gpt-6.1-terra',
    inlineAssistProvider: 'openai-codex',
  });
});

function fakeRuntime(stored) {
  const writes = [];
  return {
    writes,
    stored,
    runtime: { id: 'ext' },
    storage: {
      get: async () => structuredClone(stored),
      set: async (items) => { writes.push(items); Object.assign(stored, structuredClone(items)); },
    },
  };
}

test('the background only lists models for a page of this extension; it never writes settings for one', async () => {
  const env = fakeRuntime({ hermesBrowserSettings: { ...settings, other: 'kept' }, hermesBrowserModelCatalogCache: cache });
  const server = createInlineAssistModelServer({ runtime: env.runtime, storage: env.storage });
  const sender = { id: 'ext', tab: { id: 4 } };
  const listed = await server.handle({ type: INLINE_ASSIST_MODELS_REQUEST }, sender);
  assert.equal(listed.ok, true);
  assert.equal(listed.selectedId, 'anthropic::claude-haiku-5-5');
  assert.equal(listed.models.length, 2);
  // A content script is never trusted to change settings through the background.
  assert.equal(server.handles('HERMES_INLINE_ASSIST_SET_MODEL'), false);
  assert.equal(env.stored.hermesBrowserSettings.inlineAssistModel, 'anthropic::claude-haiku-5-5', 'nothing written');
  const stranger = await server.handle({ type: INLINE_ASSIST_MODELS_REQUEST }, { id: 'other-extension', tab: { id: 4 } });
  assert.equal(stranger.ok, false, 'never for another extension');
});
