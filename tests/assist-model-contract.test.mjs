import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAssistModelSelectionAcknowledged,
  assistChatTurnOverride,
  assistModelFallbackNotice,
  assistModelRequestPolicy,
  assistModelRoutingSupported,
  assistModelSelectionFromSettings,
  buildAssistModelRouteRequest,
  resolveAssistModelBindingFromCatalog,
} from '../extension/lib/assist-model-contract.mjs';

const MODELS = [
  {
    id: 'opencode-go::deepseek-v4-pro',
    rawModelId: 'deepseek-v4-pro',
    provider: 'opencode-go',
    runtimeSelectable: true,
  },
  {
    id: 'Provider::Model-A',
    rawModelId: 'Model-A',
    provider: 'Provider',
    runtimeSelectable: true,
  },
];

test('fresh Assist settings do not invent a one-sided model override', () => {
  assert.equal(assistModelSelectionFromSettings({ model: 'hermes-agent', provider: 'openai-codex' }), null);
});

test('incomplete explicit Assist selection fails closed', () => {
  assert.throws(
    () => assistModelSelectionFromSettings({ inlineAssistModel: 'deepseek-v4-pro' }),
    /selection is incomplete/i,
  );
});

test('released gateways without session routing use a truthful Agent-default policy', () => {
  const settings = {
    inlineAssistProvider: 'opencode-go',
    inlineAssistRawModel: 'deepseek-v4-pro',
    inlineAssistThinking: 'on',
    inlineAssistReasoningEffort: 'high',
    inlineAssistFast: true,
  };
  const capabilities = {
    sessionChat: true,
    sessionModelLock: false,
  };

  assert.equal(assistModelRoutingSupported(capabilities), false);
  assert.deepEqual(assistModelRequestPolicy(settings, capabilities), {
    mode: 'gateway-default-fallback',
    selection: null,
    requestedSelection: {
      provider: 'opencode-go',
      model: 'deepseek-v4-pro',
    },
    modelOptions: null,
    label: 'opencode-go / deepseek-v4-pro',
  });
  assert.match(
    assistModelFallbackNotice({ provider: 'opencode-go', model: 'deepseek-v4-pro' }),
    /used the gateway default model instead/i,
  );
});

test('capable gateways retain exact model selection and runtime options', () => {
  const settings = {
    inlineAssistProvider: 'opencode-go',
    inlineAssistRawModel: 'deepseek-v4-pro',
    inlineAssistThinking: 'on',
    inlineAssistReasoningEffort: 'high',
    inlineAssistFast: true,
  };
  const capabilities = {
    sessionChat: true,
    sessionModelLock: true,
  };

  assert.equal(assistModelRoutingSupported(capabilities), true);
  assert.deepEqual(assistModelRequestPolicy(settings, capabilities), {
    mode: 'session-lock',
    selection: {
      provider: 'opencode-go',
      model: 'deepseek-v4-pro',
    },
    modelOptions: {
      thinking: 'on',
      reasoning_effort: 'high',
      fast: true,
    },
    label: 'opencode-go / deepseek-v4-pro',
  });
});

test('capable gateways still reject partial exact selections', () => {
  assert.throws(
    () => assistModelRequestPolicy(
      { inlineAssistRawModel: 'deepseek-v4-pro' },
      { sessionChat: true, sessionModelLock: true },
    ),
    /selection is incomplete/i,
  );
});

test('route request builder sends only Assist\'s effort to gateways that cannot lock a model', () => {
  assert.deepEqual(buildAssistModelRouteRequest({
    inlineAssistProvider: 'opencode-go',
    inlineAssistRawModel: 'deepseek-v4-pro',
    inlineAssistThinkingEnabled: true,
    inlineAssistReasoningEffort: 'high',
    inlineAssistFastMode: true,
  }, {
    sessionChat: true,
    sessionModelLock: false,
  }), {
    policy: {
      mode: 'gateway-default-fallback',
      selection: null,
      requestedSelection: {
        provider: 'opencode-go',
        model: 'deepseek-v4-pro',
      },
      modelOptions: null,
      label: 'opencode-go / deepseek-v4-pro',
    },
    request: {
      reasoning_effort: 'high',
      fast: true,
      model_options: {
        reasoning: { enabled: true, effort: 'high' },
        reasoning_effort: 'high',
        fast: true,
        service_tier: 'priority',
      },
    },
  });
});

test('Assist\'s effort reaches Hermes even when Assist has no model of its own', () => {
  const built = buildAssistModelRouteRequest({ inlineAssistReasoningEffort: 'xhigh' }, { sessionChat: true, sessionModelLock: true });
  assert.equal(built.policy.mode, 'gateway-default');
  assert.deepEqual(built.request, {
    reasoning_effort: 'xhigh',
    fast: false,
    model_options: {
      reasoning: { enabled: true, effort: 'xhigh' },
      reasoning_effort: 'xhigh',
      fast: false,
      service_tier: null,
    },
  });
  assert.equal(buildAssistModelRouteRequest({}, { sessionChat: true, sessionModelLock: true }).request.reasoning_effort, 'low', 'unset is Low, Assist\'s default');
});

test('an Assist turn in a chat runs on Assist\'s model and effort for that turn only', () => {
  const capable = { sessionChat: true, sessionModelLock: true };
  // A one-off override: Hermes runs the turn on it and keeps the chat's own model lock.
  assert.deepEqual(assistChatTurnOverride({
    inlineAssistProvider: 'openai-codex',
    inlineAssistRawModel: 'gpt-6.1-terra',
    inlineAssistReasoningEffort: 'high',
  }, capable), {
    model: 'gpt-6.1-terra',
    provider: 'openai-codex',
    require_model_lock: false,
    reasoning_effort: 'high',
    fast: false,
    model_options: {
      reasoning: { enabled: true, effort: 'high' },
      reasoning_effort: 'high',
      fast: false,
      service_tier: null,
    },
  });
  // Without an Assist model the chat's model runs, with Assist's effort.
  const sameAsChat = assistChatTurnOverride({ inlineAssistReasoningEffort: 'minimal' }, capable);
  assert.equal(sameAsChat.model, undefined);
  assert.equal(sameAsChat.require_model_lock, undefined);
  assert.equal(sameAsChat.model_options.reasoning.effort, 'minimal');
});

test('the model notice says what ran instead', () => {
  const selection = { provider: 'openai-codex', model: 'gpt-6.1-terra' };
  assert.match(assistModelFallbackNotice(selection, 'no lock'), /Used the gateway default model instead\.$/);
  assert.match(assistModelFallbackNotice(selection, 'dashboard connection', 'this chat\'s model'), /could not enforce openai-codex \/ gpt-6\.1-terra \(dashboard connection\)\. Used this chat's model instead\.$/);
});

test('route request builder emits an exact lock only for capable gateways', () => {
  const built = buildAssistModelRouteRequest({
    inlineAssistProvider: 'opencode-go',
    inlineAssistRawModel: 'deepseek-v4-flash',
    inlineAssistThinkingEnabled: true,
    inlineAssistReasoningEffort: 'low',
    inlineAssistFastMode: false,
  }, {
    sessionChat: true,
    sessionModelLock: true,
  });

  assert.deepEqual(built.request, {
    model: 'deepseek-v4-flash',
    provider: 'opencode-go',
    require_model_lock: true,
    reasoning_effort: 'low',
    fast: false,
    model_options: {
      reasoning: { enabled: true, effort: 'low' },
      reasoning_effort: 'low',
      fast: false,
      service_tier: null,
    },
  });
});

test('route request builder preserves provider/model identifiers across user setups', () => {
  const routes = [
    ['opencode-go', 'deepseek-v4-flash'],
    ['openai-codex', 'gpt-5.6-sol'],
    ['anthropic', 'claude-sonnet-4-6'],
    ['openrouter', 'moonshotai/kimi-k3'],
    ['custom:work-proxy', 'Team/Deep-Model:Preview'],
  ];
  for (const [provider, model] of routes) {
    const supported = buildAssistModelRouteRequest({
      inlineAssistProvider: provider,
      inlineAssistRawModel: model,
    }, {
      sessionChat: true,
      sessionModelLock: true,
    });
    assert.equal(supported.request.provider, provider);
    assert.equal(supported.request.model, model);
    assert.equal(supported.request.require_model_lock, true);

    const released = buildAssistModelRouteRequest({
      inlineAssistProvider: provider,
      inlineAssistRawModel: model,
    }, {
      sessionChat: true,
      sessionModelLock: false,
    });
    assert.equal(released.request.model, undefined);
    assert.equal(released.request.require_model_lock, undefined);
  }
});

test('model binding resolves from the live provider catalog', () => {
  assert.deepEqual(resolveAssistModelBindingFromCatalog({
    settings: { inlineAssistModel: 'opencode-go::deepseek-v4-pro' },
    models: MODELS,
  }), {
    inlineAssistModel: 'opencode-go::deepseek-v4-pro',
    inlineAssistRawModel: 'deepseek-v4-pro',
    inlineAssistProvider: 'opencode-go',
  });
});

test('model binding canonicalizes raw provider rows from gateway model catalogs', () => {
  assert.deepEqual(resolveAssistModelBindingFromCatalog({
    settings: { inlineAssistModel: 'e2e/test-model' },
    models: [{
      id: 'e2e/test-model',
      rawModelId: 'e2e/test-model',
      provider: 'e2e',
      runtimeSelectable: true,
    }],
  }), {
    inlineAssistModel: 'e2e::e2e/test-model',
    inlineAssistRawModel: 'e2e/test-model',
    inlineAssistProvider: 'e2e',
  });
});

test('runtime acknowledgement aliases are normalized before exact comparison', () => {
  const selection = { model: 'deepseek-v4-pro', provider: 'opencode-go' };
  assert.deepEqual(
    assertAssistModelSelectionAcknowledged({
      runtime: {
        effective_model: 'deepseek-v4-pro',
        effective_provider: 'opencode-go',
      },
    }, selection),
    { model: 'deepseek-v4-pro', provider: 'opencode-go' },
  );
  assert.deepEqual(
    assertAssistModelSelectionAcknowledged({
      session: { runtime: { model_id: 'deepseek-v4-pro', provider_id: 'opencode-go' } },
    }, selection),
    { model: 'deepseek-v4-pro', provider: 'opencode-go' },
  );
});

test('opaque provider model identifiers stay case-sensitive', () => {
  const selection = { model: 'Model-A', provider: 'Provider' };
  assert.deepEqual(
    assertAssistModelSelectionAcknowledged({ model: 'Model-A', provider: 'Provider' }, selection),
    selection,
  );
  assert.throws(
    () => assertAssistModelSelectionAcknowledged({ model: 'model-a', provider: 'provider' }, selection),
    /did not acknowledge/i,
  );
});

test('a session that confirms the selected model without naming its provider is accepted', () => {
  // Hermes' session create returns the locked model (model + has_model_config) but no provider field.
  const selection = { model: 'claude-haiku-5-5', provider: 'anthropic' };
  assert.deepEqual(
    assertAssistModelSelectionAcknowledged({ object: 'hermes.session', session: { model: 'claude-haiku-5-5', has_model_config: true } }, selection),
    selection,
  );
  assert.throws(() => assertAssistModelSelectionAcknowledged({ session: { model: 'claude-haiku-5-5', provider: 'openrouter' } }, selection), /did not acknowledge/i, 'a different named provider');
  assert.throws(() => assertAssistModelSelectionAcknowledged({ session: { model: 'gpt-6.1-terra' } }, selection), /did not acknowledge/i, 'a different model');
  assert.throws(() => assertAssistModelSelectionAcknowledged({ session: {} }, selection), /did not acknowledge/i, 'no model at all');
});
