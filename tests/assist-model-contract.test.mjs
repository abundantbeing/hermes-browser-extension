import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertAssistModelSelectionAcknowledged,
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

test('route request builder omits unsupported fields on released gateways', () => {
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
    request: {},
  });
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
    assert.deepEqual(released.request, {});
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
