import {
  isModelRuntimeSelectable,
  normalizeFastMode,
  normalizeReasoningEffort,
  normalizeRuntimeModelPayload,
} from './common.mjs';

function clean(value = '') {
  return String(value || '').trim();
}

export function assistModelSelectionFromSettings(settings = {}) {
  const model = clean(settings.inlineAssistRawModel || settings.inlineAssistModel);
  const provider = clean(settings.inlineAssistProvider);
  if (!model && !provider) return null;
  if (!model || !provider) {
    throw new Error('Hermes Assist model selection is incomplete. Choose both a provider and model in Assist settings.');
  }
  return { model, provider };
}

export function assistModelRoutingSupported(capabilities = {}) {
  return capabilities?.sessionChat === true && capabilities?.sessionModelLock === true;
}

export function assistModelFallbackNotice(selection = null, reason = '', instead = 'the gateway default model') {
  const model = clean(selection?.model);
  const provider = clean(selection?.provider);
  if (!model || !provider) return '';
  const explanation = clean(reason);
  return `Hermes Assist could not enforce ${provider} / ${model}${explanation ? ` (${explanation})` : ''}. Used ${clean(instead) || 'the gateway default model'} instead.`;
}

// Assist's own thinking, effort and fast settings as the fields a Hermes request takes. They apply with or
// without an Assist model: with none, Hermes picks the model and still runs it at Assist's effort.
export function assistEffortRequest(settings = {}) {
  const thinkingSetting = String(settings.inlineAssistThinking || '').trim().toLowerCase();
  const thinkingEnabled = settings.inlineAssistThinkingEnabled !== false && thinkingSetting !== 'off';
  const reasoningEffort = thinkingEnabled
    ? normalizeReasoningEffort(settings.inlineAssistReasoningEffort || settings.inlineAssistEffort || 'low')
    : 'none';
  const fast = normalizeFastMode(settings.inlineAssistFastMode ?? settings.inlineAssistFast);
  return {
    reasoning_effort: reasoningEffort,
    fast,
    model_options: {
      reasoning: thinkingEnabled ? { enabled: true, effort: reasoningEffort } : { enabled: false },
      reasoning_effort: reasoningEffort,
      fast,
      service_tier: fast ? 'priority' : null,
    },
  };
}

export function assistModelRequestPolicy(settings = {}, capabilities = {}) {
  const selection = assistModelSelectionFromSettings(settings);
  if (!assistModelRoutingSupported(capabilities) && selection) {
    return {
      mode: 'gateway-default-fallback',
      selection: null,
      requestedSelection: selection,
      modelOptions: null,
      label: `${selection.provider} / ${selection.model}`,
    };
  }
  if (!selection) {
    return {
      mode: 'gateway-default',
      selection: null,
      modelOptions: null,
      label: 'Active Hermes Agent model',
    };
  }
  const thinkingSetting = String(settings.inlineAssistThinking || '').trim().toLowerCase();
  const thinkingEnabled = settings.inlineAssistThinkingEnabled !== false && thinkingSetting !== 'off';
  const reasoningEffort = normalizeReasoningEffort(
    settings.inlineAssistReasoningEffort || settings.inlineAssistEffort || 'low',
  );
  return {
    mode: 'session-lock',
    selection,
    modelOptions: {
      thinking: thinkingEnabled ? 'on' : 'off',
      reasoning_effort: thinkingEnabled ? reasoningEffort : 'none',
      fast: normalizeFastMode(settings.inlineAssistFastMode ?? settings.inlineAssistFast),
    },
    label: `${selection.provider} / ${selection.model}`,
  };
}

export function buildAssistModelRouteRequest(settings = {}, capabilities = {}) {
  const policy = assistModelRequestPolicy(settings, capabilities);
  const effort = assistEffortRequest(settings);
  if (!policy.selection) return { policy, request: effort };
  return {
    policy,
    request: {
      model: policy.selection.model,
      provider: policy.selection.provider,
      require_model_lock: true,
      ...effort,
    },
  };
}

// An Assist turn sent into a chat (Continue current chat, Start new Assist session): Assist's model and
// effort for that one turn. Hermes runs a request's own model without saving it as the chat's lock, so the
// chat keeps its model for the next message. With no Assist model the chat's model runs at Assist's effort.
export function assistChatTurnOverride(settings = {}, capabilities = {}) {
  const { request } = buildAssistModelRouteRequest(settings, capabilities);
  return request.model ? { ...request, require_model_lock: false } : request;
}

export function resolveAssistModelBindingFromCatalog({ settings = {}, models = [] } = {}) {
  const explicitId = clean(settings.inlineAssistModel || settings.inlineAssistRawModel);
  if (!explicitId) return null;
  const explicitProvider = clean(settings.inlineAssistProvider);
  const requestable = Array.from(models || []).filter(isModelRuntimeSelectable);
  const modelIdentity = (model) => {
    const id = clean(model?.id || model?.model || model?.rawModelId);
    const rawModelId = clean(model?.rawModelId || model?.raw_model_id || model?.model || model?.id);
    const provider = clean(model?.provider || model?.providerId || model?.owner);
    const gatewayAlias = model?.gatewayAlias === true || model?.gatewayDefault === true;
    const canonicalId = provider && rawModelId && id === rawModelId && !gatewayAlias
      ? `${provider}::${rawModelId}`
      : id;
    return { id, rawModelId, provider, canonicalId };
  };
  const providerMatches = (model) => {
    const identity = modelIdentity(model);
    return !explicitProvider || identity.provider === explicitProvider;
  };
  const direct = requestable.find((model) => {
    const identity = modelIdentity(model);
    return (identity.id === explicitId || identity.canonicalId === explicitId) && providerMatches(model);
  });
  const rawCandidates = requestable.filter((model) => clean(model.rawModelId || model.raw_model_id || model.model) === explicitId
    && providerMatches(model));
  const selected = direct || (rawCandidates.length === 1 ? rawCandidates[0] : null);
  if (!selected) return null;
  const identity = modelIdentity(selected);
  const { provider, canonicalId: modelId, rawModelId } = identity;
  if (!provider || !modelId || !rawModelId) return null;
  return {
    inlineAssistModel: modelId,
    inlineAssistRawModel: rawModelId,
    inlineAssistProvider: provider,
  };
}

function acknowledgedRuntime(payload = {}) {
  const session = payload?.session && typeof payload.session === 'object' ? payload.session : null;
  const primary = normalizeRuntimeModelPayload(session || payload);
  if (primary.model || primary.provider) return primary;
  const choice = Array.isArray(payload?.choices) && payload.choices[0] && typeof payload.choices[0] === 'object'
    ? normalizeRuntimeModelPayload(payload.choices[0])
    : null;
  return choice || primary;
}

export function assertAssistModelSelectionAcknowledged(payload = {}, selection = null) {
  if (!selection) return null;
  const expectedModel = clean(selection.model);
  const expectedProvider = clean(selection.provider);
  if (!expectedModel || !expectedProvider) {
    throw new Error('Hermes Assist model selection is incomplete. Choose both a provider and model in Assist settings.');
  }
  const runtime = acknowledgedRuntime(payload);
  const actualModel = clean(runtime.model);
  const actualProvider = clean(runtime.provider);
  // Hermes' session create confirms the locked model but does not name its provider. A missing provider is
  // accepted when the model matches; a different model, or a different named provider, is refused.
  if (actualModel !== expectedModel || (actualProvider && actualProvider !== expectedProvider)) {
    throw new Error(
      `Hermes Assist refused to run because Hermes did not acknowledge the selected model (${expectedProvider} / ${expectedModel}). `
      + `Hermes acknowledged ${actualProvider || 'no provider'} / ${actualModel || 'no model'}. `
      + 'Update or restart Hermes Agent before trying again.',
    );
  }
  return { model: actualModel, provider: actualProvider || expectedProvider };
}
